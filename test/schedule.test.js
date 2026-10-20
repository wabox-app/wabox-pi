import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatJobs, normalizeTasks, Scheduler } from '../src/schedule.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('normalizeTasks fills defaults and parses cron', () => {
  const [task] = normalizeTasks(
    [{ name: 'brief', slug: 'chat-1', cron: '0 8 * * *', prompt: 'Morning.' }],
    { timezone: 'America/Sao_Paulo' },
  );
  assert.equal(task.name, 'brief');
  assert.equal(task.enabled, true);
  assert.equal(task.timezone, 'America/Sao_Paulo');
  assert.ok(task.parsed);
  assert.equal(task.error, null);
});

test('normalizeTasks reports missing fields as errors, not throws', () => {
  const tasks = normalizeTasks(
    [
      { name: 'no-cron', slug: 'a', prompt: 'x' },
      { name: 'no-target', cron: '* * * * *', prompt: 'x' },
      { name: 'bad-cron', slug: 'a', cron: '99 * * * *', prompt: 'x' },
      { name: 'bad-tz', slug: 'a', cron: '* * * * *', prompt: 'x', timezone: 'Mars/Olympus' },
    ],
    {},
  );
  assert.match(tasks[0].error, /cron/);
  assert.match(tasks[1].error, /slug|to/);
  assert.match(tasks[2].error, /range/);
  assert.match(tasks[3].error, /timezone/);
});

test('normalizeTasks accepts an explicit target JID', () => {
  const [task] = normalizeTasks([{ name: 'x', to: '123@lid', cron: '* * * * *', prompt: 'x' }]);
  assert.equal(task.to, '123@lid');
  assert.equal(task.error, null);
});

test('normalizeTasks reads the silent flag', () => {
  const [plain] = normalizeTasks([{ name: 'a', to: '1@lid', cron: '* * * * *', prompt: 'x' }]);
  const [silent] = normalizeTasks([
    { name: 'b', to: '1@lid', cron: '* * * * *', prompt: 'x', silent: true },
  ]);
  assert.equal(plain.silent, false);
  assert.equal(silent.silent, true);
});

test('normalizeTasks rejects duplicate names', () => {
  assert.throws(
    () =>
      normalizeTasks([
        { name: 'dup', to: '1@lid', cron: '* * * * *', prompt: 'x' },
        { name: 'dup', to: '2@lid', cron: '* * * * *', prompt: 'y' },
      ]),
    /duplicate/,
  );
});

async function schedulerFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-sched-'));
  const stateFile = path.join(dir, 'scheduler.json');
  const fired = [];
  const tasks = normalizeTasks([
    { name: 'tick', to: '1@lid', cron: '0 8 * * *', prompt: 'x', timezone: 'America/Sao_Paulo' },
    { name: 'off', to: '1@lid', cron: '0 8 * * *', prompt: 'x', timezone: 'America/Sao_Paulo', enabled: false },
  ]);
  const scheduler = new Scheduler({
    tasks,
    log: silent,
    stateFile,
    onFire: async (task) => fired.push(task.name),
  });
  return { dir, stateFile, fired, scheduler };
}

test('Scheduler fires a due task once per minute', async () => {
  const { fired, scheduler, dir } = await schedulerFixture();
  const at = new Date('2026-10-20T11:00:30Z'); // 08:00 São Paulo, Tuesday
  await scheduler.tick(at);
  await scheduler.tick(new Date('2026-10-20T11:00:50Z')); // same minute
  await scheduler.tick(new Date('2026-10-20T11:01:00Z')); // different minute, not matching
  assert.deepEqual(fired, ['tick']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Scheduler respects enabled: false', async () => {
  const { fired, scheduler, dir } = await schedulerFixture();
  await scheduler.tick(new Date('2026-10-20T11:00:00Z'));
  assert.ok(!fired.includes('off'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('Scheduler persists the last run and does not refire after a restart', async () => {
  const { fired, scheduler, stateFile, dir } = await schedulerFixture();
  const at = new Date('2026-10-20T11:00:00Z');
  await scheduler.tick(at);
  assert.deepEqual(fired, ['tick']);

  const restarted = new Scheduler({
    tasks: scheduler.tasks,
    log: silent,
    stateFile,
    onFire: async (task) => fired.push(`restart:${task.name}`),
  });
  await restarted.loadState();
  await restarted.tick(at); // same minute -> guarded
  assert.deepEqual(fired, ['tick']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Scheduler keeps invalid tasks out of the run list', async () => {
  const { scheduler, dir } = await schedulerFixture();
  assert.deepEqual(
    scheduler.tasks.map((t) => t.name),
    ['tick', 'off'],
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('Scheduler.setTasks replaces the list at runtime', async () => {
  const { scheduler, dir, fired } = await schedulerFixture();
  const extra = normalizeTasks(
    [{ name: 'late', to: '1@lid', cron: '0 8 * * *', prompt: 'x', timezone: 'America/Sao_Paulo' }],
    {},
  );
  scheduler.setTasks([...scheduler.tasks, ...extra]);
  await scheduler.tick(new Date('2026-10-20T11:00:00Z'));
  assert.ok(fired.includes('late'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('formatJobs lists enabled, invalid, and chat-sourced jobs', () => {
  const tasks = normalizeTasks(
    [
      { name: 'brief', slug: 'chat-1', cron: '0 8 * * *', prompt: 'x', timezone: 'UTC' },
      { name: 'bad', slug: 'chat-1', cron: 'nope', prompt: 'x', timezone: 'UTC' },
      { name: 'made-up', slug: 'chat-2', cron: '0 9 * * *', prompt: 'x', timezone: 'UTC', source: 'chat' },
    ],
    {},
  );
  const text = formatJobs(tasks, { slug: 'chat-1', now: new Date('2026-10-20T08:00:00Z') });
  assert.match(text, /1\. brief \(this chat\)/);
  assert.match(text, /2\. bad.*invalid/);
  assert.match(text, /3\. made-up.*\(chat\)/);
});

test('formatJobs handles an empty list', () => {
  assert.equal(formatJobs([], {}), 'No scheduled jobs.');
});
