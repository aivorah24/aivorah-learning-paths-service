// Gives every scene of a lesson's Listen script a visual: the book's own picture from that scene's pages when there is
// one, otherwise a diagram (flow, venn, table, timeline, cause_effect, compare, web) drawn by the app from facts in
// the scene, written in words the grade can read. Visuals that are too wordy or not grounded in the scene are dropped.
// Usage: node scripts/add-scene-visuals.cjs --grade 8 --subject English --topic "The Battle of Badgam" --pdf hepr102.pdf \
//          --env-file ../aivorah-students-service/.env [--write]
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

const GRADE_NO = Number(arg('--grade') || 8);
const GRADE = `Grade ${GRADE_NO}`;
const SUBJECT = arg('--subject') || 'English';
const TOPIC = arg('--topic');
const PDF = arg('--pdf');
const WRITE = process.argv.includes('--write');
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
// Longest label a student of this grade should read at a glance.
const MAX_WORDS = GRADE_NO <= 3 ? 6 : GRADE_NO <= 5 ? 8 : GRADE_NO <= 8 ? 12 : 16;

const STOP = new Set('the a an and or of to in on at is was were be been it its this that with for as by from he she they his her their them we you i not but so are has had have do did into out up one two'.split(' '));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

function bookPictures(pages) {
  const file = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), PDF);
  const list = spawnSync('pdfimages', ['-list', '-f', String(Math.min(...pages)), '-l', String(Math.max(...pages)), file], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const byPage = {};
  for (const ln of list.split('\n').slice(2)) {
    const c = ln.trim().split(/\s+/);
    if (c.length < 10) continue;
    const page = Number(c[0]);
    (byPage[page] ||= []).push({ type: c[2], w: Number(c[3]), h: Number(c[4]), color: c[5] });
  }
  const best = {};
  for (const [page, rows] of Object.entries(byPage)) {
    rows.forEach((r, idx) => {
      if (r.type === 'image' && /rgb|cmyk/.test(r.color) && r.w >= 600 && r.h >= 350 && (!best[page] || r.w * r.h > best[page].area)) best[page] = { idx, area: r.w * r.h };
    });
  }
  return best;
}

async function uploadPicture(page, idx) {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
  const file = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), PDF);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenepic-'));
  spawnSync('pdfimages', ['-png', '-f', String(page), '-l', String(page), file, path.join(tmp, 'p')]);
  const png = path.join(tmp, `p-${String(idx).padStart(3, '0')}.png`);
  if (!fs.existsSync(png)) return null;
  const up = await cloudinary.uploader.upload(png, { public_id: `aivorah/book-images/${PDF.replace('.pdf', '')}-p${page}-${idx}`, overwrite: true });
  return up.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_1000/');
}

function prompt(scenes) {
  const body = scenes.map((s) => `### SCENE ${s.i}: ${s.heading}\n${s.text.slice(0, 1800)}`).join('\n\n');
  return `You design ONE visual per scene for ${GRADE} students listening to a ${SUBJECT} lesson ("${TOPIC}"). The student hears the scene and looks at the visual, so it must make the scene EASY to understand for a ${GRADE} student.

Pick the kind that best explains that scene:
- flow: steps or events in order. {"kind":"flow","title":"...","steps":["...","..."]} (2-6 steps)
- venn: two people/things compared, with what they share. {"kind":"venn","title":"...","left":{"label":"...","items":["..."]},"right":{"label":"...","items":["..."]},"both":["..."]} (1-3 items each)
- table: facts with 2-3 columns. {"kind":"table","title":"...","headers":["...","..."],"rows":[["...","..."]]} (2-6 rows)
- timeline: dated events. {"kind":"timeline","title":"...","events":[{"when":"...","what":"..."}]}
- cause_effect: why something happened. {"kind":"cause_effect","title":"...","pairs":[{"cause":"...","effect":"..."}]}
- compare: two or three sides side by side. {"kind":"compare","title":"...","columns":[{"label":"...","points":["..."]}]}
- web: a character, idea or place with its features. {"kind":"web","title":"...","center":"...","nodes":[{"label":"...","note":"..."}]}

RULES
1. Use ONLY facts stated in that scene's text. Do not add outside facts, dates or names.
2. Words a ${GRADE} student knows. Every label, item, step or cell is at most ${MAX_WORDS} words. Titles at most 6 words, phrased as a question or a plain heading (e.g. "Why was the airport important?").
3. Vary the kinds across the lesson; do not use the same kind for every scene.
4. If a scene is only a greeting or has no content worth a picture, give null.
Output ONLY JSON: {"visuals":[{"scene":0,"visual":{...}}, ...]}

SCENES
${body}`;
}

