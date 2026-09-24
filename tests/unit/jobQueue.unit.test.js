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

  test('publishJob stores the worker pool in the payload', async () => {
    process.env.JOB_WORKER_POOL = 'local-dev';
    const chain = insertChain({ error: null });
    supabase.from.mockReturnValueOnce(chain);
    await jobQueue.publishJob('curriculum_extract', { curriculumId: 'c1' });
    delete process.env.JOB_WORKER_POOL;
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { curriculumId: 'c1', pool: 'local-dev' } })
    );
  });

  test('runWorkerOnce only claims jobs in its own pool (unpooled rows belong to default)', async () => {
    const rows = [
      { id: 'a', payload: { pool: 'local-dev' } },
      { id: 'b', payload: {} },
      { id: 'c', payload: { pool: 'default' } },
    ];
    const chain = pollChain({ data: rows });
    // Claim step (update...select() with no args) finds nothing; poll step (select(cols)) returns the chain.
    chain.update = jest.fn(() => chain);
    chain.select = jest.fn((cols) => (cols === undefined ? Promise.resolve({ data: [] }) : chain));
    supabase.from.mockReturnValue(chain);

    const res = await jobQueue.runWorkerOnce(5);
    supabase.from.mockReset();

    expect(res.claimed).toBe(2);
    const claimedIds = chain.eq.mock.calls.filter((c) => c[0] === 'id').map((c) => c[1]);
    expect(claimedIds).toEqual(['b', 'c']);
  });

  test('recoverStaleJobs fails stale processing jobs and their curriculum rows (own pool only)', async () => {
    const scan = {};
    scan.select = jest.fn(() => scan);
    scan.eq = jest.fn(() => scan);
    scan.lt = jest.fn(() => scan);
    scan.in = jest.fn(() => Promise.resolve({ data: [
      { id: 'j1', payload: { curriculumId: 'cur1', pool: 'default' } },
      { id: 'j2', payload: { curriculumId: 'cur2', pool: 'local-dev' } },
    ] }));
    const jobUpdate = markDoneChain();
    const curUpdate = {};
    curUpdate.update = jest.fn(() => curUpdate);
    curUpdate.eq = jest.fn(() => curUpdate);
    curUpdate.select = jest.fn(() => curUpdate);
    curUpdate.single = jest.fn(() => Promise.resolve({ data: {}, error: null }));
    supabase.from.mockReset();
    supabase.from.mockReturnValueOnce(scan).mockReturnValueOnce(jobUpdate).mockReturnValueOnce(curUpdate);

    const recovered = await jobQueue.recoverStaleJobs();

    expect(recovered).toBe(1);
    expect(scan.lt).toHaveBeenCalledWith('locked_at', expect.any(String));
    expect(jobUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'interrupted (worker restarted)' }));
    expect(curUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'interrupted (worker restarted)' }));
    expect(curUpdate.eq).toHaveBeenCalledWith('id', 'cur1');
  });
});
