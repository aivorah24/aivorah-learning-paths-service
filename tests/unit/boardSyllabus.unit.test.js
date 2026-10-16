// ICSE / Cambridge Learning Path: no official textbook yet, but syllabus
// outlines (Supabase) and topic content (Qdrant) were ingested under grade
// labels a student profile never uses ("Class VI", "Stage 6", "IGCSE Year
// 10"). These tests pin the alias resolution, the merge of both sources and
// the "every topic is Coming soon" contract.

const mockScroll = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ scroll: (...args) => mockScroll(...args) })),
}));

// Minimal chainable Supabase double: records every filter, resolves from a
// per-table fixture filtered the way the real query would be.
const mockDb = { syllabus_chapters: [], syllabus_topics: [], board_syllabus_nodes: [] };
const mockCalls = [];
jest.mock('../../services/supabase', () => ({
  from: (table) => {
    const filters = [];
    const q = {
      select: () => q,
      in: (col, vals) => { filters.push(['in', col, vals]); return q; },
      is: (col, val) => { filters.push(['is', col, val]); return q; },
      ilike: (col, val) => { filters.push(['ilike', col, val]); return q; },
      eq: (col, val) => { filters.push(['eq', col, val]); return q; },
      lte: (col, val) => { filters.push(['lte', col, val]); return q; },
      gte: (col, val) => { filters.push(['gte', col, val]); return q; },
      range: () => q,
      order: () => q,
      then: (resolve) => {
        mockCalls.push({ table, filters });
        const rows = mockDb[table].filter((r) => filters.every(([op, col, v]) => {
          if (op === 'in') return v.includes(r[col]);
          if (op === 'is') return (r[col] ?? null) === v;
          if (op === 'ilike') return String(r[col]).toLowerCase() === String(v).toLowerCase();
          if (op === 'eq') return r[col] === v;
          if (op === 'lte') return r[col] <= v;
          if (op === 'gte') return r[col] >= v;
          return true;
        }));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return q;
  },
}));

const {
  isBoardWithoutBooks, boardGradeAliases, gradeNumber, listBoardSubjects, listBoardSyllabus,
} = require('../../services/boardSyllabus');

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockDb.syllabus_chapters = [];
  mockDb.syllabus_topics = [];
  mockDb.board_syllabus_nodes = [];
  mockScroll.mockResolvedValue({ points: [], next_page_offset: null });
});

describe('grade alias resolution', () => {
  test('ICSE / Cambridge only', () => {
    expect(isBoardWithoutBooks('ICSE')).toBe(true);
    expect(isBoardWithoutBooks(' cambridge ')).toBe(true);
    expect(isBoardWithoutBooks('CBSE')).toBe(false);
    expect(isBoardWithoutBooks('IB PYP')).toBe(false);
  });

  test('parses Grade N, Class roman numerals, Stage N, IGCSE Year N', () => {
    expect(gradeNumber('Grade 6')).toBe(6);
    expect(gradeNumber('Class VI')).toBe(6);
    expect(gradeNumber('Class X')).toBe(10);
    expect(gradeNumber('Stage 3')).toBe(3);
    expect(gradeNumber('IGCSE Year 10')).toBe(10);
  });

  test('ICSE Grade 6 → the "Class VI" label ingestion used', () => {
    expect(boardGradeAliases('ICSE', 'Grade 6')).toEqual(expect.arrayContaining(['Grade 6', 'Class VI', 'Class 6']));
    expect(boardGradeAliases('ICSE', 'Grade 6')).not.toContain('Stage 6');
  });

  test('Cambridge Grade 10 → "Stage 10" / "IGCSE Year 10" too', () => {
    expect(boardGradeAliases('Cambridge', 'Grade 10')).toEqual(expect.arrayContaining(['Grade 10', 'Stage 10', 'IGCSE Year 10']));
  });
});

