import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore, jobName, storedTask } from '../src/tasks.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('jobName derives a short slug from the prompt and de-duplicates', () => {
  assert.equal(jobName('Lembrar de tomar o remédio'), 'lembrar-de-tomar');
  assert.equal(jobName('   '), 'job');
  assert.equal(jobName('a b c d e'), 'a-b-c');
  assert.equal(jobName('Lembrar de tomar', new Set(['lembrar-de-tomar'])), 'lembrar-de-tomar-2');
});

test('storedTask keeps only persistable fields and marks the source', () => {
  const stored = storedTask({
    name: 'x',
    slug: 's',
    to: '1@lid',
    cron: '0 9 * * *',
    timezone: 'UTC',
    prompt: 'oi',
    enabled: true,
    parsed: { sets: {} },
    error: 'nope',
  });
  assert.deepEqual(stored, {
    name: 'x',
    slug: 's',
    to: '1@lid',
    participant: null,
    cron: '0 9 * * *',
    timezone: 'UTC',
    prompt: 'oi',
    enabled: true,
    silent: false,
    source: 'chat',
  });
});

test('TaskStore persists, reloads, and removes chat jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-jobs-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskStore({ file, log: silent, timezone: 'UTC' });
  await store.load();
  assert.equal(store.tasks.length, 0);

  await store.add({
    name: 'water',
    slug: 's',
    to: '1@lid',
    participant: null,
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'regar',
    enabled: true,
    silent: false,
    source: 'chat',
  });
  const normalized = store.normalized();
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name, 'water');
  assert.equal(normalized[0].source, 'chat');
  assert.equal(normalized[0].error, null);

  const reloaded = new TaskStore({ file, log: silent, timezone: 'UTC' });
  await reloaded.load();
  assert.equal(reloaded.tasks.length, 1);
  assert.equal(reloaded.has('water'), true);
  assert.equal(await reloaded.remove('water'), true);
  assert.equal(await reloaded.remove('water'), false);
  assert.equal(reloaded.tasks.length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test('TaskStore.normalized surfaces an invalid stored job as an error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-jobs-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskStore({ file, log: silent, timezone: 'UTC' });
  await store.load();
  await store.add({ name: 'bad', to: '1@lid', cron: 'nope', prompt: 'x', enabled: true });
  const [task] = store.normalized();
  assert.match(task.error, /fields|range/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('TaskStore.load tolerates a missing and a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-jobs-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskStore({ file, log: silent, timezone: 'UTC' });
  await store.load();
  assert.deepEqual(store.tasks, []);

  await fs.writeFile(file, '{ not json');
  const broken = new TaskStore({ file, log: silent, timezone: 'UTC' });
  await broken.load();
  assert.deepEqual(broken.tasks, []);
  await fs.rm(dir, { recursive: true, force: true });
});
