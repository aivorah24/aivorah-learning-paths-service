// Builds the Maths AI Tutor for every Maths unit (Grades 1-12), one Gemini call per unit: Gemini reads the unit PDF and
// returns its printed sections, each with 2-3 of the book's own examples taught step by step. Code keeps only what it
// can verify: section titles and problems must appear in the PDF text and every board calculation must be correct.
// Results go to out/math-tutor/<pdf>.json (resumable) and, with --write, to Supabase `math_tutor_sections`.
// Keys: GEMINI_API_KEY plus one key per line in ~/.config/aivorah/gemini_keys.txt; a key that hits its limit is rested.
// Usage: node scripts/build-math-units.cjs --env-file ../aivorah-students-service/.env [--grades 8,9] [--limit 2] [--write]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const { parseJsonLoose } = require('./lib/jsonRepair.cjs');
const { arithmeticError, grounded } = require('./build-math-tutor.cjs');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ENV_FILE = arg('--env-file');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const CACHE = process.env.NCERT_CHAPTER_CACHE || os.tmpdir();
const OUT = path.join(ROOT, 'out', 'math-tutor');
const WRITE = process.argv.includes('--write');
const GRADES = (arg('--grades') || '8,9,10,6,7,11,12,5,4,3,2,1').split(',').map(Number);
const LIMIT = Number(arg('--limit') || 0);
const BOOKS = 'https://aivorah-auth-service-g27s.onrender.com/data/ncert_books/';
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
fs.mkdirSync(OUT, { recursive: true });

const keyFile = path.join(os.homedir(), '.config', 'aivorah', 'gemini_keys.txt');
const KEYS = [...new Set([process.env.GEMINI_API_KEY, ...(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').split(/\r?\n/) : [])]
  .map((k) => (k || '').trim()).filter(Boolean))];
const restedUntil = {}; // `${keyIndex}|${model}` -> timestamp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function units() {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'book-catalog.json'), 'utf8'));
  const books = cat.books || cat;
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'curricula')).filter((x) => x.endsWith('-chapters.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'curricula', f), 'utf8'));
    const code = j.code || f.split('-').slice(-2)[0];
    if (!/math/i.test(j.subject || '') || books[code]?.hidden) continue;
    const grade = Number(String(j.grade).replace(/\D/g, ''));
    for (const c of j.chapters || []) out.push({ grade, code, book: books[code]?.title || code, unitNo: c.chapter, unitTitle: c.title || '', pdf: c.pdfFile, bookPath: c.bookPath });
  }
  return out.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || a.code.localeCompare(b.code) || a.unitNo - b.unitNo)
    .filter((u) => GRADES.includes(u.grade));
}

async function pdfFor(u) {
  const p = path.join(CACHE, u.pdf);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetch(BOOKS + u.bookPath, { signal: AbortSignal.timeout(180000) });
      if (r.ok) { fs.writeFileSync(p, Buffer.from(await r.arrayBuffer())); if (fs.statSync(p).size > 1000) return p; }
    } catch { /* retry */ }
    await sleep(3000 * (i + 1));
  }
  return null;
}

const tier = (g) => (g <= 2 ? 'a Grade 1-2 child: very short sentences, everyday words, counting objects'
  : g <= 5 ? `a Grade ${g} child: short sentences and simple words`
    : g <= 8 ? `a Grade ${g} student: clear, friendly and simple`
      : `a Grade ${g} student preparing for board exams: precise, correct terms, still step by step`);

