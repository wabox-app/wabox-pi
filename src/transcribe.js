// Inbound audio transcription.
//
// pi's model input modalities are text and image only, so audio cannot be sent
// to the agent. Instead we transcribe the voice note first and put the text in
// the turn prompt. Backends, all configured in config.json:
//
//   - transcription.command    a shell command; the audio path is appended (or
//                              substituted for `{file}`), stdout is the
//                              transcript. Same contract as wabox-bot.
//   - transcription.provider:
//       "openrouter"  chat completions with an `input_audio` content part.
//                     Reuses pi's stored OpenRouter credential by default.
//       "openai"      an OpenAI-compatible POST /audio/transcriptions endpoint
//                     (OpenAI, Groq, …).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { shellQuote } from './jail.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite';

// `input_audio` accepts a small set of containers; WhatsApp voice notes are
// OGG/Opus, so the common case needs no conversion.
const FORMAT_BY_EXT = {
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.m4a': 'mp3',
  '.mp4': 'mp3',
  '.webm': 'mp3',
  '.flac': 'mp3',
};

export function isAudio(media) {
  return media?.type === 'audio' || /^audio\//.test(media?.mimetype || '');
}

export function transcriptionConfigured(config) {
  const t = config ?? {};
  if (t.enabled === false) return false;
  return Boolean(t.command || t.baseUrl || t.provider);
}

export function transcriptionLabel(config) {
  const t = config ?? {};
  if (!t.enabled) return 'off';
  if (t.command) return t.command;
  const provider = providerOf(t);
  if (provider === 'openrouter') return `${t.model} @ openrouter`;
  if (t.baseUrl) return `${t.model} @ ${t.baseUrl}`;
  return 'off';
}

export function providerOf(config) {
  const t = config ?? {};
  if (t.command) return 'command';
  if (t.provider === 'openrouter' || t.provider === 'chat-audio') return 'openrouter';
  if (t.baseUrl) return 'openai';
  return t.provider || null;
}

function credentialToken(credential) {
  if (!credential) return null;
  if (credential.type === 'oauth') return credential.access || null;
  if (credential.type === 'apiKey') return credential.key || credential.apiKey || null;
  return credential.access || credential.key || credential.apiKey || null;
}

function readPiCredential(providerId) {
  try {
    return readStoredCredential(providerId);
  } catch {
    return undefined;
  }
}

// The API key can come from the config, an environment variable, a file (one
// key per file), or pi's stored credential for the provider (so an OpenRouter
// setup needs no separate secret).
export async function resolveTranscriptionKey(config, deps = {}) {
  const t = config ?? {};
  const env = deps.env ?? process.env;
  const piRead = deps.readPiCredential ?? readPiCredential;

  if (t.apiKey) return String(t.apiKey);
  if (t.apiKeyEnv && env[t.apiKeyEnv]) return String(env[t.apiKeyEnv]);
  if (t.apiKeyFile) {
    try {
      const text = await fs.readFile(t.apiKeyFile, 'utf8');
      const key = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (key) return key;
    } catch {
      // fall through
    }
  }

  const piProvider = t.piProvider || (providerOf(t) === 'openrouter' ? 'openrouter' : null);
  if (piProvider && t.usePiAuth !== false) {
    const token = credentialToken(piRead(piProvider));
    if (token) return token;
  }
  return null;
}

export async function transcribeFile({ config, filePath, log, fetchImpl = fetch, deps = {} }) {
  const t = config ?? {};
  const provider = providerOf(t);
  if (provider === 'command') return runCommand(t.command, filePath, t);
  if (provider === 'openrouter') return callChatAudio(t, filePath, { log, fetchImpl, deps });
  if (provider === 'openai') return callTranscriptionsApi(t, filePath, { log, fetchImpl, deps });
  throw new Error('transcription is not configured');
}

