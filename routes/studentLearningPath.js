const express = require('express');
const router = express.Router();

const { requireStudentAuth } = require('../middleware/auth');
const { getLearningPathByCurriculumId, listPublishedLearningPathsForTeachers, learningPathTitle } = require('../services/curriculumUpload/learningPathRepository');
const { getCurriculaByIds } = require('../services/curriculumUpload/curriculumRepository');
const { isStudentOfTeacher, listTeacherIdsForStudent } = require('../services/curriculumUpload/studentAccess');
const { scopeOf } = require('../services/subjectEdits/scope');
const { publishedEditsForTeachers } = require('../services/subjectEdits/repository');

router.get('/', requireStudentAuth, async (req, res) => {
  try {
    const teacherIds = await listTeacherIdsForStudent(req.auth.studentId);
    // Optional ?grade=&subject= narrows to one subject screen (e.g. Grade 6 Mathematics).
    const norm = (v) => String(v || '').toLowerCase().replace(/^grade\s*/, '').trim();
    const paths = (await listPublishedLearningPathsForTeachers(teacherIds)).filter((p) =>
      (!req.query.grade || norm(p.meta?.grade) === norm(req.query.grade))
      && (!req.query.subject || norm(p.meta?.subject) === norm(req.query.subject)));
    const curricula = await getCurriculaByIds([...new Set(paths.map((p) => p.curriculum_id))]);
    const titleByCurriculumId = new Map(curricula.map((c) => [c.id, c.file_name]));

    return res.json({
      learningPaths: paths.map((p) => ({
        id: p.id,
        curriculumId: p.curriculum_id,
        title: learningPathTitle(p.meta, titleByCurriculumId.get(p.curriculum_id)),
        grade: p.meta?.grade || null,
        subject: p.meta?.subject || null,
        publishedAt: p.published_at,
      })),
    });
  } catch (err) {
    console.error('[student/learning-paths] list failed:', err.message);
    return res.status(500).json({ error: 'Failed to load learning paths' });
  }
});

// The student's teacher's published changes to a standard subject path (null when there are none).
router.get('/subject-edits', requireStudentAuth, async (req, res) => {
  const scope = scopeOf(req.query);
  if (!scope) return res.status(400).json({ error: 'curriculum, grade and subject are required' });
  try {
    const teacherIds = await listTeacherIdsForStudent(req.auth.studentId);
    const row = await publishedEditsForTeachers(teacherIds, scope);
    res.json({ edits: row?.published || null, publishedAt: row?.published_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:curriculumId', requireStudentAuth, async (req, res) => {
  let learningPath;
  try {
    learningPath = await getLearningPathByCurriculumId(req.params.curriculumId);
  } catch (err) {
    console.error('[student/learning-paths] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to load the learning path' });
  }

  // A draft must be indistinguishable from "doesn't exist" to a student.
  if (!learningPath || learningPath.status !== 'published') {
    return res.status(404).json({ error: 'No published learning path found' });
  }

  let authorized;
  try {
    authorized = await isStudentOfTeacher(learningPath.teacher_id, req.auth.studentId);
  } catch (err) {
    console.error('[student/learning-paths] authorization check failed:', err.message);
    return res.status(500).json({ error: 'Failed to verify access' });
  }
  if (!authorized) {
    return res.status(403).json({ error: 'Not authorized for this learning path' });
  }

  return res.json({
    learningPath: {
      id: learningPath.id,
      curriculumId: learningPath.curriculum_id,
      publishedAt: learningPath.published_at,
      content: learningPath.published_content,
    },
  });
});

module.exports = router;
