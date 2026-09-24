jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGetCurriculumById = jest.fn();
const mockUpdateCurriculumStatus = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  getCurriculumById: (...args) => mockGetCurriculumById(...args),
  updateCurriculumStatus: (...args) => mockUpdateCurriculumStatus(...args),
}));

const mockGenerateLearningPathDraft = jest.fn();
jest.mock('../../services/curriculumUpload/aiGeneration', () => ({
  generateLearningPathDraft: (...args) => mockGenerateLearningPathDraft(...args),
  LearningPathGenerationError: jest.requireActual('../../services/curriculumUpload/aiGeneration').LearningPathGenerationError,
}));

const mockCreateDraftLearningPath = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  createDraftLearningPath: (...args) => mockCreateDraftLearningPath(...args),
}));

const mockDownloadCurriculumFile = jest.fn();
jest.mock('../../services/curriculumUpload/downloadCurriculumFile', () => ({
  downloadCurriculumFile: (...args) => mockDownloadCurriculumFile(...args),
}));

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

const curriculum = {
  id: 'c1',
  teacher_id: 't1',
  extracted_structure: { format: 'pdf', text: 'Chapter 1: Numbers\n1.1 Whole Numbers' },
};

describe('curriculum_generate job end-to-end', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a successful generation marks the job done and persists a draft learning path', async () => {
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job1', type: 'curriculum_generate', payload: { curriculumId: 'c1' } }] }))
      .mockReturnValueOnce(markStatusChain());

    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockGenerateLearningPathDraft.mockResolvedValueOnce({ version: 1, units: [] });
    mockCreateDraftLearningPath.mockResolvedValueOnce({ id: 'lp1' });
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'generated' });

    const ok = await jobQueue.processJobById('job1');

    expect(ok).toBe(true);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'generating');
    expect(mockCreateDraftLearningPath).toHaveBeenCalledWith({ curriculumId: 'c1', teacherId: 't1', content: { version: 1, units: [] } });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'generated', { error: null });
  });

  test('a failing generation marks the job failed and leaves the curriculum marked failed with an error', async () => {
    const markFailed = markStatusChain();
    supabase.from
      .mockReturnValueOnce(claimUpdateChain({ data: [{ id: 'job2', type: 'curriculum_generate', payload: { curriculumId: 'c1' } }] }))
      .mockReturnValueOnce(markFailed);

    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockGenerateLearningPathDraft.mockRejectedValueOnce(new Error('AI generation failed after retry: bad json'));
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'failed' });

    const ok = await jobQueue.processJobById('job2');

    expect(ok).toBe(false);
    expect(markFailed.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'AI generation failed after retry: bad json' });
    expect(mockCreateDraftLearningPath).not.toHaveBeenCalled();
  });
});