const prompt = (u, pages) => `You are a friendly Maths AI Tutor. The attached PDF is Unit ${u.unitNo} "${u.unitTitle}" (${pages} pages) of the NCERT Grade ${u.grade} Mathematics textbook. Explain for ${tier(u.grade)}.

1. List the unit's SECTIONS exactly as printed (e.g. "1.1 Square Numbers"). If the unit has no numbered sections, use its main printed headings; if none, one section titled "${u.unitTitle}". Give each section its PDF page range (first attached page = 1).
2. For EACH section: "keyIdea" = the one main rule or idea in at most 15 words as the book states it; "intro" = 2 short sentences on what we learn in this part of the unit (say "unit", never "chapter").
3. For EACH section, "examples": 2 or 3 problems from THAT section - the book's own worked examples, questions, "Figure it Out", exercises or activities. Copy the QUESTION exactly as printed (only the question, never its solution). Give its PDF "page".
4. Each example has "steps": 3 to 12. Each step: "say" (1-2 short sentences the student hears) and "show" (the working line on the board: ONE short calculation or fact per line, e.g. "7 × 7 = 49", "81 − 1 = 80", "√144 = 12"). NEVER skip a calculation: when a method repeats, write every repetition as its own step. Use × ÷ ² ³ √ ∛ symbols. Every calculation must be correct.
5. Each example: "answer" (short), "why" (one sentence on the idea behind the method), "hint" (helps without giving the answer), "yourTurn": {"question": a similar question - from the book if possible - with ONE definite answer (never just yes/no), "answer": the answer with a one-line working}.
Use only this book. Output ONLY JSON:
{"sections":[{"title":"1.1 ...","from":1,"to":5,"keyIdea":"...","intro":"...","examples":[{"title":"...","problem":"...","page":2,"steps":[{"say":"...","show":"..."}],"answer":"...","why":"...","hint":"...","yourTurn":{"question":"...","answer":"..."}}]}]}`;

// Gemini occasionally returns cut-off or malformed JSON for a long unit; ask again (up to 3 tries) before failing.
async function parseWithRetry(pdfB64, text) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    const r = await gemini(pdfB64, text);
    try { return { ...r, parsed: parseJsonLoose(r.text) }; } catch (e) { last = e; }
  }
  throw last;
}

