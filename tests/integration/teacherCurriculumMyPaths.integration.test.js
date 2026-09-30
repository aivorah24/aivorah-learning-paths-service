jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));
jest.mock('../../services/jobQueue', () => ({ publishJob: jest.fn() }));
jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({ uploadCurriculumFile: jest.fn() }));

const mockGetCurriculaByIds = jest.fn();
const mockDeleteCurriculum = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  createCurriculum: jest.fn(),
  updateCurriculumStatus: jest.fn(),
  getCurriculaByIds: (...a) => mockGetCurriculaByIds(...a),
  deleteCurriculum: (...a) => mockDeleteCurriculum(...a),
}));

const mockListLearningPathsForTeacher = jest.fn();
const mockDeleteLearningPaths = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  ...jest.requireActual('../../services/curriculumUpload/learningPathRepository'),
  listLearningPathsForTeacher: (...a) => mockListLearningPathsForTeacher(...a),
  deleteLearningPathsForCurriculum: (...a) => mockDeleteLearningPaths(...a),
}));

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

beforeEach(() => jest.clearAllMocks());

describe('GET /teacher-curriculum/learning-paths', () => {
  test("lists only this teacher's paths with a name, state and unpublished-edits flag", async () => {
    mockListLearningPathsForTeacher.mockResolvedValueOnce([
      { id: 'lp1', curriculum_id: 'c1', status: 'published', updated_at: '2026-09-29T16:10:00Z', published_at: '2026-09-29T15:59:00Z', meta: { grade: '6', subject: 'Mathematics' } },
      { id: 'lp2', curriculum_id: 'c2', status: 'draft', updated_at: '2026-09-29T14:00:00Z', published_at: null, meta: { title: 'Term 1 Science', grade: '6', subject: 'Science' } },
    ]);
    mockGetCurriculaByIds.mockResolvedValueOnce([{ id: 'c1', file_name: 'maths.docx' }, { id: 'c2', file_name: 'sci.pdf' }]);

    const res = await request(app).get('/teacher-curriculum/learning-paths');

    expect(res.status).toBe(200);
    expect(mockListLearningPathsForTeacher).toHaveBeenCalledWith('teacher-uuid-1');
    expect(res.body.learningPaths).toEqual([
      expect.objectContaining({ curriculumId: 'c1', title: 'Grade 6 Mathematics', fileName: 'maths.docx', status: 'published', hasUnpublishedChanges: true }),
      expect.objectContaining({ curriculumId: 'c2', title: 'Term 1 Science', status: 'draft', hasUnpublishedChanges: false }),
    ]);
  });

  test('500s when the list fails', async () => {
    mockListLearningPathsForTeacher.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/teacher-curriculum/learning-paths');
    expect(res.status).toBe(500);
  });
});

describe('DELETE /teacher-curriculum/:id', () => {
  test('deletes the learning path and then the curriculum', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'teacher-uuid-1' }, error: null });
    const res = await request(app).delete('/teacher-curriculum/c1');
    expect(res.status).toBe(204);
    expect(mockDeleteLearningPaths).toHaveBeenCalledWith('c1');
    expect(mockDeleteCurriculum).toHaveBeenCalledWith('c1');
    expect(mockDeleteLearningPaths.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteCurriculum.mock.invocationCallOrder[0]);
  });

  test("never deletes another teacher's curriculum", async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });
    const res = await request(app).delete('/teacher-curriculum/c1');
    expect(res.status).toBe(403);
    expect(mockDeleteLearningPaths).not.toHaveBeenCalled();
    expect(mockDeleteCurriculum).not.toHaveBeenCalled();
  });
});
