jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');
const {
  createCurriculum,
  updateCurriculumStatus,
  getCurriculumById,
  getCurriculaByIds,
} = require('../../services/curriculumUpload/curriculumRepository');

function insertChain(response) {
  const chain = {};
  chain.insert = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.single = jest.fn(() => Promise.resolve(response));
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

function getChain(response) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(() => Promise.resolve(response));
  return chain;
}

describe('curriculumRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('createCurriculum inserts a row and returns it', async () => {
    const chain = insertChain({ data: { id: 'c1' }, error: null });
    supabase.from.mockReturnValueOnce(chain);

    const result = await createCurriculum({
      teacherId: 't1', fileName: 'a.pdf', mimeType: 'application/pdf', fileUrl: 'https://x', cloudinaryPublicId: 'p1',
    });

    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ teacher_id: 't1', file_name: 'a.pdf' }));
    expect(result).toEqual({ id: 'c1' });
  });

  test('createCurriculum throws on a DB error', async () => {
    supabase.from.mockReturnValueOnce(insertChain({ data: null, error: { message: 'db down' } }));
    await expect(createCurriculum({})).rejects.toThrow('db down');
  });

  test('updateCurriculumStatus updates status and merges extra fields', async () => {
    const chain = updateChain({ data: { id: 'c1', status: 'failed', error: 'boom' }, error: null });
    supabase.from.mockReturnValueOnce(chain);

    const result = await updateCurriculumStatus('c1', 'failed', { error: 'boom' });

    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'boom' }));
    expect(result).toEqual({ id: 'c1', status: 'failed', error: 'boom' });
  });

  test('getCurriculumById returns null when not found', async () => {
    supabase.from.mockReturnValueOnce(getChain({ data: null, error: null }));
    const result = await getCurriculumById('missing');
    expect(result).toBeNull();
  });

  test('getCurriculaByIds returns [] without querying for an empty id list', async () => {
    const result = await getCurriculaByIds([]);
    expect(result).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('getCurriculaByIds returns matching rows', async () => {
    function inChain(response) {
      const chain = {};
      chain.select = jest.fn(() => chain);
      chain.in = jest.fn(() => Promise.resolve(response));
      return chain;
    }
    supabase.from.mockReturnValueOnce(inChain({ data: [{ id: 'c1', file_name: 'a.pdf' }], error: null }));
    const result = await getCurriculaByIds(['c1']);
    expect(result).toEqual([{ id: 'c1', file_name: 'a.pdf' }]);
  });

  test('getCurriculaByIds throws on a DB error', async () => {
    function inChain(response) {
      const chain = {};
      chain.select = jest.fn(() => chain);
      chain.in = jest.fn(() => Promise.resolve(response));
      return chain;
    }
    supabase.from.mockReturnValueOnce(inChain({ data: null, error: { message: 'db down' } }));
    await expect(getCurriculaByIds(['c1'])).rejects.toThrow('db down');
  });
});
