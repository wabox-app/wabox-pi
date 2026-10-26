import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../src/dashboard.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-dash-'));
  const config = {
    configFile: path.join(dir, 'config.json'),
    configFilePath: path.join(dir, 'config.json'),
    conversationsDir: path.join(dir, 'conversations'),
    stateDir: path.join(dir, 'state'),
    tasksFile: path.join(dir, 'tasks.json'),
    logFile: path.join(dir, 'wabox-pi.log'),
    inboxDir: path.join(dir, 'inbox'),
    outboxDir: path.join(dir, 'outbox'),
    dashboardPort: 0,
    dashboardHost: '127.0.0.1',
    timezone: 'UTC',
    tasks: [],
    conversations: {},
    workspaceOverrides: {},
    tools: ['read'],
    excludeTools: [],
    jail: true,
    sandboxBash: 'auto',
    sandboxNetwork: true,
    autoReply: true,
    errorReply: true,
    ackReact: '',
    batchWindowMs: 0,
    groupPerParticipant: false,
    logLevel: 'info',
    threads: false,
  };
  const slug = 'ana-1111';
  const root = path.join(config.conversationsDir, slug);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(root, 'processed'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'identity.json'),
    JSON.stringify({ from: '5511@s.whatsapp.net', pushName: 'Ana', number: '5511' }),
  );
  await fs.writeFile(path.join(root, 'workspace', 'AGENTS.md'), '# agent\n');
  await fs.writeFile(
    path.join(root, 'sessions', '2026-01-01_a.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'A WhatsApp message arrived.\n\nOi' }], timestamp: 1 },
      }),
    ].join('\n'),
  );
  await fs.writeFile(path.join(config.logFile), '2026-01-01 INFO hello\n');
  return { dir, config, slug, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function boot(config, extra = {}) {
  const server = await startDashboard({ config, log: silent, port: 0, ...extra });
  assert.ok(server, 'dashboard should start');
  return server;
}

test('serves the SPA and the JSON API', async () => {
  const { config, slug, cleanup } = await fixture();
  const server = await boot(config);
  try {
    const index = await fetch(server.url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /wabox-pi/);

    const script = await fetch(`${server.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const status = await (await fetch(`${server.url}/api/status`)).json();
    assert.equal(status.conversations, 1);
    assert.equal(status.running, false);
    assert.equal(status.paths.config, config.configFilePath);

    const { conversations } = await (await fetch(`${server.url}/api/conversations`)).json();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].slug, slug);
    assert.equal(conversations[0].identity.pushName, 'Ana');

    const detail = await (await fetch(`${server.url}/api/conversations/${slug}`)).json();
    assert.equal(detail.sessions.length, 1);
    assert.ok(detail.files.some((file) => file.path === 'AGENTS.md'));
  } finally {
    await server.close();
    await cleanup();
  }
});

test('settings round-trip through HTTP and reload the control handle', async () => {
  const { config, slug, cleanup } = await fixture();
  const reloaded = [];
  const control = {
    alive: () => true,
    isRunning: () => true,
    runnerCount: () => 1,
    reload: async (value) => reloaded.push(value),
  };
  const server = await boot(config, { control });
  try {
    const response = await fetch(`${server.url}/api/conversations/${slug}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openrouter/x', autoReply: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(reloaded, [slug]);

    const settings = await (await fetch(`${server.url}/api/conversations/${slug}/settings`)).json();
    assert.equal(settings.overrides.model, 'openrouter/x');
    assert.equal(settings.overrides.autoReply, false);

    const raw = JSON.parse(await fs.readFile(config.configFilePath, 'utf8'));
    assert.equal(raw.conversations[slug].model, 'openrouter/x');
  } finally {
    await server.close();
    await cleanup();
  }
});

test('rejects invalid settings with 400 and unknown routes with 404', async () => {
  const { config, slug, cleanup } = await fixture();
  const server = await boot(config);
  try {
    const invalid = await fetch(`${server.url}/api/conversations/${slug}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /unknown setting/);

    const missing = await fetch(`${server.url}/api/conversations/ghost`);
    assert.equal(missing.status, 404);

    const unknown = await fetch(`${server.url}/api/nothing`);
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
    await cleanup();
  }
});

test('transcript, workspace file and system prompt endpoints', async () => {
  const { config, slug, cleanup } = await fixture();
  const server = await boot(config);
  try {
    const transcript = await (
      await fetch(`${server.url}/api/conversations/${slug}/transcript?session=2026-01-01_a.jsonl`)
    ).json();
    assert.equal(transcript.events.at(-1).text, 'Oi');

    const file = await (
      await fetch(`${server.url}/api/conversations/${slug}/file?path=AGENTS.md`)
    ).json();
    assert.equal(file.content, '# agent\n');

    const escaped = await fetch(`${server.url}/api/conversations/${slug}/file?path=../../etc/passwd`);
    assert.equal(escaped.status, 500);
    assert.match((await escaped.json()).error, /escapes/);

    await fetch(`${server.url}/api/conversations/${slug}/system-prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inline: 'Be brief.', file: 'Fale português.' }),
    });
    const prompt = await (await fetch(`${server.url}/api/conversations/${slug}/system-prompt`)).json();
    assert.equal(prompt.inline, 'Be brief.');
    assert.equal(prompt.file, 'Fale português.\n');
  } finally {
    await server.close();
    await cleanup();
  }
});

test('requires a bearer token when one is configured', async () => {
  const { config, slug, cleanup } = await fixture();
  process.env.WABOX_PI_DASHBOARD_TOKEN = 's3cret';
  const server = await boot(config);
  try {
    const denied = await fetch(`${server.url}/api/status`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${server.url}/api/status`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    assert.equal(allowed.status, 200);

    // Static assets stay public so the login prompt can load.
    assert.equal((await fetch(`${server.url}/`)).status, 200);
    void slug;
  } finally {
    delete process.env.WABOX_PI_DASHBOARD_TOKEN;
    await server.close();
    await cleanup();
  }
});

test('refuses to bind off-loopback without a token', async () => {
  const { config, cleanup } = await fixture();
  try {
    await assert.rejects(
      () => startDashboard({ config, log: silent, port: 0, host: '0.0.0.0' }),
      /WABOX_PI_DASHBOARD_TOKEN/,
    );
  } finally {
    await cleanup();
  }
});
