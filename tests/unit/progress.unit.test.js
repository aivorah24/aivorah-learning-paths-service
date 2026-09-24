jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const supabase = require('../../services/supabase');
const { getProgress, writeJobProgress } = require('../../services/curriculumUpload/progress');

function selectChain(data) {
  const chain = {};
  ['select', 'eq', 'order'].forEach((m) => { chain[m] = jest.fn(() => chain); });
  chain.limit = jest.fn(() => Promise.resolve({ data }));
  return chain;
}

beforeEach(() => jest.clearAllMocks());

describe('getProgress', () => {
  test('returns the newest job row progress', async () => {
    const progress = { stage: 'generating', topicsDone: 2, topicsTotal: 5, updatedAt: 'x' };
    const chain = selectChain([{ payload: { curriculumId: 'c1', progress } }]);
    supabase.from.mockReturnValueOnce(chain);
    expect(await getProgress({ id: 'c1', status: 'generating' })).toEqual(progress);
    expect(chain.eq).toHaveBeenCalledWith('payload->>curriculumId', 'c1');
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  test.each([['processing', 'extracting'], ['generating', 'generating'], ['generated', 'done']])(
    'falls back to status %s -> %s with null counts when no job row exists', async (status, stage) => {
      supabase.from.mockReturnValueOnce(selectChain([]));
      expect(await getProgress({ id: 'c1', status })).toMatchObject({ stage, topicsDone: null, topicsTotal: null });
    });

  test('failed curriculum derives stage failed without querying jobs', async () => {
    expect(await getProgress({ id: 'c1', status: 'failed' })).toMatchObject({ stage: 'failed' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('uploaded with no job returns null', async () => {
    supabase.from.mockReturnValueOnce(selectChain([]));
    expect(await getProgress({ id: 'c1', status: 'uploaded' })).toBeNull();
  });
});

describe('writeJobProgress', () => {
  test('merges progress into the payload, keeping pool/curriculumId', async () => {
    const chain = { update: jest.fn(() => chain), eq: jest.fn(() => Promise.resolve({})) };
    supabase.from.mockReturnValueOnce(chain);
    const job = { id: 'j1', payload: { curriculumId: 'c1', pool: 'default' } };
    await writeJobProgress(job, 'generating', 1, 3);
    expect(chain.update.mock.calls[0][0].payload).toMatchObject({ curriculumId: 'c1', pool: 'default', progress: { stage: 'generating', topicsDone: 1, topicsTotal: 3 } });
  });

  test('never throws and no-ops without a job', async () => {
    supabase.from.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(writeJobProgress({ id: 'j', payload: {} }, 'saving')).resolves.toBeUndefined();
    await expect(writeJobProgress(undefined, 'saving')).resolves.toBeUndefined();
  });
});
