// Builds Learn + Listen (with a visual per scene) + a Practice quiz for every section of every non-Maths NCERT unit,
// Grades 1-12, including Hindi and Urdu. One Gemini call per unit reads the unit PDF itself (page images), so books
// set in old Hindi/Urdu fonts work too. Code checks what it can: lesson blocks against the service's block schema,
// visuals against the app's visual rules, and (for English-script books) that section titles and quiz answers
// appear in the book text. Output: out/unit-content/<pdf>.json (resumable) and, with --write, `unit_content_sections`.
// Usage: node scripts/build-unit-content.cjs --env-file ../aivorah-students-service/.env [--grades 8] [--subjects English] [--limit 1] [--write]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const { parseJsonLoose } = require('./lib/jsonRepair.cjs');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ENV_FILE = arg('--env-file');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config();
const { validateEnrichment } = require('../services/curriculum/blockSchema');

const ROOT = path.join(__dirname, '..');
const CACHE = process.env.NCERT_CHAPTER_CACHE || os.tmpdir();
const OUT = path.join(ROOT, 'out', 'unit-content');
const WRITE = process.argv.includes('--write');
const GRADES = (arg('--grades') || '8,9,10,6,7,11,12,5,4,3,2,1').split(',').map(Number);
const SUBJECTS = arg('--subjects') ? arg('--subjects').toLowerCase().split(',') : null;
const LIMIT = Number(arg('--limit') || 0);
const BOOKS = 'https://aivorah-auth-service-g27s.onrender.com/data/ncert_books/';
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
fs.mkdirSync(OUT, { recursive: true });

const keyFile = path.join(os.homedir(), '.config', 'aivorah', 'gemini_keys.txt');
const loadKeys = () => [...new Set([process.env.GEMINI_API_KEY, ...(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').split(/\r?\n/) : [])]
  .map((k) => (k || '').trim()).filter(Boolean))];
let KEYS = loadKeys();
const restedUntil = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function units() {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'book-catalog.json'), 'utf8'));
  const books = cat.books || cat;
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'curricula')).filter((x) => x.endsWith('-chapters.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'curricula', f), 'utf8'));
    const code = j.code || f.split('-').slice(-2)[0];
    if (!j.subject || /math/i.test(j.subject) || books[code]?.hidden) continue;
    if (SUBJECTS && !SUBJECTS.includes(j.subject.toLowerCase())) continue;
    const grade = Number(String(j.grade).replace(/\D/g, ''));
    for (const c of j.chapters || []) {
      out.push({ grade, subject: j.subject, code, book: books[code]?.title || code, unitNo: c.chapter, unitTitle: c.title || '', pdf: c.pdfFile, bookPath: c.bookPath });
    }
  }
  return out.filter((u) => GRADES.includes(u.grade))
    .sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || a.subject.localeCompare(b.subject) || a.code.localeCompare(b.code) || a.unitNo - b.unitNo);
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

const language = (u) => (/hindi/i.test(u.subject) ? 'Hindi (Devanagari script)' : /urdu/i.test(u.subject) ? 'Urdu (Urdu script)' : /sanskrit/i.test(u.subject) ? 'Hindi (Devanagari script), quoting Sanskrit lines as printed' : 'English');
const level = (g) => (g <= 2 ? 'very short sentences and everyday words for a 6-7 year old' : g <= 5 ? 'short sentences and simple words'
  : g <= 8 ? 'clear, friendly and simple language' : 'precise subject terms, explained step by step, suitable for board exams');

