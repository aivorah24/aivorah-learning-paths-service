jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGetCurriculumById = jest.fn();
const mockUpdateCurriculumStatus = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  getCurriculumById: (...args) => mockGetCurriculumById(...args),
  updateCurriculumStatus: (...args) => mockUpdateCurriculumStatus(...args),
}));

const mockDownloadCurriculumFile = jest.fn();
jest.mock('../../services/curriculumUpload/downloadCurriculumFile', () => ({
  downloadCurriculumFile: (...args) => mockDownloadCurriculumFile(...args),
}));

const mockExtractCurriculumContent = jest.fn();
jest.mock('../../services/curriculumUpload/extraction', () => {
  const actual = jest.requireActual('../../services/curriculumUpload/extraction');
  return { ...actual, extractCurriculumContent: (...args) => mockExtractCurriculumContent(...args) };
});

jest.mock('../../services/curriculumUpload/progress', () => ({ writeJobProgress: jest.fn(), getProgress: jest.fn() }));

const supabase = require('../../services/supabase');
const jobQueue = require('../../services/jobQueue');
require('../../services/jobHandlers');

function claimUpdateChain(response) {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.select = jest.fn(() => Promise.resolve(response));
  return chain;
}

function markStatusChain() {
  const chain = {};
  chain.update = jest.fn(() => chain);
  chain.eq = jest.fn(() => Promise.resolve({ error: null }));
  return chain;
}

function insertChain() {
  return { insert: jest.fn(() => Promise.resolve({ error: null })) };
}

const curriculum = { id: 'c1', file_url: 'https://cdn/x.pdf', mime_type: 'application/pdf' };

describe('curriculum_extract job end-to-end', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a successful extraction chains a generate job and moves the curriculum to generating', async () => {
    const enqueue = insertChain();
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job1', type: 'curriculum_extract', payload: { curriculumId: 'c1' } }] }))
      .mockReturnValueOnce(enqueue)
      .mockReturnValueOnce(markStatusChain());

    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('pdf bytes'));
    mockExtractCurriculumContent.mockResolvedValueOnce({ format: 'pdf', text: 'Chapter 1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'processed' });

    const ok = await jobQueue.processJobById('job1');

    expect(ok).toBe(true);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'processed', expect.objectContaining({ error: null }));
    expect(enqueue.insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'curriculum_generate',
      payload: expect.objectContaining({ curriculumId: 'c1', progress: expect.objectContaining({ stage: 'queued' }) }),
    }));
    expect(mockUpdateCurriculumStatus).toHaveBeenLastCalledWith('c1', 'generating');
  });

  test('a failing extraction marks the job failed but the curriculum stays reprocessable', async () => {
    const markFailed = markStatusChain();
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job2', type: 'curriculum_extract', payload: { curriculumId: 'c1' } }] }))
      .mockReturnValueOnce(markFailed);

    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('garbage'));
    mockExtractCurriculumContent.mockRejectedValueOnce(new Error('Failed to parse PDF: corrupt'));
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'failed' });

    const ok = await jobQueue.processJobById('job2');

    expect(ok).toBe(false);
    expect(markFailed.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'Failed to parse PDF: corrupt' });
  });
});
