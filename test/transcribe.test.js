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