async function gemini(text) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
        signal: AbortSignal.timeout(180000),
      }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
      const j = await r.json();
      if (r.ok) return { model, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' };
      lastErr = `${model} ${r.status}`;
      if (r.status === 429 || r.status === 503 || r.status === 0) await new Promise((res) => setTimeout(res, 15000));
      else break;
    }
  }
  throw new Error(`Gemini unavailable (${lastErr})`);
}

// Every string in the visual, so it can be checked for length and grounding.
function texts(v) {
  const out = [v.title];
  const walk = (x) => { if (typeof x === 'string') out.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.entries(x).forEach(([k, y]) => { if (k !== 'kind') walk(y); }); };
  walk({ ...v, title: undefined });
  return out.filter(Boolean);
}

function check(v, sceneText) {
  if (!v || typeof v !== 'object' || !v.kind) return 'empty';
  const parts = texts(v);
  const long = parts.find((t) => t.split(/\s+/).length > (t === v.title ? 8 : MAX_WORDS));
  if (long) return `too wordy for ${GRADE}: "${long}"`;
  const src = new Set(words(sceneText));
  const content = parts.flatMap(words);
  const grounded = content.filter((w) => src.has(w) || src.has(w.replace(/s$/, '')) || src.has(`${w}s`)).length;
  if (content.length && grounded / content.length < 0.45) return `not grounded in the scene (${Math.round((grounded / content.length) * 100)}% of words)`;
  return null;
}

async function main() {
  const supabase = require('../services/supabase');
  const key = { curriculum: 'CBSE', grade: GRADE, subject: SUBJECT, topic: TOPIC };
  const { data, error } = await supabase.from('topic_ai_enrichment').select('structured_content').match(key).single();
  if (error) throw new Error(`no lesson row for "${TOPIC}": ${error.message}`);
  const sc = data.structured_content;
  const script = sc.listenScript || [];
  if (!script.length) throw new Error('lesson has no Listen script yet');

  // 1. Book pictures: the first scene that reaches a page with a picture gets it.
  const usedPages = new Set();
  const scenePages = script.map((s) => [...new Set((s.lines || []).map((l) => l.page).filter(Number.isInteger))]);
  const allPages = scenePages.flat();
  const pics = PDF && allPages.length ? bookPictures(allPages) : {};
  const visuals = script.map(() => null);
  for (let i = 0; i < script.length; i += 1) {
    if (/before we begin|what we learned/i.test(script[i].heading)) continue;
    const page = scenePages[i].find((p) => pics[p] && !usedPages.has(p));
    if (page == null) continue;
    usedPages.add(page);
    const url = WRITE ? await uploadPicture(page, pics[page].idx) : `(book picture p${page})`;
    if (url) visuals[i] = { kind: 'image', url, caption: `From the book, page ${page}.`, page, title: script[i].heading };
  }

  // 2. Drawn diagrams for the rest.
  const need = script.map((s, i) => ({ i, heading: s.heading, text: s.text })).filter((s) => !visuals[s.i]);
  let dropped = 0;
  if (need.length) {
    const { model, text } = await gemini(prompt(need));
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { throw new Error(`${model} did not return JSON`); }
    for (const item of parsed.visuals || []) {
      const s = script[item.scene];
      if (!s || visuals[item.scene] || !item.visual) continue;
      const why = check(item.visual, `${s.heading} ${s.text}`);
      if (why) { dropped += 1; console.log(`  scene ${item.scene} dropped: ${why}`); continue; }
      visuals[item.scene] = item.visual;
    }
    console.log(`diagrams from ${model}`);
  }

  const kinds = visuals.map((v) => (v ? v.kind : '-'));
  console.log(`scenes: ${script.length}; visuals: ${kinds.filter((k) => k !== '-').length} [${kinds.join(', ')}]; dropped by checks: ${dropped}`);
  if (!WRITE) { console.log(JSON.stringify(visuals.filter(Boolean).slice(0, 3), null, 1)); console.log('DRY RUN: not saved. Re-run with --write.'); return; }

  const listenScript = script.map((s, i) => {
    const { visual: _old, ...rest } = s;
    return visuals[i] ? { ...rest, visual: visuals[i] } : rest;
  });
  const { error: e2 } = await supabase.from('topic_ai_enrichment').update({ structured_content: { ...sc, listenScript }, updated_at: new Date().toISOString() }).match(key);
  if (e2) throw new Error(e2.message);
  console.log('SAVED visuals to', TOPIC);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
