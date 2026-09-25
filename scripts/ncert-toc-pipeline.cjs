// Canonical NCERT chapter titles from each textbook's prelims/contents PDF ("<code>ps.pdf").
// Text layer first, Tesseract OCR second. Dry run unless --apply.
// Usage: node scripts/ncert-toc-pipeline.cjs [--grades 1,2] [--codes jesc1] [--apply] [--report out.json]
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pdfParse = require('pdf-parse');
const { parseToc, blockList } = require('./lib/ncertToc.cjs');
const { looksLikeRealTitle } = require('../services/syllabus-map');
const { anomalies } = require('./audit-ncert-anomalies.cjs');
const { serializeLike } = require('./lib/preserveFormat.cjs');

const DIR = path.join(__dirname, '..', 'data', 'curricula');
const CACHE = process.env.NCERT_PS_CACHE || path.join(os.tmpdir(), 'ncert-ps');
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const GRADES = arg('--grades') ? arg('--grades').split(',').map(Number) : null;
const CODES = arg('--codes') ? arg('--codes').split(',') : null;
const LANG = { Hindi: 'hin+eng', Urdu: 'urd+eng' };
fs.mkdirSync(CACHE, { recursive: true });

async function fetchPdf(code) {
  const file = path.join(CACHE, `${code}ps.pdf`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://ncert.nic.in/textbook/pdf/${code}ps.pdf`, { signal: AbortSignal.timeout(90000) });
      if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

function ocrText(code, file, lang) {
  const cache = path.join(CACHE, `${code}.${lang.replace('+', '-')}.ocr.txt`);
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
  const r = spawnSync('python', [path.join(__dirname, 'ncert_ocr_pages.py'), file, lang], { maxBuffer: 1 << 28, encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) return '';
  let text;
  try { text = Object.values(JSON.parse(r.stdout)).join('\n'); } catch { return ''; }
  fs.writeFileSync(cache, text);
  return text;
}

const GENERIC = /^(science|questions?|exercises?|summary|activity|activities|contents|introduction|notes?|answers?|index|glossary)$/i;
// Doubled OCR text ("Ntroductionntroduction"); punctuated repeats in real titles don't match.
const REPEATED = /(.{10,}?)\s?\1/i;
const SCRIPT = /[ऀ-ॿ؀-ۿ]/;
const SCRIPT_SUBJECTS = new Set(['Hindi', 'Urdu']);
const JUNK = /[\[\]|•»]|^\d+\s|^\d+\s*[–-]\s*\d+|\s\d{2,3}\s+[A-Z]|[A-Za-z]\d{2,3}(\s|$)|\b\d{4}\s*[–-]\s*\d{1,3}$/;
const JUNK_WORDS = /\b(contents|glossary|suggested readings?)\b/i;

// Second letter of the NCERT code is the medium: h = Hindi, u = Urdu.
const languageOf = (code, subject) => ((code || '')[1] === 'h' ? 'Hindi' : (code || '')[1] === 'u' ? 'Urdu' : subject);

const ARTIFACTS = /^(mar apr|or some|aabb|abc|abr|bc\/e|do you|note to the teachers?|notes? for the teachers?|think about it|let us explore|let['’]s explore|legend|think and reflect|let us discuss)$/i;
const FRONT_MATTER = /^(आमुख|प्रस्तावना|भूमिका|foreword|preface|contents|glossary|acknowledg\w*)(\s|$)/i;
const FUNCTION_WORDS = new Set(['or', 'and', 'some', 'do', 'you', 'the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'we', 'our', 'my', 'how', 'what', 'why', 'i',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);

// Page numbers left on a title: "Maps1", "Education  1", "13 —22", "v 1-16", "iii", OCR "l7".
function stripPage(t) {
  return String(t || '')
    .replace(/\s+[ivxlc]{1,4}\s+\d{1,3}\s*[-–—]\s*\d{1,3}$/i, '')
    .replace(/\s+\d{1,3}\s*[-–—]\s*\d{1,3}$/, '')
    .replace(/\s{2,}\d{1,3}$/, '')
    .replace(/(?<=[A-Za-z?)!ऀ-ॿ])\d{1,3}$/, '')
    .replace(/(?<=[A-Za-z?)!\dऀ-ॿ])\s+[0-9lI]{1,3}$/, (m) => (/\d{2,}$/.test(m) || /^\s+[lI]\d/.test(m) ? '' : m))
    .replace(/(?<=[ऀ-ॿ])\s+[ivxl]{1,4}$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const hardJunk = (t, subject) => {
  const s = String(t || '').trim();
  if (!s || s.length > 75) return true;
  if (JUNK.test(s) || JUNK_WORDS.test(s) || REPEATED.test(s) || GENERIC.test(s) || ARTIFACTS.test(s) || FRONT_MATTER.test(s)) return true;
  if (s.toLowerCase().split(/\s+/).every((w) => FUNCTION_WORDS.has(w))) return true;
  if (SCRIPT_SUBJECTS.has(subject) && /[A-Za-z]{2,}/.test(s)) return true;
  return stripPage(s) !== s;
};

const validTitle = (t, subject) => {
  if (!t || anomalies(t, undefined).length > 0 || hardJunk(t, subject)) return false;
  if (SCRIPT_SUBJECTS.has(subject)) return SCRIPT.test(t);
  return looksLikeRealTitle(t);
};

function extract(text, chapters, subject) {
  const first = Math.min(...chapters.map((c) => c.chapter));
  const clean = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stripPage(v)]));
  const cands = [clean(parseToc(text, first))];
  const b = blockList(text, chapters.length);
  if (Object.keys(b).length) cands.push(clean(Object.fromEntries(Object.entries(b).map(([k, v]) => [Number(k) - 1 + first, v]))));
  const score = (m) => chapters.filter((c) => validTitle(m[c.chapter], subject)).length;
  return cands.sort((x, y) => score(y) - score(x))[0];
}

async function resolveToc(code, subject, chapters) {
  const file = await fetchPdf(code);
  if (!file) return { toc: {}, via: 'download-failed' };
  let toc = {}, via = 'text';
  try {
    const r = await pdfParse(fs.readFileSync(file), { max: 60 });
    toc = extract(r.text, chapters, subject);
  } catch { /* fall through to OCR */ }
  const ok = (m) => chapters.filter((c) => validTitle(m[c.chapter], subject)).length;
  if (ok(toc) < chapters.length) {
    const o = extract(ocrText(code, file, LANG[subject] || 'eng'), chapters, subject);
    if (ok(o) > ok(toc)) { toc = o; via = 'ocr'; }
  }
  return { toc, via };
}

async function main() {
  const report = { decisions: [], map: {}, unresolved: [] };
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('-chapters.json')).sort()) {
    const file = path.join(DIR, f);
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    const grade = parseInt(String(j.grade).replace(/\D/g, ''), 10);
    if (!(grade >= 1 && grade <= 12)) continue;
    if (GRADES && !GRADES.includes(grade)) continue;
    if (CODES && !CODES.includes(j.code)) continue;
    const lang = languageOf(j.code, j.subject);
    const { toc, via } = j.code ? await resolveToc(j.code, lang, j.chapters) : { toc: {}, via: "no-code" };
    const mapKey = `${j.grade}|${j.subject}|${j.code}`;
    report.map[mapKey] = Object.fromEntries(j.chapters.filter((c) => validTitle(toc[c.chapter], lang)).map((c) => [c.chapter, toc[c.chapter]]));
    let changed = false;
    for (const c of j.chapters) {
      const canon = validTitle(toc[c.chapter], lang) ? toc[c.chapter] : null;
      const cur = String(c.title || '').trim();
      const truncated = canon && canon.toLowerCase().includes(cur.toLowerCase()) && canon.length > cur.length;
      const bad = anomalies(cur, undefined).length > 0 || c.needsTitleReview || !validTitle(cur, lang) || truncated || GENERIC.test(cur);
      // Text-layer titles are exact copies of the printed contents page; OCR titles only overwrite clearly bad ones.
      if (canon && canon !== cur && (bad || via === 'text')) {
        report.decisions.push({ file: f, chapter: c.chapter, action: 'replace', from: c.title, to: canon, via });
        c.title = canon;
        delete c.needsTitleReview;
        changed = true;
      } else if (canon && canon !== cur) {
        report.decisions.push({ file: f, chapter: c.chapter, action: 'mismatch-kept', current: c.title, canonical: canon, via });
      } else if (!canon && hardJunk(cur, lang) && !/^chapter\s*\d+$/i.test(cur)) {
        // Unresolvable junk becomes the neutral placeholder the UI already renders cleanly.
        report.decisions.push({ file: f, chapter: c.chapter, action: 'reset-to-placeholder', from: c.title, to: `Chapter ${c.chapter}`, via });
        c.title = `Chapter ${c.chapter}`;
        changed = true;
        report.unresolved.push({ file: f, grade, subject: j.subject, chapter: c.chapter, title: c.title, via });
      } else if (!canon && bad) {
        report.unresolved.push({ file: f, grade, subject: j.subject, chapter: c.chapter, title: c.title, via });
      }
    }
    if (changed && APPLY) fs.writeFileSync(file, serializeLike(raw, j));
    console.log(`${f} via=${via} canonical=${Object.keys(report.map[mapKey]).length}/${j.chapters.length}`);
  }
  const out = arg('--report');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const n = (a) => report.decisions.filter((d) => d.action === a).length;
  console.log(JSON.stringify({ replaced: n('replace'), mismatchKept: n('mismatch-kept'), unresolved: report.unresolved.length, applied: APPLY }));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { hardJunk, stripPage, validTitle };
