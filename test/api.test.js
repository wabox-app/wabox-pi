import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  coerceOverride,
  coerceOverrides,
  createApi,
  parseSession,
  resolveInWorkspace,
  stripTurnPrompt,
} from '../src/api.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-api-'));
  const config = {
    configFile: path.join(dir, 'config.json'),
    configFilePath: path.join(dir, 'config.json'),
    conversationsDir: path.join(dir, 'conversations'),
    stateDir: path.join(dir, 'state'),
    tasksFile: path.join(dir, 'tasks.json'),
    logFile: path.join(dir, 'wabox-pi.log'),
    schedulerFile: path.join(dir, 'scheduler.json'),
    inboxDir: path.join(dir, 'inbox'),
    outboxDir: path.join(dir, 'outbox'),
    workspaceTemplate: path.join(dir, 'workspace-AGENTS.md'),
    timezone: 'UTC',
    tasks: [],
    conversations: {},
    workspaceOverrides: {},
    tools: ['read', 'bash'],
    excludeTools: [],
    jail: true,
    sandboxBash: 'auto',
    sandboxNetwork: true,
    sandboxBashBin: 'bwrap',
    sandboxDenyRead: ['~/.ssh'],
    sandboxAllowRead: [],
    autoReply: true,
    errorReply: true,
    ackReact: '👀',
    batchWindowMs: 0,
    modelProvider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
    thinkingLevel: null,
    turnFeedbackMs: 60_000,
    turnFeedbackReact: '⏳',
    turnTimeoutMs: 600_000,
    contextCompactRatio: 0.5,
    contextCompactWarnTokens: 120_000,
    logTokens: true,
    ignoreEmojiOnly: true,
    ignoreEmpty: true,
    groupPerParticipant: false,
    logLevel: 'info',
    threads: false,
  };
  const api = createApi({ config, log: silent });
  return { dir, config, api, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeConversation(config, slug, { identity, sessions = [], processed = [] } = {}) {
  const root = path.join(config.conversationsDir, slug);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(root, 'processed'), { recursive: true });
  if (identity) {
    await fs.writeFile(path.join(root, 'identity.json'), JSON.stringify(identity));
  }
  for (const name of sessions) {
    await fs.writeFile(path.join(root, 'sessions', name), '');
  }
  for (const [name, envelope] of processed) {
    await fs.writeFile(path.join(root, 'processed', name), JSON.stringify(envelope));
  }
  return root;
}

/* ---------- pure helpers ---------- */

test('coerceOverride validates and coerces each type', () => {
  assert.deepEqual(coerceOverride('autoReply', 'false'), { ok: true, value: false });
  assert.deepEqual(coerceOverride('turnTimeoutMs', '1500'), { ok: true, value: 1500 });
  assert.deepEqual(coerceOverride('tools', 'read, bash ,'), { ok: true, value: ['read', 'bash'] });
  assert.deepEqual(coerceOverride('model', 'x'), { ok: true, value: 'x' });
  assert.deepEqual(coerceOverride('model', ''), { ok: true, value: null });
  assert.deepEqual(coerceOverride('model', null), { ok: true, value: null });
  assert.equal(coerceOverride('contextCompactRatio', '2').ok, false);
  assert.equal(coerceOverride('turnTimeoutMs', 'soon').ok, false);
  assert.equal(coerceOverride('nope', '1').ok, false);
});

