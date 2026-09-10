// Unit tests for services/syllabus-map.js — the authoritative NCERT/CBSE
// chapter structure, normally read from data/curricula/*.json. fs is mocked
// so no real data files are read. This module caches its parsed data at
// module scope (loads once, lazily) — so we jest.resetModules() + re-require
// BOTH fs and the module fresh together in each test, keeping them in sync.

jest.mock('fs');

function freshSyllabusMap() {
  jest.resetModules();
  const fs = require('fs');
  return { fs, syllabusMap: require('../../services/syllabus-map') };
}

const MATH_G11_DOC = {
  curriculum: 'CBSE', grade: 'Grade 11', subject: 'Mathematics', code: 'kemh1',
  chapters: [
    { chapter: 1, pdfFile: 'kemh101.pdf', title: 'Sets', bookPath: 'g11/math/kemh101.pdf', subtopics: [{ title: 'Set operations' }] },
    { chapter: 2, pdfFile: 'kemh102.pdf', title: 'Relations and Functions', bookPath: 'g11/math/kemh102.pdf', subtopics: [] },
  ],
};

describe('chaptersFor', () => {
  test('returns all chapters for a grade+subject, in book order', () => {
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['math-g11-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(MATH_G11_DOC));

    const chapters = syllabusMap.chaptersFor(11, 'Mathematics');
    expect(chapters.map(c => c.chapter)).toEqual([1, 2]);
  });

  test('an unmatched grade+subject returns an empty array', () => {
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['math-g11-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(MATH_G11_DOC));

    expect(syllabusMap.chaptersFor(11, 'Science')).toEqual([]);
  });

  test('subject match is case-insensitive', () => {
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['math-g11-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(MATH_G11_DOC));

    expect(syllabusMap.chaptersFor(11, 'mathematics')).toHaveLength(2);
  });

  test('no curricula files at all -> returns an empty array, no crash', () => {
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockImplementation(() => { throw new Error('ENOENT'); });

    expect(syllabusMap.chaptersFor(11, 'Mathematics')).toEqual([]);
  });

  test('a chapter whose title is still "Chapter N" is flagged as a placeholder', () => {
    const PLACEHOLDER_DOC = {
      curriculum: 'CBSE', grade: 'Grade 6', subject: 'Science', code: 'fesc1',
      chapters: [{ chapter: 1, pdfFile: 'fesc101.pdf', title: 'Chapter 1', bookPath: 'g6/science/fesc101.pdf' }],
    };
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['sci-g6-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(PLACEHOLDER_DOC));

    const rec = syllabusMap.chaptersFor(6, 'Science')[0];
    expect(rec.placeholder).toBe(true);
    expect(rec.title).toBe('Chapter 1');
  });

  // Regression for the real Grade 9 Hindi data (cbse-g9-hindi-ihsc1-chapters.json):
  // extract-ncert-structure.cjs's page-1 heading regex only checks for Latin
  // uppercase letters, so PDF font-encoding mojibake from the Devanagari-script
  // source PDFs slipped through as "real" titles, overwriting the safe
  // "Chapter N" + needsTitleReview placeholder these chapters should have kept.
  test('mojibake titles extracted from Hindi PDFs fall back to "Chapter N" and are flagged, instead of shipping garbage', () => {
    const HINDI_G9_DOC = {
      curriculum: 'CBSE', grade: 'Grade 9', subject: 'Hindi', code: 'ihsc1',
      chapters: [
        { chapter: 6, pdfFile: 'ihsc106.pdf', title: 'Chapter 6', needsTitleReview: true, bookPath: 'g9/hindi/ihsc106.pdf' },
        { chapter: 7, pdfFile: 'ihsc107.pdf', title: 'Fff F', bookPath: 'g9/hindi/ihsc107.pdf' },
        { chapter: 8, pdfFile: 'ihsc108.pdf', title: 'Klmn', bookPath: 'g9/hindi/ihsc108.pdf' },
        { chapter: 9, pdfFile: 'ihsc109.pdf', title: 'Hco', bookPath: 'g9/hindi/ihsc109.pdf' },
        { chapter: 10, pdfFile: 'ihsc110.pdf', title: 'Crcrcr', bookPath: 'g9/hindi/ihsc110.pdf' },
      ],
    };
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['cbse-g9-hindi-ihsc1-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(HINDI_G9_DOC));

    const chapters = syllabusMap.chaptersFor(9, 'Hindi');
    for (const ch of chapters) {
      expect(ch.title).toBe(`Chapter ${ch.chapter}`);
      expect(ch.placeholder).toBe(true);
    }
  });

  test('a real, legitimately short title (e.g. "Sets") is NOT treated as mojibake', () => {
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['math-g11-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(MATH_G11_DOC));

    const rec = syllabusMap.chaptersFor(11, 'Mathematics')[0];
    expect(rec.title).toBe('Sets');
    expect(rec.placeholder).toBe(false);
  });

  // Found via a full scan of all 154 curricula files (1465 chapters) after
  // the first mojibake fix — these real garbled titles have a vowel and are
  // long enough, so they slipped past the original length+vowel check.
  test('additional real garbled titles found across the full curricula scan are also caught', () => {
    const CASES = [
      { grade: 'Grade 11', subject: 'Economics', chapter: 7, title: 'Onstructionofanindexnumber' }, // one giant run-together word
      { grade: 'Grade 4', subject: 'Mathematics', chapter: 7, title: 'Mawlynnongmawlynnong' },       // duplicated fragment
      { grade: 'Grade 12', subject: 'Physics', chapter: 2, title: 'Ntroductionntroduction Ntroductionntroduction Ntroduction' }, // repeated duplication
      { grade: 'Grade 9', subject: 'English', chapter: 7, title: 'Asatisfytb Luygbkcull Dmandgjfoo' }, // 5+ consonant runs, no real words
    ];
    for (const c of CASES) {
      const doc = {
        curriculum: 'CBSE', grade: c.grade, subject: c.subject, code: 'x',
        chapters: [{ chapter: c.chapter, pdfFile: `x${c.chapter}.pdf`, title: c.title, bookPath: 'x.pdf' }],
      };
      const { fs, syllabusMap } = freshSyllabusMap();
      fs.readdirSync = jest.fn().mockReturnValue(['x-chapters.json']);
      fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(doc));

      const rec = syllabusMap.chaptersFor(c.grade.replace(/\D/g, ''), c.subject)[0];
      expect(rec.title).toBe(`Chapter ${c.chapter}`);
      expect(rec.placeholder).toBe(true);
    }
  });

  // S04: real Devanagari (Hindi) titles recovered from actual NCERT PDFs must
  // survive this validator. The Latin-only check (`/[aeiouAEIOU]/`) has no
  // concept of a Devanagari vowel, so a completely real, correctly-extracted
  // Hindi title like "चित्र और बातचीत" (Grade 2 Hindi ch1, "Picture and
  // Conversation") was being silently discarded back to "Chapter N" at serve
  // time — even though the underlying data file held the real title.
  test('real Devanagari titles are accepted, not reverted to "Chapter N" (S04)', () => {
    const HINDI_G2_DOC = {
      curriculum: 'CBSE', grade: 'Grade 2', subject: 'Hindi', code: 'bhsr1',
      chapters: [
        { chapter: 1, pdfFile: 'bhsr101.pdf', title: 'चित्र और बातचीत', bookPath: 'g2/hindi/bhsr101.pdf' },
        { chapter: 8, pdfFile: 'bhsr108.pdf', title: 'इकाई 2: रंग ही रंग', bookPath: 'g2/hindi/bhsr108.pdf' },
      ],
    };
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['cbse-g2-hindi-bhsr1-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(HINDI_G2_DOC));

    const chapters = syllabusMap.chaptersFor(2, 'Hindi');
    const ch1 = chapters.find(c => c.chapter === 1);
    const ch8 = chapters.find(c => c.chapter === 8);
    expect(ch1.title).toBe('चित्र और बातचीत');
    expect(ch1.placeholder).toBe(false);
    expect(ch8.title).toBe('इकाई 2: रंग ही रंग');
    expect(ch8.placeholder).toBe(false);
  });

  // Mojibake must still be rejected for Devanagari-tagged chapters too — this
  // guard must not become "anything non-Latin passes unconditionally."
  test('mojibake titles on a Devanagari chapter are still rejected (S04, no regression)', () => {
    const BAD_DOC = {
      curriculum: 'CBSE', grade: 'Grade 9', subject: 'Hindi', code: 'ihsc1',
      chapters: [{ chapter: 7, pdfFile: 'ihsc107.pdf', title: 'Fff F', bookPath: 'g9/hindi/ihsc107.pdf' }],
    };
    const { fs, syllabusMap } = freshSyllabusMap();
    fs.readdirSync = jest.fn().mockReturnValue(['cbse-g9-hindi-ihsc1-chapters.json']);
    fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(BAD_DOC));

    const rec = syllabusMap.chaptersFor(9, 'Hindi')[0];
    expect(rec.title).toBe('Chapter 7');
    expect(rec.placeholder).toBe(true);
  });

  // Long, multi-word, or hyphenated real titles must not be caught by the
  // "one giant run-together word" or consonant-run checks.
  test('long real multi-word titles are NOT treated as mojibake', () => {
    const REAL_TITLES = [
      'Post-Mauryan Trends in Indian Art and Architecture',
      'Systems of Particles and Rotational Motion',
      'Demand for National Self-Determination in Basque',
      'Salient Features of Ancient Education System',
    ];
    for (const title of REAL_TITLES) {
      const doc = {
        curriculum: 'CBSE', grade: 'Grade 11', subject: 'History', code: 'x',
        chapters: [{ chapter: 1, pdfFile: 'x1.pdf', title, bookPath: 'x.pdf' }],
      };
      const { fs, syllabusMap } = freshSyllabusMap();
      fs.readdirSync = jest.fn().mockReturnValue(['x-chapters.json']);
      fs.readFileSync = jest.fn().mockReturnValue(JSON.stringify(doc));

      const rec = syllabusMap.chaptersFor(11, 'History')[0];
      expect(rec.title).toBe(title);
      expect(rec.placeholder).toBe(false);
    }
  });
});
