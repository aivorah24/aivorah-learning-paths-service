require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-learning-paths-service' }));

app.use('/ibpyp', require('./routes/ibpyp'));
app.use('/teacher/syllabus', require('./routes/syllabus'));

const PORT = process.env.PORT || 3014;
app.listen(PORT, () => {
  console.log(`Aivorah Learning Paths service running on http://localhost:${PORT}`);
});