describe('listBoardSubjects', () => {
  test('ICSE Grade 1: subjects + chapters from the "Class I" syllabus outline', async () => {
    mockDb.syllabus_chapters = [
      { id: 'c1', curriculum: 'ICSE', grade: 'Class I', subject: 'English', unit_no: 1, title: 'Alphabet Fun', school_id: null },
      { id: 'c2', curriculum: 'ICSE', grade: 'Class I', subject: 'Mathematics', unit_no: 1, title: 'Numbers 1 to 20', school_id: null },
      // a school's own upload is not the board syllabus
      { id: 'c3', curriculum: 'ICSE', grade: 'Class I', subject: 'Art', unit_no: 1, title: 'School only', school_id: 's1' },
      // other grade
      { id: 'c4', curriculum: 'ICSE', grade: 'Class II', subject: 'English', unit_no: 1, title: 'Nope', school_id: null },
    ];
    mockDb.syllabus_topics = [
      { id: 't1', chapter_id: 'c1', topic_order: 0, name: 'Vowels' },
      { id: 't2', chapter_id: 'c1', topic_order: 1, name: 'Consonants' },
      { id: 't3', chapter_id: 'c2', topic_order: 0, name: 'Counting' },
    ];
    const subjects = await listBoardSubjects('ICSE', 'Grade 1');
    expect(subjects.map((s) => s.subject)).toEqual(['English', 'Mathematics']);
    expect(subjects[0]).toMatchObject({
      topicCount: 2, units: ['Alphabet Fun'], chapters: [{ unitNo: 1, title: 'Alphabet Fun' }], comingSoon: true,
    });
    expect(subjects[0].topics.map((t) => t.topic)).toEqual(['Vowels', 'Consonants']);
  });

  test('Qdrant-only subjects are listed too, matched across grade aliases', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { curriculum: 'ICSE', grade: 'Class VI', subject: 'Geography', topic: 'Maps and Globes' } },
        { payload: { curriculum: 'ICSE', grade: 'Class VI', subject: 'Geography', topic: 'iemr101' } }, // junk
      ],
      next_page_offset: null,
    });
    const subjects = await listBoardSubjects('ICSE', 'Grade 6');
    expect(subjects).toEqual([expect.objectContaining({ subject: 'Geography', topicCount: 1, comingSoon: true })]);
    const filter = mockScroll.mock.calls[0][1].filter;
    expect(filter.must).toEqual(expect.arrayContaining([
      { key: 'grade', match: { any: expect.arrayContaining(['Grade 6', 'Class VI']) } },
      { key: 'curriculum', match: { any: expect.arrayContaining(['ICSE']) } },
    ]));
  });

  test('Cambridge also reads the Grade 1-5 topic maps in the second collection', async () => {
    mockScroll.mockImplementation((collection) => Promise.resolve({
      points: collection === 'aivorah_curriculum_chunks_v1'
        ? [{ payload: { curriculum: 'Cambridge', grade: 'Grade 3', subject: 'Science', topic: 'Plant Parts and Functions', unit: 'Science Grade 3 Topic Map' } }]
        : [],
      next_page_offset: null,
    }));
    const subjects = await listBoardSubjects('Cambridge', 'Grade 3');
    expect(subjects).toEqual([expect.objectContaining({ subject: 'Science', topicCount: 1 })]);
    expect(subjects[0].topics[0].unit).toBe('Topics');
  });

  test('a Supabase or Qdrant failure degrades to whatever the other source has', async () => {
    mockScroll.mockRejectedValue(new Error('qdrant down'));
    mockDb.syllabus_chapters = [{ id: 'c1', curriculum: 'Cambridge', grade: 'Stage 4', subject: 'English', unit_no: 1, title: 'Stories', school_id: null }];
    const subjects = await listBoardSubjects('Cambridge', 'Grade 4');
    expect(subjects.map((s) => s.subject)).toEqual(['English']);
  });
});