test('coerceOverrides reports unknown keys instead of dropping them', () => {
  const { overrides, errors } = coerceOverrides({ model: 'a/b', bogus: 1 });
  assert.deepEqual(overrides, { model: 'a/b' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown setting: bogus/);
});

test('resolveInWorkspace refuses paths that escape the workspace', () => {
  const root = '/tmp/ws';
  assert.equal(resolveInWorkspace(root, 'notes/a.md'), '/tmp/ws/notes/a.md');
  assert.equal(resolveInWorkspace(root, '/abs.md'), '/tmp/ws/abs.md');
  assert.throws(() => resolveInWorkspace(root, '../secret'), /escapes/);
  assert.throws(() => resolveInWorkspace(root, 'a/../../secret'), /escapes/);
});

test('stripTurnPrompt removes the harness wrapper', () => {
  const text = [
    'A WhatsApp message arrived. Respond to the user as yourself, in their language.',
    '',
    '--- Message 1 ---',
    'From: Ana (5511)',
    'Text:',
    'Oi!',
    '',
    'Reply with the wabox_send tool. If you do not call it, your final text is sent automatically.',
  ].join('\n');
  assert.equal(stripTurnPrompt(text), '--- Message 1 ---\nFrom: Ana (5511)\nText:\nOi!');
  assert.equal(stripTurnPrompt('plain text'), 'plain text');
});

test('parseSession normalizes messages, tools and model changes', () => {
  const lines = [
    { type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/ws' },
    { type: 'model_change', provider: 'openrouter', modelId: 'm1', timestamp: '2026-01-01T00:00:01Z' },
    { type: 'thinking_level_change', thinkingLevel: 'high', timestamp: '2026-01-01T00:00:02Z' },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'A WhatsApp message arrived.\n\nhi' }],
        timestamp: 1,
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'hello' },
          { type: 'toolCall', id: 'c1', name: 'wabox_send', arguments: { text: 'hi' } },
        ],
        provider: 'openrouter',
        model: 'm1',
        usage: { input: 10, output: 2, cost: { total: 0.01 } },
        stopReason: 'stop',
        timestamp: 2,
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'wabox_send',
        content: [{ type: 'text', text: 'sent' }],
      },
    },
    { type: 'not-an-event' },
    'not json',
  ];
  const parsed = parseSession(lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));

  assert.equal(parsed.meta.id, 's1');
  assert.deepEqual(parsed.model, { provider: 'openrouter', modelId: 'm1' });
  assert.equal(parsed.thinkingLevel, 'high');
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ['model', 'thinkingLevel', 'user', 'assistant', 'tool'],
  );
  assert.equal(parsed.events[2].text, 'hi');
  assert.equal(parsed.events[3].text, 'hello');
  assert.equal(parsed.events[3].thinking, 'pondering');
  assert.equal(parsed.events[3].tools[0].name, 'wabox_send');
  assert.equal(parsed.events[4].text, 'sent');
});

/* ---------- api ---------- */

test('listConversations reads identity, sessions and effective model', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'ana-1111', {
      identity: { from: '5511@s.whatsapp.net', pushName: 'Ana', number: '5511' },
      sessions: ['2026-01-01_a.jsonl'],
      processed: [['1.json', { id: '1', text: 'oi' }]],
    });
    await fs.writeFile(
      config.configFilePath,
      JSON.stringify({ conversations: { 'ana-1111': { model: 'x/y' } } }),
    );

    const list = await api.listConversations();
    assert.equal(list.length, 1);
    assert.equal(list[0].slug, 'ana-1111');
    assert.equal(list[0].identity.pushName, 'Ana');
    assert.equal(list[0].sessions, 1);
    assert.equal(list[0].processed, 1);
    assert.equal(list[0].model, 'x/y');
    assert.equal(list[0].overridden, true);
  } finally {
    await cleanup();
  }
});

test('getSettings merges overrides and redacts secrets', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'ana-1111');
    await fs.writeFile(
      config.configFilePath,
      JSON.stringify({
        conversations: {
          'ana-1111': {
            ackReact: '👍',
            turnTimeoutMs: 5,
            imageGen: { apiKey: 'sk-secret', model: 'flux' },
          },
        },
      }),
    );

    const settings = await api.getSettings('ana-1111');
    assert.equal(settings.overrides.ackReact, '👍');
    assert.equal(settings.effective.turnTimeoutMs, 5);
    // Inherited instance value stays visible.
    assert.equal(settings.effective.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(settings.overrides.imageGen.apiKey, '[set]');
    assert.equal(settings.overrides.imageGen.model, 'flux');
  } finally {
    await cleanup();
  }
});