function runCommand(command, filePath, t) {
  const quoted = shellQuote(filePath);
  const line = command.includes('{file}') ? command.split('{file}').join(quoted) : `${command} ${quoted}`;
  const timeoutMs = t.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const child = spawn(line, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new Error(`transcription command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => done(reject, error));
    child.on('close', (code) => {
      const text = out.trim();
      if (code !== 0) {
        done(reject, new Error(`transcription command exited ${code}: ${err.trim().slice(0, 300)}`));
      } else if (!text) {
        done(reject, new Error('transcription command returned no text'));
      } else {
        done(resolve, { text, model: 'command' });
      }
    });
  });
}

// Encode the file for `input_audio`. Known containers are sent as-is; anything
// else is transcoded to mp3 with ffmpeg (bundled on any wabox host).
async function encodeAudio(filePath, t) {
  const ext = path.extname(filePath).toLowerCase();
  const known = FORMAT_BY_EXT[ext];
  if (known && known !== 'mp3') {
    return { data: (await fs.readFile(filePath)).toString('base64'), format: known, cleanup: null };
  }
  if (known === 'mp3') {
    // .m4a/.mp4/.webm/.flac map to mp3, so they still need a transcode.
    if (ext === '.mp3') {
      return { data: (await fs.readFile(filePath)).toString('base64'), format: 'mp3', cleanup: null };
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const out = path.join(dir, 'audio.mp3');
  await runFfmpeg(['-nostdin', '-loglevel', 'error', '-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-b:a', '48k', out]);
  return { data: (await fs.readFile(out)).toString('base64'), format: 'mp3', cleanup: dir };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });
}

async function callChatAudio(t, filePath, { log, fetchImpl, deps }) {
  const key = await resolveTranscriptionKey(t, deps);
  if (!key) {
    throw new Error(
      'no transcription API key (set transcription.apiKey/apiKeyEnv/apiKeyFile, or sign in to pi for the provider)',
    );
  }

  const model = t.model || DEFAULT_OPENROUTER_MODEL;
  const { data, format, cleanup } = await encodeAudio(filePath, t);
  const instruction =
    t.prompt ||
    `Transcribe this audio${t.language ? ` in ${t.language}` : ''} verbatim. ` +
      'Return only the transcription, with no preamble or commentary.';

  const controller = new AbortController();
  const timeoutMs = t.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchImpl(t.baseUrl || OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'input_audio', input_audio: { data, format } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`transcription API ${res.status}: ${raw.trim().slice(0, 300)}`);
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`transcription API returned invalid JSON: ${raw.slice(0, 200)}`);
    }
    if (value.error) {
      throw new Error(`transcription API error: ${JSON.stringify(value.error).slice(0, 300)}`);
    }
    const text = String(value.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('transcription API returned no text');
    return { text, model };
  } catch (err) {
    if (err.name === 'AbortError') {
      log?.warn(`transcription API timed out after ${timeoutMs}ms`);
      throw new Error(`transcription API timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (cleanup) await fs.rm(cleanup, { recursive: true, force: true }).catch(() => {});
  }
}

async function callTranscriptionsApi(t, filePath, { log, fetchImpl, deps }) {
  const key = await resolveTranscriptionKey(t, deps);
  if (!key) {
    throw new Error('no transcription API key (set transcription.apiKey, apiKeyEnv, or apiKeyFile)');
  }

  const buffer = await fs.readFile(filePath);
  const mime = /\.mp3$/i.test(filePath) ? 'audio/mpeg' : 'audio/ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), path.basename(filePath));
  form.append('model', t.model || 'whisper-1');
  form.append('response_format', 'json');
  if (t.language) form.append('language', t.language);
  if (t.prompt) form.append('prompt', t.prompt);

  const controller = new AbortController();
  const timeoutMs = t.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchImpl(t.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`transcription API ${res.status}: ${body.trim().slice(0, 300)}`);
    }
    const model = t.model || 'whisper-1';
    if (contentType.includes('application/json')) {
      try {
        const value = JSON.parse(body);
        const text = String(value.text ?? '').trim();
        if (!text) throw new Error('transcription API returned no text');
        return { text, model };
      } catch (err) {
        if (err instanceof SyntaxError) return { text: body.trim(), model };
        throw err;
      }
    }
    const text = body.trim();
    if (!text) throw new Error('transcription API returned no text');
    return { text, model };
  } catch (err) {
    if (err.name === 'AbortError') {
      log?.warn(`transcription API timed out after ${timeoutMs}ms`);
      throw new Error(`transcription API timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