describe('Cambridge Primary / Lower Secondary strands', () => {
  const strand = (id, subject, ordinal, title, [from, to] = [1, 6]) => ({
    id, board: 'CAMBRIDGE', subject, version: `${subject}-public`, year_from: 2020, year_to: 2030, level: 'UNIT', parent_id: null, ordinal, title, grade_from: from, grade_to: to,
  });

  test('a Primary class shows the official strands instead of the AI outline', async () => {
    mockDb.board_syllabus_nodes = [strand('n1', 'Mathematics', 1, 'Number'), strand('n2', 'Mathematics', 2, 'Geometry and Measure')];
    mockDb.syllabus_chapters = [{ id: 'c1', curriculum: 'Cambridge', grade: 'Stage 4', subject: 'Social Studies', unit_no: 1, title: 'Maps', school_id: null }];
    const subjects = await listBoardSubjects('Cambridge', 'Grade 4');
    expect(subjects.map((s) => s.subject)).toEqual(['Mathematics']);
    expect(subjects[0].units).toEqual(['Number', 'Geometry and Measure']);
  });

  test('strands only reach the classes of their stage', async () => {
    mockDb.board_syllabus_nodes = [strand('n1', 'Mathematics', 1, 'Number', [7, 8])];
    expect(await listBoardSubjects('Cambridge', 'Grade 6')).toEqual([]);
    expect((await listBoardSubjects('Cambridge', 'Grade 8')).map((s) => s.subject)).toEqual(['Mathematics']);
  });

  test('a strand with no topics opens as one Coming soon topic of the same name', async () => {
    mockDb.board_syllabus_nodes = [strand('n1', 'Science', 1, 'Earth and Space')];
    const units = await listBoardSyllabus('Cambridge', 'Grade 2', 'Science');
    expect(units).toEqual([expect.objectContaining({ title: 'Earth and Space', topics: [expect.objectContaining({ name: 'Earth and Space' })] })]);
  });
});

describe('listBoardSyllabus', () => {
  test('chapters + topics from the outline, every topic Coming soon', async () => {
    mockDb.syllabus_chapters = [
      { id: 'c1', curriculum: 'Cambridge', grade: 'IGCSE Year 10', subject: 'Physics', unit_no: 1, title: 'Motion', school_id: null },
      { id: 'c2', curriculum: 'Cambridge', grade: 'IGCSE Year 10', subject: 'Physics', unit_no: 2, title: 'Energy', school_id: null },
    ];
    mockDb.syllabus_topics = [{ id: 't1', chapter_id: 'c1', topic_order: 0, name: 'Speed and Velocity' }];
    const units = await listBoardSyllabus('Cambridge', 'Grade 10', 'Physics');
    expect(units).toEqual([
      { unitNo: 1, title: 'Motion', topics: [{ id: 't1', name: 'Speed and Velocity', kind: 'coming_soon', page: '', comingSoon: true }], comingSoon: true, pending: false },
      { unitNo: 2, title: 'Energy', topics: [expect.objectContaining({ name: 'Energy', comingSoon: true })], comingSoon: true, pending: false },
    ]);
  });

  test('the same chapter stored under two grade labels is listed once', async () => {
    mockDb.syllabus_chapters = [
      { id: 'c1', curriculum: 'ICSE', grade: 'Class VI', subject: 'History', unit_no: 1, title: 'Early Humans', school_id: null },
      { id: 'c2', curriculum: 'ICSE', grade: 'Grade 6', subject: 'History', unit_no: 1, title: 'Early Humans', school_id: null },
    ];
    const units = await listBoardSyllabus('ICSE', 'Grade 6', 'History');
    expect(units).toHaveLength(1);
  });

  test('no outline: Qdrant topics grouped into a browsable chapter, Coming soon', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { curriculum: 'ICSE', grade: 'Class VII', subject: 'Biology', topic: 'Cell Structure' } },
        { payload: { curriculum: 'ICSE', grade: 'Class VII', subject: 'Biology', topic: 'Cell Structure' } },
        { payload: { curriculum: 'ICSE', grade: 'Class VII', subject: 'Biology', topic: 'Tissues' } },
      ],
      next_page_offset: null,
    });
    const units = await listBoardSyllabus('ICSE', 'Grade 7', 'Biology');
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ unitNo: 1, title: 'Topics', comingSoon: true, pending: false });
    expect(units[0].topics.map((t) => [t.name, t.comingSoon])).toEqual([['Cell Structure', true], ['Tissues', true]]);
  });
});
