// Unit tests for services/llm/fallback.js — callWithFallback's provider
// chain, cooldown and disable behaviour. fetch is mocked; no real network call.
const { callWithFallback, LLMUnavailableError, resetFallbackState } = require('../../services/llm/fallback');

function okResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}
function errResponse(status, body, headers) {
  return { ok: false, status, text: async () => body, headers: new Map(Object.entries(headers || [])) };
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  resetFallbackState();
  jest.resetAllMocks();
  global.fetch = jest.fn();
  process.env = {
    ...ORIGINAL_ENV,
    LLM_CHAIN: 'groq:model-a,cerebras:model-b',
    GROQ_API_KEY: 'groq-key',
    CEREBRAS_API_KEY: 'cerebras-key',
  };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NVIDIA_API_KEY;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
  delete global.fetch;
});

test('primary provider succeeds — used directly, no fallover', async () => {
  global.fetch.mockResolvedValueOnce(okResponse('hello'));
  const result = await callWithFallback('prompt');
  expect(result).toBe('hello');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('primary daily-limit error falls over to the second provider, and the first is skipped on the next call (cooldown)', async () => {
  global.fetch.mockResolvedValueOnce(errResponse(429, 'You have exceeded your requests per day limit'));
  global.fetch.mockResolvedValueOnce(okResponse('from-b'));

  const result = await callWithFallback('prompt');
  expect(result).toBe('from-b');
  expect(global.fetch).toHaveBeenCalledTimes(2);

  global.fetch.mockClear();
  global.fetch.mockResolvedValueOnce(okResponse('from-b-again'));
  const second = await callWithFallback('prompt');
  expect(second).toBe('from-b-again');
  // Only ONE call this time — model-a was skipped because it's cooling down.
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('401 disables a provider for the process — never retried again', async () => {
  global.fetch.mockResolvedValueOnce(errResponse(401, 'invalid api key'));
  global.fetch.mockResolvedValueOnce(okResponse('from-b'));

  await callWithFallback('prompt');

  global.fetch.mockClear();
  global.fetch.mockResolvedValueOnce(okResponse('from-b-2'));
  await callWithFallback('prompt');
  expect(global.fetch).toHaveBeenCalledTimes(1); // model-a never called again
});

test('every entry failing throws a typed LLMUnavailableError', async () => {
  global.fetch.mockResolvedValue(errResponse(500, 'server error'));
  await expect(callWithFallback('prompt')).rejects.toBeInstanceOf(LLMUnavailableError);
});

test('a 400 json_validate_failed retries once on the same entry, then falls over on a second failure', async () => {
  global.fetch.mockResolvedValueOnce(errResponse(400, JSON.stringify({ error: { code: 'json_validate_failed' } })));
  global.fetch.mockResolvedValueOnce(errResponse(400, JSON.stringify({ error: { code: 'json_validate_failed' } })));
  global.fetch.mockResolvedValueOnce(okResponse('from-b'));

  const result = await callWithFallback('prompt');
  expect(result).toBe('from-b');
  expect(global.fetch).toHaveBeenCalledTimes(3); // 2 attempts on model-a + 1 on model-b
});

test('an entry with no API key configured is skipped silently', async () => {
  process.env.LLM_CHAIN = 'openrouter:model-c,groq:model-a';
  global.fetch.mockResolvedValueOnce(okResponse('from-groq'));

  const result = await callWithFallback('prompt');
  expect(result).toBe('from-groq');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

describe('short-429 handling and per-task routing', () => {
  const shortRateLimit = () => errResponse(429, 'Rate limit reached. Please try again in 2s.');

  test('short 429 falls over to a free entry immediately, without sleeping', async () => {
    jest.useFakeTimers();
    try {
      global.fetch.mockResolvedValueOnce(shortRateLimit());
      global.fetch.mockResolvedValueOnce(okResponse('from-b'));
      // Resolves without advancing timers => no sleep happened.
      await expect(callWithFallback('prompt')).resolves.toBe('from-b');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('sleeps only when every entry is cooling down, then retries', async () => {
    jest.useFakeTimers();
    try {
      global.fetch.mockResolvedValueOnce(shortRateLimit());
      global.fetch.mockResolvedValueOnce(shortRateLimit());
      global.fetch.mockResolvedValueOnce(okResponse('after-wait'));
      const pending = callWithFallback('prompt');
      await jest.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toBe('after-wait');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps waiting across several rate-limit rounds instead of giving up after one', async () => {
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 6; i++) global.fetch.mockResolvedValueOnce(shortRateLimit());
      global.fetch.mockResolvedValueOnce(okResponse('eventually'));
      const pending = callWithFallback('prompt');
      await jest.advanceTimersByTimeAsync(20000);
      await expect(pending).resolves.toBe('eventually');
    } finally {
      jest.useRealTimers();
    }
  });

  test('error says rate-limited, not "no key", when keyed models are only cooling', async () => {
    jest.useFakeTimers();
    process.env.LLM_WAIT_BUDGET_MS = '0';
    try {
      global.fetch.mockResolvedValue(shortRateLimit());
      const pending = callWithFallback('prompt');
      const assertion = expect(pending).rejects.toThrow(/short429|rate-limited/);
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  test('per-task chain env selects the model for that task, falling back to LLM_CHAIN', async () => {
    process.env.LLM_CHAIN_COMPANIONS = 'groq:qwen-x';
    process.env.LLM_CHAIN_JUDGE = 'groq:judge-x';
    global.fetch.mockResolvedValue(okResponse('ok'));
    const lastBody = () => JSON.parse(global.fetch.mock.calls[global.fetch.mock.calls.length - 1][1].body);

    await callWithFallback('p', { task: 'companions' });
    expect(lastBody().model).toBe('qwen-x');
    await callWithFallback('p', { task: 'judge' });
    expect(lastBody().model).toBe('judge-x');
    await callWithFallback('p', { task: 'content' }); // no LLM_CHAIN_CONTENT -> LLM_CHAIN
    expect(lastBody().model).toBe('model-a');
    expect(lastBody().max_tokens).toBeGreaterThan(0);
  });

  test('default routing: worked example and judge start on qwen with its output cap; companions avoid it', async () => {
    delete process.env.LLM_CHAIN;
    global.fetch.mockResolvedValue(okResponse('ok'));
    const lastBody = () => JSON.parse(global.fetch.mock.calls[global.fetch.mock.calls.length - 1][1].body);

    await callWithFallback('p', { task: 'workedExample' });
    expect(lastBody().model).toBe('qwen/qwen3.8-27b');
    expect(lastBody().max_tokens).toBe(900);
    await callWithFallback('p', { task: 'companions' });
    expect(lastBody().model).toBe('openai/gpt-oss-20b');
    expect(lastBody().max_tokens).toBe(4000);
    await callWithFallback('p', { task: 'content' });
    expect(lastBody().model).toBe('openai/gpt-oss-120b');
  });
});
