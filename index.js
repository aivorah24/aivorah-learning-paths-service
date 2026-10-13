require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(require('./services/curriculumName').normalizeCurriculumParams);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-learning-paths-service' }));

app.use('/ibpyp', require('./routes/ibpyp'));
app.use('/teacher/syllabus', require('./routes/syllabus'));
app.use('/curriculum', require('./routes/curriculum'));
app.use('/teacher-curriculum', require('./routes/teacherCurriculum'));
app.use('/teacher-subject-edits', require('./routes/teacherSubjectEdits'));
app.use('/student/learning-paths', require('./routes/studentLearningPath'));
app.use('/read-aloud', require('./routes/readAloud'));

require('./services/jobHandlers');

const PORT = process.env.PORT || 3014;
// Only start listening when run directly (`node index.js`) — not when
// required by tests, so Supertest can exercise `app` in-memory.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Learning Paths service running on http://localhost:${PORT}`);
  });
  const { runWorkerOnce } = require('./services/jobQueue');
  setInterval(() => {
    runWorkerOnce(5).catch(err => console.error('[jobQueue] drain tick failed:', err.message));
  }, 4000);
}

module.exports = app;
