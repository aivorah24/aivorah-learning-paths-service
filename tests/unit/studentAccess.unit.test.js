jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');
const { isStudentOfTeacher, listTeacherIdsForStudent } = require('../../services/curriculumUpload/studentAccess');

function listChain(response) {
  const c = {};
  c.select = jest.fn(() => c);
  c.eq = jest.fn(() => Promise.resolve(response));
  return c;
}

function chain(response) {
  const c = {};
  c.select = jest.fn(() => c);
  c.eq = jest.fn(() => c);
  c.limit = jest.fn(() => c);
  c.maybeSingle = jest.fn(() => Promise.resolve(response));
  return c;
}

describe('isStudentOfTeacher', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns true when a teacher_student row exists', async () => {
    supabase.from.mockReturnValueOnce(chain({ data: { teacher_id: 't1' }, error: null }));
    expect(await isStudentOfTeacher('t1', 's1')).toBe(true);
  });

  test('returns false when no relationship row exists', async () => {
    supabase.from.mockReturnValueOnce(chain({ data: null, error: null }));
    expect(await isStudentOfTeacher('t1', 's1')).toBe(false);
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(chain({ data: null, error: { message: 'db down' } }));
    await expect(isStudentOfTeacher('t1', 's1')).rejects.toThrow('db down');
  });
});

describe('listTeacherIdsForStudent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns deduplicated teacher ids', async () => {
    supabase.from.mockReturnValueOnce(listChain({ data: [{ teacher_id: 't1' }, { teacher_id: 't1' }, { teacher_id: 't2' }], error: null }));
    expect(await listTeacherIdsForStudent('s1')).toEqual(['t1', 't2']);
  });

  test('returns an empty array when the student has no links', async () => {
    supabase.from.mockReturnValueOnce(listChain({ data: [], error: null }));
    expect(await listTeacherIdsForStudent('s1')).toEqual([]);
  });

  test('throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(listChain({ data: null, error: { message: 'db down' } }));
    await expect(listTeacherIdsForStudent('s1')).rejects.toThrow('db down');
  });
});
