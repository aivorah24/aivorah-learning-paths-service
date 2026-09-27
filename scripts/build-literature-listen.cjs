// Camel-format Listen for literature (English, Hindi, Urdu, Sanskrit): for every built section, Gemini reads the
// section's pages and returns the book's OWN full text as scenes (speakers for dialogue, book page per line), an
// intro naming the book/unit/piece with two hard words, a recap, and a diagram per scene. The book's own pictures
// replace diagrams on scenes whose pages have one. English lines must appear word-for-word in the book text.
// Replaces `listen` in unit_content_sections. Resumable via out/lit-listen/<pdf>-<section>.json.
// Usage: node scripts/build-literature-listen.cjs --env-file ../aivorah-students-service/.env [--grades 8] [--subjects Hindi] [--limit 1] [--write]
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
const supabase = require('../services/supabase');

const ROOT = path.join(__dirname, '..');
const CACHE = process.env.NCERT_CHAPTER_CACHE || os.tmpdir();
const OUT = path.join(ROOT, 'out', 'lit-listen');
const WRITE = process.argv.includes('--write');
const GRADES = (arg('--grades') || '8,9,10,6,7,11,12,5,4,3,2,1').split(',').map(Number);
const SUBJECTS = (arg('--subjects') || 'English,Hindi,Urdu,Sanskrit').split(',');
const LIMIT = Number(arg('--limit') || 0);
const BOOKS = 'https://aivorah-auth-service-g27s.onrender.com/data/ncert_books/';
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
fs.mkdirSync(OUT, { recursive: true });