const prompt = (u, pages) => `You are Aivorah, a friendly NCERT tutor. The attached PDF is Unit ${u.unitNo} "${u.unitTitle}" (${pages} pages) of the NCERT Grade ${u.grade} ${u.subject} textbook "${u.book}".
Write everything in ${language(u)}, using ${level(u.grade)}. Use ONLY this book's content - no outside facts, names, dates or numbers. Say "unit", never "chapter".

Return the unit's SECTIONS as printed (numbered headings, or the main headings / the individual stories and poems; at most 6 - merge small ones; if there are no headings, one section titled with the unit title). For each section:
- "title" exactly as printed, "from"/"to" PDF pages (first attached page = 1).
- "learn": {"whatYoullLearn": [3 short points], "blocks": [5-8 blocks]} using ONLY these block types:
  {"type":"overview","text":"a hook question or 1-2 sentence opener"}
  {"type":"explanation","text":"..."}
  {"type":"key_terms","items":[{"term":"...","definition":"..."}]}
  {"type":"example","text":"a concrete example from the book"}
  {"type":"process","title":"...","steps":["...","..."]}
  {"type":"comparison","title":"...","items":[{"name":"...","description":"..."}]}
  {"type":"table","caption":"...","headers":["...","..."],"rows":[["...","..."]]}
  {"type":"timeline","title":"...","events":[{"date":"...","description":"..."}]}
  {"type":"cause_and_effect","title":"...","items":[{"cause":"...","effect":"..."}]}
  {"type":"prose_excerpt","sourceText":"a key line copied exactly from the book","explanation":"what it means"}
  {"type":"key_points","items":["...","..."]}
  Include at least one visual block (process, comparison, table, timeline or cause_and_effect) when the content allows.
- "listen": 3-5 scenes, each {"heading":"...","lines":[{"speaker":"Narrator","text":"one or two spoken sentences","page":N}] (3-6 lines), "visual": one diagram that explains the scene, one of:
  {"kind":"flow","title":"...","steps":["...","..."]} | {"kind":"venn","title":"...","left":{"label":"...","items":["..."]},"right":{"label":"...","items":["..."]},"both":["..."]}
  | {"kind":"table","title":"...","headers":["...","..."],"rows":[["...","..."]]} | {"kind":"timeline","title":"...","events":[{"when":"...","what":"..."}]}
  | {"kind":"cause_effect","title":"...","pairs":[{"cause":"...","effect":"..."}]} | {"kind":"compare","title":"...","columns":[{"label":"...","points":["..."]}]}
  | {"kind":"web","title":"...","center":"...","nodes":[{"label":"...","note":"..."}]} (labels at most 12 words). The first scene says which book, unit and section this is.
- "quiz": 5 multiple-choice questions on this section: {"question":"...","options":["...","...","...","..."],"correctIndex":0-3,"explanation":"why, citing the book","page":N}. The correct option must be stated in the book. Test understanding of the section's ideas, facts and vocabulary - never trivia about the textbook, its grade, unit numbers or page numbers.
Output ONLY JSON: {"sections":[{"title":"...","from":1,"to":4,"learn":{...},"listen":[...],"quiz":[...]}]}`;

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
    KEYS = loadKeys();
    for (const model of MODELS) {
      for (let k = 0; k < KEYS.length; k += 1) {
        const slot = `${KEYS[k].slice(-6)}|${model}`;
        if ((restedUntil[slot] || 0) > Date.now()) continue;
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': KEYS[k], 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfB64 } }, { text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 60000 } }),
          signal: AbortSignal.timeout(420000),
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
const inBook = (s, hay, need = 0.6) => {
  const w = norm(s).split(' ').filter((x) => x.length > 2);
  return !w.length || w.filter((x) => hay.includes(` ${x} `)).length / w.length >= need;
};
const str = (v) => typeof v === 'string' && v.trim().length > 0;
const VISUAL_KINDS = new Set(['flow', 'venn', 'table', 'timeline', 'cause_effect', 'compare', 'web']);

function check(u, parsed, text, pages, englishText) {
  const hay = ` ${norm(text)} `;
  const notes = [];
  const sections = [];
  for (const [i, s] of (parsed.sections || []).slice(0, 8).entries()) {
    if (!str(s.title)) continue;
    if (englishText && !inBook(String(s.title).replace(/^\d+(\.\d+)*\s*/, ''), hay, 0.7) && s.title !== u.unitTitle) { notes.push(`section "${s.title}" not in book`); continue; }
    const v = validateEnrichment({ whatYoullLearn: s.learn?.whatYoullLearn, blocks: s.learn?.blocks });
    const learn = v.valid ? { whatYoullLearn: s.learn.whatYoullLearn, blocks: v.blocks } : null;
    if (!learn) notes.push(`learn invalid in "${s.title}": ${(v.errors || []).slice(0, 2).join('; ')}`);
    const from = Math.max(1, Math.min(pages, Number(s.from) || 1));
    const to = Math.max(from, Math.min(pages, Number(s.to) || pages));
    const listen = (Array.isArray(s.listen) ? s.listen : []).map((sc) => {
      const lines = (sc.lines || []).filter((l) => str(l.text)).map((l) => ({ speaker: 'Narrator', text: l.text.trim(), page: Number.isInteger(l.page) && l.page >= 1 && l.page <= pages ? l.page : from }));
      const visual = sc.visual && VISUAL_KINDS.has(sc.visual.kind) ? sc.visual : undefined;
      return lines.length ? { card: null, heading: str(sc.heading) ? sc.heading : s.title, text: lines.map((l) => l.text).join(' '), lines, ...(visual ? { visual } : {}) } : null;
    }).filter(Boolean);
    const quiz = (Array.isArray(s.quiz) ? s.quiz : []).filter((q) => str(q.question) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(str)
      && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4
      && (!englishText || inBook(q.options[q.correctIndex], hay, 0.5)));
    if (!learn && !listen.length) continue;
    sections.push({ no: i + 1, title: String(s.title).trim(), from, to, learn, listen, quiz });
  }
  return { sections, notes };
}

async function save(u, result, model, lang) {
  const supabase = require('../services/supabase');
  const rows = result.sections.map((s) => ({
    curriculum: 'CBSE', grade: u.grade, subject: u.subject, book_code: u.code, pdf_file: u.pdf, unit_no: u.unitNo, unit_title: u.unitTitle,
    section_no: s.no, section_title: s.title, page_from: s.from, page_to: s.to, lang, learn: s.learn, listen: s.listen, quiz: s.quiz, model,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('unit_content_sections').upsert(rows, { onConflict: 'pdf_file,section_no' });
  if (error) throw new Error(`save failed: ${error.message}`);
}

(async () => {
  const list = units();
  console.log(`units: ${list.length}; keys: ${KEYS.length}; write: ${WRITE}`);
  let n = 0;
  for (const u of list) {
    if (LIMIT && n >= LIMIT) break;
    const done = path.join(OUT, `${u.pdf}.json`);
    if (fs.existsSync(done)) {
      const d = JSON.parse(fs.readFileSync(done, 'utf8'));
      if (WRITE && !d.saved) { try { await save(u, d, d.model, d.lang); d.saved = true; fs.writeFileSync(done, JSON.stringify(d)); } catch (e) { console.log(`${u.pdf}: ${e.message}`); } }
      continue;
    }
    n += 1;
    const p = await pdfFor(u);
    if (!p) { console.log(`G${u.grade} ${u.subject} ${u.pdf}: PDF missing`); continue; }
    const text = spawnSync('pdftotext', [p, '-'], { encoding: 'utf8', maxBuffer: 1 << 27 }).stdout || '';
    const pages = Number((spawnSync('pdfinfo', [p], { encoding: 'utf8' }).stdout.match(/Pages:\s+(\d+)/) || [])[1] || 1);
    const words = text.toLowerCase().split(/\s+/);
    const englishText = !/hindi|urdu|sanskrit/i.test(u.subject) && (text.match(/\b(the|and|of|is|to|in)\b/gi) || []).length / Math.max(1, words.length) > 0.02;
    const lang = /hindi|sanskrit/i.test(u.subject) ? 'hi' : /urdu/i.test(u.subject) ? 'ur' : 'en';
    try {
      const b64 = fs.readFileSync(p).toString('base64');
      if (b64.length > 19e6) { console.log(`G${u.grade} ${u.subject} ${u.pdf}: skipped (PDF too large for one call)`); continue; }
      const t0 = Date.now();
      const { model, key, parsed } = await parseWithRetry(b64, prompt(u, pages));
      const result = check(u, parsed, text, pages, englishText);
      const rec = { ...u, lang, model, sections: result.sections, notes: result.notes, saved: false };
      if (result.sections.length && WRITE) { try { await save(u, result, model, lang); rec.saved = true; } catch (e) { result.notes.push(e.message); } }
      if (result.sections.length) fs.writeFileSync(done, JSON.stringify(rec));
      const q = result.sections.reduce((a, s) => a + s.quiz.length, 0);
      const sc = result.sections.reduce((a, s) => a + s.listen.length, 0);
      console.log(`G${u.grade} ${u.subject} U${u.unitNo} ${u.unitTitle.slice(0, 30)} [${model} k${key} ${Math.round((Date.now() - t0) / 1000)}s]: ${result.sections.length} sections, ${sc} scenes, ${q} quiz${rec.saved ? ', saved' : ''}${result.notes.length ? ` | ${result.notes.slice(0, 2).join('; ')}` : ''}`);
    } catch (e) {
      console.log(`G${u.grade} ${u.subject} ${u.pdf}: FAILED ${String(e.message).slice(0, 160)}`);
      if (/unavailable/.test(e.message)) await sleep(60000);
    }
  }
  console.log(`DONE: ${fs.readdirSync(OUT).length} of ${list.length} units have content`);
})();