async function gemini(pdfB64, text) {
  let lastErr = '';
  for (let round = 0; round < 6; round += 1) {
    for (const model of MODELS) {
      for (let k = 0; k < KEYS.length; k += 1) {
        const slot = `${k}|${model}`;
        if ((restedUntil[slot] || 0) > Date.now()) continue;
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': KEYS[k], 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfB64 } }, { text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
          signal: AbortSignal.timeout(300000),
        }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
        const j = await r.json().catch(() => ({}));
        if (r.ok) return { model, key: k, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' };
        const msg = j.error?.message || '';
        lastErr = `key${k} ${model} ${r.status} ${msg.slice(0, 90)}`;
        if (r.status === 429) restedUntil[slot] = Date.now() + (/per.?day|daily|PerDay/i.test(msg) ? 6 * 3600e3 : 65e3);
        else if (r.status >= 500 || r.status === 0) await sleep(5000);
        else if (r.status === 400) throw new Error(lastErr);
      }
    }
    await sleep(20000);
  }
  throw new Error(`Gemini unavailable (${lastErr})`);
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function check(u, parsed, text, pages) {
  const hay = ` ${norm(text)} `;
  const sections = [];
  const notes = [];
  for (const [i, s] of (parsed.sections || []).entries()) {
    const titleWords = norm(String(s.title).replace(/^\d+(\.\d+)*\s*/, '')).split(' ').filter((w) => w.length > 2);
    const titleOk = !titleWords.length || titleWords.filter((w) => hay.includes(` ${w} `)).length / titleWords.length >= 0.7 || s.title === u.unitTitle;
    if (!titleOk) { notes.push(`section "${s.title}" not in book text`); continue; }
    const examples = [];
    for (const ex of s.examples || []) {
      if (ex.yourTurn && /^(yes|no)\.?$/i.test(String(ex.yourTurn.answer || '').trim())) delete ex.yourTurn;
      const lines = [...(ex.steps || []).map((x) => x.show), ex.answer, ex.yourTurn?.answer].filter(Boolean);
      const bad = lines.map(arithmeticError).find(Boolean);
      if (bad) { notes.push(`wrong sum "${bad}"`); continue; }
      if (!(ex.steps || []).length || !ex.problem || !ex.answer) { notes.push('incomplete example'); continue; }
      if (!grounded(ex.problem, text)) { notes.push(`problem not in book: "${String(ex.problem).slice(0, 50)}"`); continue; }
      if (!Number.isInteger(ex.page) || ex.page < 1 || ex.page > pages) ex.page = Math.max(1, Math.min(pages, Number(s.from) || 1));
      examples.push(ex);
    }
    if (!examples.length) { notes.push(`section "${s.title}" had no example that passed`); continue; }
    const from = Math.max(1, Math.min(pages, Number(s.from) || 1));
    sections.push({
      no: i + 1, title: String(s.title).trim(), from, to: Math.max(from, Math.min(pages, Number(s.to) || pages)),
      tutor: { intro: String(s.intro || '').replace(/\bchapter\b/gi, 'unit'), keyIdea: s.keyIdea, examples, section: String(s.title).trim(), pages: [from, Number(s.to) || pages] },
    });
  }
  return { sections, notes };
}

async function save(u, result, model) {
  const supabase = require('../services/supabase');
  const rows = result.sections.map((s) => ({
    curriculum: 'CBSE', grade: u.grade, book_code: u.code, pdf_file: u.pdf, unit_no: u.unitNo, unit_title: u.unitTitle,
    section_no: s.no, section_title: s.title, page_from: s.from, page_to: s.to, tutor: s.tutor, model, updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('math_tutor_sections').upsert(rows, { onConflict: 'pdf_file,section_no' });
  if (error) throw new Error(`save failed: ${error.message}`);
}

(async () => {
  const list = units();
  console.log(`maths units: ${list.length}; keys: ${KEYS.length}; write: ${WRITE}`);
  let n = 0;
  for (const u of list) {
    if (LIMIT && n >= LIMIT) break;
    const done = path.join(OUT, `${u.pdf}.json`);
    if (fs.existsSync(done)) {
      if (WRITE && !JSON.parse(fs.readFileSync(done, 'utf8')).saved) {
        const d = JSON.parse(fs.readFileSync(done, 'utf8'));
        try { await save(u, d, d.model); d.saved = true; fs.writeFileSync(done, JSON.stringify(d, null, 1)); console.log(`G${u.grade} ${u.pdf}: saved from cache`); } catch (e) { console.log(`G${u.grade} ${u.pdf}: ${e.message}`); }
      }
      continue;
    }
    n += 1;
    const p = await pdfFor(u);
    if (!p) { console.log(`G${u.grade} ${u.pdf}: PDF missing`); continue; }
    const text = spawnSync('pdftotext', [p, '-'], { encoding: 'utf8', maxBuffer: 1 << 27 }).stdout || '';
    const pages = Number((spawnSync('pdfinfo', [p], { encoding: 'utf8' }).stdout.match(/Pages:\s+(\d+)/) || [])[1] || 1);
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const common = (text.toLowerCase().match(/\b(the|and|of|is|to|in)\b/g) || []).length;
    if (letters > 500 && common / Math.max(1, text.split(/\s+/).length) < 0.02) { console.log(`G${u.grade} ${u.pdf}: skipped (not English text)`); continue; }
    try {
      const b64 = fs.readFileSync(p).toString('base64');
      if (b64.length > 19e6) { console.log(`G${u.grade} ${u.pdf}: skipped (PDF too large for one call)`); continue; }
      const { model, key, parsed } = await parseWithRetry(b64, prompt(u, pages));
      const result = check(u, parsed, text, pages);
      const exCount = result.sections.reduce((a, s) => a + s.tutor.examples.length, 0);
      const rec = { ...u, model, sections: result.sections, notes: result.notes, saved: false };
      if (result.sections.length && WRITE) { try { await save(u, result, model); rec.saved = true; } catch (e) { result.notes.push(e.message); } }
      if (result.sections.length) fs.writeFileSync(done, JSON.stringify(rec, null, 1));
      console.log(`G${u.grade} U${u.unitNo} ${u.unitTitle.slice(0, 34)} [${model} k${key}]: ${result.sections.length} sections, ${exCount} examples${rec.saved ? ', saved' : ''}${result.notes.length ? ` | dropped: ${result.notes.slice(0, 3).join('; ')}` : ''}`);
    } catch (e) {
      console.log(`G${u.grade} ${u.pdf}: FAILED ${e.message.slice(0, 160)}`);
      if (/unavailable/.test(e.message)) await sleep(60000);
    }
  }
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).length;
  console.log(`DONE: ${files} of ${list.length} units have a tutor`);
})();
