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
  // Back-compat: generic OpenAI-compatible endpoint via KNOWLEDGE_LLM_* env.
  custom: { baseUrl: null, keyEnv: 'KNOWLEDGE_LLM_API_KEY' },
};

const DEFAULT_CHAIN = 'groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b';
const LONG_COOLDOWN_MS = 15 * 60 * 1000;
const waitBudgetMs = () => (process.env.LLM_WAIT_BUDGET_MS !== undefined ? Number(process.env.LLM_WAIT_BUDGET_MS) : 180000);
const DAILY_LIMIT_RE = /tokens per day|requests per day|\btpd\b|\brpd\b/i;

// Per-task model routing — each Groq model has its own TPM/TPD budget, so
// spreading tasks across models raises overall throughput. Each still falls
// back through a full chain. Override per-task via LLM_CHAIN_CONTENT /
// LLM_CHAIN_COMPANIONS / LLM_CHAIN_WORKED_EXAMPLE / LLM_CHAIN_JUDGE, else
// LLM_CHAIN, else these defaults. qwen only gets the small-output tasks: on
// Groq's free tier it is capped at 1000 output tokens/min (see MODEL_MAX_OUTPUT).
const TASK_ENV = { content: 'LLM_CHAIN_CONTENT', companions: 'LLM_CHAIN_COMPANIONS', workedExample: 'LLM_CHAIN_WORKED_EXAMPLE', judge: 'LLM_CHAIN_JUDGE' };
const TASK_DEFAULT_CHAIN = {
  content: 'groq:openai/gpt-oss-120b,cerebras:gpt-oss-120b,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b',
  companions: 'groq:openai/gpt-oss-20b,cerebras:gpt-oss-120b,groq:openai/gpt-oss-120b',
  workedExample: 'groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-20b,cerebras:gpt-oss-120b,groq:openai/gpt-oss-120b',
  judge: 'groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-20b,cerebras:gpt-oss-120b,groq:openai/gpt-oss-120b',
};
// Per-task completion cap (includes gpt-oss reasoning tokens — too low truncates the JSON).
const TASK_MAX_TOKENS = { content: 4500, companions: 4000, workedExample: 2000, judge: 2000 };
// Groq free-tier qwen rejects a request whose max_tokens exceeds its 1000 OTPM.
const MODEL_MAX_OUTPUT = { 'qwen/qwen3.8-27b': 900 };

class LLMUnavailableError extends Error {}

// key "provider:model" -> cooldown-until timestamp (ms epoch).
const cooldowns = new Map();
// key "provider:model" -> 'short' (429 with brief retry-after) | 'long' (daily
// limit / 5xx / network) — only 'short' cooldowns are worth a bounded wait-retry.
const cooldownKind = new Map();
// key "provider:model" -> disabled for process lifetime (401/403).
const disabledForever = new Set();

// Test-only: clears in-memory state between cases.
function resetFallbackState() {
  cooldowns.clear();
  cooldownKind.clear();
  disabledForever.clear();
}