test('saveSettings writes, clears and preserves unrelated config', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'ana-1111');
    await fs.writeFile(
      config.configFilePath,
      JSON.stringify({ logLevel: 'debug', conversations: { 'ana-1111': { ackReact: '👍' } } }),
    );

    await api.saveSettings('ana-1111', { model: 'openrouter/x', tools: ['read'] });
    let raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.logLevel, 'debug');
    assert.equal(raw.conversations['ana-1111'].ackReact, '👍');
    assert.equal(raw.conversations['ana-1111'].model, 'openrouter/x');
    assert.deepEqual(raw.conversations['ana-1111'].tools, ['read']);

    // null removes a single override.
    await api.saveSettings('ana-1111', { ackReact: null });
    raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations['ana-1111'].ackReact, undefined);
    assert.equal(raw.conversations['ana-1111'].model, 'openrouter/x');

    // Removing the last override drops the conversation entry (and the empty
    // `conversations` map) entirely.
    await api.saveSettings('ana-1111', { model: null, tools: null });
    raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations, undefined);
  } finally {
    await cleanup();
  }
});

test('saveSettings creates the config file and rejects unknown keys', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'ana-1111');
    await api.saveSettings('ana-1111', { autoReply: false });
    const raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations['ana-1111'].autoReply, false);

    await assert.rejects(() => api.saveSettings('ana-1111', { bogus: true }), /unknown setting/);
  } finally {
    await cleanup();
  }
});

test('resetSession removes only that conversation session files', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1', { sessions: ['one.jsonl', 'two.jsonl'] });
    await makeConversation(config, 'b-2', { sessions: ['three.jsonl'] });

    const result = await api.resetSession('a-1');
    assert.equal(result.removed, 2);
    assert.deepEqual(await fs.readdir(path.join(config.conversationsDir, 'a-1', 'sessions')), []);
    assert.deepEqual(await fs.readdir(path.join(config.conversationsDir, 'b-2', 'sessions')), [
      'three.jsonl',
    ]);
  } finally {
    await cleanup();
  }
});

test('workspace file read/write stays inside the workspace', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    await api.writeFile('a-1', 'notes/todo.md', '# hi');
    const read = await api.readFile('a-1', 'notes/todo.md');
    assert.equal(read.content, '# hi');
    await assert.rejects(() => api.readFile('a-1', '../../etc/passwd'), /escapes/);
  } finally {
    await cleanup();
  }
});

test('system prompt saves inline override and SYSTEM.md', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    await api.saveSystemPrompt('a-1', { inline: 'Be brief.', file: 'Always answer in pt-BR.' });

    const prompt = await api.getSystemPrompt('a-1');
    assert.equal(prompt.inline, 'Be brief.');
    assert.equal(prompt.file, 'Always answer in pt-BR.\n');

    const raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations['a-1'].systemPrompt, 'Be brief.');

    // Clearing the inline value removes the override but keeps the file.
    await api.saveSystemPrompt('a-1', { inline: '  ' });
    const after = await api.getSystemPrompt('a-1');
    assert.equal(after.inline, '');
    assert.equal(after.file, 'Always answer in pt-BR.\n');
  } finally {
    await cleanup();
  }
});

test('getMessages returns processed envelopes in chronological order', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1', {
      processed: [
        ['2.json', { id: '2', text: 'segunda', timestamp: '2026-01-01T00:01:00Z' }],
        ['1.json', { id: '1', text: 'primeira', timestamp: '2026-01-01T00:00:00Z' }],
      ],
    });
    const messages = await api.getMessages('a-1', 10);
    assert.deepEqual(messages.map((m) => m.text), ['primeira', 'segunda']);
  } finally {
    await cleanup();
  }
});

test('getTranscript rejects a session name outside the sessions dir', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1', { sessions: ['ok.jsonl'] });
    await assert.rejects(() => api.getTranscript('a-1', '../identity.json'), /invalid session file/);
    const transcript = await api.getTranscript('a-1', 'ok.jsonl');
    assert.equal(transcript.session, 'ok.jsonl');
  } finally {
    await cleanup();
  }
});

test('status and tasks come from config plus tasks.json', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    config.tasks = [{ name: 'morning', cron: '0 8 * * *', prompt: 'hi' }];
    await fs.writeFile(
      config.tasksFile,
      JSON.stringify([{ name: 'chat-job', slug: 'a-1', cron: '*/5 * * * *', prompt: 'ping' }]),
    );

    const status = await api.getStatus();
    assert.equal(status.conversations, 1);
    assert.equal(status.tasks, 2);

    const { tasks } = await api.getTasks();
    assert.deepEqual(tasks.map((t) => t.name).sort(), ['chat-job', 'morning']);
  } finally {
    await cleanup();
  }
});

