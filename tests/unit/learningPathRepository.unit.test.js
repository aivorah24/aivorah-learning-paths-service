jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');
const {
  learningPathTitle,
  createDraftLearningPath,
  getDraftByCurriculumId,
  updateDraftContent,
  getLearningPathByCurriculumId,
  publishLearningPath,
  listPublishedLearningPathsForTeachers,
} = require('../../services/curriculumUpload/learningPathRepository');

function insertChain(response) {
  const chain = {};
  chain.insert = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.single = jest.fn(() => Promise.resolve(response));
  return chain;
}

function getChain(response) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(() => Promise.resolve(response));
  return chain;
}

function updateChain(response) {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.single = jest.fn(() => Promise.resolve(response));
  return chain;
}

function updateMaybeSingleChain(response) {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(() => Promise.resolve(response));
  return chain;
}

describe('createDraftLearningPath', () => {
  beforeEach(() => jest.clearAllMocks());

  test('inserts a draft row with status draft', async () => {
    const chain = insertChain({ data: { id: 'lp1' }, error: null });
    supabase.from.mockReturnValueOnce(chain);

    const result = await createDraftLearningPath({ curriculumId: 'c1', teacherId: 't1', content: { units: [] } });

    expect(chain.insert).toHaveBeenCalledWith({
      curriculum_id: 'c1', teacher_id: 't1', content: { units: [] }, status: 'draft',
    });
    expect(result).toEqual({ id: 'lp1' });
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(insertChain({ data: null, error: { message: 'db down' } }));
    await expect(createDraftLearningPath({})).rejects.toThrow('db down');
  });
});

describe('getDraftByCurriculumId', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the draft row for a curriculum', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: { id: 'lp1', status: 'draft' }, error: null }));
    const result = await getDraftByCurriculumId('c1');
    expect(result).toEqual({ id: 'lp1', status: 'draft' });
  });

  test('returns null when no draft exists', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: null, error: null }));
    const result = await getDraftByCurriculumId('c1');
    expect(result).toBeNull();
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: null, error: { message: 'db down' } }));
    await expect(getDraftByCurriculumId('c1')).rejects.toThrow('db down');
  });
});

describe('updateDraftContent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('updates the working copy whatever the status (a published path stays editable)', async () => {
    const chain = updateChain({ data: { id: 'lp1', content: { units: [] } }, error: null });
    supabase.from.mockReturnValueOnce(chain);

    const result = await updateDraftContent('lp1', { units: [] });

    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ content: { units: [] } }));
    expect(chain.eq).not.toHaveBeenCalledWith('status', 'draft');
    expect(result).toEqual({ id: 'lp1', content: { units: [] } });
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(updateChain({ data: null, error: { message: 'db down' } }));
    await expect(updateDraftContent('lp1', {})).rejects.toThrow('db down');
  });
});

describe('getLearningPathByCurriculumId', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the row regardless of status', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: { id: 'lp1', status: 'published' }, error: null }));
    const result = await getLearningPathByCurriculumId('c1');
    expect(result).toEqual({ id: 'lp1', status: 'published' });
  });

  test('returns null when nothing exists', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: null, error: null }));
    expect(await getLearningPathByCurriculumId('c1')).toBeNull();
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: null, error: { message: 'db down' } }));
    await expect(getLearningPathByCurriculumId('c1')).rejects.toThrow('db down');
  });
});

describe('publishLearningPath', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sets status, published_content and published_at — also for a later "Publish updates"', async () => {
    const chain = updateMaybeSingleChain({ data: { id: 'lp1', status: 'published' }, error: null });
    supabase.from.mockReturnValueOnce(chain);

    const result = await publishLearningPath('lp1', { units: [] });

    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'published', published_content: { units: [] },
    }));
    expect(chain.update.mock.calls[0][0]).toHaveProperty('published_at');
    expect(chain.eq).not.toHaveBeenCalledWith('status', 'draft');
    expect(result).toEqual({ id: 'lp1', status: 'published' });
  });

  test('returns null when no row matched', async () => {
    supabase.from.mockReturnValueOnce(updateMaybeSingleChain({ data: null, error: null }));
    const result = await publishLearningPath('lp1', { units: [] });
    expect(result).toBeNull();
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(updateMaybeSingleChain({ data: null, error: { message: 'db down' } }));
    await expect(publishLearningPath('lp1', {})).rejects.toThrow('db down');
  });
});

describe('listPublishedLearningPathsForTeachers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns [] without querying for an empty teacher list', async () => {
    const result = await listPublishedLearningPathsForTeachers([]);
    expect(result).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('returns published paths scoped to status=published and the given teacher ids', async () => {
    const chain = {};
    chain.select = jest.fn(() => chain);
    chain.eq = jest.fn(() => chain);
    chain.in = jest.fn(() => chain);
    chain.order = jest.fn(() => Promise.resolve({ data: [{ id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', published_at: 'x' }], error: null }));
    supabase.from.mockReturnValueOnce(chain);

    const result = await listPublishedLearningPathsForTeachers(['t1']);

    expect(chain.eq).toHaveBeenCalledWith('status', 'published');
    expect(chain.in).toHaveBeenCalledWith('teacher_id', ['t1']);
    expect(result).toEqual([{ id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', published_at: 'x' }]);
  });

  test('throws on a DB error', async () => {
    const chain = {};
    chain.select = jest.fn(() => chain);
    chain.eq = jest.fn(() => chain);
    chain.in = jest.fn(() => chain);
    chain.order = jest.fn(() => Promise.resolve({ data: null, error: { message: 'db down' } }));
    supabase.from.mockReturnValueOnce(chain);
    await expect(listPublishedLearningPathsForTeachers(['t1'])).rejects.toThrow('db down');
  });
});

describe('learningPathTitle', () => {
  test("the teacher's own title wins", () => {
    expect(learningPathTitle({ title: ' Term 1 Maths ', grade: '6', subject: 'Mathematics' }, 'x.docx')).toBe('Term 1 Maths');
  });
  test('otherwise "Grade 6 Mathematics" from the settings', () => {
    expect(learningPathTitle({ grade: '6', subject: 'Mathematics' }, 'x.docx')).toBe('Grade 6 Mathematics');
    expect(learningPathTitle({ grade: 'Grade 7', subject: 'Science' }, 'x.docx')).toBe('Grade 7 Science');
  });
  test('last resort: a readable file name', () => {
    expect(learningPathTitle({}, 'Grade_6_Mathematics_Curriculum_Test.docx')).toBe('Grade 6 Mathematics Curriculum Test');
  });
});
