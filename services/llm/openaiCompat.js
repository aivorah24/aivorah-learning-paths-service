// Generic OpenAI-compatible chat-completions caller — native fetch, no SDK dep.
// Used for the knowledge tier's LLM, which is provider-agnostic (Groq/Gemini/
// anything else that speaks this API shape). Callers must fall back to the
// existing Groq gpt-oss-120b path on any thrown error (rate limit, no key, etc.).
const DAILY_LIMIT_RE = /tokens per day|requests per day|\btpd\b|\brpd\b|per day|quota exceeded/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses Groq/OpenAI-style "try again in 1m0.48s" / "in 12.3s" messages, since
// these providers put the real wait time there rather than Retry-After.
function parseRetryAfterMs(message) {
  const m = /try again in\s*(?:(\d+)m)?([\d.]+)s/i.exec(String(message || ''));
  if (!m) return null;
  const minutes = Number(m[1] || 0);
  const seconds = Number(m[2] || 0);
  return Math.round((minutes * 60 + seconds) * 1000);
}

// Shared retry/backoff for any LLM call path — 429 (rate limit) and the
// transient Groq 400 "json_validate_failed" (model returned empty/invalid
// JSON, usually recoverable on a plain retry). Every other error is thrown
// immediately so callers keep falling back the way they already do.
async function withLLMRetry(fn, { maxRetries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode;
      const code = err.error?.error?.code || err.code;
      const isRateLimited = status === 429;
      const isJsonValidateFailed = status === 400 && code === 'json_validate_failed';
      // A daily quota will not clear in a minute — fail now so the fallback chain moves to the next provider.
      const isDailyLimit = isRateLimited && DAILY_LIMIT_RE.test(String(err.message || err.error?.error?.message || ''));
      if (attempt >= maxRetries || isDailyLimit || !(isRateLimited || isJsonValidateFailed)) throw err;

      let delay = 500 * 2 ** attempt;
      if (isRateLimited) {
        const headerRetryAfter = Number(err.headers?.['retry-after']);
        const parsed = Number.isFinite(headerRetryAfter) && headerRetryAfter > 0
          ? headerRetryAfter * 1000
          : parseRetryAfterMs(err.message || err.error?.error?.message);
        if (parsed) delay = Math.min(parsed, 65000);
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function callLLM(prompt, { json = false, baseUrl, apiKey, model, temperature = 0.3 } = {}) {
  if (!apiKey) throw new Error('No API key configured for knowledge-tier LLM');
  if (!baseUrl) throw new Error('No base URL configured for knowledge-tier LLM');

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

  return withLLMRetry(async () => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsedBody;
      try { parsedBody = JSON.parse(text); } catch { /* not JSON */ }
      const err = new Error(`Knowledge-tier LLM request failed: ${res.status} ${text}`);
      err.status = res.status;
      err.error = parsedBody;
      err.headers = Object.fromEntries(res.headers.entries());
      throw err;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Knowledge-tier LLM response had no content');
    return content;
  });
}

module.exports = { callLLM, withLLMRetry, parseRetryAfterMs };
