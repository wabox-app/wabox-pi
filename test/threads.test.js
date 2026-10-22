import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readThreads,
  ensureThread,
  createThread,
  setActiveThread,
  touchThread,
  updateThreadMeta,
  threadAwarePaths,
} from '../src/threads.js';

test('readThreads returns default when file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  const db = await readThreads(dir);
  assert.equal(db.activeThreadId, 'default');
  assert.equal(db.threads.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('ensureThread seeds a default thread on first call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  const { thread, db } = await ensureThread(dir, 'default');
  assert.equal(thread.id, 'default');
  assert.equal(thread.name, 'General');
  assert.equal(db.activeThreadId, 'default');
  assert.equal(db.threads.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('createThread adds a new thread without changing active', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  await ensureThread(dir, 'default');
  const { threadId, db } = await createThread(dir, { name: 'Go project', summary: 'Refactoring auth' });
  assert.ok(threadId.startsWith('thread-'));
  assert.equal(db.threads.length, 2);
  assert.equal(db.activeThreadId, 'default');
  await fs.rm(dir, { recursive: true, force: true });
});

test('setActiveThread updates the active id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  await ensureThread(dir, 'default');
  const { threadId } = await createThread(dir, { name: 'Auth' });
  const db = await setActiveThread(dir, threadId);
  assert.equal(db.activeThreadId, threadId);
  await fs.rm(dir, { recursive: true, force: true });
});

test('touchThread updates lastActiveAt and messageCount', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  await ensureThread(dir, 'default');
  const before = (await readThreads(dir)).threads[0].lastActiveAt;
  await new Promise((r) => setTimeout(r, 50)); // guarantee timestamp change
  await touchThread(dir, 'default', { messageCountDelta: 3 });
  const db = await readThreads(dir);
  assert.notEqual(db.threads[0].lastActiveAt, before);
  assert.equal(db.threads[0].messageCount, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test('updateThreadMeta patches name and summary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-th-'));
  await ensureThread(dir, 'default');
  const thread = await updateThreadMeta(dir, 'default', {
    name: 'New name',
    summary: 'New summary',
  });
  assert.equal(thread.name, 'New name');
  assert.equal(thread.summary, 'New summary');
  await fs.rm(dir, { recursive: true, force: true });
});

test('threadAwarePaths keeps workspace and changes sessions', () => {
  const paths = {
    root: '/state/conv/slug-1',
    workspace: '/state/conv/slug-1/workspace',
    sessions: '/state/conv/slug-1/sessions',
    media: '/state/conv/slug-1/media',
  };
  const threaded = threadAwarePaths(paths, 'thread-abc');
  assert.equal(threaded.workspace, paths.workspace);
  assert.equal(threaded.media, paths.media);
  assert.equal(threaded.sessions, '/state/conv/slug-1/sessions/thread-abc');
});
