jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');

function insertChain(response) {
  return { insert: jest.fn(() => Promise.resolve(response)) };
}

function claimUpdateChain(response) {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.select = jest.fn(() => Promise.resolve(response));
  return chain;
}

function markDoneChain() {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => Promise.resolve({ error: null }));
  return chain;
}

function pollChain(response) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.in = jest.fn(() => Promise.resolve(response));
  return chain;
}

const jobQueue = require('../../services/jobQueue');

describe('jobQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('publishJob inserts a pending row and returns a jobId', async () => {
    const chain = insertChain({ error: null });
    supabase.from.mockReturnValueOnce(chain);
    const { jobId } = await jobQueue.publishJob('curriculum_extract', { curriculumId: 'c1' });
    expect(jobId).toEqual(expect.any(String));
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'curriculum_extract', status: 'pending' })
    );
  });

  test('publishJob throws when the insert fails', async () => {
    supabase.from.mockReturnValueOnce(insertChain({ error: { message: 'db down' } }));
    await expect(jobQueue.publishJob('curriculum_extract')).rejects.toThrow('db down');
  });

  test('processJobById runs the registered handler and marks the job done', async () => {
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job1', type: 'curriculum_extract_ok', payload: { a: 1 } }] }))
      .mockReturnValueOnce(markDoneChain());

    const handler = jest.fn().mockResolvedValue({ ok: true });
    jobQueue.registerHandler('curriculum_extract_ok', handler);

    const ok = await jobQueue.processJobById('job1');

    expect(ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ a: 1 }, expect.objectContaining({ id: 'job1' }));
  });

  test('processJobById marks the job failed when no handler is registered', async () => {
    const markFailed = markDoneChain();
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job2', type: 'unknown_type', payload: {} }] }))
      .mockReturnValueOnce(markFailed);

    const ok = await jobQueue.processJobById('job2');

    expect(ok).toBe(false);
    expect(markFailed.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
  });

  test('processJobById returns false when the row is already claimed', async () => {
    supabase.from.mockReturnValueOnce(claimUpdateChain({ data: [] }));
    const ok = await jobQueue.processJobById('job3');
    expect(ok).toBe(false);
  });

  test('runWorkerOnce scopes the poll to registered handler types', async () => {
    const chain = pollChain({ data: [] });
    supabase.from.mockReturnValueOnce(chain);

    await jobQueue.runWorkerOnce(5);

    expect(chain.in).toHaveBeenCalledWith('type', expect.arrayContaining(['curriculum_extract_ok']));
  });
});
