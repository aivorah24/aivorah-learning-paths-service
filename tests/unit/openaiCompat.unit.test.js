// Unit tests for the shared LLM retry/backoff path (services/llm/openaiCompat.js).
// Uses fake timers so backoff delays don't slow the suite down.
const { withLLMRetry, parseRetryAfterMs } = require('../../services/llm/openaiCompat');

describe('parseRetryAfterMs', () => {
  test('parses "try again in 1m0.48s"', () => {
    expect(parseRetryAfterMs('Rate limit reached. Please try again in 1m0.48s.')).toBe(60480);
  });
  test('parses "try again in 12.3s"', () => {
    expect(parseRetryAfterMs('try again in 12.3s')).toBe(12300);
  });
  test('returns null when no wait time is present', () => {
    expect(parseRetryAfterMs('some other error')).toBeNull();
  });
});

describe('withLLMRetry', () => {
  beforeEach(() => jest.useFakeTimers({ legacyFakeTimers: false }));
  afterEach(() => jest.useRealTimers());

  // Runs the retried call while advancing fake timers so backoff sleeps
  // resolve instantly instead of slowing the suite down.
  async function drive(promise) {
    let settled = false;
    let result;
    let error;
    promise.then((r) => { result = r; settled = true; }, (e) => { error = e; settled = true; });
    for (let i = 0; i < 20 && !settled; i++) {
      await jest.advanceTimersByTimeAsync(70000);
    }
    if (error) throw error;
    return result;
  }

  test('a 429 succeeds after retrying, honoring the "try again in Xs" wait', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('429 rate limit');
        err.status = 429;
        err.message = 'Rate limit reached. Please try again in 1.5s.';
        throw err;
      }
      return 'ok';
    });

    const result = await drive(withLLMRetry(fn));
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('a Groq 400 json_validate_failed gets one retry and then succeeds', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('400 json_validate_failed');
        err.status = 400;
        err.error = { error: { code: 'json_validate_failed' } };
        throw err;
      }
      return 'ok';
    });

    const result = await drive(withLLMRetry(fn));
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('a non-retryable error (e.g. 401) throws immediately without retrying', async () => {
    const err = new Error('401 unauthorized');
    err.status = 401;
    const fn = jest.fn(async () => { throw err; });

    await expect(drive(withLLMRetry(fn))).rejects.toThrow('401 unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('gives up after maxRetries and rethrows the last error', async () => {
    const err = new Error('429 rate limit');
    err.status = 429;
    const fn = jest.fn(async () => { throw err; });

    await expect(drive(withLLMRetry(fn, { maxRetries: 2 }))).rejects.toThrow('429 rate limit');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('a daily-limit 429 throws at once so the fallback chain can move on', async () => {
    const err = new Error('429 Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199999');
    err.status = 429;
    const fn = jest.fn(async () => { throw err; });

    await expect(drive(withLLMRetry(fn))).rejects.toThrow('tokens per day');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
