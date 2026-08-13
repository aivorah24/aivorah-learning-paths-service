/**
 * syllabus-map.js — the authoritative NCERT chapter structure, read from
 * data/curricula/*.json (populated by scripts/extract-ncert-structure.cjs
 * straight from the textbook PDFs).
 *
 * Chapter structure must come from the BOOK, never from a model. Before this,
 * publish() invented a chapter per generated topic with unit_no hardcoded to 1,
 * so Grade 11 Mathematics listed "Area of a Triangle" as a chapter instead of
 * NCERT's Ch 1 Sets / Ch 2 Relations and Functions, and every unit held exactly
 * one topic. Everything that renders curriculum structure should resolve it
 * through here.
 *
 *   byCode('kemh101')            → { grade, subject, chapter: 1, title: 'Sets', subtopics, bookPath }
 *   chaptersFor(11,'Mathematics') → all 14 chapters in order
 */
const fs = require('fs');
const path = require('path');

const CUR_DIR = path.resolve(__dirname, '..', 'data', 'curricula');

let _byCode = null;      // 'kemh101' → chapter record
let _byGradeSubject = null;

function load() {
  if (_byCode) return;
  _byCode = new Map();
  _byGradeSubject = new Map();
  let files = [];
  try { files = fs.readdirSync(CUR_DIR).filter(f => f.endsWith('-chapters.json')); } catch { files = []; }

  for (const file of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(CUR_DIR, file), 'utf8')); } catch { continue; }
    const grade = parseInt(String(doc.grade || '').replace(/\D/g, ''), 10);
    const subject = doc.subject || '';
    if (!grade || !subject) continue;

    for (const ch of doc.chapters || []) {
      const code = String(ch.pdfFile || '').replace(/\.pdf$/i, '');
      if (!code) continue;
      const rec = {
        grade, subject,
        chapter: ch.chapter,
        title: ch.title && !/^Chapter \d+$/i.test(ch.title) ? ch.title : `Chapter ${ch.chapter}`,
        subtopics: Array.isArray(ch.subtopics) ? ch.subtopics : [],
        pdfFile: ch.pdfFile,
        bookPath: ch.bookPath || null,
        // A title still reading "Chapter 7" means extraction could not read that
        // PDF — surfaced so validation can flag it rather than ship a placeholder.
        placeholder: !ch.title || /^Chapter \d+$/i.test(ch.title),
      };
      _byCode.set(code.toLowerCase(), rec);
      const key = `${grade}|${subject.toLowerCase()}`;
      if (!_byGradeSubject.has(key)) _byGradeSubject.set(key, []);
      _byGradeSubject.get(key).push(rec);
    }
  }
  for (const list of _byGradeSubject.values()) list.sort((a, b) => (a.chapter || 0) - (b.chapter || 0));
}

/** Chapter record for a book chapter code ("kemh101"), or null. */
function byCode(code) {
  load();
  return _byCode.get(String(code || '').replace(/\.pdf$/i, '').toLowerCase()) || null;
}

/** Every chapter for a grade+subject, in book order. */
function chaptersFor(grade, subject) {
  load();
  return _byGradeSubject.get(`${Number(grade)}|${String(subject || '').toLowerCase()}`) || [];
}

/**
 * Best chapter for a lesson, given the chapter codes its grounding hit.
 * Falls back to matching the topic name against a chapter's subtopics, so a
 * lesson still lands on a real chapter when grounding returns no usable code.
 */
function resolveChapter({ grade, subject, chapterCodes = [], topic = '' }) {
  load();
  for (const c of chapterCodes) {
    const rec = byCode(c);
    if (rec && rec.grade === Number(grade)) return rec;
  }
  const t = String(topic).toLowerCase().trim();
  if (!t) return null;
  for (const rec of chaptersFor(grade, subject)) {
    if (rec.title && t.includes(rec.title.toLowerCase())) return rec;
    for (const s of rec.subtopics || []) {
      const st = String(s.title || '').toLowerCase();
      if (st && (t.includes(st) || st.includes(t))) return rec;
    }
  }
  return null;
}

/** Every subject the textbook map knows for a grade, in alphabetical order. */
function subjectsFor(grade) {
  load();
  const g = Number(grade);
  const out = new Set();
  for (const key of _byGradeSubject.keys()) {
    const [gr, subj] = key.split('|');
    if (Number(gr) !== g) continue;
    // Recover the original casing from the first record rather than the
    // lowercased map key, so inserted rows match what the app displays.
    const list = _byGradeSubject.get(key);
    if (list && list.length) out.add(list[0].subject);
  }
  return [...out].sort();
}

module.exports = { byCode, chaptersFor, resolveChapter, subjectsFor };
