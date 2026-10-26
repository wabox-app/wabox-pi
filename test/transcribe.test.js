import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  isAudio,
  providerOf,
  resolveTranscriptionKey,
  transcribeFile,
  transcriptionBackends,
  transcriptionConfigured,
  transcriptionLabel,
} from '../src/transcribe.js';

test('isAudio recognises the type and the mime type', () => {
  assert.equal(isAudio({ type: 'audio' }), true);
  assert.equal(isAudio({ mimetype: 'audio/ogg; codecs=opus' }), true);
  assert.equal(isAudio({ type: 'image', mimetype: 'image/png' }), false);
  assert.equal(isAudio(null), false);
});

test('transcriptionConfigured needs a backend and respects enabled:false', () => {
  assert.equal(transcriptionConfigured({}), false);
  assert.equal(transcriptionConfigured({ baseUrl: 'http://x' }), true);
  assert.equal(transcriptionConfigured({ command: 'cat' }), true);
  assert.equal(transcriptionConfigured({ provider: 'openrouter' }), true);
  assert.equal(transcriptionConfigured({ baseUrl: 'http://x', enabled: false }), false);
});

test('providerOf picks the backend', () => {
  assert.equal(providerOf({}), null);
  assert.equal(providerOf({ command: 'cat', provider: 'openrouter' }), 'command');
  assert.equal(providerOf({ provider: 'openrouter' }), 'openrouter');
  assert.equal(providerOf({ provider: 'chat-audio' }), 'openrouter');
  assert.equal(providerOf({ baseUrl: 'http://x' }), 'openai');
});

test('transcriptionLabel summarises the backend', () => {
  assert.equal(transcriptionLabel({ enabled: false }), 'off');
  assert.equal(transcriptionLabel({ enabled: true, command: 'cat' }), 'cat');
  assert.equal(
    transcriptionLabel({ enabled: true, provider: 'openrouter', model: 'google/gemini-3.1-flash-lite' }),
    'google/gemini-3.1-flash-lite @ openrouter',
  );
});

test('resolveTranscriptionKey reads config, env, then file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const keyFile = path.join(dir, 'key');
  await fs.writeFile(keyFile, 'file-key\n');

  assert.equal(await resolveTranscriptionKey({ apiKey: 'literal' }), 'literal');
  assert.equal(
    await resolveTranscriptionKey({ apiKeyEnv: 'MY_KEY' }, { env: { MY_KEY: 'from-env' } }),
    'from-env',
  );
  assert.equal(await resolveTranscriptionKey({ apiKeyFile: keyFile }), 'file-key');
  assert.equal(await resolveTranscriptionKey({ apiKeyFile: path.join(dir, 'missing') }), null);
  assert.equal(await resolveTranscriptionKey({}), null);

  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveTranscriptionKey falls back to the pi credential for the provider', async () => {
  const creds = { openrouter: { type: 'oauth', access: 'pi-token' } };
  const readPiCredential = (id) => creds[id];

  assert.equal(
    await resolveTranscriptionKey({ provider: 'openrouter' }, { readPiCredential }),
    'pi-token',
  );
  assert.equal(
    await resolveTranscriptionKey(
      { provider: 'openrouter', usePiAuth: false },
      { readPiCredential },
    ),
    null,
  );
});

test('transcribeFile sends input_audio to an OpenRouter-style endpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ola mundo' } }] }),
    };
  };

  const result = await transcribeFile({
    config: { provider: 'openrouter', model: 'google/gemini-3.1-flash-lite', apiKey: 'k', language: 'pt' },
    filePath: file,
    fetchImpl,
  });
  assert.equal(result.text, 'ola mundo');
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  const audioPart = sent.body.messages[0].content.find((c) => c.type === 'input_audio');
  assert.equal(audioPart.input_audio.format, 'ogg');
  assert.equal(Buffer.from(audioPart.input_audio.data, 'base64').toString(), 'AUDIO');

  await fs.rm(dir, { recursive: true, force: true });
});

test('transcribeFile runs a command with {file} or an appended path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO-BYTES');

  const placed = await transcribeFile({ config: { command: 'cat {file}' }, filePath: file });
  assert.equal(placed.text, 'AUDIO-BYTES');

  const appended = await transcribeFile({ config: { command: 'cat' }, filePath: file });
  assert.equal(appended.text, 'AUDIO-BYTES');

  await fs.rm(dir, { recursive: true, force: true });
});

