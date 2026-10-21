import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, fetchWithRetry, sleep, isRetryableFetchError } from '../src/retry.js';

test('withRetry succeeds on first attempt', async () => {
  const fn = async () => 'ok';
  const result = await withRetry(fn, { maxAttempts: 3 });
  assert.equal(result, 'ok');
});

test('withRetry retries on transient failure then succeeds', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('network');
    return 'ok';
  };
  const result = await withRetry(fn, { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 100 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('withRetry throws after exhausting attempts', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts += 1;
    throw new TypeError('network');
  };
  await assert.rejects(
    withRetry(fn, { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 50 }),
    /network/,
  );
  assert.equal(attempts, 2);
});

test('withRetry does not retry non-retryable errors', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts += 1;
    throw new Error('fatal');
  };
  const shouldRetry = (err) => err.message !== 'fatal';
  await assert.rejects(
    withRetry(fn, { maxAttempts: 3, initialDelayMs: 5, shouldRetry }),
    /fatal/,
  );
  assert.equal(attempts, 1);
});

test('withRetry calls onRetry before each retry', async () => {
  const retries = [];
  let attempts = 0;
  const fn = async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('boom');
    return 'ok';
  };
  await withRetry(fn, {
    maxAttempts: 3,
    initialDelayMs: 5,
    maxDelayMs: 50,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(retries.length, 2);
  assert.ok(retries[0].attempt >= 1);
  assert.ok(retries[0].delay >= 5);
});

test('withRetry respects maxDelayMs cap', async () => {
  const delays = [];
  let attempts = 0;
  const fn = async () => {
    attempts += 1;
    throw new TypeError('boom');
  };
  try {
    await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 150,
      multiplier: 10,
      onRetry: (info) => delays.push(info.delay),
    });
  } catch {}
  assert.ok(delays.every((d) => d <= 150));
});

test('fetchWithRetry returns ok response directly', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => 'hi' });
  const wrapped = fetchWithRetry(fakeFetch);
  const res = await wrapped('http://example.com');
  assert.equal(res.status, 200);
});

test('fetchWithRetry retries on TypeError (network)', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('ECONNREFUSED');
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const wrapped = fetchWithRetry(fakeFetch, { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 50 });
  const res = await wrapped('http://example.com');
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test('fetchWithRetry retries on 5xx and 429', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    const status = calls === 1 ? 503 : calls === 2 ? 429 : 200;
    return { ok: status === 200, status, text: async () => `err ${status}` };
  };
  const wrapped = fetchWithRetry(fakeFetch, { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 50 });
  const res = await wrapped('http://example.com');
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test('fetchWithRetry does not retry 4xx', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 403, text: async () => 'forbidden' };
  };
  const wrapped = fetchWithRetry(fakeFetch, { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 50 });
  const res = await wrapped('http://example.com');
  assert.equal(res.status, 403);
  assert.equal(calls, 1);
});

test('fetchWithRetry does not retry when signal already aborted', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: true, status: 200 };
  };
  const controller = new AbortController();
  controller.abort();
  const wrapped = fetchWithRetry(fakeFetch);
  await assert.rejects(wrapped('http://example.com', { signal: controller.signal }), /aborted/);
  assert.equal(calls, 0);
});

test('isRetryableFetchError detects TypeError', () => {
  assert.equal(isRetryableFetchError(new TypeError('net')), true);
});

test('isRetryableFetchError detects 5xx in message', () => {
  assert.equal(isRetryableFetchError(new Error('HTTP 503: busy')), true);
  assert.equal(isRetryableFetchError(new Error('HTTP 502: bad gateway')), true);
});

test('isRetryableFetchError detects 429 in message', () => {
  assert.equal(isRetryableFetchError(new Error('HTTP 429: rate limited')), true);
});

test('isRetryableFetchError rejects 4xx and generic errors', () => {
  assert.equal(isRetryableFetchError(new Error('HTTP 403: forbidden')), false);
  assert.equal(isRetryableFetchError(new Error('something else')), false);
});

test('sleep resolves after the given ms', async () => {
  const t0 = Date.now();
  await sleep(50);
  assert.ok(Date.now() - t0 >= 45);
});
