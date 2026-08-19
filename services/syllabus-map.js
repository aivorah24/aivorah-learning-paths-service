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
 *   chaptersFor(11,'Mathematics') → all 14 chapters in order
 */
const fs = require('fs');
const path = require('path');

const CUR_DIR = path.resolve(__dirname, '..', 'data', 'curricula');

let _byGradeSubject = null;

function load() {
  if (_byGradeSubject) return;
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
      const key = `${grade}|${subject.toLowerCase()}`;
      if (!_byGradeSubject.has(key)) _byGradeSubject.set(key, []);
      _byGradeSubject.get(key).push(rec);
    }
  }
  for (const list of _byGradeSubject.values()) list.sort((a, b) => (a.chapter || 0) - (b.chapter || 0));
}

/** Every chapter for a grade+subject, in book order. */
function chaptersFor(grade, subject) {
  load();
  return _byGradeSubject.get(`${Number(grade)}|${String(subject || '').toLowerCase()}`) || [];
}

module.exports = { chaptersFor };
