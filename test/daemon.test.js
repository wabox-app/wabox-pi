import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupIdleRunners } from '../src/daemon.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function makeRunner(overrides = {}) {
  return {
    lastActive: Date.now() - (overrides.idleMs ?? 0),
    isIdle() { return overrides.idle ?? true; },
    stop() {},
    dispose: overrides.dispose ?? (() => Promise.resolve()),
  };
}

test('cleanupIdleRunners removes only idle runners past the timeout', () => {
  const runners = new Map([
    ['active', makeRunner({ idleMs: 10_000, idle: false })],
    ['fresh', makeRunner({ idleMs: 100, idle: true })],
    ['expired', makeRunner({ idleMs: 20_000, idle: true })],
  ]);

  cleanupIdleRunners(runners, { runnerIdleTimeoutMs: 5_000 }, silent);

  assert.equal(runners.has('active'), true);
  assert.equal(runners.has('fresh'), true);
  assert.equal(runners.has('expired'), false);
});

test('cleanupIdleRunners does nothing when timeout is 0 (disabled)', () => {
  const runners = new Map([
    ['expired', makeRunner({ idleMs: 1_000_000, idle: true })],
  ]);

  cleanupIdleRunners(runners, { runnerIdleTimeoutMs: 0 }, silent);

  assert.equal(runners.has('expired'), true);
});

test('cleanupIdleRunners calls dispose on removed runners', async () => {
  let disposed = false;
  const runner = makeRunner({
    idleMs: 10_000,
    idle: true,
    dispose: async () => { disposed = true; },
  });
  const runners = new Map([['slug', runner]]);

  cleanupIdleRunners(runners, { runnerIdleTimeoutMs: 5_000 }, silent);

  // dispose is async; give it a tick
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(disposed, true);
  assert.equal(runners.has('slug'), false);
});

test('cleanupIdleRunners does not remove busy runners even if idleMs is past timeout', () => {
  const runners = new Map([
    ['busy', makeRunner({ idleMs: 10_000, idle: false })],
  ]);

  cleanupIdleRunners(runners, { runnerIdleTimeoutMs: 5_000 }, silent);

  assert.equal(runners.has('busy'), true);
});

test('cleanupIdleRunners skips an exact deadline', () => {
  const runners = new Map([
    ['edge', makeRunner({ idleMs: 5_000, idle: true })],
  ]);

  cleanupIdleRunners(runners, { runnerIdleTimeoutMs: 5_000 }, silent);

  assert.equal(runners.has('edge'), true);
});
