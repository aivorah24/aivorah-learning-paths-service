// Normalises one raw LLM-generated quiz question into the shape the app
// expects — handles both MCQ and fill_blank, and shuffles MCQ options so the
// correct answer isn't always in the same position. Moved out of
// routes/ibpyp.js so it can be unit-tested directly. Same logic, no
// behavior change.

const LETTER_MAP = { A: 0, B: 1, C: 2, D: 3 };

function normalizeQuizQuestion(q) {
  if (q.type === 'fill_blank') {
    return {
      type:        'fill_blank',
      question:    q.question,
      options:     [],
      correct:     String(q.correct || '').trim(),
      hint:        q.hint || '',
      explanation: q.explanation || '',
    };
  }

  const rawOptions = (q.options || []).map(opt => String(opt).replace(/^[A-D]\.\s*/i, '').trim());
  const correctIdx = typeof q.correct === 'string'
    ? (LETTER_MAP[String(q.correct).toUpperCase()] ?? 0)
    : (typeof q.correct === 'number' ? q.correct : 0);

  // Shuffle options so correct answer isn't always in the same position
  const indexed = rawOptions.map((opt, i) => ({ opt, wasCorrect: i === correctIdx }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }

  return {
    type:        'mcq',
    question:    q.question,
    options:     indexed.map(x => x.opt),
    correct:     indexed.findIndex(x => x.wasCorrect),
    hint:        q.hint || '',
    explanation: q.explanation || '',
  };
}

module.exports = { normalizeQuizQuestion };
