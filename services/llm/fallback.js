// Shared provider-fallback chain for ALL LLM generation call sites in this
// service (enrichment.js, aiGeneration.js, gradeFit.js, routes/ibpyp.js).
// Chain is env-configured (LLM_CHAIN, "provider:model,provider:model,...");
// entries with no key configured are skipped. See callWithFallback().
const { callLLM, parseRetryAfterMs } = require('./openaiCompat');

const PROVIDER_REGISTRY = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
  // Back-compat: generic OpenAI-compatible endpoint via KNOWLEDGE_LLM_* env.
  custom: { baseUrl: null, keyEnv: 'KNOWLEDGE_LLM_API_KEY' },
};

// Gemini sits before the small Groq models: those often return empty JSON on the long prompts used here.
const DEFAULT_CHAIN = 'groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b,gemini:gemini-flash-lite-latest,gemini:gemini-3-flash-preview,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b';
const LONG_COOLDOWN_MS = 15 * 60 * 1000;
// A server overload (503) or dropped connection usually clears quickly: bench that model briefly, not for 15 minutes.
const SHORT_COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT_RE = /tokens per day|requests per day|\btpd\b|\brpd\b/i;

class LLMUnavailableError extends Error {}

// key "provider:model" -> cooldown-until timestamp (ms epoch).
const cooldowns = new Map();
// key "provider:model" -> disabled for process lifetime (401/403).
const disabledForever = new Set();

// Test-only: clears in-memory state between cases.
function resetFallbackState() {
  cooldowns.clear();
  disabledForever.clear();
}

function parseChain() {
  const raw = process.env.LLM_CHAIN || DEFAULT_CHAIN;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return { provider: entry.slice(0, idx).trim(), model: entry.slice(idx + 1).trim() };
    })
    .filter((e) => e.provider && e.model);
}

function resolveProviderConfig(provider) {
  const reg = PROVIDER_REGISTRY[provider];
  if (!reg) return null;
  const baseUrl = provider === 'custom' ? process.env.KNOWLEDGE_LLM_BASE_URL : reg.baseUrl;
  const apiKey = process.env[reg.keyEnv];
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

function retryAfterMsOf(err) {
  const headerVal = Number(err.headers?.['retry-after']);
  if (Number.isFinite(headerVal) && headerVal > 0) return headerVal * 1000;
  return parseRetryAfterMs(err.message || err.error?.error?.message);
}

// Classifies a failed call so callWithFallback knows whether to retry the
// SAME entry once, or move on (with/without a cooldown).
function classifyError(err) {
  const status = err.status || err.statusCode;
  if (status === 401 || status === 403) return { type: 'auth' };
  const code = err.error?.error?.code || err.code;
  if (status === 400 && code === 'json_validate_failed') return { type: 'json_validate_failed' };
  if (status === 429) {
    const retryMs = retryAfterMsOf(err);
    const msg = String(err.message || err.error?.error?.message || '');
    if (DAILY_LIMIT_RE.test(msg) || (retryMs != null && retryMs > 60000)) {
      return { type: 'long', cooldownMs: retryMs || LONG_COOLDOWN_MS };
    }
    return { type: 'short429', delayMs: retryMs || 1000 };
  }
  if (status >= 500 || status == null) return { type: 'serverOrNetwork', cooldownMs: SHORT_COOLDOWN_MS };
  return { type: 'other' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry inside the SAME provider:model — only for a short rate-limit or
// a transient bad-JSON response. Anything else (or a second failure) throws
// so the outer loop can classify and move to the next chain entry.
async function callEntryWithOneRetry(cfg, model, prompt, opts) {
  try {
    return await callLLM(prompt, { ...opts, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
  } catch (err) {
    const c = classifyError(err);
    if (c.type === 'short429' || c.type === 'json_validate_failed') {
      await sleep(c.delayMs || 500);
      return await callLLM(prompt, { ...opts, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
    }
    throw err;
  }
}

/**
 * Runs `prompt` through the configured LLM_CHAIN, provider by provider,
 * skipping entries with no key / on cooldown / permanently disabled.
 * Never logs API keys. Throws LLMUnavailableError only if every entry fails.
 */
async function callWithFallback(prompt, { json = false, temperature } = {}) {
  const chain = parseChain();
  const attempts = [];

  for (const { provider, model } of chain) {
    const key = `${provider}:${model}`;
    if (disabledForever.has(key)) continue;
    const cooldownUntil = cooldowns.get(key);
    if (cooldownUntil && cooldownUntil > Date.now()) continue;

    const cfg = resolveProviderConfig(provider);
    if (!cfg) continue; // missing key — silently skipped

    try {
      const content = await callEntryWithOneRetry(cfg, model, prompt, { json, temperature });
      cooldowns.delete(key);
      return content;
    } catch (err) {
      const c = classifyError(err);
      console.error(`[llm] fallover ${key} -> ${c.type} (${err.status || err.statusCode || '-'}: ${String(err.message || '').slice(0, 160)})`);
      if (c.type === 'auth') disabledForever.add(key);
      else if (c.type === 'long' || c.type === 'serverOrNetwork') cooldowns.set(key, Date.now() + (c.cooldownMs || LONG_COOLDOWN_MS));
      attempts.push(`${key}: ${c.type}`);
    }
  }

  throw new LLMUnavailableError(`All LLM providers exhausted: ${attempts.join('; ') || 'no configured provider had a key'}`);
}

module.exports = { callWithFallback, LLMUnavailableError, resetFallbackState, parseChain };
