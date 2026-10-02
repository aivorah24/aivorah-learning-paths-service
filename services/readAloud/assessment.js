const { callWithFallback } = require('../llm/fallback');
const { splitWords } = require('./wordMatching');

const STARS_PER_READING = 50;
const MAX_ERRORS_LISTED = 5;

function readingLevel(accuracy) {
  if (accuracy >= 95) return 'excellent';
  if (accuracy >= 80) return 'good';
  if (accuracy >= 60) return 'developing';
  return 'needs-practice';
}

function scoreReading(passage, wordStatuses, durationSeconds) {
  const words = splitWords(passage);
  const totalWords = words.length;
  const count = (s) => wordStatuses.filter((x) => x === s).length;
  const correct = count('correct');
  const misread = count('misread');
  const skipped = count('skipped');
  const minutes = durationSeconds / 60;
  const accuracy = totalWords ? Math.round((correct / totalWords) * 100) : 0;

  const errors = [];
  wordStatuses.forEach((s, i) => {
    if (s === 'misread' || s === 'skipped') errors.push({ word: words[i] || '', position: i + 1, type: s });
  });

  return {
    accuracy,
    wcpm: minutes > 0 ? Math.round(correct / minutes) : 0,
    wpm: minutes > 0 ? Math.round(totalWords / minutes) : 0,
    totalWords,
    correct,
    misread,
    skipped,
    duration: Math.round(durationSeconds),
    errors,
    level: readingLevel(accuracy),
  };
}

function fallbackFeedback(accuracy) {
  if (accuracy >= 90) return `Amazing reading! You got ${accuracy}% of the words right. Keep up the great work!`;
  if (accuracy >= 70) return `Good job! You read ${accuracy}% of the words correctly. Keep practising and you'll get even better!`;
  return 'Nice try! Reading gets easier with practice. Try reading the passage again slowly, one word at a time.';
}

async function feedbackFor(score, grade) {
  const errorSummary = score.errors.slice(0, MAX_ERRORS_LISTED).map((e) => `"${e.word}" (${e.type})`).join(', ');
  const prompt = `You are a warm, encouraging reading tutor for a ${grade || 'Grade 3'} student (age 8-11).
The student just read a passage aloud. Results:
- Accuracy: ${score.accuracy}%
- Speed: ${score.wcpm} words correct per minute
- Errors: ${errorSummary || 'none'}

Give brief, encouraging feedback (2-3 sentences max). Be specific about what they did well. If there are errors, gently suggest practising those words. Never be discouraging. Use simple language a child would understand.`;
  try {
    const text = (await callWithFallback(prompt, { temperature: 0.7 }))?.trim();
    return text || fallbackFeedback(score.accuracy);
  } catch (err) {
    console.warn('[read-aloud] feedback LLM failed:', err.message);
    return fallbackFeedback(score.accuracy);
  }
}

module.exports = { scoreReading, feedbackFor, fallbackFeedback, readingLevel, STARS_PER_READING };
