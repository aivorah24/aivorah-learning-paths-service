#!/usr/bin/env node
/**
 * Official Cambridge syllabus ingestion (IGCSE + AS & A Level).
 *
 *   node scripts/cambridge-ingest.cjs --dry-run            parse, print chapter/topic counts
 *   node scripts/cambridge-ingest.cjs --only 0625,9702     limit to syllabus codes
 *   node scripts/cambridge-ingest.cjs --target dev,test    write to Supabase (Management API)
 *
 * Sources: data/cambridge/sources.txt — STAGE|Subject|code|label|file (from the
 * official syllabus pages on cambridgeinternational.org). Chapters are the
 * numbered topics of the "Subject content" section ("1 Motion, forces and
 * energy"), topics their sub-topics ("1.1 Physical quantities…"). Outline only:
 * PDFs stay in the local cache and are never stored or published.
 * Needs poppler's pdftotext on PATH; SUPABASE_ACCESS_TOKEN/DEV_REF/TEST_REF
 * from ../aivorah-db/.env for --target.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cambridge-cache');
const BASE = 'https://www.cambridgeinternational.org/Images/';
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run');
const only = (arg('--only') || '').split(',').filter(Boolean);
const targets = (arg('--target') || '').split(',').filter(Boolean);
const STAGES = { IGCSE: { label: 'IGCSE', grades: [9, 10] }, ASAL: { label: 'AS & A Level', grades: [11, 12] } };

function loadEnv() {
  const f = path.join(ROOT, '..', 'aivorah-db', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function sources() {
  return fs.readFileSync(path.join(ROOT, 'data', 'cambridge', 'sources.txt'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const [stage, subject, code, label, file] = l.split('|');
    const years = (label.match(/\d{4}/g) || []).map(Number);
    return { stage, subject, code, label, url: BASE + file, file, year_from: years[0], year_to: years[years.length - 1] || years[0] };
  }).filter((s) => !only.length || only.includes(s.code));
}

async function download(s) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, s.file);
  if (!fs.existsSync(f)) {
    const res = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Aivorah syllabus outline)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
    fs.writeFileSync(f, buf);
    await new Promise((r) => setTimeout(r, 800));
  }
  return f;
}

const UNIT = /^\s*(\d{1,2})\s{1,4}([A-Z][A-Za-z0-9,.'’()&:\- ]{2,90}?)\s*$/;
// IGCSE Mathematics numbers topics C1.1 / E1.1 (Core / Extended).
const TOPIC = /^\s*[CE]?(\d{1,2})\.(\d{1,2})\s{1,4}([A-Z][^\t]{2,120}?)\s*$/;
const clean = (t) => t.replace(/\s{2,}.*$/, '').replace(/\s+(continued|Supplement|Core)$/i, '').replace(/\s+continued$/i, '').trim();

// Splits the syllabus into its "Syllabus overview" (which lists the chapter
// names) and its "Subject content" (topics, often without chapter headings).
function sections(pdf) {
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const lines = text.split(/\r?\n/);
  const isOverview = (l) => /^\s*\d\s+Syllabus overview\s*$/i.test(l);
  const isStart = (l) => /^\s*\d?\s*(AS Level |A Level |)Subject content\s*$/i.test(l);
  const isEnd = (l) => /^\s*\d\s+(Details of the assessment|What else you need to know|Practical assessment|Additional information)\s*$/i.test(l);
  const overview = [];
  const content = [];
  let mode = null;
  for (const l of lines) {
    if (/\.{5,}/.test(l)) continue; // contents-list rows
    if (isOverview(l)) { mode = 'overview'; continue; }
    if (isStart(l)) { mode = 'content'; continue; }
    if (mode === 'content' && isEnd(l)) { mode = null; continue; }
    if (mode === 'overview') overview.push(l);
    if (mode === 'content') content.push(l);
  }
  return { overview, content };
}

// Chapter names listed in the overview, in order ("1 Number", "2 Algebra and graphs").
function overviewUnits(lines) {
  const out = new Map();
  let last = 0;
  for (const l of lines) {
    const m = l.replace(/\f/g, '').match(UNIT);
    if (!m) continue;
    const n = +m[1];
    if (n === last + 1 && !out.has(n) && clean(m[2]).split(' ').length <= 12) { out.set(n, clean(m[2])); last = n; }
  }
  return out;
}

function parse({ overview, content }) {
  const named = overviewUnits(overview);
  const units = new Map();
  const unitFor = (n) => {
    if (!units.has(n) && named.has(n)) units.set(n, { n, title: named.get(n), topics: new Map() });
    return units.get(n);
  };
  let last = 0;
  for (const raw of content) {
    const l = raw.replace(/\f/g, '');
    const t = l.match(TOPIC);
    if (t) {
      const u = units.get(+t[1]) || unitFor(+t[1]);
      if (!u) continue;
      const key = `${t[1]}.${t[2]}`;
      if (!u.topics.has(key)) u.topics.set(key, clean(t[3]));
      continue;
    }
    const m = l.match(UNIT);
    if (m) {
      const n = +m[1];
      const title = clean(m[2]);
      if (units.has(n)) continue; // repeated heading ("continued")
      if (n !== last + 1 && n !== 1) continue; // page numbers, list items
      if (title.split(' ').length > 12) continue;
      units.set(n, { n, title, topics: new Map() });
      last = n;
    }
  }
  return [...units.values()].sort((a, b) => a.n - b.n).map((u) => ({ n: u.n, title: u.title, topics: [...u.topics.entries()].map(([k, v]) => ({ k, title: v })) }));
}

const uuid = (s) => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function sql(ref, query, attempt = 1) {
  let res, text;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
    });
    text = await res.text();
  } catch (err) {
    if (attempt < 6) { await new Promise((r) => setTimeout(r, 3000 * attempt)); return sql(ref, query, attempt + 1); }
    throw err;
  }
  if (!res.ok) {
    if (attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); return sql(ref, query, attempt + 1); }
    throw new Error(`${ref}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

(async () => {
  loadEnv();
  const refs = targets.map((t) => ({ dev: process.env.DEV_REF, test: process.env.TEST_REF }[t])).filter(Boolean);
  if (targets.length && refs.length !== targets.length) throw new Error('--target accepts dev,test');
  const rows = [];
  const report = [];
  for (const s of sources()) {
    try {
      const pdf = await download(s);
      const units = parse(sections(pdf));
      const version = `${s.code}-${s.year_from}-${s.year_to}`;
      const stage = STAGES[s.stage];
      report.push(`${s.stage.padEnd(5)} ${s.code} ${s.subject.padEnd(32)} ${s.label.padEnd(22)} ${String(units.length).padStart(3)} ch ${String(units.reduce((a, u) => a + u.topics.length, 0)).padStart(4)} topics`);
      for (const u of units) {
        const uid = uuid(`cambridge|${version}|${u.n}`);
        rows.push({ id: uid, board: 'CAMBRIDGE', stage: stage.label, grade_from: stage.grades[0], grade_to: stage.grades[1], subject: s.subject, code: s.code, version, year_from: s.year_from, year_to: s.year_to, source_url: s.url, level: 'UNIT', parent_id: null, ordinal: u.n, number_label: String(u.n), title: u.title });
        u.topics.forEach((t, i) => rows.push({ id: uuid(`cambridge|${version}|${t.k}`), board: 'CAMBRIDGE', stage: stage.label, grade_from: stage.grades[0], grade_to: stage.grades[1], subject: s.subject, code: s.code, version, year_from: s.year_from, year_to: s.year_to, source_url: s.url, level: 'TOPIC', parent_id: uid, ordinal: i + 1, number_label: t.k, title: t.title }));
      }
    } catch (err) {
      report.push(`${s.stage.padEnd(5)} ${s.code} ${s.subject.padEnd(32)} FAILED: ${err.message}`);
    }
  }
  console.log(report.join('\n'));
  console.log(`total: ${rows.filter((r) => r.level === 'UNIT').length} chapters, ${rows.filter((r) => r.level === 'TOPIC').length} topics`);
  if (dryRun || !refs.length) return;
  const cols = Object.keys(rows[0]);
  for (const ref of refs) {
    await sql(ref, "delete from public.board_syllabus_nodes where board = 'CAMBRIDGE'");
    const ordered = [...rows.filter((r) => r.level === 'UNIT'), ...rows.filter((r) => r.level === 'TOPIC')];
    for (let i = 0; i < ordered.length; i += 400) {
      const values = ordered.slice(i, i + 400).map((r) => `(${cols.map((c) => lit(r[c])).join(',')})`).join(',');
      await sql(ref, `insert into public.board_syllabus_nodes (${cols.join(',')}) values ${values} on conflict (id) do nothing`);
    }
    const [{ n }] = await sql(ref, "select count(*)::int n from public.board_syllabus_nodes where board = 'CAMBRIDGE'");
    console.log(`${ref}: ${n} rows${n === rows.length ? '' : ` MISMATCH (expected ${rows.length})`}`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
