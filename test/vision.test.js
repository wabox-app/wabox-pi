import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  describeImage,
  isImage,
  mimeFor,
  modelSupportsImages,
  shouldDescribe,
  visionConfigured,
  visionLabel,
} from '../src/vision.js';
import { conversationConfig, normalizeVision } from '../src/config.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeModel(overrides = {}) {
  return {
    provider: 'openrouter',
    id: 'google/gemini-flash',
    name: 'Gemini Flash',
    input: ['text', 'image'],
    contextWindow: 100_000,
    ...overrides,
  };
}

function fakeRuntime(models = [fakeModel()], { text = 'a photo of a cat' } = {}) {
  const calls = [];
  return {
    calls,
    getModels: () => models,
    hasConfiguredAuth: () => true,
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return {
        result: async () => ({ content: [{ type: 'text', text }], stopReason: 'stop' }),
      };
    },
  };
}

async function imageFixture(contents = 'fake-image-bytes') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-vision-'));
  const file = path.join(dir, 'photo.jpg');
  await fs.writeFile(file, contents);
  return { dir, file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/* ---------- pure helpers ---------- */

test('isImage recognises the media type and the mime type', () => {
  assert.equal(isImage({ type: 'image' }), true);
  assert.equal(isImage({ type: 'sticker' }), true);
  assert.equal(isImage({ type: 'document', mimetype: 'image/png' }), true);
  assert.equal(isImage({ type: 'document', mimetype: 'application/pdf' }), false);
  assert.equal(isImage(null), false);
});

test('mimeFor prefers the media mime and falls back to the extension', () => {
  assert.equal(mimeFor('/x/a.jpg', { mimetype: 'image/webp' }), 'image/webp');
  assert.equal(mimeFor('/x/a.png'), 'image/png');
  assert.equal(mimeFor('/x/a.HEIC'), 'image/heic');
  assert.equal(mimeFor('/x/a.bin'), 'image/jpeg');
});

test('visionConfigured needs a backend and honours enabled/mode', () => {
  assert.equal(visionConfigured({}), false);
  assert.equal(visionConfigured({ model: 'openrouter/x' }), true);
  assert.equal(visionConfigured({ command: 'describe' }), true);
  assert.equal(visionConfigured({ model: 'openrouter/x', enabled: false }), false);
  assert.equal(visionConfigured({ model: 'openrouter/x', mode: 'off' }), false);
});

test('visionLabel summarises the backend', () => {
  assert.equal(visionLabel({}), 'off');
  assert.equal(visionLabel({ modelProvider: 'openrouter', model: 'x/y' }), 'openrouter/x/y (auto)');
  assert.equal(visionLabel({ command: 'desc' }), 'desc (command)');
});

test('modelSupportsImages treats unknown models as text-only', () => {
  assert.equal(modelSupportsImages(fakeModel()), true);
  assert.equal(modelSupportsImages(fakeModel({ input: ['text'] })), false);
  assert.equal(modelSupportsImages(null), false);
});

test('shouldDescribe follows the mode and the chat model modalities', () => {
  const vision = { model: 'openrouter/x' };
  assert.equal(shouldDescribe({ vision, model: fakeModel({ input: ['text'] }) }), true);
  assert.equal(shouldDescribe({ vision, model: fakeModel() }), false);
  assert.equal(shouldDescribe({ vision: { ...vision, mode: 'always' }, model: fakeModel() }), true);
  assert.equal(shouldDescribe({ vision: { ...vision, mode: 'off' }, model: fakeModel() }), false);
  assert.equal(shouldDescribe({ vision: {}, model: fakeModel({ input: ['text'] }) }), false);
});

test('normalizeVision keeps known fields and coerces booleans and numbers', () => {
  assert.equal(normalizeVision(null), null);
  assert.equal(normalizeVision('nope'), null);
  assert.deepEqual(normalizeVision({ mode: 'ALWAYS', enabled: 'false', timeoutMs: '5000' }), {
    mode: 'always',
    enabled: false,
    timeoutMs: 5000,
  });
  assert.deepEqual(normalizeVision({ mode: 'bogus' }), { mode: 'auto' });
  assert.deepEqual(normalizeVision({ apiKey: 'k', prompt: 'p', modelProvider: 'openrouter' }), {
    apiKey: 'k',
    prompt: 'p',
    modelProvider: 'openrouter',
  });
});

test('conversationConfig deep-merges the vision block over the instance', () => {
  const config = {
    conversationsDir: '/state',
    vision: { modelProvider: 'openrouter', model: 'gemini', mode: 'auto', maxTokens: 800 },
    conversations: {
      'a-1': { vision: { mode: 'always' } },
      'b-2': { vision: null },
    },
    workspaceOverrides: {},
  };
  const merged = conversationConfig(config, 'a-1');
  assert.deepEqual(merged.vision, {
    modelProvider: 'openrouter',
    model: 'gemini',
    mode: 'always',
    maxTokens: 800,
  });
  // `vision: null` inherits the instance block instead of disabling it.
  assert.deepEqual(conversationConfig(config, 'b-2').vision, config.vision);
  assert.equal(conversationConfig(config, 'c-3'), config);
});

/* ---------- backends ---------- */

test('describeImage sends the image to the configured pi model', async () => {
  const { file, cleanup } = await imageFixture();
  const runtime = fakeRuntime();
  try {
    const result = await describeImage({
      vision: { model: 'openrouter/google/gemini-flash', maxTokens: 300, prompt: 'Describe it.' },
      filePath: file,
      media: { mimetype: 'image/jpeg' },
      log: silent,
      deps: { modelRuntime: runtime },
    });

    assert.equal(result.text, 'a photo of a cat');
    assert.equal(result.model, 'openrouter/google/gemini-flash');

    assert.equal(runtime.calls.length, 1);
    const { context, options } = runtime.calls[0];
    assert.equal(options.maxTokens, 300);
    const [text, image] = context.messages[0].content;
    assert.equal(text.text, 'Describe it.');
    assert.equal(image.type, 'image');
    assert.equal(image.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(image.data, 'base64').toString(), 'fake-image-bytes');
  } finally {
    await cleanup();
  }
});

test('describeImage rejects a vision model that cannot read images', async () => {
  const { file, cleanup } = await imageFixture();
  const runtime = fakeRuntime([fakeModel({ input: ['text'] })]);
  try {
    await assert.rejects(
      () =>
        describeImage({
          vision: { model: 'openrouter/google/gemini-flash' },
          filePath: file,
          log: silent,
          deps: { modelRuntime: runtime },
        }),
      /does not accept image input/,
    );
  } finally {
    await cleanup();
  }
});

test('describeImage surfaces model errors and empty output', async () => {
  const { file, cleanup } = await imageFixture();
  const failing = {
    getModels: () => [fakeModel()],
    hasConfiguredAuth: () => true,
    streamSimple: () => ({
      result: async () => ({ content: [], stopReason: 'error', errorMessage: 'rate limited' }),
    }),
  };
  const empty = {
    getModels: () => [fakeModel()],
    hasConfiguredAuth: () => true,
    streamSimple: () => ({ result: async () => ({ content: [], stopReason: 'stop' }) }),
  };
  try {
    await assert.rejects(
      () =>
        describeImage({
          vision: { model: 'openrouter/google/gemini-flash' },
          filePath: file,
          log: silent,
          deps: { modelRuntime: failing },
        }),
      /rate limited/,
    );
    await assert.rejects(
      () =>
        describeImage({
          vision: { model: 'openrouter/google/gemini-flash' },
          filePath: file,
          log: silent,
          deps: { modelRuntime: empty },
        }),
      /no description/,
    );
  } finally {
    await cleanup();
  }
});

test('describeImage enforces vision.maxBytes', async () => {
  const { file, cleanup } = await imageFixture('x'.repeat(2048));
  try {
    await assert.rejects(
      () =>
        describeImage({
          vision: { model: 'openrouter/google/gemini-flash', maxBytes: 1000 },
          filePath: file,
          log: silent,
          deps: { modelRuntime: fakeRuntime() },
        }),
      /larger than vision.maxBytes/,
    );
  } finally {
    await cleanup();
  }
});

test('describeImage runs a local command with the file path', async () => {
  const { dir, file, cleanup } = await imageFixture();
  const script = path.join(dir, 'describe.sh');
  await fs.writeFile(script, `#!/bin/sh\necho "description of $1"\n`, { mode: 0o755 });
  try {
    const result = await describeImage({
      vision: { command: shellQuote(script) },
      filePath: file,
      log: silent,
    });
    assert.equal(result.text, `description of ${file}`);
    assert.equal(result.model, 'command');
  } finally {
    await cleanup();
  }
});

test('describeImage surfaces a failing command', async () => {
  const { file, cleanup } = await imageFixture();
  try {
    await assert.rejects(
      () => describeImage({ vision: { command: 'false' }, filePath: file, log: silent }),
      /vision command exited/,
    );
  } finally {
    await cleanup();
  }
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