test('transcribeFile surfaces a failing or empty command', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'x');

  await assert.rejects(
    transcribeFile({ config: { command: 'false' }, filePath: file }),
    /exited 1/,
  );
  await assert.rejects(
    transcribeFile({ config: { command: 'printf ""' }, filePath: file }),
    /no text/,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('transcribeFile calls an OpenAI-compatible endpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  const seen = {};
  const server = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: 'ola mundo' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const result = await transcribeFile({
      config: {
        baseUrl: `http://127.0.0.1:${port}/audio/transcriptions`,
        apiKey: 'secret',
        model: 'whisper-large-v3',
      },
      filePath: file,
    });
    assert.equal(result.text, 'ola mundo');
    assert.equal(result.model, 'whisper-large-v3');
    assert.equal(seen.auth, 'Bearer secret');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile rejects an API error and a missing key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  await assert.rejects(
    transcribeFile({ config: { baseUrl: 'http://127.0.0.1:1/x', apiKey: 'k' }, filePath: file }),
    /.+/,
  );
  await assert.rejects(
    transcribeFile({ config: { baseUrl: 'http://127.0.0.1:1/x' }, filePath: file }),
    /no transcription API key/,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('transcriptionBackends orders the primary then fallbacks without leaking identity', () => {
  const backends = transcriptionBackends({
    provider: 'openrouter',
    model: 'a',
    language: 'pt',
    timeoutMs: 5000,
    fallback: [
      { command: 'whisper {file}' },
      { provider: 'openai', baseUrl: 'http://x', model: 'w' },
      { enabled: false, command: 'never' },
      null,
    ],
  });
  assert.equal(backends.length, 3);
  assert.equal(backends[0].provider, 'openrouter');
  assert.equal(backends[0].fallback, undefined);

  assert.equal(backends[1].command, 'whisper {file}');
  assert.equal(backends[1].provider, undefined, 'provider must not be inherited');
  assert.equal(backends[1].model, undefined, 'model must not be inherited');
  assert.equal(backends[1].language, 'pt', 'language is shared');
  assert.equal(backends[1].timeoutMs, 5000, 'timeout is shared');

  assert.equal(backends[2].baseUrl, 'http://x');
  assert.equal(backends[2].model, 'w');
});

test('transcriptionBackends is empty when disabled or unconfigured', () => {
  assert.deepEqual(transcriptionBackends({}), []);
  assert.deepEqual(transcriptionBackends({ enabled: false, command: 'x' }), []);
  assert.deepEqual(transcriptionBackends({ fallback: [{ command: 'x' }] }).length, 1);
});

test('transcriptionLabel reports the fallback chain', () => {
  assert.equal(
    transcriptionLabel({ command: 'cat', fallback: [{ command: 'echo' }, { command: 'tee' }] }),
    'cat (+2 fallback)',
  );
});

test('transcribeFile falls back when the primary backend fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO-BYTES');

  const result = await transcribeFile({
    config: { command: 'false', fallback: [{ command: 'cat' }] },
    filePath: file,
    log: { warn() {} },
  });
  assert.equal(result.text, 'AUDIO-BYTES');
  assert.equal(result.model, 'command');

  await fs.rm(dir, { recursive: true, force: true });
});

test('transcribeFile reports every backend when all of them fail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  await assert.rejects(
    transcribeFile({
      config: { command: 'false', fallback: [{ command: 'printf ""' }] },
      filePath: file,
      log: { warn() {} },
    }),
    /transcription failed on 2 backend\(s\): .*exited 1.*no text/,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

function piModel(overrides = {}) {
  return {
    provider: 'opencode-go',
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    api: 'google-generative-ai',
    baseUrl: 'https://opencode.ai/inference/go/v1',
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    ...overrides,
  };
}

function piRuntime(models = [piModel()]) {
  return { getModels: () => models, hasConfiguredAuth: () => true };
}

test('providerOf treats unknown ids as pi providers', () => {
  assert.equal(providerOf({ provider: 'opencode-go', model: 'gemini-4-argon' }), 'opencode-go');
  assert.equal(providerOf({ provider: 'x', command: 'cat' }), 'command');
});

test('transcribeFile sends inline audio to a Gemini pi provider', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ola mundo' }] } }] }),
    };
  };

  try {
    const result = await transcribeFile({
      config: { provider: 'opencode-go', model: 'gemini-4-argon', language: 'pt', apiKey: 'k' },
      filePath: file,
      fetchImpl,
      deps: { modelRuntime: piRuntime() },
    });

    assert.equal(result.text, 'ola mundo');
    assert.equal(result.model, 'opencode-go/gemini-4-argon');
    assert.match(sent.url, /\/models\/gemini-4-argon:generateContent$/);
    assert.equal(sent.opts.headers['x-goog-api-key'], 'k');
    assert.ok(sent.opts.headers['x-opencode-session'], 'opencode needs a session header');
    const parts = sent.body.contents[0].parts;
    assert.match(parts[0].text, /transcribe/i);
    assert.equal(parts[1].inlineData.mimeType, 'audio/ogg');
    assert.equal(Buffer.from(parts[1].inlineData.data, 'base64').toString(), 'AUDIO');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile uses Bearer for an OAuth Gemini provider', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'oi' }] } }] }),
    };
  };

  try {
    const result = await transcribeFile({
      config: { provider: 'google', model: 'gemini-3.1-flash-lite' },
      filePath: file,
      fetchImpl,
      deps: {
        modelRuntime: piRuntime([
          piModel({ provider: 'google', id: 'gemini-3.1-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        ]),
        readPiCredential: () => ({ type: 'oauth', access: 'tok' }),
      },
    });
    assert.equal(result.text, 'oi');
    assert.equal(sent.opts.headers.authorization, 'Bearer tok');
    assert.equal(sent.opts.headers['x-goog-api-key'], undefined);
    assert.equal(sent.opts.headers['x-opencode-session'], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile sends input_audio to an OpenAI-compatible pi provider', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ola' } }] }),
    };
  };

  try {
    const result = await transcribeFile({
      config: { provider: 'some-proxy', model: 'audio-model', apiKey: 'k' },
      filePath: file,
      fetchImpl,
      deps: {
        modelRuntime: piRuntime([
          piModel({ provider: 'some-proxy', id: 'audio-model', api: 'openai-completions', baseUrl: 'https://proxy.test/v1' }),
        ]),
      },
    });
    assert.equal(result.text, 'ola');
    assert.equal(sent.url, 'https://proxy.test/v1/chat/completions');
    assert.equal(sent.opts.headers.authorization, 'Bearer k');
    assert.equal(sent.body.messages[0].content[1].type, 'input_audio');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile rejects an unsupported pi API and unknown models', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  try {
    await assert.rejects(
      transcribeFile({
        config: { provider: 'anthropic', model: 'claude', apiKey: 'k' },
        filePath: file,
        deps: {
          modelRuntime: piRuntime([
            piModel({ provider: 'anthropic', id: 'claude', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }),
          ]),
        },
      }),
      /cannot send audio/,
    );

    await assert.rejects(
      transcribeFile({
        config: { provider: 'ghost', model: 'x', apiKey: 'k' },
        filePath: file,
        deps: { modelRuntime: piRuntime() },
      }),
      /Unknown provider/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile surfaces a deprecated or failing pi model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  try {
    await assert.rejects(
      transcribeFile({
        config: { provider: 'opencode-go', model: 'gemini-4-argon', apiKey: 'k' },
        filePath: file,
        fetchImpl: async () => ({
          ok: false,
          status: 410,
          text: async () => JSON.stringify({ error: { message: 'ModelDeprecated' } }),
        }),
        deps: { modelRuntime: piRuntime() },
      }),
      /410.*ModelDeprecated/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribeFile prefers the configured model id over a stale catalog match', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-stt-'));
  const file = path.join(dir, 'note.ogg');
  await fs.writeFile(file, 'AUDIO');

  let sentUrl;
  const fetchImpl = async (url) => {
    sentUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'oi' }] } }] }),
    };
  };

  try {
    await transcribeFile({
      config: { provider: 'opencode-go', model: 'gemini-4-argon', apiKey: 'k' },
      filePath: file,
      fetchImpl,
      deps: {
        modelRuntime: piRuntime([
          // The static catalog only knows the deprecated sibling.
          piModel({ id: 'gemini-4-argon-contributor' }),
        ]),
      },
    });
    assert.match(sentUrl, /gemini-4-argon:generateContent$/);
    assert.doesNotMatch(sentUrl, /contributor/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
