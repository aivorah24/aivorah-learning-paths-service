const mockCallWithFallback = jest.fn();
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: (...a) => mockCallWithFallback(...a) }));

const { structureWithAI, makeFoundIn, verify, documentText, lastCoveredLine, leftover } = require('../../services/curriculumUpload/aiStructure');

const DOC = [
  'Grade 6 Science Curriculum',
  'Strand 1: Living Things',
  'Topic\tSubtopics\tObjectives',
  'Plants\tLeaves; roots; stems\tName the parts of a plant',
  'Animals\tBirds; insects\tSort animals into groups',
  'Strand 2: Materials',
  'Topic\tSubtopics\tObjectives',
  'Solids and liquids\tShape; flow\tCompare solids and liquids',
].join('\n');
const answer = (units) => JSON.stringify({ metadata: { grade: '6', subject: 'Science', curriculum: null }, units });

beforeEach(() => mockCallWithFallback.mockReset());

test('finds units, topics, subtopics and notes for any layout and returns the normalized shape', async () => {
  mockCallWithFallback.mockResolvedValueOnce(answer([
    { title: 'Strand 1: Living Things', topics: [
      { title: 'Plants', subtopics: ['Leaves', 'roots', 'stems'], notes: ['Objectives: Name the parts of a plant'] },
      { title: 'Animals', subtopics: ['Birds', 'insects'], notes: [] },
    ] },
    { title: 'Materials', topics: [{ title: 'Solids and liquids', subtopics: ['Shape', 'flow'], notes: [] }] },
  ]));
  const s = await structureWithAI({ format: 'pdf', text: DOC });
  expect(s.structuredBy).toBe('ai');
  expect(s.metadata).toEqual({ grade: '6', subject: 'Science' });
  expect(s.units.map((u) => u.title)).toEqual(['Living Things', 'Materials']);
  expect(s.units[0].topics[0]).toMatchObject({ title: 'Plants', order: 0, content: ['Objectives: Name the parts of a plant'] });
  expect(s.units[0].topics[0].subtopics.map((x) => x.title)).toEqual(['Leaves', 'roots', 'stems']);
});

test('anything the document does not contain is dropped (no invented topics, subtopics or notes)', () => {
  const foundIn = makeFoundIn(DOC);
  const out = verify({ units: [{ title: 'Living Things', topics: [
    { title: 'Plants', subtopics: ['Leaves', 'Photosynthesis in C4 plants'], notes: ['Objectives: Name the parts of a plant', 'Explain quantum tunnelling'] },
    { title: 'Volcanoes', subtopics: [], notes: [] },
  ] }] }, foundIn);
  expect(out.units[0].topics.map((t) => t.title)).toEqual(['Plants']);
  expect(out.units[0].topics[0].subtopics).toEqual(['Leaves']);
  expect(out.units[0].topics[0].notes).toEqual(['Objectives: Name the parts of a plant']);
});

test('an answer that stops early is followed up for the part of the document it skipped', async () => {
  mockCallWithFallback
    .mockResolvedValueOnce(answer([{ title: 'Living Things', topics: [{ title: 'Plants', subtopics: ['Leaves'], notes: [] }, { title: 'Animals', subtopics: ['Birds'], notes: [] }] }]))
    .mockResolvedValueOnce(answer([{ title: 'Materials', topics: [{ title: 'Solids and liquids', subtopics: ['Shape'], notes: [] }] }]));
  const s = await structureWithAI({ format: 'pdf', text: DOC });
  expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
  expect(mockCallWithFallback.mock.calls[1][0]).toContain('Solids and liquids');
  expect(mockCallWithFallback.mock.calls[1][0]).not.toContain('Leaves; roots; stems');
  expect(s.units.map((u) => u.title)).toEqual(['Living Things', 'Materials']);
});

test('nothing usable (AI down, or only invented content) -> null, so the rules take over', async () => {
  mockCallWithFallback.mockRejectedValueOnce(new Error('all providers exhausted'));
  expect(await structureWithAI({ format: 'pdf', text: DOC })).toBeNull();
  mockCallWithFallback.mockResolvedValueOnce(answer([{ title: 'X', topics: [{ title: 'Black holes', subtopics: [], notes: [] }] }]));
  expect(await structureWithAI({ format: 'pdf', text: DOC })).toBeNull();
});

test('spreadsheets are read row by row with cells kept apart', () => {
  const text = documentText({ format: 'xlsx', sheets: [{ name: 'Plan', rows: [['Unit', 'Topic'], ['Living Things', 'Plants']] }] });
  expect(text).toBe('Sheet: Plan\nUnit\tTopic\nLiving Things\tPlants');
});

test('coverage: the last line the answer accounts for, and whether real content is left after it', () => {
  const lines = DOC.split('\n');
  const result = { units: [{ title: 'Living Things', topics: [{ title: 'Plants', subtopics: ['Leaves'], notes: [] }] }] };
  const last = lastCoveredLine(lines, result);
  expect(lines[last]).toContain('Plants');
  expect(leftover(lines, last)).toEqual(expect.arrayContaining(['Solids and liquids\tShape; flow\tCompare solids and liquids']));
  expect(leftover(lines, lines.length - 1)).toBeNull();
});

test('an answer wrapped in a list is read the same (it used to count as "no units" and drop every subtopic)', async () => {
  const units = [{ title: 'Living Things', topics: [{ title: 'Plants', subtopics: ['Leaves', 'roots'], notes: [] }] }];
  mockCallWithFallback.mockResolvedValue(`[${answer(units)}]`);
  const wrapped = await structureWithAI({ format: 'pdf', text: 'Strand 1: Living Things\nPlants\tLeaves; roots' });
  expect(wrapped.units[0].topics[0].subtopics.map((s) => s.title)).toEqual(['Leaves', 'roots']);

  mockCallWithFallback.mockResolvedValue(JSON.stringify(units));
  const bare = await structureWithAI({ format: 'pdf', text: 'Strand 1: Living Things\nPlants\tLeaves; roots' });
  expect(bare.units[0].title).toBe('Living Things');
});
