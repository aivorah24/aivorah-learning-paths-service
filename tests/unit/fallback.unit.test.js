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

test('gemini is a provider: called at its OpenAI-compatible endpoint with GEMINI_API_KEY', async () => {
  process.env.LLM_CHAIN = 'gemini:gemini-3-flash-preview';
  process.env.GEMINI_API_KEY = 'gem-key';
  global.fetch.mockResolvedValueOnce(okResponse('{"ok":true}'));

  await expect(callWithFallback('prompt', { json: true })).resolves.toBe('{"ok":true}');
  const [url, req] = global.fetch.mock.calls[0];
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  expect(req.headers.Authorization).toBe('Bearer gem-key');
  expect(JSON.parse(req.body).model).toBe('gemini-3-flash-preview');
});

test('the default chain tries Gemini before the small Groq models', () => {
  delete process.env.LLM_CHAIN;
  const chain = require('../../services/llm/fallback').parseChain().map((e) => `${e.provider}:${e.model}`);
  expect(chain.indexOf('gemini:gemini-flash-lite-latest')).toBeGreaterThan(chain.indexOf('groq:openai/gpt-oss-120b'));
  expect(chain.indexOf('gemini:gemini-flash-lite-latest')).toBeLessThan(chain.indexOf('groq:openai/gpt-oss-20b'));
});

test('a server overload (503) benches that model for about a minute, not 15', async () => {
  const now = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
  global.fetch
    .mockResolvedValueOnce(errResponse(503, '{"error":{"message":"The model is overloaded"}}'))
    .mockResolvedValueOnce(okResponse('from b'))
    .mockResolvedValueOnce(okResponse('from b again'))
    .mockResolvedValueOnce(okResponse('from a'));
  await expect(callWithFallback('p')).resolves.toBe('from b');
  await expect(callWithFallback('p')).resolves.toBe('from b again'); // a still benched
  spy.mockReturnValue(now + 61 * 1000);
  await expect(callWithFallback('p')).resolves.toBe('from a'); // back after a minute
  spy.mockRestore();
});
