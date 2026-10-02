const express = require('express');
const multer = require('multer');

const { requireStudentAuth } = require('../middleware/auth');
const { listPassages, pickPassage, calibrationPassage, isKnownPassageText } = require('../services/readAloud/passages');
const readAloud = require('../services/readAloud/readAloudService');
const { speechFor } = require('../services/readAloud/tts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const WORD_STATUSES = new Set(['correct', 'misread', 'skipped', 'pending', 'current']);

router.use(requireStudentAuth);

function fail(res, where, err, status = 500) {
  console.error(`[read-aloud${where}]`, err.message);
  return res.status(status).json({ error: err.message });
}

router.get('/passages', (req, res) => {
  const lexile = req.query.lexile != null && req.query.lexile !== '' ? Number(req.query.lexile) : null;
  const grade = req.query.grade || 'Grade 3';
  res.json({ grade, ...listPassages(grade, Number.isFinite(lexile) ? lexile : null) });
});

router.post('/passage', (req, res) => {
  const { grade, topic, level } = req.body || {};
  res.json(pickPassage({ grade, topic, level }));
});

router.get('/calibration', (req, res) => {
  res.json(calibrationPassage(req.query.grade));
});

router.get('/lexile', async (req, res) => {
  try {
    res.json(await readAloud.getLexile(req.auth.studentId));
  } catch (err) {
    fail(res, '/lexile', err);
  }
});

router.post('/lexile', async (req, res) => {
  const lexile = Number(req.body?.lexile);
  if (req.body?.lexile == null || !Number.isFinite(lexile)) return res.status(400).json({ error: 'lexile is required' });
  try {
    res.json(await readAloud.setLexile(req.auth.studentId, lexile, req.body.source));
  } catch (err) {
    fail(res, '/lexile', err);
  }
});

router.post('/assess', async (req, res) => {
  const { passage, wordStatuses, duration, grade, topic } = req.body || {};
  if (typeof passage !== 'string' || !passage.trim() || !Array.isArray(wordStatuses) || !(Number(duration) > 0)) {
    return res.status(400).json({ error: 'Missing required fields: passage, wordStatuses, duration' });
  }
  if (!wordStatuses.every((s) => WORD_STATUSES.has(s))) return res.status(400).json({ error: 'Invalid word status' });
  try {
    res.json(await readAloud.assess(req.auth.studentId, { passage, wordStatuses, duration: Number(duration), grade, topic }));
  } catch (err) {
    fail(res, '/assess', err);
  }
});

router.get('/history', async (req, res) => {
  try {
    res.json(await readAloud.history(req.auth.studentId));
  } catch (err) {
    fail(res, '/history', err);
  }
});

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  try {
    res.json(await readAloud.transcribeRecording(req.file, req.body.passage || ''));
  } catch (err) {
    fail(res, '/transcribe', err);
  }
});

router.post('/transcribe-live', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  try {
    res.json(await readAloud.transcribeLive(req.file, req.body.passage || ''));
  } catch (err) {
    fail(res, '/transcribe-live', err);
  }
});

router.post('/tts', async (req, res) => {
  const text = req.body?.text;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!isKnownPassageText(text)) return res.status(400).json({ error: 'Narration is only available for Read Aloud passages' });
  try {
    res.json(await speechFor(text));
  } catch (err) {
    fail(res, '/tts', err, 503);
  }
});

module.exports = router;
