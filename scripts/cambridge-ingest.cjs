#!/usr/bin/env node
/**
 * Official Cambridge syllabus ingestion (IGCSE + AS & A Level, plus the
 * public Primary / Lower Secondary strands in data/cambridge/frameworks.json).
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

// Chapter heading in the subject content: "1 Motion, forces and energy" or "Topic 1 Hydrology…".
const UNIT = /^\s*(?:Topic\s+)?(\d{1,2})\s{1,8}([A-Z][A-Za-z0-9,.'’()&:\- ]{2,90}?)\s*$/;
// Overview list rows may carry a second layout column ("1 Functions      a function.").
const OVERVIEW_UNIT =/^\s*(\d{1,2})\s{1,4}([A-Z][A-Za-z0-9,.'’()&:\-]*(?: [A-Za-z0-9,.'’()&:\-]+){0,11})(?:\s{2,}.*)?\s*$/;
// IGCSE Mathematics numbers topics C1.1 / E1.1 (Core / Extended); some syllabi write "1.1." .
const TOPIC = /^\s*[CE]?(\d{1,2})\.(\d{1,2})\.?\s{1,8}([A-Z][^\t]{2,120}?)\s*$/;
// Assessment-route rows and learning-objective statements are not chapters.
const NOT_A_CHAPTER = /^(AS Level|A Level|Details of|What else|Why choose|Syllabus overview|Understand|Describe|Explain|Identify|Show|Use|Define|State|Calculate|Know|Demonstrate|Recognise|Recognize|Investigate|Construct|Predict|Suggest|Interpret|Deduce|Compare|Outline|Measure|Plan|Classify|Determine|Draw|Recording|Research log|Research proposal)\b/;
const clean = (t) => t.replace(/\s{2,}.*$/, '').replace(/\s+(continued|Supplement|Core)$/i, '').replace(/\s+continued$/i, '').replace(/\s*\((AS|A) Level\)$/i, '').trim();

// UTF-8 text; pdftotext leaves tabs/control bytes inside some lines ("11.1 <tab><bell>Title").
const pdfText = (pdf) => execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, '-'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').replace(/[\x00-\x09\x0B\x0E-\x1F\x7F]/g, ' ');

// Splits the syllabus into its "Syllabus overview" (which lists the chapter
// names) and its "Subject content" (topics, often without chapter headings).
function sections(pdf) {
  const text = pdfText(pdf);
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
    const m = l.replace(/\f/g, '').match(OVERVIEW_UNIT);
    if (!m) continue;
    const n = +m[1];
    if (n === last + 1 && !out.has(n) && clean(m[2]).split(' ').length <= 12 && !NOT_A_CHAPTER.test(clean(m[2]))) { out.set(n, clean(m[2])); last = n; }
  }
  return out;
}

// Combined / Co-ordinated Sciences number by science: B1, C1, P1 with topics B1.1.
const LETTERED = new Set(['0653', '0654']);
const L_UNIT = /^\s*([BCP])(\d{1,2})\s{1,4}([A-Z][A-Za-z0-9,.'’()&:\- ]{2,90}?)(?:\s{2,}.*)?\s*$/;
const L_TOPIC = /^\s*([BCP])(\d{1,2})\.(\d{1,2})\s{1,4}([A-Z][^\t]{2,120}?)(?:\s{2,}.*)?\s*$/;
function parseLettered({ content }) {
  const units = new Map();
  for (const raw of content) {
    const l = raw.replace(/\f/g, '');
    const t = l.match(L_TOPIC);
    if (t) {
      const u = units.get(t[1] + t[2]);
      const key = `${t[1]}${t[2]}.${t[3]}`;
      if (u && !u.topics.has(key)) u.topics.set(key, clean(t[4]));
      continue;
    }
    const m = l.match(L_UNIT);
    if (m && !units.has(m[1] + m[2]) && !NOT_A_CHAPTER.test(m[3])) units.set(m[1] + m[2], { key: m[1] + m[2], title: clean(m[3]), topics: new Map() });
  }
  const order = { B: 0, C: 100, P: 200 };
  return [...units.values()]
    .map((u) => ({ n: order[u.key[0]] + parseInt(u.key.slice(1), 10), label: u.key, title: u.title, topics: [...u.topics.entries()].map(([k, v]) => ({ k, title: v })) }))
    .sort((a, b) => a.n - b.n);
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
      if (title.split(' ').length > 12 || NOT_A_CHAPTER.test(title)) continue;
      // The overview names chapters properly; body headings can be objective lines.
      units.set(n, { n, title: named.get(n) || title, topics: new Map() });
      last = n;
    }
  }
  // No numbered topics anywhere: the overview's chapter list is the syllabus.
  if (![...units.values()].some((u) => u.topics.size) && named.size > units.size) {
    for (const [n, title] of named) if (!units.has(n)) units.set(n, { n, title, topics: new Map() });
  }
  return [...units.values()].sort((a, b) => a.n - b.n).map((u) => ({ n: u.n, title: u.title, topics: [...u.topics.entries()].map(([k, v]) => ({ k, title: v })) }));
}

// Prose syllabi (languages, humanities, arts) have no numbered topic list, so
// each gets its own rule: which lines are chapters and which are topics,
// or a two-column topic list ("list") whose items are the chapters.
const BULLET = '[•\\uFFFD]';
const SKILLS = (...names) => new RegExp(`^\\s*(${names.join('|')})\\s*$`);
const LANG = { ch: /^\s*[A-E]\s{1,6}([A-Z][^•�]*?)(?:\s{2,}|$)/, tp: new RegExp(`${BULLET}\\s+([A-Z][^(]+?)\\s*(?:\\(|$)`), from: /^Topic areas\s*$/ };
// AS & A Level languages list their topic areas as bullets in the overview.
const AS_LANG = { from: /described in more detail in section 3/, to: /^\s*A course based on/, ch: new RegExp(`^${BULLET}\\s+(.+?)\\s*$`) };
const PROSE = {
  '0400': { ch: /^\s*(Painting and related media|Painting and\/or other media|Graphic communication|Three-dimensional design|Photography|Textiles and fashion|Textiles and\/or Fashion)\s*$/ },
  '9479': { ch: /^\s*(?:Area of study: (.+?)|(Fine art|Graphic communication|Three-dimensional design|Textiles and\/or Fashion|Photography))\s*$/ },
  '9479-2028': { ch: /^\s*Component \d: (.+?)\s*$/, tp: /^\s*AO\d (Record|Explore|Develop|Present)\s*$/ },
  '0410': { ch: /^\s*(Listening|Composing|Performing|Area of study \d: .+?)\s*$/ },
  '0413': { ch: /^\s*\d ([A-Z][a-z]+(?:,? [a-z]+)*)\s*$/, tp: /^\s{0,2}([A-Z][a-z]+(?: [a-z]+){0,5})\s*$/ },
  '0457': { list: /^\s*Topic list/ },
  '9239': { list: /^\s*Global topics\s*$/ },
  '0470': { ch: /^\s*(Core content: Option [AB]|Depth study [A-E]: .+?)\s*$/, tp: /^\s*\d\s*([A-Z][^?]*\?)\s*$/ },
  '9489': { ch: /^\s*(?:\d\s+([A-Z][^?]{3,70}?)|Topic \d: (.+?))\s*$/, tp: /^\s*\d\.\d\s*([A-Z][^?]*\?)/ },
  '0500': { ch: SKILLS('Reading', 'Writing', 'Speaking and Listening') },
  '0510': { ch: SKILLS('Reading', 'Writing', 'Listening', 'Speaking') },
  '0549': { ch: SKILLS('Reading', 'Writing', 'Listening', 'Speaking'), tp: /^\s*\d\s+([A-Z][^|]{10,110}?)\s*$/ },
  '0520': LANG,
  // These layouts misalign sub-topics against their areas: areas only.
  '0520-2028': { ...LANG, tp: null },
  '0525': { ...LANG, tp: null },
  '0530': { ...LANG, tp: null },
  '0547': { ...LANG, tp: null },
  '9898': AS_LANG, '9897': AS_LANG, '9844': AS_LANG,
  '0411': { ch: /^\s*(Elements of practical drama|Performance skills|Staging and design|From script to performance|Devising original drama from a stimulus)\s*$/ },
  '9482': { ch: /^\s*Component \d – (.+?)\s*$/ },
  '9483': { from: /^\s*Contents\s*$/, to: /^\s*1\s+Why choose this syllabus/, ch: /^\s*(?:Paper|Component) \d (.+?)\s{2,}\d+\s*$/ },
  '9695': { ch: /^\s*Paper \d ([A-Z].+?)\s*$/ },
  '9481': { from: /grouped into three broad areas of study/, to: /^\s*You do not have to cover/, ch: new RegExp(`^${BULLET}\\s+(.+?)\\s*$`) },
  // Area names wrap across lines; kept verbatim and checked against the PDF.
  '8021': { fixed: ['Economic, historical, moral, political and social issues', 'Science, including its history, philosophy, ethics, general principles and applications; environmental issues; technology and mathematics', 'Literature, language, the arts, crafts, and the media'] },
  '9274': { ch: /^\s*Topic [A-F] – (.+?)\s*$/ },
  '9487': { ch: /^\s*Section [A-D]: (.+?)\s*$/, tp: /^\s*\d\.\d\.\d\s+([A-Z].+?)\s*$/ },
  '0499': { ch: /^\s*Paper \d – (.+?)\s*$/, tp: /^\s*(Lexicology – Vocabulary List|Grammar|\d (?:Verse|Prose|Drama) – [^:]+)/ },
  '9093': { ch: /^\s*(?:Paper \d \S (.+?)|Section [A-C]: (.+?))\s*$/ },
  '0992': { ch: /^\s*(?:Section [A-C]: (Poetry|Prose|Drama)|Set texts for examination in \d{4} – (Paper [23]))\s*$/, name: { 'Paper 2': 'Drama', 'Paper 3': 'Drama (Open Text)' } },
  '9607': {
    from: /^Candidates must study:/, to: /^\s*Support for Cambridge/,
    ch: /^(Candidates must study:|Candidates must study at least one media area|In addition to the above|Candidates must also study:)/,
    tp: new RegExp(`^${BULLET}\\s+(.+?)\\s*$`),
    name: { 'Candidates must study:': 'Core concepts', 'Candidates must study at least one media area': 'Media areas', 'In addition to the above': 'A Level topics', 'Candidates must also study:': 'Media ecology' },
  },
};

function proseLines(pdf, from) {
  const text = pdfText(pdf);
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\f/g, '')).filter((l) => !/\.{5,}|Back to contents page|syllabus for 20\d\d/.test(l));
  const start = from ? lines.findIndex((l) => from.test(l)) : lines.findIndex((l) => /^\s*\d?\s*(AS Level |A Level |)Subject content\s*$/i.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\s*\d\s+Details of the assessment\s*$/i.test(l));
  return lines.slice(from ? start : start + 1, end < 0 ? undefined : end);
}

function parseProse(pdf, rule) {
  if (rule.fixed) {
    const flat = pdfText(pdf).replace(/\s+/g, ' ');
    return rule.fixed.filter((t) => flat.includes(t.slice(0, 40))).map((title, i) => ({ n: i + 1, title, topics: [] }));
  }
  const lines = proseLines(pdf, rule.list || rule.from);
  if (rule.list) {
    // Two columns: left column first, then right, each item becomes a chapter.
    const left = []; const right = [];
    for (const l of lines) {
      if (!l.trim()) { if (left.length) break; continue; }
      if (/^\s*(The|Learners|Students)\b/.test(l) && left.length) break;
      const row = l.replace(/^(\s*)(Topic list|Global topics)/, (_, s, w) => s + ' '.repeat(w.length));
      if (/^\s{20,}\S/.test(row)) { right.push(row.trim()); continue; }
      const [a, b] = row.trim().split(/\s{2,}/);
      if (a) left.push(a);
      if (b) right.push(b);
    }
    return [...left, ...right].map((title, i) => ({ n: i + 1, title, topics: [] }));
  }
  const units = [];
  let cur = null;
  for (const l of lines) {
    if (rule.to && rule.to.test(l)) break;
    const m = l.match(rule.ch);
    if (m) {
      const raw = clean(m.slice(1).find(Boolean) || '').replace(/\s+\(?continued\)?$/i, '').replace(/\.$/, '');
      const title = rule.name?.[raw] || raw;
      // A heading that wrapped onto two lines repeats as a prefix of the full one.
      cur = units.find((u) => u.title === title || (title.length > 25 && u.title.startsWith(title)));
      if (!cur && title) { cur = { n: units.length + 1, title, topics: [] }; units.push(cur); }
      if (!rule.tp) continue;
    }
    const t = cur && rule.tp && l.replace(m ? m[0] : '', ' ').match(rule.tp);
    if (t) {
      const title = clean(t[1]).replace(/\s+continued$/i, '').replace(/\s+$/, '');
      if (title && title !== cur.title && !cur.topics.some((x) => x.title === title)) cur.topics.push({ k: `${cur.n}.${cur.topics.length + 1}`, title });
    }
  }
  return units;
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
      const rule = PROSE[`${s.code}-${s.year_from}`] || PROSE[s.code];
      const units = rule ? parseProse(pdf, rule) : LETTERED.has(s.code) ? parseLettered(sections(pdf)) : parse(sections(pdf));
      const version = `${s.code}-${s.year_from}-${s.year_to}`;
      const stage = STAGES[s.stage];
      report.push(`${s.stage.padEnd(5)} ${s.code} ${s.subject.padEnd(32)} ${s.label.padEnd(22)} ${String(units.length).padStart(3)} ch ${String(units.reduce((a, u) => a + u.topics.length, 0)).padStart(4)} topics`);
      if (args.includes('--show')) for (const u of units) report.push(`    ${u.n} ${u.title}${u.topics.length ? `\n      - ${u.topics.map((t) => t.title).join('\n      - ')}` : ''}`);
      for (const u of units) {
        const uid = uuid(`cambridge|${version}|${u.n}`);
        rows.push({ id: uid, board: 'CAMBRIDGE', stage: stage.label, grade_from: stage.grades[0], grade_to: stage.grades[1], subject: s.subject, code: s.code, version, year_from: s.year_from, year_to: s.year_to, source_url: s.url, level: 'UNIT', parent_id: null, ordinal: u.n, number_label: u.label || String(u.n), title: u.title });
        u.topics.forEach((t, i) => rows.push({ id: uuid(`cambridge|${version}|${t.k}`), board: 'CAMBRIDGE', stage: stage.label, grade_from: stage.grades[0], grade_to: stage.grades[1], subject: s.subject, code: s.code, version, year_from: s.year_from, year_to: s.year_to, source_url: s.url, level: 'TOPIC', parent_id: uid, ordinal: i + 1, number_label: t.k, title: t.title }));
      }
    } catch (err) {
      report.push(`${s.stage.padEnd(5)} ${s.code} ${s.subject.padEnd(32)} FAILED: ${err.message}`);
    }
  }
  // Primary / Lower Secondary: strand outline from the public subject pages
  // (data/cambridge/frameworks.json) until official frameworks are available.
  if (!only.length) {
    const fw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cambridge', 'frameworks.json'), 'utf8'));
    for (const s of fw.subjects) {
      const stage = fw.stages[s.stage];
      const version = `${s.code}-public`;
      const source_url = `${stage.page}${s.slug}/`;
      report.push(`${s.stage.slice(0, 5).padEnd(5)} ${s.code} ${s.subject.padEnd(32)} ${'public strands'.padEnd(22)} ${String(s.strands.length).padStart(3)} ch    0 topics`);
      s.strands.forEach((title, i) => rows.push({ id: uuid(`cambridge|${version}|${i + 1}`), board: 'CAMBRIDGE', stage: stage.label, grade_from: stage.grades[0], grade_to: stage.grades[1], subject: s.subject, code: s.code, version, year_from: 2020, year_to: 2030, source_url, level: 'UNIT', parent_id: null, ordinal: i + 1, number_label: String(i + 1), title }));
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