function parseChain(task) {
  const envName = task && TASK_ENV[task];
  const raw = (envName && process.env[envName]) || process.env.LLM_CHAIN || (task && TASK_DEFAULT_CHAIN[task]) || DEFAULT_CHAIN;
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
  if (status >= 500 || status == null) return { type: 'serverOrNetwork' };
  return { type: 'other' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry inside the SAME provider:model — only for a transient bad-JSON
// response. A 429 is never retried in place — it falls over to the next
// chain entry immediately (see callWithFallback) rather than sleeping here.
async function callEntryWithOneRetry(cfg, model, prompt, opts) {
  try {
    return await callLLM(prompt, { ...opts, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
  } catch (err) {
    const c = classifyError(err);
    if (c.type === 'json_validate_failed') {
      await sleep(c.delayMs || 500);
      return await callLLM(prompt, { ...opts, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
    }
    throw err;
  }
}

// One pass over the chain, skipping disabled/cooling/keyless entries, trying
// every other entry in order. Never sleeps.
async function attemptChain(chain, prompt, opts) {
  const attempts = [];
  for (const { provider, model } of chain) {
    const key = `${provider}:${model}`;
    if (disabledForever.has(key)) continue;
    const cooldownUntil = cooldowns.get(key);
    if (cooldownUntil && cooldownUntil > Date.now()) continue;

    const cfg = resolveProviderConfig(provider);
    if (!cfg) continue; // missing key — silently skipped

    try {
      const cap = MODEL_MAX_OUTPUT[model];
      const entryOpts = cap && opts.maxTokens ? { ...opts, maxTokens: Math.min(opts.maxTokens, cap) } : opts;
      const content = await callEntryWithOneRetry(cfg, model, prompt, entryOpts);
      cooldowns.delete(key);
      cooldownKind.delete(key);
      return { ok: true, content };
    } catch (err) {
      const c = classifyError(err);
      console.error(`[llm] fallover ${key} -> ${c.type}`);
      if (c.type === 'auth') {
        disabledForever.add(key);
      } else if (c.type === 'long' || c.type === 'serverOrNetwork') {
        cooldowns.set(key, Date.now() + (c.cooldownMs || LONG_COOLDOWN_MS));
        cooldownKind.set(key, 'long');
      } else if (c.type === 'short429') {
        cooldowns.set(key, Date.now() + (c.delayMs || 1000));
        cooldownKind.set(key, 'short');
      }
      attempts.push(`${key}: ${c.type}`);
    }
  }
  return { ok: false, attempts };
}

// Every currently-cooling, non-disabled, keyed chain entry is on a SHORT
// (429 retry-after) cooldown — i.e. nothing failed for a real reason, the
// whole chain is just momentarily rate-limited. Only then is a bounded wait
// worth it; a 'long' (daily-limit/5xx) cooldown means don't wait, just exhaust.
function allCoolingDownShort(chain) {
  const now = Date.now();
  let sawCoolingEntry = false;
  let minWait = Infinity;
  for (const { provider, model } of chain) {
    const key = `${provider}:${model}`;
    if (disabledForever.has(key)) continue;
    if (!resolveProviderConfig(provider)) continue;
    const until = cooldowns.get(key);
    if (!until || until <= now) return { wait: false };
    if (cooldownKind.get(key) !== 'short') return { wait: false };
    sawCoolingEntry = true;
    minWait = Math.min(minWait, until - now);
  }
  return sawCoolingEntry ? { wait: true, minWait } : { wait: false };
}

/**
 * Runs `prompt` through the configured LLM_CHAIN (or the per-`task` chain —
 * see TASK_DEFAULT_CHAIN), provider by provider, skipping entries with no
 * key / on cooldown / permanently disabled. A short 429 falls over to the
 * next free entry immediately; only when EVERY entry is short-cooling does
 * this sleep, for the smallest remaining cooldown, then retries once.
 * Never logs API keys. Throws LLMUnavailableError only if every entry fails.
 */
async function callWithFallback(prompt, { json = false, temperature, task, maxTokens } = {}) {
  const chain = parseChain(task);
  // maxRetries 0: the chain itself handles 429s (fall over / bounded wait), not a per-call sleep loop.
  const opts = { json, temperature, maxTokens: maxTokens || TASK_MAX_TOKENS[task], maxRetries: 0 };

  let result = await attemptChain(chain, prompt, opts);
  if (result.ok) return result.content;

  // Whole chain briefly rate-limited: wait out the shortest cooldown and retry, bounded by LLM_WAIT_BUDGET_MS.
  const deadline = Date.now() + waitBudgetMs();
  let lastAttempts = result.attempts;
  for (;;) {
    const { wait, minWait } = allCoolingDownShort(chain);
    if (!wait || Date.now() + minWait > deadline) break;
    await sleep(minWait + 250);
    result = await attemptChain(chain, prompt, opts);
    if (result.ok) return result.content;
    if (result.attempts.length) lastAttempts = result.attempts;
  }

  const detail = lastAttempts.join('; ') || (wait_state(chain) ? 'all models rate-limited, retry shortly' : 'no configured provider had a key');
  throw new LLMUnavailableError(`All LLM providers exhausted: ${detail}`);
}

// True when at least one keyed, non-disabled entry exists (so "no key" would be a wrong diagnosis).
function wait_state(chain) {
  return chain.some(({ provider, model }) => !disabledForever.has(`${provider}:${model}`) && resolveProviderConfig(provider));
}

module.exports = { callWithFallback, LLMUnavailableError, resetFallbackState, parseChain };
