// Builds the Maths AI Tutor for one topic from the book's own pages: Gemini reads the PDF pages (equations intact) and
// writes step-by-step tutoring for the book's worked examples. Code then checks every example: the problem must come
// from the page text and every arithmetic line on the board must be correct, or the example is dropped.
// Usage: node scripts/build-math-tutor.cjs --pdf hegp101.pdf --pages 7-10 --grade 8 --topic "Square Roots" \
//          --section "Square Roots" --env-file ../aivorah-students-service/.env [--write]
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
const GRADE_NO = Number(arg('--grade') || 8);
const GRADE = `Grade ${GRADE_NO}`;
const SUBJECT = arg('--subject') || 'Mathematics';
const TOPIC = arg('--topic');
const SECTION = arg('--section') || TOPIC;
const WRITE = process.argv.includes('--write');
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];
const file = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), PDF || '');

// Only the section's pages go to Gemini, as a small PDF, so it reads the real layout and symbols.
function sectionPdf() {
  const out = path.join(os.tmpdir(), `mt-${process.pid}.pdf`);
  const py = `import fitz,sys\nd=fitz.open(sys.argv[1]);n=fitz.open();n.insert_pdf(d,from_page=int(sys.argv[2])-1,to_page=int(sys.argv[3])-1);n.save(sys.argv[4])`;
  const r = spawnSync('python', ['-c', py, file, String(FROM), String(TO), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not cut pages: ${r.stderr}`);
  return fs.readFileSync(out).toString('base64');
}

function pageText() {
  return spawnSync('pdftotext', ['-f', String(FROM), '-l', String(TO), file, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
}

const prompt = () => `You are a friendly Maths AI Tutor for a ${GRADE} student. The attached PDF is pages ${FROM}-${TO} of their NCERT Mathematics textbook, the part on "${SECTION}".

Build a tutoring script from THIS book only:
1. "intro": 2-3 short sentences saying what we will learn in this part of the unit (say "unit", never "chapter"). "keyIdea": the ONE main rule or idea of "${SECTION}" in at most 15 words, as the book states it (e.g. "If y = x², then x is the square root of y.").
2. "examples": 2 to 4 problems. Use the book's OWN worked examples, questions or "Figure it Out" problems from these pages - copy the QUESTION exactly as printed (you may drop figure references) - only the question, never its worked solution or answer. Put the PDF page number where it appears (the first attached page is page ${FROM}).
3. For each example, "steps": 3 to 12 steps - NEVER skip a calculation: when a method repeats (e.g. subtracting 1, 3, 5, 7, ...), write every repetition as its own step so the student can follow each one. Each step has "say" = what the tutor says out loud, one or two short sentences a ${GRADE} student understands, and "show" = the working line written on the board for that step (numbers and symbols, ONE short calculation per line, e.g. "7 × 7 = 49", "√144 = 12", "81 − 1 = 80"; never several calculations in one line). Use × for multiply, ÷ for divide, ² ³ for powers, √ and ∛ for roots. Every calculation must be correct.
4. "answer": the final answer, short. "why": one sentence on the idea behind the method. "hint": one sentence that helps without giving the answer away.
5. "yourTurn": a similar question for the student, taken from these pages if the book has one, that has ONE definite answer (a number or short expression, never just yes/no), with its correct "answer" and the one-line working, e.g. "27, because 27 × 27 = 729".
Do not invent facts, stories or numbers that are not needed; do not use outside material.
Output ONLY JSON: {"intro":"...","keyIdea":"...","examples":[{"title":"...","problem":"...","page":${FROM},"steps":[{"say":"...","show":"..."}],"answer":"...","why":"...","hint":"...","yourTurn":{"question":"...","answer":"..."}}]}`;

async function gemini(pdfB64) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: pdfB64 } }, { text: prompt() }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(240000),
      }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
      const j = await r.json();
      if (r.ok) return { model, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' };
      lastErr = `${model} ${r.status} ${(j.error?.message || '').slice(0, 80)}`;
      if (r.status === 429 || r.status === 503 || r.status === 0) await new Promise((res) => setTimeout(res, 15000));
      else break;
    }
  }
  throw new Error(`Gemini unavailable (${lastErr})`);
}

// Evaluates a purely numeric side ("7 × 7", "√144", "2³ + 1"); returns null for anything with letters or words.
function evalSide(raw) {
  let s = String(raw).trim()
    .replace(/[×xX·]/g, '*').replace(/÷/g, '/').replace(/−|–/g, '-')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/∛\s*\(?([\d.]+)\)?/g, 'cbrt($1)').replace(/√\s*\(?([\d.]+)\)?/g, 'sqrt($1)');
  if (!/^[\d\s.+\-*/^()a-z]*$/.test(s) || /[a-z]/.test(s.replace(/sqrt|cbrt/g, ''))) return null;
  if (!/\d/.test(s)) return null;
  s = s.replace(/\^/g, '**');
  try {
    // eslint-disable-next-line no-new-func
    const v = Function('sqrt', 'cbrt', `return (${s});`)(Math.sqrt, Math.cbrt);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

// A board line like "a = b = c" is wrong when two numeric sides disagree.
function arithmeticError(line) {
  const parts = String(line).split(/[,;]\s+(?=[^,;]*=)/);
  if (parts.length > 1) return parts.map(arithmeticError).find(Boolean) || null;
  const sides = String(line).split('=').map(evalSide);
  const nums = sides.filter((v) => v !== null);
  for (let i = 1; i < nums.length; i += 1) if (Math.abs(nums[i] - nums[0]) > 1e-6 * Math.max(1, Math.abs(nums[0]))) return `${line}`;
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function grounded(problem, text) {
  const hay = ` ${norm(text)} `;
  const words = norm(problem).split(' ').filter((w) => w.length > 2);
  if (!words.length) return true;
  return words.filter((w) => hay.includes(` ${w} `)).length / words.length >= 0.6;
}

async function main() {
  const text = pageText();
  const { model, text: out } = await gemini(sectionPdf());
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error(`${model} did not return JSON`); }
  const kept = [];
  for (const ex of parsed.examples || []) {
    const lines = [...(ex.steps || []).map((s) => s.show), ex.answer, ex.yourTurn?.answer].filter(Boolean);
    if (ex.yourTurn && /^(yes|no)\.?$/i.test(String(ex.yourTurn.answer).trim())) delete ex.yourTurn;
    const bad = lines.map(arithmeticError).find(Boolean);
    if (bad) { console.log(`  dropped "${String(ex.title).slice(0, 40)}": wrong arithmetic "${bad}"`); continue; }
    if (!grounded(ex.problem, text)) { console.log(`  dropped "${String(ex.title).slice(0, 40)}": problem not found in the book pages`); continue; }
    if (!Number.isInteger(ex.page) || ex.page < FROM || ex.page > TO) ex.page = FROM;
    kept.push(ex);
  }
  console.log(`${model}: ${kept.length} of ${(parsed.examples || []).length} examples passed the checks`);
  if (!kept.length) throw new Error('no example passed the checks');
  const mathTutor = { intro: String(parsed.intro || '').replace(/chapter/gi, 'unit'), keyIdea: parsed.keyIdea, examples: kept, section: SECTION, pages: [FROM, TO] };
  console.log(JSON.stringify(mathTutor, null, 1).slice(0, 2500));
  if (!WRITE) { console.log('DRY RUN: not saved. Re-run with --write.'); return; }

  const supabase = require('../services/supabase');
  const key = { curriculum: 'CBSE', grade: GRADE, subject: SUBJECT, topic: TOPIC };
  const { data } = await supabase.from('topic_ai_enrichment').select('structured_content').match(key).maybeSingle();
  if (!data) throw new Error(`no lesson row for "${TOPIC}" (run enrich-one-topic first)`);
  const sc = { ...data.structured_content, mathTutor, pdfPage: FROM };
  const { error } = await supabase.from('topic_ai_enrichment').update({ structured_content: sc, updated_at: new Date().toISOString() }).match(key);
  if (error) throw new Error(error.message);
  console.log('SAVED mathTutor to', TOPIC);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { arithmeticError, evalSide, grounded };
