// Polite HTTP client for cisce.org: browser User-Agent (bots get 403) and at
// most one request per minIntervalMs, however many workers call it.
const { BROWSER_UA, MIN_REQUEST_INTERVAL_MS } = require('./constants');

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createHttp({
  fetchImpl = globalThis.fetch,
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  userAgent = BROWSER_UA,
  sleep = realSleep,
  now = Date.now,
  retries = 2,
  timeoutMs = 60000,
} = {}) {
  let chain = Promise.resolve();
  let last = -Infinity;

  // Serialises request *starts* so the gap between two is never < minIntervalMs.
  function slot() {
    const turn = chain.then(async () => {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = turn.catch(() => {});
    return turn;
  }

  async function once(url) {
    await slot();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        signal: ctrl?.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
      });
      const body = Buffer.from(await res.arrayBuffer());
      return {
        url,
        status: res.status,
        ok: res.ok,
        finalUrl: res.url || url,
        contentType: (res.headers?.get?.('content-type') || '').split(';')[0].trim() || null,
        body,
      };
    } catch (err) {
      return { url, status: 0, ok: false, finalUrl: null, contentType: null, body: Buffer.alloc(0), error: err.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 429/503 and network errors back off and retry; 403/404 are final answers.
  async function get(url) {
    let res;
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await once(url);
      if (![0, 429, 502, 503, 504].includes(res.status)) return res;
      if (attempt < retries) await sleep(minIntervalMs * 2 ** (attempt + 1));
    }
    return res;
  }

  return { get };
}

module.exports = { createHttp };
