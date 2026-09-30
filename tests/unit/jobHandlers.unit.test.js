// aiGeneration.js's real module (loaded below via requireActual, only for
// LearningPathGenerationError) now pulls in topicCache.js -> services/supabase,
// which throws at require-time with no SUPABASE_URL configured.
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn(), upsert: jest.fn() })) }));

const mockRegisterHandler = jest.fn();
const mockPublishJob = jest.fn();
jest.mock('../../services/jobQueue', () => ({ registerHandler: mockRegisterHandler, publishJob: (...a) => mockPublishJob(...a) }));
const mockWriteJobProgress = jest.fn();
jest.mock('../../services/curriculumUpload/progress', () => ({ writeJobProgress: (...a) => mockWriteJobProgress(...a) }));

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
const { CurriculumExtractionError } = jest.requireActual('../../services/curriculumUpload/extraction');
jest.mock('../../services/curriculumUpload/extraction', () => {
  const actual = jest.requireActual('../../services/curriculumUpload/extraction');
  return {
    ...actual,
    extractCurriculumContent: (...args) => mockExtractCurriculumContent(...args),
  };
});

const mockGenerateLearningPathDraft = jest.fn();
jest.mock('../../services/curriculumUpload/aiGeneration', () => ({
  generateLearningPathDraft: (...args) => mockGenerateLearningPathDraft(...args),
  LearningPathGenerationError: jest.requireActual('../../services/curriculumUpload/aiGeneration').LearningPathGenerationError,
}));

const mockCreateDraftLearningPath = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  createDraftLearningPath: (...args) => mockCreateDraftLearningPath(...args),
}));

require('../../services/jobHandlers');
const extractRegistrationCall = mockRegisterHandler.mock.calls[0];
const generateRegistrationCall = mockRegisterHandler.mock.calls[1];
const handleCurriculumExtract = extractRegistrationCall[1];
const handleCurriculumGenerate = generateRegistrationCall[1];

const curriculum = {
  id: 'c1',
  file_url: 'https://cdn/x.pdf',
  mime_type: 'application/pdf',
  cloudinary_public_id: 'pub1',
};

describe('handleCurriculumExtract', () => {
  beforeEach(() => jest.clearAllMocks());

  test('registers itself under the curriculum_extract job type', () => {
    expect(extractRegistrationCall[0]).toBe('curriculum_extract');
    expect(extractRegistrationCall[1]).toEqual(expect.any(Function));
  });

  test('extracts, marks the curriculum processed, and preserves the file fields', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('pdf bytes'));
    mockExtractCurriculumContent.mockResolvedValueOnce({ format: 'pdf', text: 'Chapter 1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'processed' });

    const result = await handleCurriculumExtract({ curriculumId: 'c1' });

    expect(result).toEqual({ status: 'processed' });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'processed', {
      extracted_structure: { format: 'pdf', text: 'Chapter 1' },
      error: null,
    });
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_generate', expect.objectContaining({ curriculumId: 'c1' }));
    expect(mockUpdateCurriculumStatus).toHaveBeenLastCalledWith('c1', 'generating');
    const [, , extra] = mockUpdateCurriculumStatus.mock.calls[0];
    expect(extra).not.toHaveProperty('file_url');
    expect(extra).not.toHaveProperty('cloudinary_public_id');
  });

  test('throws when the curriculum row does not exist', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(null);
    await expect(handleCurriculumExtract({ curriculumId: 'missing' })).rejects.toThrow(/not found/);
    expect(mockUpdateCurriculumStatus).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed and rethrows on a Cloudinary download failure', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockRejectedValueOnce(new Error('Failed to download curriculum file (HTTP 404)'));

    await expect(handleCurriculumExtract({ curriculumId: 'c1' })).rejects.toThrow(/HTTP 404/);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', {
      error: 'Failed to download curriculum file (HTTP 404)',
    });
  });

  test('marks the curriculum failed and rethrows on a parser failure', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('garbage'));
    mockExtractCurriculumContent.mockRejectedValueOnce(new CurriculumExtractionError('Failed to parse PDF: bad xref'));

    await expect(handleCurriculumExtract({ curriculumId: 'c1' })).rejects.toThrow(/bad xref/);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', {
      error: 'Failed to parse PDF: bad xref',
    });
  });

  test('marks the curriculum failed when the document has no extractable content', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('pdf bytes'));
    mockExtractCurriculumContent.mockResolvedValueOnce({ format: 'pdf', text: '' });

    await expect(handleCurriculumExtract({ curriculumId: 'c1' })).rejects.toThrow(/no extractable content/);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', {
      error: expect.stringContaining('no extractable content'),
    });
  });
});

