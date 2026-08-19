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
});