test('rejects slugs that are not safe filenames', async () => {
  const { api, cleanup } = await fixture();
  try {
    for (const slug of ['../escape', '__proto__', 'a/b', '', 'constructor']) {
      await assert.rejects(() => api.getSettings(slug), /invalid conversation slug/);
      await assert.rejects(() => api.getConversation(slug), /invalid conversation slug/);
    }
  } finally {
    await cleanup();
  }
});

test('vision overrides are normalized and empty ones removed', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    config.vision = { modelProvider: 'openrouter', model: 'gemini', mode: 'auto', enabled: true };

    await api.saveSettings('a-1', {
      vision: { mode: 'always', maxTokens: '512' },
    });
    let raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.deepEqual(raw.conversations['a-1'].vision, { mode: 'always', maxTokens: 512 });

    // The per-chat block composes with the instance one.
    const settings = await api.getSettings('a-1');
    assert.equal(settings.effective.vision.model, 'gemini');
    assert.equal(settings.effective.vision.mode, 'always');

    // An empty object is dropped instead of disabling the inherited block.
    await api.saveSettings('a-1', { vision: {} });
    raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations, undefined);
  } finally {
    await cleanup();
  }
});

test('transcription overrides are normalized and merged over the instance', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    config.transcription = {
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-lite',
      language: 'pt',
      fallback: [],
    };

    await api.saveSettings('a-1', {
      transcription: {
        model: 'google/gemini-3.1-pro',
        timeoutMs: '45000',
        fallback: [{ command: 'local-whisper {file}' }],
      },
    });

    const raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.deepEqual(raw.conversations['a-1'].transcription, {
      model: 'google/gemini-3.1-pro',
      timeoutMs: 45000,
      fallback: [{ command: 'local-whisper {file}' }],
    });

    const settings = await api.getSettings('a-1');
    assert.equal(settings.effective.transcription.provider, 'openrouter');
    assert.equal(settings.effective.transcription.model, 'google/gemini-3.1-pro');
    assert.equal(settings.effective.transcription.language, 'pt');
    assert.equal(settings.effective.transcription.fallback.length, 1);

    // An empty object is dropped instead of overriding the instance.
    await api.saveSettings('a-1', { transcription: {} });
    const after = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(after.conversations, undefined);
  } finally {
    await cleanup();
  }
});

test('redacted [set] secrets are restored from the config on save', async () => {
  const { config, api, cleanup } = await fixture();
  try {
    await makeConversation(config, 'a-1');
    await api.saveSettings('a-1', {
      transcription: {
        fallback: [
          { provider: 'openai', baseUrl: 'https://x/stt', model: 'whisper-large-v3', apiKeyFile: '/secrets/groq.key' },
        ],
      },
    });

    const seen = await api.getSettings('a-1');
    assert.equal(seen.overrides.transcription.fallback[0].apiKeyFile, '[set]');

    // The editor sends the redacted entry back, changing only the model.
    const entries = JSON.parse(JSON.stringify(seen.overrides.transcription.fallback));
    entries[0].model = 'whisper-large-v3-turbo';
    await api.saveSettings('a-1', { transcription: { fallback: entries } });

    const raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations['a-1'].transcription.fallback[0].apiKeyFile, '/secrets/groq.key');
    assert.equal(raw.conversations['a-1'].transcription.fallback[0].model, 'whisper-large-v3-turbo');
  } finally {
    await cleanup();
  }
});

test('an unresolved [set] secret is rejected instead of stored', async () => {
  const { api, cleanup } = await fixture();
  try {
    await assert.rejects(
      () =>
        api.saveSettings('a-1', {
          transcription: { fallback: [{ command: 'x', apiKeyFile: '[set]' }] },
        }),
      /replace fallback\[0\]\.apiKeyFile/,
    );
  } finally {
    await cleanup();
  }
});