const processedCurriculum = {
  id: 'c1',
  teacher_id: 'teacher-uuid-1',
  extracted_structure: { format: 'pdf', text: 'Chapter 1: Numbers\n1.1 Whole Numbers' },
};

describe('handleCurriculumGenerate', () => {
  beforeEach(() => jest.clearAllMocks());

  test('registers itself under the curriculum_generate job type', () => {
    expect(generateRegistrationCall[0]).toBe('curriculum_generate');
    expect(generateRegistrationCall[1]).toEqual(expect.any(Function));
  });

  test('normalizes, generates, persists a draft and marks the curriculum generated', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(processedCurriculum);
    mockGenerateLearningPathDraft.mockResolvedValueOnce({ version: 1, units: [] });
    mockCreateDraftLearningPath.mockResolvedValueOnce({ id: 'lp1' });
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'generated' });

    const result = await handleCurriculumGenerate({ curriculumId: 'c1' });

    expect(result).toEqual({ status: 'generated', learningPathId: 'lp1' });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'generating');
    expect(mockCreateDraftLearningPath).toHaveBeenCalledWith({
      curriculumId: 'c1',
      teacherId: 'teacher-uuid-1',
      content: { version: 1, units: [] },
    });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'generated', { error: null });
  });

  test('throws when the curriculum row does not exist', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(null);
    await expect(handleCurriculumGenerate({ curriculumId: 'missing' })).rejects.toThrow(/not found/);
    expect(mockUpdateCurriculumStatus).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed when extracted_structure fails normalization', async () => {
    mockGetCurriculumById.mockResolvedValueOnce({ ...processedCurriculum, extracted_structure: null });
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'failed' });

    await expect(handleCurriculumGenerate({ curriculumId: 'c1' })).rejects.toThrow();
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: expect.any(String) });
    expect(mockGenerateLearningPathDraft).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed and rethrows when AI generation fails', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(processedCurriculum);
    mockGenerateLearningPathDraft.mockRejectedValueOnce(new Error('AI generation failed after retry: bad json'));
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'failed' });

    await expect(handleCurriculumGenerate({ curriculumId: 'c1' })).rejects.toThrow(/bad json/);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'AI generation failed after retry: bad json' });
    expect(mockCreateDraftLearningPath).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed and rethrows when persisting the draft fails', async () => {
    mockGetCurriculumById.mockResolvedValueOnce(processedCurriculum);
    mockGenerateLearningPathDraft.mockResolvedValueOnce({ version: 1, units: [] });
    mockCreateDraftLearningPath.mockRejectedValueOnce(new Error('insert failed'));
    mockUpdateCurriculumStatus.mockResolvedValue({ id: 'c1', status: 'failed' });

    await expect(handleCurriculumGenerate({ curriculumId: 'c1' })).rejects.toThrow('insert failed');
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'insert failed' });
  });
});

describe('progress writes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('extract writes the extracting stage', async () => {
    const job = { id: 'j1', payload: {} };
    mockGetCurriculumById.mockResolvedValueOnce(curriculum);
    mockDownloadCurriculumFile.mockResolvedValueOnce(Buffer.from('x'));
    mockExtractCurriculumContent.mockResolvedValueOnce({ format: 'pdf', text: 'Chapter 1' });
    mockUpdateCurriculumStatus.mockResolvedValue({});
    await handleCurriculumExtract({ curriculumId: 'c1' }, job);
    expect(mockWriteJobProgress).toHaveBeenCalledWith(job, 'extracting');
  });

  test('generate walks analysing, generating (counts), saving, done', async () => {
    const job = { id: 'j2', payload: {} };
    mockGetCurriculumById.mockResolvedValueOnce(processedCurriculum);
    mockGenerateLearningPathDraft.mockImplementationOnce(async (n, onTopicDone) => { await onTopicDone(1, 2); return { units: [] }; });
    mockCreateDraftLearningPath.mockResolvedValueOnce({ id: 'lp1' });
    mockUpdateCurriculumStatus.mockResolvedValue({});
    await handleCurriculumGenerate({ curriculumId: 'c1' }, job);
    const stages = mockWriteJobProgress.mock.calls.map((c) => c[1]);
    expect(stages).toEqual(['analysing', 'generating', 'generating', 'saving', 'done']);
    expect(mockWriteJobProgress).toHaveBeenCalledWith(job, 'generating', 1, 2);
  });
});
