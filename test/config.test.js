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
