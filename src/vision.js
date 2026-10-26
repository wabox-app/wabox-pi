// Inbound image descriptions.
//
// The chat model may be text-only (pi's input modalities are text and image,
// and plenty of useful models are text-only). Rather than dropping the image or
// letting the agent hallucinate about a file it cannot read, we describe it
// first with a separate vision model and put the description in the turn
// prompt — the same shape as audio transcription.
//
// Backends, configured in config.json under `vision`:
//
//   - vision.command            a shell command; the image path is appended (or
//                               substituted for `{file}`); stdout is the
//                               description. Same contract as wabox-bot.
//   - vision.modelProvider +
//     vision.model              any pi model that accepts image input. pi's
//                               stored credentials are reused, so no extra
//                               secret is needed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { shellQuote } from './jail.js';

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_INSTRUCTION =
  'Describe this image for a text-only assistant that will act on it and cannot see it. ' +
  'Include all visible text verbatim, the layout, UI state, people, objects, numbers, and any ' +
  'errors or warnings. Be complete but concise, and do not invent details.';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function isImage(media) {
  if (!media) return false;
  if (media.type === 'image' || media.type === 'sticker') return true;
  return /^image\//.test(media.mimetype || '');
}

export function mimeFor(filePath, media = {}) {
  if (media.mimetype && /^image\//.test(media.mimetype)) return media.mimetype;
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

// `mode` decides *when* to describe: `auto` only when the active chat model
// cannot read images, `always` regardless, `off` never.
export function visionConfigured(vision) {
  const v = vision ?? {};
  if (v.enabled === false) return false;
  if (v.mode === 'off') return false;
  return Boolean(v.command || v.model || v.modelProvider);
}

// Does this pi model accept image input? Unknown models are treated as
// text-only, so we describe rather than send an image the provider rejects.
export function modelSupportsImages(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}

export function shouldDescribe({ vision, model }) {
  const v = vision ?? {};
  if (!visionConfigured(v)) return false;
  if (v.mode === 'always') return true;
  return !modelSupportsImages(model);
}

export function visionLabel(vision) {
  const v = vision ?? {};
  if (!visionConfigured(v)) return 'off';
  if (v.command) return `${v.command} (command)`;
  const model = [v.modelProvider, v.model].filter(Boolean).join('/');
  return `${model} (${v.mode === 'always' ? 'always' : 'auto'})`;
}

let runtimePromise = null;

function runtime(deps) {
  if (deps.modelRuntime) return Promise.resolve(deps.modelRuntime);
  runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false });
  return runtimePromise;
}

// Resolve the configured vision model against pi's catalog. Kept separate so
// the daemon can log a bad config before the first image arrives and the
// dashboard can validate it.
export async function resolveVisionModel(vision, deps = {}) {
  const v = vision ?? {};
  if (v.command) return { kind: 'command' };
  if (!v.model && !v.modelProvider) {
    throw new Error('vision model is not configured (set vision.model/modelProvider or vision.command)');
  }

  const modelRuntime = await runtime(deps);
  const resolved = resolveCliModel({
    cliProvider: v.modelProvider || undefined,
    cliModel: v.model || undefined,
    modelRuntime,
  });
  if (resolved.error || !resolved.model) {
    throw new Error(resolved.error || 'vision model not found');
  }
  if (!modelSupportsImages(resolved.model)) {
    throw new Error(
      `vision model ${resolved.model.provider}/${resolved.model.id} does not accept image input`,
    );
  }
  return { kind: 'pi', model: resolved.model, modelRuntime };
}

export async function describeImage({ vision, filePath, media = {}, log, deps = {} }) {
  const v = vision ?? {};
  const resolved = await resolveVisionModel(v, deps);
  if (resolved.kind === 'command') {
    return runCommand(v, filePath);
  }

  const stat = await fs.stat(filePath);
  const maxBytes = v.maxBytes ?? DEFAULT_MAX_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`image is ${stat.size} bytes, larger than vision.maxBytes (${maxBytes})`);
  }

  const data = (await fs.readFile(filePath)).toString('base64');
  const mimeType = mimeFor(filePath, media);
  const instruction = v.prompt || DEFAULT_INSTRUCTION;

  const controller = new AbortController();
  const timeoutMs = v.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const stream = resolved.modelRuntime.streamSimple(
      resolved.model,
      {
        systemPrompt:
          'You describe images accurately and neutrally for another assistant. ' +
          'Never ask questions and never refuse to describe ordinary content.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image', data, mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: v.maxTokens ?? 1024,
        signal: controller.signal,
        ...(v.apiKey ? { apiKey: v.apiKey } : {}),
      },
    );

    const message = await stream.result();
    if (message.stopReason === 'error' || message.errorMessage) {
      throw new Error(message.errorMessage || 'vision model failed');
    }
    const text = (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('vision model returned no description');

    log?.info(`described ${path.basename(filePath)} with ${resolved.model.provider}/${resolved.model.id}`);
    return { text, model: `${resolved.model.provider}/${resolved.model.id}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`vision model timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(v, filePath) {
  const quoted = shellQuote(filePath);
  const line = v.command.includes('{file}')
    ? v.command.split('{file}').join(quoted)
    : `${v.command} ${quoted}`;
  const timeoutMs = v.timeoutMs ?? 120_000;
  const maxBytes = v.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
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
      if (out.length > maxBytes) {
        child.kill('SIGKILL');
        done(reject, new Error(`vision command output exceeded ${maxBytes} bytes`));
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new Error(`vision command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => done(reject, error));
    child.on('close', (code) => {
      const text = out.trim();
      if (code !== 0) {
        done(reject, new Error(`vision command exited ${code}: ${err.trim().slice(0, 300)}`));
      } else if (!text) {
        done(reject, new Error('vision command returned no description'));
      } else {
        done(resolve, { text, model: 'command' });
      }
    });
  });
}
