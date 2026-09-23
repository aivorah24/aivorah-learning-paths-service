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
