// Builds the Listen "play script" for one textbook piece (play, story, essay or poem) with Gemini, keeping the
// book's own wording: every non-own line must appear word-for-word on its PDF page or it is dropped.
// Usage: node scripts/build-piece-script.cjs --pdf hepr102.pdf --pages 1-12 --type essay --title "..." \
//          --grade 8 --subject English --topic "The Battle of Badgam" --env-file ../aivorah-students-service/.env [--write]
// PDFs are read from $NCERT_CHAPTER_CACHE (default: OS temp dir). --write saves listenScript (+ pdfPage) into the topic's
// existing topic_ai_enrichment row; run enrich-one-topic.cjs first so the row has its Learn blocks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ENV_FILE = arg('--env-file');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config();

const PDF = arg('--pdf');
const [FROM, TO] = (arg('--pages') || '1-1').split('-').map(Number);
const TYPE = arg('--type') || 'essay';
const TITLE = arg('--title');
const GRADE = `Grade ${arg('--grade') || 8}`;
const SUBJECT = arg('--subject') || 'English';
const TOPIC = arg('--topic');
const BOOK = arg('--book') || 'Poorvi';
const UNIT = arg('--unit') || '';
const WRITE = process.argv.includes('--write');
const OUT = arg('--out');
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];

const norm = (s) => String(s).toLowerCase().replace(/[‘’“”"'`]/g, '').replace(/[–—-]+/g, ' ').replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

function pageTexts() {
  const file = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), PDF);
  const out = {};
  for (let p = FROM; p <= TO; p += 1) {
    const t = spawnSync('pdftotext', ['-f', String(p), '-l', String(p), file, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
    const unitTitle = UNIT.split(',').pop().trim().toLowerCase();
    out[p] = t.replace(/\r/g, '').replace(/Reprint 20\d\d-\d\d/g, '').split('\n')
      .filter((ln) => !/^\s*\d{1,3}\s*$/.test(ln) && !/^\s*poorvi\s*$/i.test(ln) && !(unitTitle && ln.trim().toLowerCase() === unitTitle))
      .join('\n');
  }
  return out;
}

const SHAPE = {
  play: 'Speakers are the characters in the play; stage directions are lines with "stage": true spoken by "Narrator"; a spoken cue in brackets such as (Smiling) goes in "direction".',
  story: 'Narration is read by "Narrator". Words inside quotation marks are spoken by the named character (use the name from the text; if unclear use "Character"). Give "direction" only when the text states how something is said.',
  essay: 'Everything is read by "Narrator", except a quotation attributed to a named person, which uses that person\'s name as the speaker.',
  poem: 'Everything is read by "Narrator", one poem line or short group of lines per item.',
};

function buildPrompt(pages) {
  const body = Object.entries(pages).map(([p, t]) => `=== PDF PAGE ${p} ===\n${t.trim()}`).join('\n\n');
  return `You are turning one ${TYPE} from an NCERT ${GRADE} ${SUBJECT} textbook (${BOOK}, ${UNIT}) titled "${TITLE}" into a Listen script for students to hear.

RULES
1. Each item in "lines" is a piece of the piece's own text COPIED WORD FOR WORD from the page text below (same words, same order). Do not paraphrase, fix, translate or merge words. You may drop glossary words in the page margins, activity boxes, exercises ("Let us..."), captions and page headers - only the main reading text is read.
2. Cover ALL of the main reading text of every page, in order - do not summarise, skip or shorten any paragraph. Split long paragraphs into items of at most ~45 words, cutting at sentence ends. Keep the reading order.
3. ${SHAPE[TYPE] || SHAPE.essay}
4. Every item has "page" = the PDF PAGE number it appears on.
5. Group items into 3 to 8 scenes with a short heading of 2 to 6 words that you write (e.g. "The Morning of the Battle").
6. Also write "intro": 3 or 4 short spoken items in simple words for a ${GRADE} student (your own words, "own": true): name the book "${BOOK}" and the piece "${TITLE}", what it is about in one or two sentences, and 1 or 2 hard words from the glossary with meanings copied from the glossary; and "outro": 2 or 3 items in your own words ("own": true) summing up what the student should remember and one question to think about. Use only facts in the page text.
7. Output ONLY JSON: {"intro":[{"speaker":"Narrator","text":"...","own":true}],"scenes":[{"heading":"...","lines":[{"speaker":"Narrator","text":"...","page":2,"direction":"optional","stage":false}]}],"outro":[...]}

PAGE TEXT
${body}`;
}

async function gemini(prompt) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
        signal: AbortSignal.timeout(240000),
      });
      const j = await r.json();
      if (r.ok) return { model, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' };
      lastErr = `${model} ${r.status}`;
      if (r.status === 429 || r.status === 503) await new Promise((res) => setTimeout(res, 15000));
      else break;
    }
  }
  throw new Error(`Gemini unavailable (${lastErr})`);
}

