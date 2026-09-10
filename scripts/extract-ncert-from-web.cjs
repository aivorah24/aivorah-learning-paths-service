/**
 * extract-ncert-from-web.cjs — fills in the 681 still-placeholder ("Chapter N")
 * chapters across data/curricula/*.json by downloading the real NCERT PDF
 * directly from ncert.nic.in (the local `data/ncert_books` source the old
 * monolith script expected does not exist on this machine — confirmed empty,
 * both locally and in the `ncert-books` Supabase Storage bucket) and
 * re-running the SAME deterministic page-1-heading extraction the monolith's
 * extract-ncert-structure.cjs used (no LLM — ported logic, adapted for a
 * live download instead of a local file).
 *
 * NCERT's own download URL is exactly `pdfFile` from each chapter record:
 *   https://ncert.nic.in/textbook/pdf/<pdfFile>
 * (verified live — this matches the book-code convention already baked into
 * every curricula JSON file, e.g. "iesc101.pdf", "ihsc107.pdf").
 *
 * Also uploads each downloaded PDF into the (currently empty) `ncert-books`
 * Supabase Storage bucket at its existing `bookPath`, so future re-runs and
 * the student-facing "view textbook" links have a real source instead of a
 * 404 — this is the actual root gap that left ncert-books empty.
 *
 * Every extracted title is run through services/syllabus-map.js's own
 * looksLikeRealTitle() validator before being accepted — a garbled/mojibake
 * extraction is left as "Chapter N" + needsTitleReview rather than replacing
 * one placeholder with another kind of bad data.
 *
 * Usage:
 *   node scripts/extract-ncert-from-web.cjs --grades 1,2,3 [--dry] [--limit 20]
 *   node scripts/extract-ncert-from-web.cjs                 (all grades)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const GRADES = (arg('--grades', arg('--grade', '')) || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes('--dry');
const LIMIT = parseInt(arg('--limit', '0'), 10) || Infinity;
const CUR_DIR = path.resolve(__dirname, '..', 'data', 'curricula');
const NCERT_BASE = 'https://ncert.nic.in/textbook/pdf/';
const STORAGE_BUCKET = 'ncert-books';

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL.trim(), (process.env.SUPABASE_SERVICE_KEY || '').trim())
  : null;

const { looksLikeRealTitle } = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'syllabus-map.js'), 'utf8');
  const m = src.match(/function looksLikeRealTitle\(title\) \{[\s\S]*?\n\}/);
  return { looksLikeRealTitle: new Function(`${m[0]}\nreturn looksLikeRealTitle;`)() };
})();

// ── Same deterministic page-1 heading extraction as the monolith's
// extract-ncert-structure.cjs (see that file for the original design notes).
const NOT_A_TITLE = /MATHEMATICS|PHYSICS|CHEMISTRY|BIOLOGY|CHAPTER|INTRODUCTION|EXERCISE|NCERT|REPRINT|PUBLISHED|SUMMARY|APPENDIX/i;

// Older NCERT editions typeset the chapter title in ALL CAPS on page 1 — the
// monolith script's original heuristic, kept as the first attempt.
function titleFromPage1AllCaps(text) {
  const lines = text.split(/\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const isHeading = (l) => /^[A-Z][A-Z \-'&,]{2,45}$/.test(l) && !NOT_A_TITLE.test(l) && !/^[A-Z]\.[A-Z]/.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (!isHeading(lines[i])) continue;
    const parts = [lines[i]];
    for (let j = i + 1; j < lines.length && parts.length < 3 && isHeading(lines[j]); j++) parts.push(lines[j]);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}

// Newer NCERT editions (2026 revision, seen live during this pipeline build —
// e.g. iesc101.pdf/iemh101.pdf) typeset the title in Title Case, sometimes
// wrapped across 2 lines, right at the top of page 1 before any body text or
// numbered subsection. Take the first few short, title-like lines; stop the
// moment we hit a numbered subsection ("1.1 Introduction"), a line ending in
// . or ? (body prose or an exercise instruction — e.g. English reader pages
// that open with "I Complete the given word web." have no real title on
// page 1 at all), a Roman-numeral/numbered list marker, or a long sentence.
function titleFromPage1TitleCase(text) {
  const lines = text.split(/\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const skipButKeepLooking = (l) => /^\d{1,3}$/.test(l) || /^chapter$/i.test(l) || NOT_A_TITLE.test(l);
  const candidates = [];
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const l = lines[i];
    if (skipButKeepLooking(l)) { if (candidates.length) break; continue; }
    if (/^\d+\.\d+\s/.test(l)) break;                 // numbered subsection -> title is done
    if (/[.?]$/.test(l)) break;                        // body prose / a question, not a title
    if (/^(I{1,3}|IV|VI{0,3})\.?\s/.test(l)) break;    // Roman-numeral exercise marker
    if (/^\d+[.)]\s/.test(l)) break;                    // numbered list item
    if (l.split(/\s+/).length > 10) break;              // too long to be a title line
    candidates.push(l);
    if (candidates.length >= 3) break;
  }
  return candidates.length ? candidates.join(' ').replace(/\s+/g, ' ').trim() : null;
}

function titleFromPage1(text) {
  return titleFromPage1AllCaps(text) || titleFromPage1TitleCase(text);
}
function subtopicsFrom(text, chapterNo) {
  const re = new RegExp(`(?:^|\\n)\\s*(${chapterNo})\\.(\\d{1,2})\\s*([A-Z][A-Za-z][A-Za-z \\-'&,()]{3,60})`, 'g');
  const seen = new Map();
  let m;
  while ((m = re.exec(text))) {
    const key = `${m[1]}.${m[2]}`;
    const t = m[3].replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
    if (!seen.has(key) && !/^Introduction$/i.test(t)) seen.set(key, t);
  }
  return [...seen.entries()].sort((a, b) => parseInt(a[0].split('.')[1], 10) - parseInt(b[0].split('.')[1], 10)).map(([section, title]) => ({ section, title }));
}
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\b(And|Or|Of|The|To|In|A|An|With|For)\b/g, (w) => w.toLowerCase())
  .replace(/^./, (c) => c.toUpperCase());

async function downloadPdf(pdfFile) {
  const res = await fetch(`${NCERT_BASE}${pdfFile}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadToStorage(buffer, bookPath) {
  if (!supabase || DRY) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(bookPath, buffer, {
    contentType: 'application/pdf', upsert: true,
  });
  if (error) console.warn(`   [storage] upload failed for ${bookPath}: ${error.message}`);
}

async function main() {
  const files = fs.readdirSync(CUR_DIR).filter(f => f.endsWith('-chapters.json'));
  let attempted = 0, titled = 0, stillPlaceholder = 0, rejectedAsGarbled = 0, downloadFailed = 0;

  for (const file of files) {
    if (attempted >= LIMIT) break;
    const full = path.join(CUR_DIR, file);
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    const gradeNum = String(doc.grade || '').replace(/\D/g, '');
    if (GRADES.length && !GRADES.includes(gradeNum)) continue;

    let fileChanged = false;
    for (const ch of doc.chapters || []) {
      if (attempted >= LIMIT) break;
      const hasRealTitle = ch.title && !/^Chapter \d+$/i.test(ch.title) && looksLikeRealTitle(ch.title);
      if (hasRealTitle) continue; // already good — don't re-download
      if (!ch.pdfFile) continue;

      attempted++;
      let buf;
      try {
        buf = await downloadPdf(ch.pdfFile);
      } catch (e) {
        downloadFailed++;
        console.log(`   [skip] ${doc.grade} ${doc.subject} ch${ch.chapter} ${ch.pdfFile}: download failed (${e.message})`);
        continue;
      }

      let parsed;
      try {
        parsed = await pdf(buf, { max: 2 }); // title is always on page 1; cap parsing for speed
      } catch (e) {
        stillPlaceholder++;
        console.log(`   [skip] ${doc.grade} ${doc.subject} ch${ch.chapter} ${ch.pdfFile}: PDF parse failed (${e.message})`);
        continue;
      }

      const raw = titleFromPage1(parsed.text);
      if (raw && looksLikeRealTitle(titleCase(raw))) {
        ch.title = titleCase(raw);
        delete ch.needsTitleReview;
        const subs = subtopicsFrom(parsed.text, ch.chapter);
        if (subs.length) ch.subtopics = subs;
        titled++;
        fileChanged = true;
        console.log(`   [ok]   ${doc.grade} ${doc.subject} ch${ch.chapter}: "${ch.title}"`);
      } else if (raw) {
        rejectedAsGarbled++;
        console.log(`   [reject] ${doc.grade} ${doc.subject} ch${ch.chapter}: extracted "${raw}" failed the real-title check — left as placeholder`);
      } else {
        stillPlaceholder++;
        console.log(`   [none] ${doc.grade} ${doc.subject} ch${ch.chapter}: no heading found on page 1 — left as placeholder`);
      }

      if (ch.bookPath) {
        try { await uploadToStorage(buf, ch.bookPath); } catch (e) { console.warn(`   [storage] ${ch.bookPath}: ${e.message}`); }
      }

      // Be polite to ncert.nic.in — small delay between requests.
      await new Promise(r => setTimeout(r, 400));
    }

    if (fileChanged && !DRY) {
      fs.writeFileSync(full, JSON.stringify(doc, null, 1));
      console.log(`  -> saved ${file}`);
    }
  }

  console.log(`\nDone. attempted=${attempted} titled=${titled} rejectedAsGarbled=${rejectedAsGarbled} noHeadingFound=${stillPlaceholder} downloadFailed=${downloadFailed}${DRY ? '  (DRY RUN — nothing written)' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
