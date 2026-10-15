// Test doubles for the CISCE pipeline: an in-memory Supabase, a recording
// Qdrant client, a fake fetch serving fixture pages/PDFs, and a fake embedder.
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'cisce');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

function memoryDb(seed = {}) {
  const tables = structuredClone(seed);
  const calls = [];
  const rowsOf = (t) => (tables[t] ||= []);
  function from(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let conflict = null;
    let range = null;
    const match = (r) => filters.every(([kind, col, v]) => {
      if (kind === 'eq') return r[col] === v;
      if (kind === 'neq') return r[col] !== v;
      if (kind === 'in') return v.includes(r[col]);
      if (kind === 'is') return (r[col] ?? null) === v;
      if (kind === 'not_in') return !v.includes(r[col]);
      return true;
    });
    const q = {
      select: () => q,
      upsert: (rows, opts = {}) => { op = 'upsert'; payload = rows; conflict = (opts.onConflict || 'id').split(','); return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c, v) => { filters.push(['eq', c, v]); return q; },
      neq: (c, v) => { filters.push(['neq', c, v]); return q; },
      in: (c, v) => { filters.push(['in', c, v]); return q; },
      is: (c, v) => { filters.push(['is', c, v]); return q; },
      not: (c, operator, v) => { filters.push(['not_' + operator, c, String(v).replace(/^\(|\)$/g, '').split(',')]); return q; },
      order: () => q,
      range: (a, b) => { range = [a, b]; return q; },
      then: (resolve, reject) => {
        calls.push({ table, op, rows: payload ? payload.length : 0, filters });
        const rows = rowsOf(table);
        let data = null;
        if (op === 'upsert') {
          for (const r of payload) {
            const i = rows.findIndex((x) => conflict.every((k) => x[k] === r[k]));
            if (i >= 0) rows[i] = { ...rows[i], ...r }; else rows.push({ ...r });
          }
        } else if (op === 'delete') {
          tables[table] = rows.filter((r) => !match(r));
        } else {
          data = rows.filter(match);
          if (range) data = data.slice(range[0], range[1] + 1);
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  return { from, tables, calls };
}

function memoryQdrant() {
  const collections = {};
  const calls = [];
  return {
    collections,
    calls,
    getCollections: async () => ({ collections: Object.keys(collections).map((name) => ({ name })) }),
    createCollection: async (name, cfg) => { calls.push(['createCollection', name]); collections[name] = { cfg, points: new Map() }; },
    createPayloadIndex: async (name) => { calls.push(['createPayloadIndex', name]); },
    upsert: async (name, { points }) => {
      calls.push(['upsert', name, points.length]);
      for (const p of points) collections[name].points.set(p.id, p);
    },
    delete: async (name, { filter }) => {
      calls.push(['delete', name]);
      const ok = (p, c) => p.payload[c.key] === c.match.value;
      for (const [id, p] of collections[name].points) {
        if (filter.must.every((c) => ok(p, c)) && !filter.must_not.some((c) => ok(p, c))) collections[name].points.delete(id);
      }
    },
  };
}

// Fake fetch: url → { status, body, contentType, finalUrl }. Unknown URLs 404.
function fakeFetch(routes) {
  const requests = [];
  const fn = async (url, init) => {
    requests.push({ url, headers: init?.headers || {} });
    const r = typeof routes === 'function' ? routes(url) : routes[url];
    if (r instanceof Error) throw r;
    const route = r || { status: 404, body: '<!DOCTYPE html><html>Not found</html>', contentType: 'text/html' };
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body || '');
    return {
      status: route.status || 200,
      ok: (route.status || 200) < 400,
      url: route.finalUrl || url,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? route.contentType || null : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  fn.requests = requests;
  return fn;
}

const fakeEmbed = async (text) => {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i) / 1000;
  return v;
};

module.exports = { memoryDb, memoryQdrant, fakeFetch, fakeEmbed, fixture, FIXTURES };
