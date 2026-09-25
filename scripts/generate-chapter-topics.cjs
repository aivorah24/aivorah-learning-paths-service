// Pilot: grounded topic + explanation generation for chapters that have no lessons yet.
// Reads each chapter from its official NCERT PDF (OCR for Hindi), asks the LLM for topics using ONLY that text,
// keeps a topic only if its quote and key terms appear in the source. Writes JSON files only — nothing goes to Qdrant.
// Usage: node scripts/generate-chapter-topics.cjs --grade 8 --codes hees2,hekr1 --out <dir> [--limit N] [--dry] [--force]
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sm = require('../services/syllabus-map');
const ct = require('./lib/chapterTopics.cjs');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const GRADE = Number(arg('--grade') || 8);
const CODES = (arg('--codes') || '').split(',').filter(Boolean);
const OUT = arg('--out') || path.join(os.tmpdir(), 'ncert-topics');
const CACHE = process.env.NCERT_CHAPTER_CACHE || path.join(os.tmpdir(), 'ncert-chapters');
const LIMIT = Number(arg('--limit') || 0);
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
fs.mkdirSync(path.join(OUT, '_sections'), { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

const isHindi = (pdfFile) => String(pdfFile)[1] === 'h';

async function download(pdfFile) {
  const file = path.join(CACHE, pdfFile);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(`https://ncert.nic.in/textbook/pdf/${pdfFile}`, { signal: AbortSignal.timeout(120000) });
      if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

function pdfText(file, pdfFile) {
  if (isHindi(pdfFile)) {
    const cache = `${file}.hin.txt`;
    if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
    const r = spawnSync('python', [path.join(__dirname, 'ncert_ocr_pages.py'), file, 'hin+eng'], { maxBuffer: 1 << 28, encoding: 'utf8', timeout: 900000 });
    let text = '';
    try { text = Object.values(JSON.parse(r.stdout)).join('\n\n'); } catch { text = ''; }
    if (text) fs.writeFileSync(cache, text);
    return text;
  }
  const r = spawnSync('pdftotext', [file, '-'], { maxBuffer: 1 << 28, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

const callGemini = (model) => async (prompt) => {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(JSON.stringify(j.error || j).slice(0, 160)), { status: r.status });
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
};

const callGroq = (model) => async (prompt) => {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 3500, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(JSON.stringify(j.error || j).slice(0, 160)), { status: r.status });
  return j.choices?.[0]?.message?.content || '';
};

// Free-tier pacing: Gemini 5 requests/min; Groq 8k tokens/min per model.
const providers = [
  { name: 'gemini-lite', gap: 13000, fn: callGemini('gemini-flash-lite-latest'), next: 0, cooldown: 0 },
  { name: 'groq-120b', gap: 30000, fn: callGroq('openai/gpt-oss-120b'), next: 0, cooldown: 0 },
  { name: 'groq-20b', gap: 30000, fn: callGroq('openai/gpt-oss-20b'), next: 0, cooldown: 0 },
  { name: 'groq-qwen', gap: 30000, fn: callGroq('qwen/qwen3.8-27b'), next: 0, cooldown: 0 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(p, queue, stats) {
  while (queue.length) {
    // Wait for this provider's turn BEFORE taking work, so a rate-limited provider never sits on a task.
    const wait = Math.max(p.next, p.cooldown) - Date.now();
    if (wait > 0) await sleep(wait);
    const task = queue.shift();
    if (!task) break;
    p.next = Date.now() + p.gap;
    try {
      const raw = await p.fn(task.prompt);
      const parsed = ct.parseJson(raw);
      if (!parsed || !Array.isArray(parsed.topics)) throw new Error('unparseable');
      task.provider = p.name;
      task.topics = parsed.topics;
      fs.writeFileSync(task.cacheFile, JSON.stringify({ provider: p.name, topics: parsed.topics }));
      stats.done += 1;
    } catch (e) {
      task.attempts = (task.attempts || 0) + 1;
      task.lastErr = e.status || String(e.message).slice(0, 40);
      if (e.status === 429) p.cooldown = Date.now() + 65000;
      if (e.status === 503) p.cooldown = Date.now() + 30000;
      if (task.attempts < 10) queue.push(task); else { task.failed = e.message; stats.done += 1; }
    }
    console.log(`[${stats.done}/${stats.total}] ${task.code} §${task.idx + 1}/${task.of} ${p.name} ${task.topics ? `ok raw=${task.topics.length}` : task.failed ? `FAILED ${task.failed}` : `retry(${task.lastErr})`}`);
  }
}

async function main() {
  const targets = [];
  for (const { subject } of sm.subjectsFor(`Grade ${GRADE}`)) {
    const seen = new Set();
    for (const c of sm.chaptersFor(GRADE, subject)) {
      if (seen.has(c.chapter)) continue;
      seen.add(c.chapter);
      const code = String(c.pdfFile).replace(/\.pdf$/i, '');
      if (CODES.length && !CODES.some((x) => code.startsWith(x))) continue;
      targets.push({ ...c, code, subject });
    }
  }
  const chosen = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`chapters selected: ${chosen.length}`);

  const tasks = [];
  const chapters = [];
  for (const c of chosen) {
    const outFile = path.join(OUT, `${c.code}.json`);
    if (!FORCE && fs.existsSync(outFile)) { console.log(`skip ${c.code} (already generated)`); continue; }
    const file = await download(c.pdfFile);
    if (!file) { console.log(`skip ${c.code}: download failed`); continue; }
    const text = pdfText(file, c.pdfFile);
    const sections = ct.splitSections(text, isHindi(c.pdfFile) ? 6000 : 10000);
    const ch = { c, outFile, sections: sections.length, tasks: [] };
    sections.forEach((s, idx) => {
      const cacheFile = path.join(OUT, '_sections', `${c.code}_${idx}.json`);
      const t = { cacheFile, code: c.code, idx, of: sections.length, text: s, prompt: ct.buildPrompt({ grade: GRADE, subject: c.subject, book: c.book, title: c.title, script: isHindi(c.pdfFile) ? 'Devanagari' : 'Latin', text: s }) };
      ch.tasks.push(t);
      if (fs.existsSync(cacheFile)) { const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); t.topics = saved.topics; t.provider = saved.provider; } else tasks.push(t);
    });
    chapters.push(ch);
    console.log(`${c.code} ${c.subject.slice(0, 14)} "${c.title.slice(0, 30)}" chars=${text.length} sections=${sections.length}`);
  }
  console.log(`planned LLM calls: ${tasks.length}`);
  if (DRY || !tasks.length) return;

  const queue = [...tasks];
  const stats = { done: 0, total: tasks.length };
  await Promise.all(providers.map((p) => worker(p, queue, stats)));

  const summary = [];
  for (const ch of chapters) {
    const dropped = {};
    const lists = ch.tasks.map((t) => (t.topics || []).filter((tp) => {
      const v = ct.validateTopic(tp, t.text);
      if (!v.ok) dropped[v.reason] = (dropped[v.reason] || 0) + 1;
      return v.ok;
    }));
    const topics = ct.mergeTopics(lists);
    const failed = ch.tasks.filter((t) => t.failed).length;
    const rec = { pdfFile: ch.c.pdfFile, subject: ch.c.subject, chapter: ch.c.chapter, title: ch.c.title, book: ch.c.book, sections: ch.sections, failedSections: failed, providers: [...new Set(ch.tasks.map((t) => t.provider).filter(Boolean))], topics, dropped };
    fs.writeFileSync(ch.outFile, JSON.stringify(rec, null, 1));
    summary.push({ code: ch.c.code, subject: ch.c.subject, topics: topics.length, dropped, failed });
  }
  fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify(summary, null, 1));
  console.log(`done: ${summary.length} chapters, ${summary.reduce((a, s) => a + s.topics, 0)} topics kept`);
}

main().catch((e) => { console.error(e); process.exit(1); });
