jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({ createCurriculum: jest.fn(), updateCurriculumStatus: jest.fn() }));
jest.mock('../../services/jobQueue', () => ({ publishJob: jest.fn() }));
jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({ uploadCurriculumFile: jest.fn() }));

const mockGetDraft = jest.fn();
const mockUpdateDraft = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  getDraftByCurriculumId: (...a) => mockGetDraft(...a),
  updateDraftContent: (...a) => mockUpdateDraft(...a),
  getLearningPathByCurriculumId: jest.fn(),
  publishLearningPath: jest.fn(),
}));

const mockLoadBookSections = jest.fn();
jest.mock('../../services/curriculumUpload/bookMatch', () => ({ loadBookSections: (...a) => mockLoadBookSections(...a) }));
const mockRebuildTopic = jest.fn();
jest.mock('../../services/curriculumUpload/aiGeneration', () => ({ rebuildTopic: (...a) => mockRebuildTopic(...a) }));

jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: jest.fn(() => chain), _chain: chain };
});

const express = require('express');
const request = require('supertest');
const supabase = require('../../services/supabase');
const teacherCurriculumRoute = require('../../routes/teacherCurriculum');

const app = express();
app.use(express.json());
app.use('/teacher-curriculum', teacherCurriculumRoute);

const extracted = { format: 'docx', text: 'Grade: 6\nSubject: Mathematics\nUnit 1: Numbers\nTopic 1: Whole Numbers\nSubtopics\nNumber line\nSuccessor', uploadConfig: { grade: '6' } };
const draftContent = {
  version: 1, metadata: { grade: '6', subject: 'Mathematics' },
  units: [{ title: 'Numbers', order: 0, topics: [{ title: 'Whole Numbers', order: 0, subtopics: [], objectives: ['old'], lessons: [], status: 'ready', content: null }] }],
};

beforeEach(() => jest.clearAllMocks());

describe('GET /teacher-curriculum/book-sections', () => {
  test('returns sections without their heavy tutor/learn payloads', async () => {
    mockLoadBookSections.mockResolvedValueOnce([{ id: 'S1', grade: 6, pdfFile: 'fegp102.pdf', title: '2.4 Ray', page: 3, tutor: { big: 1 }, learn: null }]);
    const res = await request(app).get('/teacher-curriculum/book-sections?grade=6&subject=Mathematics');
    expect(res.status).toBe(200);
    expect(mockLoadBookSections).toHaveBeenCalledWith('6', 'Mathematics');
    expect(res.body.sections).toEqual([{ grade: 6, pdfFile: 'fegp102.pdf', title: '2.4 Ray', page: 3 }]);
  });
});

describe('POST /teacher-curriculum/:id/learning-path/topics/rebuild', () => {
  const body = { unitOrder: 0, topicOrder: 0, subtopicSections: [{ pdfFile: 'fegp103.pdf', title: '3.3 Patterns' }, null] };

  test('rebuilds only the chosen topic with the picked sections and saves the draft', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'teacher-uuid-1', extracted_structure: extracted }, error: null });
    mockGetDraft.mockResolvedValueOnce({ id: 'lp1', content: draftContent });
    mockRebuildTopic.mockResolvedValueOnce({ objectives: ['new'], lessons: [], status: 'ready', content: { blocks: [] }, groundingSource: 'ncert_book' });
    mockUpdateDraft.mockImplementationOnce(async (id, content) => ({ id, content }));

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/topics/rebuild').send(body);

    expect(res.status).toBe(200);
    const [normalized, u, t, chosen] = mockRebuildTopic.mock.calls[0];
    expect(normalized.metadata).toMatchObject({ grade: '6', subject: 'Mathematics' });
    expect([u, t, chosen]).toEqual([0, 0, body.subtopicSections]);
    const saved = res.body.learningPath.content.units[0].topics[0];
    expect(saved).toMatchObject({ title: 'Whole Numbers', objectives: ['new'], groundingSource: 'ncert_book' });
  });

  test('400s on a bad body', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'teacher-uuid-1', extracted_structure: extracted }, error: null });
    const res = await request(app).post('/teacher-curriculum/c1/learning-path/topics/rebuild').send({ unitOrder: 0 });
    expect(res.status).toBe(400);
    expect(mockRebuildTopic).not.toHaveBeenCalled();
  });

  test('403s for another teacher\'s curriculum', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });
    const res = await request(app).post('/teacher-curriculum/c1/learning-path/topics/rebuild').send(body);
    expect(res.status).toBe(403);
  });

  test('a failed rebuild keeps the draft unchanged', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'teacher-uuid-1', extracted_structure: extracted }, error: null });
    mockGetDraft.mockResolvedValueOnce({ id: 'lp1', content: draftContent });
    mockRebuildTopic.mockRejectedValueOnce(new Error('Could not rebuild this topic right now — please try again'));
    const res = await request(app).post('/teacher-curriculum/c1/learning-path/topics/rebuild').send(body);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again/);
    expect(mockUpdateDraft).not.toHaveBeenCalled();
  });
});
