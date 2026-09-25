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

// ── GET /curriculum/subjects ────────────────────────────────────────────
router.get('/subjects', async (req, res) => {
  const { curriculum, grade } = req.query;
  if (!curriculum || !grade) {
    return res.status(400).json({ error: 'curriculum and grade are required.' });
  }
  // CBSE subjects come from the same book-derived chapter data the syllabus
  // endpoint already uses, not Qdrant — that data is proven complete for
  // every CBSE grade, whereas Qdrant coverage for CBSE (esp. primary grades)
  // is not guaranteed. Every other curriculum keeps its existing Qdrant path.
  if (/^(cbse|ncert)$/i.test(String(curriculum).trim())) {
    return res.json({ grade, curriculum, subjects: subjectsFor(grade) });
  }
  try {
    const subjects = await listSubjects(curriculum, grade);
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
  const { curriculum, grade, subject } = req.query;
  if (!curriculum || !grade || !subject) {
    return res.status(400).json({ error: 'curriculum, grade and subject are required.' });
  }
  try {
    const units = await listSyllabus(curriculum, grade, subject);
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
module.exports = router;
