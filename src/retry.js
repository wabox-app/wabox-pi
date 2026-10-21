// Generic retry with exponential backoff.
//
// Exported for tests and for building a resilient fetch wrapper.

export async function withRetry(fn, {
  maxAttempts = 3,
  initialDelayMs = 1_000,
  maxDelayMs = 30_000,
  multiplier = 2,
  shouldRetry = () => true,
  onRetry = null,
} = {}) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;

      const delay = Math.min(initialDelayMs * Math.pow(multiplier, attempt - 1), maxDelayMs);
      if (onRetry) onRetry({ attempt, delay, error: err });
      await sleep(delay);
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True for network errors (TypeError from fetch) and HTTP 5xx / 429.
export function isRetryableFetchError(err) {
  if (err instanceof TypeError) return true; // DNS, ECONNREFUSED, ETIMEOUT, etc.
  const msg = err?.message || '';
  if (/\b(5\d\d)\b/.test(msg)) return true; // 500, 502, 503, 504…
  if (/\b429\b/.test(msg)) return true;      // rate limited
  return false;
}

// Wrapper that retries the underlying fetch on transient failures.
// The returned function is signature-compatible with global fetch.
// 5xx and 429 responses are retried; 4xx responses are returned directly.
export function fetchWithRetry(fetchImpl, retryOptions = {}) {
  return async (url, init = {}) => {
    // If the caller passed an already-aborted signal, do not retry.
    if (init.signal?.aborted) {
      throw new Error('fetch aborted');
    }

    return withRetry(
      async () => {
        const res = await fetchImpl(url, init);
        if (res.status >= 500 || res.status === 429) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        return res;
      },
      {
        maxAttempts: retryOptions.maxAttempts ?? 3,
        initialDelayMs: retryOptions.initialDelayMs ?? 1_000,
        maxDelayMs: retryOptions.maxDelayMs ?? 30_000,
        multiplier: retryOptions.multiplier ?? 2,
        shouldRetry: isRetryableFetchError,
        onRetry: retryOptions.onRetry,
      },
    );
  };
}
