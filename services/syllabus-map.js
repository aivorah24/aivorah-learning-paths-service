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

// extract-ncert-structure.cjs's page-1 heading regex only checks for Latin
// uppercase letters — it has no concept of whether the result is an actual
// word. Most textbook PDFs extract cleanly, but a handful (seen so far only
// in Hindi-subject PDFs, which use Devanagari script through a non-standard
// embedded font encoding) produce short Latin-looking mojibake that still
// satisfies that regex and gets accepted as a "real" title, silently
// overwriting the safe "Chapter N" + needsTitleReview placeholder — e.g.
// "Fff F", "Klmn", "Hco", "Crcrcr" (Grade 9 Hindi, chapters 7-10). None of
// those are real words: they're either missing a vowel entirely or too short
// to be a plausible title. Treat anything failing this check the same as a
// missing title — fall back to "Chapter N" and flag it for review, rather
// than shipping mojibake to students.
function looksLikeRealTitle(title) {
  const t = String(title || '').trim();
  if (t.length < 4) return false;
  if (!/[aeiouAEIOU]/.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const letters = w.replace(/[^a-zA-Z]/g, '');
    // A single "word" this long with no spaces is virtually never a real
    // title fragment — real extraction bugs run words together instead of
    // inserting a space, e.g. "Onstructionofanindexnumber" (Grade 11
    // Economics ch7) or "Mawlynnongmawlynnong" (Grade 4 Maths ch7).
    if (letters.length >= 18) return false;
    // The same letter 3+ times in a row — real words don't do this either,
    // e.g. "Iiiiiiiv" (Grade 11 Health & PE ch10), "Viii" (Grade 6 Maths ch4).
    if (/(.)\1{2,}/i.test(letters)) return false;
    // 5+ consecutive consonants inside one word — real English words don't
    // do this; garbled extraction does, e.g. "Asatisfytb" (…sfytb…), the
    // Grade 9 English ch7 gibberish title.
    if (/[^aeiouAEIOU\s]{5,}/.test(letters)) return false;
    // A word made of two identical (case-insensitive) halves back-to-back —
    // the exact shape of "Ntroductionntroduction" and
    // "Mawlynnongmawlynnong": extraction duplicated a fragment onto itself.
    if (letters.length >= 8 && letters.length % 2 === 0) {
      const half = letters.length / 2;
      if (letters.slice(0, half).toLowerCase() === letters.slice(half).toLowerCase()) return false;
    }
  }
  return true;
}

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
      const hasRealTitle = ch.title && !/^Chapter \d+$/i.test(ch.title) && looksLikeRealTitle(ch.title);
      const rec = {
        grade, subject,
        chapter: ch.chapter,
        title: hasRealTitle ? ch.title : `Chapter ${ch.chapter}`,
        subtopics: Array.isArray(ch.subtopics) ? ch.subtopics : [],
        pdfFile: ch.pdfFile,
        bookPath: ch.bookPath || null,
        // A title still reading "Chapter N" means extraction could not read that
        // PDF (or produced unusable mojibake) — surfaced so validation can flag
        // it rather than ship a placeholder or garbled text.
        placeholder: !hasRealTitle,
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

/**
 * Distinct subjects for a grade, read straight from the same book-derived
 * chapter data chaptersFor() uses — feeds the Learning Path "Subjects" grid
 * for CBSE without depending on Qdrant, since Qdrant coverage for CBSE
 * (esp. primary grades) is not guaranteed the way IB DP/MYP's is.
 */
function subjectsFor(grade) {
  load();
  const g = parseInt(String(grade).replace(/\D/g, ''), 10);
  const bySubject = new Map();
  for (const [key, chapters] of _byGradeSubject.entries()) {
    const [keyGrade] = key.split('|');
    if (Number(keyGrade) !== g) continue;
    const subject = chapters[0]?.subject;
    if (!subject) continue;
    bySubject.set(subject, chapters.length);
  }
  return [...bySubject.entries()].map(([subject, chapterCount]) => ({
    subject,
    topicCount: chapterCount,
    topics: [],
    units: [],
  }));
}

module.exports = { chaptersFor, subjectsFor };