// Keeps only lines whose words are on their claimed page (or, failing that, any page in range).
function verify(script, pages) {
  const hay = Object.fromEntries(Object.entries(pages).map(([p, t]) => [p, norm(t)]));
  const all = Object.values(hay).join(' ');
  let kept = 0; const dropped = [];
  for (const scene of script.scenes || []) {
    scene.lines = (scene.lines || []).filter((l) => {
      const n = norm(l.text || '');
      const ok = n && ((hay[l.page] || '').includes(n) || all.includes(n));
      if (ok) { kept += 1; if (!(hay[l.page] || '').includes(n)) { const p = Object.keys(hay).find((k) => hay[k].includes(n)); if (p) l.page = Number(p); } } else dropped.push(l.text);
      return ok;
    });
  }
  script.scenes = (script.scenes || []).filter((s) => s.lines.length);
  return { kept, dropped };
}


// Pulls the largest full-colour illustrations from the piece's pages and uploads them to Cloudinary.
async function bookImages(max) {
  if (!max) return [];
  const file = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), PDF);
  const list = spawnSync('pdfimages', ['-list', '-f', String(FROM), '-l', String(TO), file], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const perPage = {};
  for (const ln of list.split('\n').slice(2)) {
    const c = ln.trim().split(/\s+/);
    if (c.length < 10) continue;
    const page = Number(c[0]);
    (perPage[page] ||= []).push({ type: c[2], w: Number(c[3]), h: Number(c[4]), color: c[5] });
  }
  const picks = [];
  for (const [page, rows] of Object.entries(perPage)) {
    rows.forEach((r, idx) => {
      if (r.type === 'image' && /rgb|cmyk/.test(r.color) && r.w >= 600 && r.h >= 350) picks.push({ page: Number(page), idx, area: r.w * r.h });
    });
  }
  picks.sort((a, b) => b.area - a.area);
  const chosen = picks.slice(0, max).sort((a, b) => a.page - b.page);
  if (!chosen.length) return [];
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookimg-'));
  const out = [];
  for (const c of chosen) {
    spawnSync('pdfimages', ['-png', '-f', String(c.page), '-l', String(c.page), file, path.join(tmp, `p${c.page}`)]);
    const png = path.join(tmp, `p${c.page}-${String(c.idx).padStart(3, '0')}.png`);
    if (!fs.existsSync(png)) continue;
    const up = await cloudinary.uploader.upload(png, { public_id: `aivorah/book-images/${PDF.replace('.pdf', '')}-p${c.page}-${c.idx}`, overwrite: true });
    out.push({ type: 'image', url: up.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_1000/'), caption: `Illustration from the book, page ${c.page}.` });
  }
  return out;
}

async function main() {
  const pages = pageTexts();
  const chars = Object.values(pages).join('').length;
  console.log(`read pages ${FROM}-${TO}: ${chars} chars`);
  // Long pieces time out or come back cut short in one call, so work a few pages at a time.
  const CHUNK = Number(arg('--chunk') || 4);
  const nums = Object.keys(pages).map(Number).sort((x, y) => x - y);
  const script = { intro: [], scenes: [], outro: [] };
  let keptChars = 0;
  for (let i = 0; i < nums.length; i += CHUNK) {
    const part = Object.fromEntries(nums.slice(i, i + CHUNK).map((n) => [n, pages[n]]));
    const first = i === 0;
    const last = i + CHUNK >= nums.length;
    let prompt = buildPrompt(part);
    if (!first) prompt += '\n\nThis is a LATER part of the piece: return "intro": [] and do not re-introduce it.';
    if (!last) prompt += '\n\nThis is NOT the end of the piece: return "outro": [].';
    let best = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { model, text } = await gemini(prompt);
      let parsed;
      try { parsed = JSON.parse(text); } catch { prompt += '\n\nYour last answer was not valid JSON. Output ONLY the JSON object.'; continue; }
      const report = verify(parsed, part);
      console.log(`pages ${nums[i]}-${nums[Math.min(i + CHUNK, nums.length) - 1]} ${model}: kept ${report.kept}, dropped ${report.dropped.length}`);
      best = parsed;
      if (report.dropped.length <= Math.max(2, report.kept * 0.05)) break;
      prompt += `\n\nThese items were NOT word-for-word in the page text and were removed: ${JSON.stringify(report.dropped.slice(0, 8))}. Redo the whole JSON copying exactly.`;
    }
    if (!best) throw new Error(`no valid script for pages from ${nums[i]}`);
    if (first) script.intro = best.intro || [];
    if (last) script.outro = best.outro || [];
    script.scenes.push(...(best.scenes || []));
    keptChars += (best.scenes || []).reduce((acc, sc) => acc + sc.lines.reduce((x, l) => x + norm(l.text).length, 0), 0);
  }
  // Share of the pages' text that is read aloud; margins, glossary and exercises are left out, so ~40-70% is normal.
  const coverage = keptChars / Math.max(1, norm(Object.values(pages).join(' ')).length);
  console.log(`coverage: ${Math.round(coverage * 100)}% of page text`);
  if (coverage < Number(arg('--min-coverage') || 0.25)) throw new Error(`coverage too low (${Math.round(coverage * 100)}%): script is missing book text`);

  const listenScript = [];
  const mk = (heading, lines) => ({ card: null, heading, text: lines.map((l) => l.text).join(' '), lines });
  const clean = (l, fallbackPage) => ({
    speaker: l.speaker || 'Narrator', text: String(l.text).trim(), page: Number.isInteger(l.page) ? l.page : fallbackPage,
    ...(l.direction ? { direction: String(l.direction) } : {}), ...(l.stage ? { stage: true } : {}),
  });
  if (script.intro?.length) listenScript.push(mk('Before we begin', script.intro.map((l) => clean(l, FROM))));
  for (const s of script.scenes) listenScript.push(mk(s.heading, s.lines.map((l) => clean(l, FROM))));
  if (script.outro?.length) listenScript.push(mk('What we learned', script.outro.map((l) => clean(l, TO))));
  const n = listenScript.reduce((a, s) => a + s.lines.length, 0);
  console.log(`script: ${listenScript.length} scenes, ${n} lines, ~${Math.round(listenScript.reduce((a, s) => a + s.text.split(/\s+/).length, 0) / 2.6 / 60)} min`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(listenScript, null, 1));
  if (!WRITE) { console.log('DRY RUN: not saved. Re-run with --write.'); return; }

  const supabase = require('../services/supabase');
  const key = { curriculum: 'CBSE', grade: GRADE, subject: SUBJECT, topic: TOPIC };
  const { data, error } = await supabase.from('topic_ai_enrichment').select('structured_content').match(key).single();
  if (error) throw new Error(`no lesson row for "${TOPIC}" (run enrich-one-topic first): ${error.message}`);
  const images = await bookImages(Number(arg('--images') ?? 2));
  const oldBlocks = (data.structured_content.blocks || []).filter((b) => !(b.type === 'image' && /\/book-images\//.test(b.url || '')));
  const at = oldBlocks.findIndex((b) => b.type === 'overview') + 1;
  const blocks = [...oldBlocks.slice(0, at), ...images, ...oldBlocks.slice(at)];
  console.log(`textbook pictures added: ${images.length}`);
  const sc = { ...data.structured_content, blocks, listenScript, pdfPage: FROM };
  const { error: e2 } = await supabase.from('topic_ai_enrichment').update({ structured_content: sc, updated_at: new Date().toISOString() }).match(key);
  if (e2) throw new Error(e2.message);
  console.log('SAVED listenScript to', TOPIC);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
