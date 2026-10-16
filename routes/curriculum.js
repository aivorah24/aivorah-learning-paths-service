/**
 * routes/curriculum.js
 * Read-only, Qdrant-backed subject/syllabus listing for the student Learning
 * Path screen. The old monolith's own /curriculum/subjects route hasn't been
 * migrated here for every curriculum yet — this currently only needs to
 * carry curricula that route hasn't been reached for (IB DP first); every
 * other curriculum's frontend call is untouched and keeps hitting the
 * monolith exactly as before.
 */
const express = require('express');
const router = express.Router();
const { listSubjects, listSyllabus, topicCount } = require('../services/qdrant');
const { subjectsFor } = require('../services/syllabus-map');
const { isCbse } = require('../services/curriculumName');
const { isBoardWithoutBooks, listBoardSubjects, listBoardSyllabus } = require('../services/boardSyllabus');

// IB programmes are grade-bound (PYP 1–5, MYP 6–10, DP 11–12). A profile saved
// with a mismatched pair (e.g. IB DP + Grade 9, before validation existed)
// is served the programme that actually covers its grade.
const IB_BY_GRADE = [[1, 5, 'IB PYP'], [6, 10, 'IB MYP'], [11, 12, 'IB DP']];
function ibProgrammeFor(curriculum, grade) {
  if (!/^ib[\s_]?(pyp|myp|dp)$/i.test(String(curriculum || '').trim())) return curriculum;
  const n = parseInt((String(grade || '').match(/(\d{1,2})/) || [])[1], 10);
  const hit = IB_BY_GRADE.find(([a, b]) => n >= a && n <= b);
  return hit ? hit[2] : curriculum;
}

// ── GET /curriculum/subjects ────────────────────────────────────────────
router.get('/subjects', async (req, res) => {
  const { grade } = req.query;
  const curriculum = ibProgrammeFor(req.query.curriculum, grade);
  if (!curriculum || !grade) {
    return res.status(400).json({ error: 'curriculum and grade are required.' });
  }
  // CBSE subjects come from the same book-derived chapter data the syllabus
  // endpoint already uses, not Qdrant — that data is proven complete for
  // every CBSE grade, whereas Qdrant coverage for CBSE (esp. primary grades)
  // is not guaranteed. Every other curriculum keeps its existing Qdrant path.
  if (isCbse(curriculum)) {
    return res.json({ grade, curriculum, subjects: subjectsFor(grade) });
  }
  try {
    // ICSE/Cambridge: no textbook yet — syllabus-only subjects resolved across
    // the grade labels their content was ingested under (boardSyllabus.js).
    const subjects = isBoardWithoutBooks(curriculum)
      ? await listBoardSubjects(curriculum, grade)
      : await listSubjects(curriculum, grade);
    res.json({ grade, curriculum, subjects });
  } catch (err) {
    console.error('[curriculum/subjects] error:', err.message, err.cause || '');
    // A Qdrant hiccup must read as "nothing ingested yet", not a broken
    // screen — same contract the rest of the Learning Path flow keeps.
    res.json({ grade, curriculum, subjects: [] });
  }
});

// ── GET /curriculum/syllabus ─────────────────────────────────────────────
router.get('/syllabus', async (req, res) => {
  const { grade, subject } = req.query;
  const curriculum = ibProgrammeFor(req.query.curriculum, grade);
  if (!curriculum || !grade || !subject) {
    return res.status(400).json({ error: 'curriculum, grade and subject are required.' });
  }
  try {
    const units = isBoardWithoutBooks(curriculum)
      ? await listBoardSyllabus(curriculum, grade, subject)
      : await listSyllabus(curriculum, grade, subject);
    res.json({ units });
  } catch (err) {
    console.error('[curriculum/syllabus] error:', err.message);
    res.json({ units: [] });
  }
});

// ── GET /curriculum/topic-count ──────────────────────────────────────────
// Total distinct topics ingested for one curriculum+grade — used by
// aivorah-students-service's GET /parent/:email/children (per-child
// totalTopics) so that service never has to own Qdrant directly. Ported
// from the monolith's fetchTotalTopicsFromQdrant() (ai-mentor/server/
// routes/student.js), which this endpoint replaces for that caller.
router.get('/topic-count', async (req, res) => {
  const { curriculum, grade } = req.query;
  if (!curriculum || !grade) {
    return res.status(400).json({ error: 'curriculum and grade are required.' });
  }
  const totalTopics = await topicCount(curriculum, grade);
  res.json({ totalTopics });
});

router.post('/school-quizzes', async (req, res) => { const { quizId, vector, payload } = req.body; if (!quizId || !vector || !payload) return res.status(400).json({ error: 'Missing payload' }); const { saveSchoolQuiz } = require('../services/qdrant'); try { await saveSchoolQuiz(quizId, vector, payload); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });
router.ibProgrammeFor = ibProgrammeFor;
module.exports = router;
