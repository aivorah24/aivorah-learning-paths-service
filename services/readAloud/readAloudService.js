const repo = require('./repository');
const { lexileToLevel, clampLexile, autoAdjustment } = require('./lexile');
const { scoreReading, feedbackFor, STARS_PER_READING } = require('./assessment');
const { splitWords, matchWordsToPassage } = require('./wordMatching');
const { transcribe, looksHallucinated } = require('./whisper');

const RECENT_SESSIONS = 10;
// A child reads at most ~3 words a second; anything faster is a Whisper over-match.
const MAX_WORDS_PER_SECOND = 3;

async function getLexile(studentId) {
  const level = await repo.getLevel(studentId);
  if (!level) return { lexile: null, needsCalibration: true };
  return { lexile: level.lexile, level: lexileToLevel(level.lexile), history: level.history, needsCalibration: false };
}

async function setLexile(studentId, lexile, source) {
  const clamped = clampLexile(lexile);
  const previous = await repo.getLevel(studentId);
  await repo.saveLevel(studentId, clamped, { source: source || 'manual' }, previous);
  return { lexile: clamped, level: lexileToLevel(clamped) };
}

async function assess(studentId, { passage, wordStatuses, duration, grade, topic }) {
  const score = scoreReading(passage, wordStatuses, duration);
  const feedback = await feedbackFor(score, grade);

  let lexile = null;
  let lexileChange = 0;
  const current = await repo.getLevel(studentId);
  if (current) {
    const errorCount = score.misread + score.skipped;
    lexileChange = autoAdjustment(errorCount);
    lexile = current.lexile;
    if (lexileChange !== 0) {
      lexile = clampLexile(current.lexile + lexileChange);
      lexileChange = lexile - current.lexile;
      await repo.saveLevel(studentId, lexile, { source: 'auto', errors: errorCount }, current);
    }
  }

  const result = { ...score, feedback, starsEarned: STARS_PER_READING, lexile, lexileChange };
  try {
    await repo.addSession(studentId, { ...result, topic: topic || 'Unknown', grade: grade || 'Grade 3' });
  } catch (err) {
    console.warn('[read-aloud] failed to save session:', err.message);
  }
  return result;
}

async function history(studentId) {
  const sessions = await repo.listSessions(studentId);
  if (!sessions.length) return { history: [], stats: {} };
  const recent = sessions.slice(0, RECENT_SESSIONS).reverse();
  const avg = (key) => Math.round(recent.reduce((s, h) => s + (h[key] || 0), 0) / recent.length);
  return {
    history: recent,
    stats: {
      avgAccuracy: avg('accuracy'),
      avgWcpm: avg('wcpm'),
      totalSessions: sessions.length,
      bestAccuracy: Math.max(...sessions.map((h) => h.accuracy || 0)),
      bestWcpm: Math.max(...sessions.map((h) => h.wcpm || 0)),
    },
  };
}

async function transcribeRecording(file, passage) {
  const passageWords = splitWords(passage);
  const data = await transcribe(file.buffer, file.mimetype, passage);
  const whisperWords = (data.words || []).map((w) => w.word);
  const { statuses, matchedUpTo } = matchWordsToPassage(whisperWords, passageWords, false);
  return { transcript: data.text || '', whisperWords, wordStatuses: statuses, matchedUpTo, totalWords: passageWords.length };
}

// Called every few seconds with the audio so far, to move the live highlight.
async function transcribeLive(file, passage) {
  const passageWords = splitWords(passage);
  if (!passageWords.length) return { wordStatuses: [], matchedUpTo: 0 };
  const data = await transcribe(file.buffer, file.mimetype, passage);
  const rawWords = data.words || [];
  const duration = data.duration || 0;
  if (looksHallucinated(rawWords, duration)) {
    return { wordStatuses: new Array(passageWords.length).fill('pending'), matchedUpTo: 0 };
  }
  const { statuses, matchedUpTo } = matchWordsToPassage(rawWords.map((w) => w.word), passageWords, true);
  const cap = Math.ceil(duration * MAX_WORDS_PER_SECOND);
  if (matchedUpTo <= cap) return { wordStatuses: statuses, matchedUpTo };
  for (let i = cap; i < passageWords.length; i++) statuses[i] = 'pending';
  if (cap < passageWords.length) statuses[cap] = 'current';
  return { wordStatuses: statuses, matchedUpTo: cap };
}

module.exports = { getLexile, setLexile, assess, history, transcribeRecording, transcribeLive };
