import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveThread, classifyMessage } from '../src/router.js';
import { ensureThread } from '../src/threads.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('resolveThread returns default when threads are disabled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-router-'));
  const result = await resolveThread({
    envelope: { text: 'hello' },
    slug: 'chat-1',
    config: { threads: false },
    paths: { root: dir, sessions: path.join(dir, 'sessions') },
    log: silent,
  });
  assert.equal(result.threadId, 'default');
  assert.equal(result.switched, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveThread continues active thread when only one thread exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-router-'));
  await ensureThread(dir, 'default');
  const result = await resolveThread({
    envelope: { text: 'hello again' },
    slug: 'chat-1',
    config: { threads: true, router: {} },
    paths: { root: dir, sessions: path.join(dir, 'sessions') },
    log: silent,
  });
  assert.equal(result.threadId, 'default');
  assert.equal(result.switched, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveThread continues hot thread without calling API', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-router-'));
  await ensureThread(dir, 'default');
  // Create a second thread so classification would normally be triggered
  const { readThreads, createThread, setActiveThread } = await import('../src/threads.js');
  const { threadId } = await createThread(dir, { name: 'Side topic', summary: 'Other stuff' });
  await setActiveThread(dir, 'default');

  const result = await resolveThread({
    envelope: { text: 'quick follow-up' },
    slug: 'chat-1',
    config: { threads: true, threadHotMinutes: 5, router: {} },
    paths: { root: dir, sessions: path.join(dir, 'sessions') },
    log: silent,
  });
  assert.equal(result.threadId, 'default');
  assert.equal(result.switched, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('classifyMessage defaults to continue when no API key is configured', async () => {
  const decision = await classifyMessage({
    message: 'hello',
    activeThread: { id: 't1', name: 'Main', summary: 'General chat' },
    otherThreads: [],
    config: { router: { apiKey: null, apiKeyEnv: null, apiKeyFile: null } },
    log: silent,
    fetchImpl: async () => { throw new Error('should not be called'); },
  });
  assert.equal(decision.action, 'continue');
});

test('classifyMessage parses continue response', async () => {
  const decision = await classifyMessage({
    message: 'hello',
    activeThread: { id: 't1', name: 'Main', summary: 'General' },
    otherThreads: [{ id: 't2', name: 'Other', summary: 'Other topic' }],
    config: { router: { apiKey: 'test-key', baseUrl: 'http://test', timeoutMs: 5_000 } },
    log: silent,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"action":"continue"}' } }],
      }),
    }),
  });
  assert.equal(decision.action, 'continue');
});

test('classifyMessage parses switch response', async () => {
  const decision = await classifyMessage({
    message: 'about that other thing',
    activeThread: { id: 't1', name: 'Main', summary: 'General' },
    otherThreads: [{ id: 't2', name: 'Auth refactor', summary: 'JWT migration' }],
    config: { router: { apiKey: 'test-key', baseUrl: 'http://test', timeoutMs: 5_000 } },
    log: silent,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"action":"switch","threadId":"t2"}' } }],
      }),
    }),
  });
  assert.equal(decision.action, 'switch');
  assert.equal(decision.threadId, 't2');
});

test('classifyMessage parses new response', async () => {
  const decision = await classifyMessage({
    message: 'completely new topic about DNS',
    activeThread: { id: 't1', name: 'Main', summary: 'General' },
    otherThreads: [],
    config: { router: { apiKey: 'test-key', baseUrl: 'http://test', timeoutMs: 5_000 } },
    log: silent,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"action":"new","name":"DNS Setup","summary":"Configuring DNS records"}' } }],
      }),
    }),
  });
  assert.equal(decision.action, 'new');
  assert.equal(decision.name, 'DNS Setup');
  assert.equal(decision.summary, 'Configuring DNS records');
});

test('classifyMessage defaults to continue on API error', async () => {
  const decision = await classifyMessage({
    message: 'hello',
    activeThread: { id: 't1', name: 'Main', summary: 'General' },
    otherThreads: [],
    config: { router: { apiKey: 'bad-key', baseUrl: 'http://test', timeoutMs: 5_000 } },
    log: silent,
    fetchImpl: async () => { throw new TypeError('ECONNREFUSED'); },
  });
  assert.equal(decision.action, 'continue');
});

test('classifyMessage defaults to continue on timeout', async () => {
  let aborted = false;
  const decision = await classifyMessage({
    message: 'hello',
    activeThread: { id: 't1', name: 'Main', summary: 'General' },
    otherThreads: [],
    config: { router: { apiKey: 'test-key', baseUrl: 'http://test', timeoutMs: 50 } },
    log: silent,
    fetchImpl: async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    },
  });
  assert.equal(decision.action, 'continue');
  assert.equal(aborted, true);
});