const keyFile = path.join(os.homedir(), '.config', 'aivorah', 'gemini_keys.txt');
const loadKeys = () => [...new Set([process.env.GEMINI_API_KEY, ...(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').split(/\r?\n/) : [])]
  .map((k) => (k || '').trim()).filter(Boolean))];
const restedUntil = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(pdfB64, text) {
  let lastErr = '';
  for (let round = 0; round < 6; round += 1) {
    const keys = loadKeys();
    for (const model of MODELS) {
      for (let k = 0; k < keys.length; k += 1) {
        const slot = `${keys[k].slice(-6)}|${model}`;
        if ((restedUntil[slot] || 0) > Date.now()) continue;
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': keys[k], 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfB64 } }, { text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 60000 } }),
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

async function pdfFor(pdf, bookPath) {
  const p = path.join(CACHE, pdf);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
  if (!bookPath) return null;
  const r = await fetch(BOOKS + bookPath, { signal: AbortSignal.timeout(180000) }).catch(() => null);
  if (!r || !r.ok) return null;
  fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  return p;
}

function cutPages(file, from, to) {
  const out = path.join(os.tmpdir(), `lit-${process.pid}.pdf`);
  const py = 'import fitz,sys\nd=fitz.open(sys.argv[1]);n=fitz.open();n.insert_pdf(d,from_page=int(sys.argv[2])-1,to_page=int(sys.argv[3])-1);n.save(sys.argv[4])';
  const r = spawnSync('python', ['-c', py, file, String(from), String(to), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not cut pages: ${r.stderr}`);
  return fs.readFileSync(out).toString('base64');
}

const language = (s) => (/hindi|sanskrit/i.test(s) ? 'Hindi (Devanagari)' : /urdu/i.test(s) ? 'Urdu (Urdu script)' : 'English');

const prompt = (unit, book, pages, titles) => `The attached PDF is the whole of Unit ${unit.unit_no} (${pages} pages) of the NCERT Grade ${unit.grade} ${unit.subject} textbook "${book}". Its sections are: ${titles.map((t) => `"${t}"`).join(', ')}.
Build a Listen script for EACH of these sections so a Grade ${unit.grade} student can HEAR the book and understand it. Language: ${language(unit.subject)}.

For each section:
1. "intro": 3-4 short spoken lines in your own simple words: the book "${book}", the unit and the section title; what it is about in one or two sentences; 1-2 hard words with meanings (from the book's glossary if it has one).
2. "scenes": that section's OWN main text, COPIED EXACTLY from the pages in reading order - EVERY paragraph, poem line and dialogue line, the COMPLETE text, never a sample or summary. Leave out only exercises/questions, activity boxes, margin glossary and page headers. Split into scenes of 3-10 lines, each with a short "heading" you write. Each line: {"speaker": the character's name for dialogue (as printed) or "Narrator"; "text": at most ~45 words copied exactly; "page": PDF page number (first page = 1); "direction": a printed stage direction if any}.
   Each scene gets a "visual" explaining it, one of:
   {"kind":"flow","title":"...","steps":["...","..."]} | {"kind":"web","title":"...","center":"...","nodes":[{"label":"...","note":"..."}]}
   | {"kind":"compare","title":"...","columns":[{"label":"...","points":["..."]}]} | {"kind":"cause_effect","title":"...","pairs":[{"cause":"...","effect":"..."}]}
   | {"kind":"timeline","title":"...","events":[{"when":"...","what":"..."}]} | {"kind":"venn","title":"...","left":{"label":"...","items":["..."]},"right":{"label":"...","items":["..."]},"both":["..."]}
   (labels at most 12 words, same language, only facts from the scene).
3. "outro": 2-3 spoken lines in your own words: what to remember and one question to think about.
Output ONLY JSON: {"sections":[{"title":"<one of the section titles above>","intro":[{"speaker":"Narrator","text":"..."}],"scenes":[{"heading":"...","lines":[...],"visual":{...}}],"outro":[...]}]}`;

const norm = (s) => String(s).toLowerCase().replace(/[‘’“”"'`]/g, '').replace(/[–—-]+/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function bookPictures(file, from, to) {
  const list = spawnSync('pdfimages', ['-list', '-f', String(from), '-l', String(to), file], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const best = {};
  const perPage = {};
  for (const ln of list.split('\n').slice(2)) {
    const c = ln.trim().split(/\s+/);
    if (c.length < 10) continue;
    const page = Number(c[0]);
    const idx = (perPage[page] = (perPage[page] ?? -1) + 1);
    if (c[2] === 'image' && /rgb|cmyk/.test(c[5]) && Number(c[3]) >= 600 && Number(c[4]) >= 350) {
      const area = Number(c[3]) * Number(c[4]);
      if (!best[page] || area > best[page].area) best[page] = { idx, area };
    }
  }
  return best;
}

async function uploadPicture(file, pdf, page, idx) {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litpic-'));
  spawnSync('pdfimages', ['-png', '-f', String(page), '-l', String(page), file, path.join(tmp, 'p')]);
  const png = path.join(tmp, `p-${String(idx).padStart(3, '0')}.png`);
  if (!fs.existsSync(png)) return null;
  const up = await cloudinary.uploader.upload(png, { public_id: `aivorah/book-images/${pdf.replace('.pdf', '')}-p${page}-${idx}`, overwrite: true });
  return up.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_1000/');
}

function headingFor(subject, kind) {
  const hi = { intro: 'शुरू करने से पहले', outro: 'हमने क्या सीखा' };
  const ur = { intro: 'شروع کرنے سے پہلے', outro: 'ہم نے کیا سیکھا' };
  const en = { intro: 'Before we begin', outro: 'What we learned' };
  return (/hindi|sanskrit/i.test(subject) ? hi : /urdu/i.test(subject) ? ur : en)[kind];
}


const chunkPrompt = (unit, book, from, to, titles) => `The attached PDF is pages ${from}-${to} of Unit ${unit.unit_no} of the NCERT Grade ${unit.grade} ${unit.subject} textbook "${book}". The unit's sections are: ${titles.map((t) => `"${t}"`).join(', ')}.
COPY EXACTLY the COMPLETE main text on these pages, in reading order - every paragraph, poem line and dialogue line. Leave out only exercises/questions, activity boxes, margin glossary and page headers. If these pages hold only exercises, return {"scenes":[]}.
Split it into scenes of 3-10 lines with a short "heading" you write, and give each scene the "section" title it belongs to (one of the titles above). Each line: {"speaker": character name for dialogue or "Narrator", "text": at most ~45 words copied exactly, "page": page number in the WHOLE unit (the first attached page is page ${from}), "direction": printed stage direction if any}.
Each scene gets a "visual" explaining it (same kinds as before: flow, web, compare, cause_effect, timeline, venn; labels at most 12 words, same language).
Language: ${language(unit.subject)}. Output ONLY JSON: {"scenes":[{"section":"...","heading":"...","lines":[...],"visual":{...}}]}`;

// Long units: read the pages in windows so the whole book text comes back, then file each scene under its section.
async function chunkScenes(unit, book, file, pages, titles, english, hay) {
  const bySection = new Map();
  let chars = 0; let kept = 0; let dropped = 0;
  for (let from = 1; from <= pages; from += 6) {
    const to = Math.min(pages, from + 5);
    let parsed;
    for (let i = 0; i < 2 && !parsed; i += 1) {
      const r = await gemini(cutPages(file, from, to), chunkPrompt(unit, book, from, to, titles));
      try { parsed = parseJsonLoose(r.text); } catch { /* retry */ }
    }
    for (const sc of parsed?.scenes || []) {
      const title = titles.find((t) => t === sc.section) || titles.find((t) => String(sc.section || '').includes(t) || t.includes(String(sc.section || ''))) || titles[0];
      const lines = (sc.lines || []).filter((l) => String(l.text || '').trim()).filter((l) => {
        if (!english) return true;
        const ok = hay.includes(norm(l.text));
        if (ok) kept += 1; else dropped += 1;
        return ok;
      }).flatMap((l) => {
        const base = { speaker: String(l.speaker || 'Narrator').trim() || 'Narrator', page: Number.isInteger(l.page) && l.page >= from && l.page <= to ? l.page : from, ...(l.direction ? { direction: String(l.direction) } : {}) };
        const out = [];
        for (const part of String(l.text).trim().split(/(?<=[.!?\u0964\u06D4])\s+/).filter(Boolean)) {
          const last = out[out.length - 1];
          if (last && last.text.split(/\s+/).length + part.split(/\s+/).length <= 30) last.text += ` ${part}`;
          else out.push({ ...base, text: part });
        }
        return out;
      });
      chars += lines.reduce((a, l) => a + l.text.replace(/\s+/g, '').length, 0);
      if (!lines.length) continue;
      if (!bySection.has(title)) bySection.set(title, []);
      bySection.get(title).push({ card: null, heading: String(sc.heading || title), text: lines.map((l) => l.text).join(' '), lines, ...(sc.visual?.kind ? { visual: sc.visual } : {}) });
    }
  }
  return { bySection, chars, kept, dropped };
}

// One call per unit: every section's complete book text as scenes. Retries when too little of the book came back.
async function buildUnit(rows, book, bookPath) {
  const unit = rows[0];
  const file = await pdfFor(unit.pdf_file, bookPath);
  if (!file) throw new Error('PDF missing');
  const pages = Number((spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout.match(/Pages:\s+(\d+)/) || [])[1] || 1);
  const raw = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8', maxBuffer: 1 << 27 }).stdout || '';
  const english = /english/i.test(unit.subject);
  const hay = ` ${norm(raw)} `;
  const bookChars = raw.replace(/\s+/g, '').length;
  const titles = rows.map((r) => r.section_title);
  const pdfB64 = fs.readFileSync(file).toString('base64');
  if (pdfB64.length > 19e6) throw new Error('PDF too large for one call');
  let best = null;
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await gemini(pdfB64, prompt(unit, book, pages, titles) + feedback);
    let parsed;
    try { parsed = parseJsonLoose(r.text); } catch { feedback = '\n\nYour last reply was not valid JSON. Output valid JSON only.'; continue; }
    let kept = 0; let dropped = 0; let chars = 0;
    const bySection = new Map();
    for (const sec of parsed.sections || []) {
      const title = titles.find((t) => t === sec.title) || titles.find((t) => String(sec.title || '').includes(t) || t.includes(String(sec.title || '')));
      if (!title) continue;
      const scenes = [];
      for (const sc of sec.scenes || []) {
        const lines = (sc.lines || []).filter((l) => String(l.text || '').trim()).filter((l) => {
          if (!english) return true;
          const ok = hay.includes(norm(l.text));
          if (ok) kept += 1; else dropped += 1;
          return ok;
        }).map((l) => ({ speaker: String(l.speaker || 'Narrator').trim() || 'Narrator', text: String(l.text).trim(),
          page: Number.isInteger(l.page) && l.page >= 1 && l.page <= pages ? l.page : 1, ...(l.direction ? { direction: String(l.direction) } : {}) }));
        // A paragraph given as one line is split at sentence ends so it is read and highlighted sentence by sentence.
        const split = lines.flatMap((l) => {
          const parts = l.text.split(/(?<=[.!?।۔])\s+/).filter(Boolean);
          const out = [];
          for (const part of parts) {
            const last = out[out.length - 1];
            if (last && last.text.split(/\s+/).length + part.split(/\s+/).length <= 30) last.text += ` ${part}`;
            else out.push({ ...l, text: part });
          }
          return out.length ? out : [l];
        });
        lines.splice(0, lines.length, ...split);
        chars += lines.reduce((a2, l) => a2 + l.text.replace(/\s+/g, '').length, 0);
        if (lines.length) scenes.push({ card: null, heading: String(sc.heading || title), text: lines.map((l) => l.text).join(' '), lines, ...(sc.visual?.kind ? { visual: sc.visual } : {}) });
      }
      const own = (arr) => (arr || []).filter((l) => l && String(l.text || '').trim()).map((l) => ({ speaker: 'Narrator', text: String(l.text).trim(), page: 1 }));
      const intro = own(sec.intro);
      const outro = own(sec.outro);
      if (!scenes.length) continue;
      bySection.set(title, [
        ...(intro.length ? [{ card: null, heading: headingFor(unit.subject, 'intro'), text: intro.map((l) => l.text).join(' '), lines: intro }] : []),
        ...scenes,
        ...(outro.length ? [{ card: null, heading: headingFor(unit.subject, 'outro'), text: outro.map((l) => l.text).join(' '), lines: outro }] : []),
      ]);
    }
    // Share of the unit's printed text that is read aloud (exercises, glossary and headers are left out, so ~40-80% is normal).
    const coverage = chars / Math.max(1, bookChars);
    const result = { bySection, model: r.model, coverage, kept, dropped };
    if (!best || coverage > best.coverage) best = result;
    if (coverage >= 0.45 && bySection.size) break;
    feedback = `\n\nYour last reply covered only ${Math.round(coverage * 100)}% of the book text. Copy the COMPLETE main text of every section - every paragraph and line - not a sample.`;
  }
  if ((!best || best.coverage < 0.35) && pages > 8) {
    // Keep the whole-unit intro and recap; replace the body with the page-window text.
    const c = await chunkScenes(unit, book, file, pages, titles, english, hay);
    const coverage = c.chars / Math.max(1, bookChars);
    if (c.bySection.size && (!best || coverage > best.coverage)) {
      const merged = new Map();
      for (const t of titles) {
        const body = c.bySection.get(t);
        const old = best?.bySection.get(t) || [];
        const intro = old.filter((sc) => sc.heading === headingFor(unit.subject, 'intro'));
        const outro = old.filter((sc) => sc.heading === headingFor(unit.subject, 'outro'));
        if (body?.length) merged.set(t, [...intro, ...body, ...outro]);
        else if (old.length) merged.set(t, old);
      }
      best = { bySection: merged, model: `${best?.model || ''}+chunks`, coverage, kept: c.kept, dropped: c.dropped };
    }
  }
  if (!best || !best.bySection.size) throw new Error('no section passed');
  // The book's own pictures replace diagrams on the first scene that reaches their page.
  if (WRITE) {
    const pics = bookPictures(file, 1, pages);
    const used = new Set();
    for (const listen of best.bySection.values()) {
      for (const sc of listen) {
        if (!sc.lines.some((l) => l.speaker !== 'Narrator' || sc.visual)) continue;
        const page = [...new Set(sc.lines.map((l) => l.page))].find((p) => pics[p] && !used.has(p));
        if (page == null) continue;
        used.add(page);
        const url = await uploadPicture(file, unit.pdf_file, page, pics[page].idx).catch(() => null);
        if (url) sc.visual = { kind: 'image', url, caption: `From the book, page ${page}.`, page, title: sc.heading };
      }
    }
  }
  return best;
}

(async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'book-catalog.json'), 'utf8'));
  const books = cat.books || cat;
  const paths = {};
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'curricula')).filter((x) => x.endsWith('-chapters.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'curricula', f), 'utf8'));
    for (const c of j.chapters || []) paths[c.pdfFile] = c.bookPath;
  }
  const { data, error } = await supabase.from('unit_content_sections').select('id, grade, subject, book_code, pdf_file, unit_no, section_no, section_title, page_from, page_to')
    .in('subject', SUBJECTS).in('grade', GRADES);
  if (error) throw new Error(error.message);
  const rows = data.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject) || a.pdf_file.localeCompare(b.pdf_file) || a.section_no - b.section_no);
  const units = new Map();
  for (const r of rows) { if (!units.has(r.pdf_file)) units.set(r.pdf_file, []); units.get(r.pdf_file).push(r); }
  console.log(`literature units: ${units.size} (${rows.length} sections); keys: ${loadKeys().length}; write: ${WRITE}`);
  let n = 0;
  for (const [pdf, secs] of units) {
    if (LIMIT && n >= LIMIT) break;
    const done = path.join(OUT, `${pdf}.json`);
    if (fs.existsSync(done)) continue;
    n += 1;
    try {
      const t0 = Date.now();
      const r = await buildUnit(secs, books[secs[0].book_code]?.title || secs[0].book_code, paths[pdf]);
      let saved = 0;
      for (const row of secs) {
        const listen = r.bySection.get(row.section_title);
        if (!listen) continue;
        if (WRITE) {
          const { error: e2 } = await supabase.from('unit_content_sections').update({ listen, updated_at: new Date().toISOString() }).eq('id', row.id);
          if (e2) throw new Error(e2.message);
        }
        saved += 1;
      }
      const lines = [...r.bySection.values()].flat().reduce((a2, sc) => a2 + sc.lines.length, 0);
      fs.writeFileSync(done, JSON.stringify({ pdf, grade: secs[0].grade, subject: secs[0].subject, coverage: r.coverage, sections: Object.fromEntries(r.bySection) }));
      console.log(`G${secs[0].grade} ${secs[0].subject} ${pdf} [${r.model} ${Math.round((Date.now() - t0) / 1000)}s]: ${saved}/${secs.length} sections, ${lines} lines, book text covered ${Math.round(r.coverage * 100)}%${/english/i.test(secs[0].subject) ? `, verbatim kept ${r.kept} dropped ${r.dropped}` : ''}${WRITE ? ', saved' : ''}`);
    } catch (e) {
      console.log(`G${secs[0].grade} ${secs[0].subject} ${pdf}: FAILED ${String(e.message).slice(0, 140)}`);
    }
  }
  console.log('DONE');
})().catch((e) => { console.error(e); process.exitCode = 1; });
