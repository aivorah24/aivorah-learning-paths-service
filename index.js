require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-learning-paths-service' }));

app.use('/ibpyp', require('./routes/ibpyp'));
app.use('/teacher/syllabus', require('./routes/syllabus'));
app.use('/curriculum', require('./routes/curriculum'));

const PORT = process.env.PORT || 3014;
// Only start listening when run directly (`node index.js`) — not when
// required by tests, so Supertest can exercise `app` in-memory.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Learning Paths service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
