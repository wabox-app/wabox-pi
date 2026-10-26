import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationConfig, loadConfig } from '../src/config.js';
import { conversationPaths } from '../src/workspace.js';

function instance(extra = {}) {
  return {
    conversationsDir: '/state/conversations',
    tools: ['read', 'bash'],
    excludeTools: [],
    jail: true,
    sandboxBash: 'auto',
    sandboxNetwork: true,
    sandboxDenyRead: ['~/.ssh'],
    autoReply: true,
    errorReply: true,
    ackReact: '👀',
    batchWindowMs: 0,
    conversations: {},
    workspaceOverrides: {},
    ...extra,
  };
}

test('loadConfig parses the transcription block', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  await fs.writeFile(
    cfg,
    JSON.stringify({
      inboxDir: 'inbox',
      outboxDir: 'outbox',
      stateDir: 'state',
      transcription: {
        baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
        model: 'whisper-large-v3',
        apiKeyFile: './stt.key',
        language: 'pt',
      },
    }),
  );

  const previous = process.env.WABOX_PI_CONFIG;
  process.env.WABOX_PI_CONFIG = cfg;
  try {
    const config = loadConfig();
    assert.equal(config.transcription.enabled, true);
    assert.equal(config.transcription.baseUrl, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(config.transcription.model, 'whisper-large-v3');
    assert.equal(config.transcription.language, 'pt');
    assert.equal(config.transcription.apiKeyFile, path.join(dir, 'stt.key'));
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig leaves transcription disabled without a backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  await fs.writeFile(cfg, JSON.stringify({ inboxDir: 'i', outboxDir: 'o', stateDir: 's' }));
  const previous = process.env.WABOX_PI_CONFIG;
  process.env.WABOX_PI_CONFIG = cfg;
  try {
    assert.equal(loadConfig().transcription.enabled, false);
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('conversationConfig returns the instance config when nothing is overridden', () => {
  const config = instance();
  assert.equal(conversationConfig(config, 'slug-a'), config);
});

test('per-slug model overrides merge over the instance model', () => {
  const config = instance({
    modelProvider: 'openrouter',
    model: 'moonshotai/kimi-k2.6',
    conversations: {
      'slug-a': { modelProvider: 'anthropic', model: 'claude-sonnet-4-5', thinkingLevel: 'high' },
    },
  });
  const merged = conversationConfig(config, 'slug-a');
  assert.equal(merged.modelProvider, 'anthropic');
  assert.equal(merged.model, 'claude-sonnet-4-5');
  assert.equal(merged.thinkingLevel, 'high');
  // Another slug keeps the instance default.
  assert.equal(conversationConfig(config, 'slug-b').modelProvider, 'openrouter');
});

test('loadConfig parses model settings and per-slug overrides', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  await fs.writeFile(
    cfg,
    JSON.stringify({
      inboxDir: 'i',
      outboxDir: 'o',
      stateDir: 's',
      modelProvider: 'openrouter',
      model: 'moonshotai/kimi-k2.6',
      conversations: { 'slug-a': { model: 'google/gemini-3.1-flash-lite', thinkingLevel: 'low' } },
    }),
  );
  const previous = process.env.WABOX_PI_CONFIG;
  process.env.WABOX_PI_CONFIG = cfg;
  try {
    const config = loadConfig();
    assert.equal(config.modelProvider, 'openrouter');
    assert.equal(config.model, 'moonshotai/kimi-k2.6');
    const merged = conversationConfig(config, 'slug-a');
    assert.equal(merged.model, 'google/gemini-3.1-flash-lite');
    assert.equal(merged.modelProvider, 'openrouter'); // inherited
    assert.equal(merged.thinkingLevel, 'low');
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('per-slug values replace instance values', () => {
  const config = instance({
    conversations: {
      'slug-a': { jail: false, sandboxBash: 'off', tools: ['read'], ackReact: '👍' },
    },
  });
  const merged = conversationConfig(config, 'slug-a');
  assert.notEqual(merged, config);
  assert.equal(merged.jail, false);
  assert.equal(merged.sandboxBash, 'off');
  assert.deepEqual(merged.tools, ['read']);
  assert.equal(merged.ackReact, '👍');
  // Untouched keys fall back to the instance value.
  assert.equal(merged.sandboxNetwork, true);
  assert.deepEqual(merged.excludeTools, []);
});

test('conversationConfig is keyed by slug', () => {
  const config = instance({
    conversations: { 'slug-a': { jail: false } },
  });
  assert.equal(conversationConfig(config, 'slug-b'), config);
});

test('workspaceOverrides still maps to the workspace', () => {
  const config = instance({ workspaceOverrides: { 'slug-a': '/projects/a' } });
  const merged = conversationConfig(config, 'slug-a');
  assert.equal(merged.workspace, '/projects/a');
});

test('conversations.workspace wins over workspaceOverrides', () => {
  const config = instance({
    conversations: { 'slug-a': { workspace: '/projects/new' } },
    workspaceOverrides: { 'slug-a': '/projects/old' },
  });
  assert.equal(conversationConfig(config, 'slug-a').workspace, '/projects/new');
});

test('conversationPaths honours a merged workspace override', () => {
  const merged = conversationConfig(
    instance({ conversations: { 'slug-a': { workspace: '/projects/a' } } }),
    'slug-a',
  );
  const paths = conversationPaths(merged, 'slug-a');
  assert.equal(paths.workspace, path.resolve('/projects/a'));
  assert.equal(paths.media, path.join('/state/conversations/slug-a', 'media'));
});

test('conversationPaths falls back to the state dir', () => {
  const paths = conversationPaths(instance(), 'slug-a');
  assert.equal(paths.workspace, path.join('/state/conversations/slug-a', 'workspace'));
});

test('loadConfig normalizes the vision block and enables it only with a backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  const previous = process.env.WABOX_PI_CONFIG;
  try {
    await fs.writeFile(
      cfg,
      JSON.stringify({
        inboxDir: 'inbox',
        outboxDir: 'outbox',
        stateDir: 'state',
        vision: { modelProvider: 'openrouter', model: 'google/gemini-flash', maxBytes: 4096 },
      }),
    );
    process.env.WABOX_PI_CONFIG = cfg;
    const config = loadConfig();
    assert.equal(config.vision.enabled, undefined);
    assert.equal(config.vision.mode, 'auto');
    assert.equal(config.vision.modelProvider, 'openrouter');
    assert.equal(config.vision.maxBytes, 4096);

    await fs.writeFile(cfg, JSON.stringify({ stateDir: 'state' }));
    const withoutVision = loadConfig();
    // No derived `enabled`: a conversation may supply the backend, and an
    // inherited false would disable it.
    assert.equal(withoutVision.vision.enabled, undefined);
    assert.equal(withoutVision.vision.mode, 'auto');

    await fs.writeFile(
      cfg,
      JSON.stringify({ stateDir: 'state', vision: { model: 'x/y', enabled: false } }),
    );
    assert.equal(loadConfig().vision.enabled, false);
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a conversation can supply the vision backend without the instance enabling it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  const previous = process.env.WABOX_PI_CONFIG;
  try {
    await fs.writeFile(
      cfg,
      JSON.stringify({
        stateDir: 'state',
        conversations: {
          'slug-a': {
            vision: { modelProvider: 'openrouter', model: 'google/gemini-2.5-flash', mode: 'auto' },
          },
        },
      }),
    );
    process.env.WABOX_PI_CONFIG = cfg;
    const { conversationConfig } = await import('../src/config.js');
    const { visionConfigured } = await import('../src/vision.js');
    const config = loadConfig();
    const merged = conversationConfig(config, 'slug-a');
    assert.equal(visionConfigured(merged.vision), true);
    assert.equal(merged.vision.model, 'google/gemini-2.5-flash');
    assert.equal(merged.vision.enabled, undefined);
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a conversation can override transcription and keep the instance backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  const previous = process.env.WABOX_PI_CONFIG;
  try {
    await fs.writeFile(
      cfg,
      JSON.stringify({
        stateDir: 'state',
        transcription: { provider: 'openrouter', model: 'google/gemini-3.1-flash-lite', language: 'pt' },
        conversations: {
          'slug-a': {
            transcription: {
              model: 'google/gemini-3.1-pro',
              fallback: [{ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3', apiKeyFile: 'groq.key' }],
            },
          },
        },
      }),
    );
    process.env.WABOX_PI_CONFIG = cfg;
    const config = loadConfig();

    assert.equal(config.transcription.language, 'pt');
    assert.equal(config.transcription.fallback.length, 0);

    const merged = conversationConfig(config, 'slug-a');
    assert.equal(merged.transcription.provider, 'openrouter', 'inherits the provider');
    assert.equal(merged.transcription.model, 'google/gemini-3.1-pro', 'overrides the model');
    assert.equal(merged.transcription.language, 'pt', 'inherits the language');
    assert.equal(merged.transcription.fallback.length, 1);
    assert.equal(merged.transcription.fallback[0].apiKeyFile, path.join(dir, 'groq.key'));
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig normalizes an instance transcription fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-cfg-'));
  const cfg = path.join(dir, 'config.json');
  const previous = process.env.WABOX_PI_CONFIG;
  try {
    await fs.writeFile(
      cfg,
      JSON.stringify({
        stateDir: 'state',
        transcription: {
          command: 'primary.sh',
          fallback: [{ command: 'local-whisper {file}', language: 'en' }, { baseUrl: 'https://x/stt', apiKeyFile: './k' }],
        },
      }),
    );
    process.env.WABOX_PI_CONFIG = cfg;
    const config = loadConfig();
    assert.equal(config.transcription.enabled, true);
    assert.equal(config.transcription.fallback.length, 2);
    assert.equal(config.transcription.fallback[0].command, 'local-whisper {file}');
    assert.equal(config.transcription.fallback[0].language, 'en');
    assert.equal(config.transcription.fallback[1].apiKeyFile, path.join(dir, 'k'));
  } finally {
    if (previous === undefined) delete process.env.WABOX_PI_CONFIG;
    else process.env.WABOX_PI_CONFIG = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
