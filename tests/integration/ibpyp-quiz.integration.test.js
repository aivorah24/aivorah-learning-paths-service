// Unit tests for routes/ibpyp.js — POST /quiz, /explain-wrong, /track-result.
// Groq, Supabase, and analytics are mocked so no real LLM/DB call happens.

jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

jest.mock('../../services/analytics', () => ({
  logEvent: jest.fn().mockResolvedValue(null),
}));

// routes/ibpyp.js now calls the shared LLM_CHAIN fallback (native fetch)
// instead of groq-sdk directly. This shim forwards each fetch call into
// mockCreate so every existing mockCreate.mockResolvedValueOnce(...) test
// body below keeps working unchanged.
// Single-entry chain — matches this route's pre-fallback-chain behaviour of
// one provider call per attempt, so a mockRejectedValueOnce/mockCreate
// leftover from an earlier test can't leak into a later test's 2nd/3rd
// chain-entry attempt.
process.env.LLM_CHAIN = 'groq:openai/gpt-oss-20b';
process.env.GROQ_API_KEY = 'test-groq-key';
const { resetFallbackState } = require('../../services/llm/fallback');

const mockCreate = jest.fn();
global.fetch = jest.fn(async (url, req) => {
  const body = JSON.parse(req.body);
  const result = await mockCreate({ model: body.model, messages: body.messages });
  const content = result?.choices?.[0]?.message?.content;
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
});

const express = require('express');
const request = require('supertest');
const supabase = require('../../services/supabase');
const { logEvent } = require('../../services/analytics');
const ibpypRoute = require('../../routes/ibpyp');

const app = express();
app.use(express.json());
app.use('/ibpyp', ibpypRoute);

function groqResponse(json) {
  return { choices: [{ message: { content: JSON.stringify(json) } }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFallbackState();
});

describe('POST /ibpyp/quiz', () => {
  test('missing topic -> 400', async () => {
    const res = await request(app).post('/ibpyp/quiz').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('topic is required');
  });

  test('a topicId with a stored real textbook quiz -> returns it verbatim, skips the LLM', async () => {
    const storedQuiz = [{ type: 'mcq', question: 'Real book Q', options: ['a', 'b'], correct: 0 }];
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { static_payload: { practiceQuiz: storedQuiz } },
      error: null,
    });

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', topicId: 'topic-1' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('textbook_exercises');
    expect(res.body.questions).toEqual(storedQuiz);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a topicId with NO stored quiz falls through to LLM generation', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockCreate.mockResolvedValueOnce(groqResponse({
      questions: [
        { type: 'mcq', question: 'Q1', options: ['A', 'B', 'C', 'D'], correct: 1, hint: 'h', explanation: 'e' },
      ],
    }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', topicId: 'topic-1' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBeUndefined();
    expect(mockCreate).toHaveBeenCalled();
  });

  test('no topicId at all -> goes straight to LLM generation', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({
      questions: [{ type: 'mcq', question: 'Q1', options: ['A', 'B', 'C', 'D'], correct: 0 }],
    }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions' });

    expect(res.status).toBe(200);
    expect(supabase._chain.maybeSingle).not.toHaveBeenCalled();
  });

  // A single bad generation (e.g. truncated mid-array — see the RCA comment
  // above generateAndParseQuiz in the route) retries once with a fresh
  // completion before giving up, so one unlucky response doesn't surface as
  // a user-facing failure.
  test('one unparseable LLM response followed by a good one -> retries and succeeds', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' }, finish_reason: 'length' }] })
      .mockResolvedValueOnce(groqResponse({
        questions: [{ type: 'mcq', question: 'Q1', options: ['A', 'B', 'C', 'D'], correct: 0 }],
      }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions' });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  test('two consecutive unparseable LLM responses -> 500', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'not json at all' }, finish_reason: 'length' }] });
    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Quiz generation failed');
  });

  test('fill_blank questions come out with an empty options array and a trimmed string answer', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({
      questions: [
        { type: 'fill_blank', question: 'The sky is ___.', correct: '  blue  ', hint: 'h', explanation: 'e' },
      ],
    }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Colors' });

    expect(res.body.questions[0]).toEqual({
      type: 'fill_blank', question: 'The sky is ___.', options: [], correct: 'blue', hint: 'h', explanation: 'e',
    });
  });

  test('mcq option shuffling preserves which option text is actually correct', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({
      questions: [{
        type: 'mcq', question: 'Q1', options: ['wrong1', 'wrong2', 'RIGHT', 'wrong3'], correct: 2, hint: 'h', explanation: 'e',
      }],
    }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Test' });

    const q = res.body.questions[0];
    // Wherever "RIGHT" ended up after shuffling, `correct` must point at it.
    expect(q.options[q.correct]).toBe('RIGHT');
  });

  test('a letter-based correct answer (A/B/C/D) is converted to the right 0-based index', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({
      questions: [{
        type: 'mcq', question: 'Q1', options: ['w1', 'w2', 'RIGHT', 'w3'], correct: 'C', hint: 'h', explanation: 'e',
      }],
    }));

    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Test' });
    const q = res.body.questions[0];
    expect(q.options[q.correct]).toBe('RIGHT');
  });

  test('logs a success analytics event on success', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({ questions: [{ type: 'mcq', question: 'Q', options: ['a', 'b'], correct: 0 }] }));
    await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', userEmail: 'a@a.com' });
    expect(logEvent).toHaveBeenCalledWith('ibpyp_quiz_generated', expect.objectContaining({ status: 'success', topic: 'Fractions' }));
  });

  test('a Groq failure -> 500, logs an error analytics event', async () => {
    mockCreate.mockRejectedValueOnce(new Error('groq down'));
    const res = await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', userEmail: 'a@a.com' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Quiz generation failed');
    expect(logEvent).toHaveBeenCalledWith('ibpyp_quiz_generated', expect.objectContaining({ status: 'error' }));
  });

  test('passageText is included in the prompt as a grounding block, so the model quizzes on the real text', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({ questions: [{ type: 'mcq', question: 'Q', options: ['a', 'b'], correct: 0 }] }));
    await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', passageText: 'A story about a magic banana plantation.' });

    const promptSent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptSent).toContain('Source material');
    expect(promptSent).toContain('A story about a magic banana plantation.');
  });

  test('no passageText -> prompt has no grounding block (falls back to general topic knowledge)', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({ questions: [{ type: 'mcq', question: 'Q', options: ['a', 'b'], correct: 0 }] }));
    await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions' });

    const promptSent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptSent).not.toContain('Source material');
  });

  test('IB PYP curriculum (any casing/spacing) labels the prompt "IB PYP"', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({ questions: [{ type: 'mcq', question: 'Q', options: ['a', 'b'], correct: 0 }] }));
    await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', curriculum: 'ib_pyp' });

    const promptSent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptSent).toContain('expert IB PYP Grade 3 Mathematics teacher');
  });

  test('a non-IB curriculum (e.g. CBSE) is uppercased in the prompt label', async () => {
    mockCreate.mockResolvedValueOnce(groqResponse({ questions: [{ type: 'mcq', question: 'Q', options: ['a', 'b'], correct: 0 }] }));
    await request(app).post('/ibpyp/quiz').send({ topic: 'Fractions', curriculum: 'cbse' });

    const promptSent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptSent).toContain('expert CBSE Grade 3 Mathematics teacher');
  });
});

describe('POST /ibpyp/explain-wrong', () => {
  test('missing required fields -> 400', async () => {
    const res = await request(app).post('/ibpyp/explain-wrong').send({ question: 'Q' });
    expect(res.status).toBe(400);
  });

  test('success -> returns the trimmed explanation text', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '  Almost! Try again.  ' } }] });
    const res = await request(app).post('/ibpyp/explain-wrong').send({
      question: 'Q', wrongAnswer: 'x', correctAnswer: 'y',
    });
    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Almost! Try again.');
  });

  test('a Groq failure -> 500', async () => {
    mockCreate.mockRejectedValueOnce(new Error('groq down'));
    const res = await request(app).post('/ibpyp/explain-wrong').send({
      question: 'Q', wrongAnswer: 'x', correctAnswer: 'y',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /ibpyp/track-result', () => {
  test('logs the result event and returns ok:true', async () => {
    const res = await request(app).post('/ibpyp/track-result').send({
      userEmail: 'a@a.com', topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4',
      score: 80, totalQuestions: 5, correctAnswers: 4,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(logEvent).toHaveBeenCalledWith('ibpyp_quiz_result', expect.objectContaining({ score: 80, topic: 'Fractions' }));
  });

  test('per-question retry metadata (attemptNumber, firstAttemptCorrect, perQuestionAttempts) is passed through to logEvent exactly', async () => {
    await request(app).post('/ibpyp/track-result').send({
      userEmail: 'a@a.com', topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4',
      score: 60, totalQuestions: 5, correctAnswers: 3,
      firstAttemptCorrect: 2, attemptNumber: 2, perQuestionAttempts: [1, 2, 1, 3, 1],
    });

    expect(logEvent).toHaveBeenCalledWith('ibpyp_quiz_result', expect.objectContaining({
      score: 60,
      meta: {
        totalQuestions: 5,
        correctAnswers: 3,
        firstAttemptCorrect: 2,
        attemptNumber: 2,
        perQuestionAttempts: [1, 2, 1, 3, 1],
      },
    }));
  });

  test('an unexpected exception (e.g. logEvent itself throwing) -> 500, caught by the route\'s own safety net', async () => {
    logEvent.mockRejectedValueOnce(new Error('unexpected analytics failure'));
    const res = await request(app).post('/ibpyp/track-result').send({ userEmail: 'a@a.com', topic: 'Fractions', score: 80 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unexpected analytics failure');
  });

  test('defaults role to "student" when not provided', async () => {
    await request(app).post('/ibpyp/track-result').send({ userEmail: 'a@a.com', topic: 'Fractions', score: 100 });
    expect(logEvent).toHaveBeenCalledWith('ibpyp_quiz_result', expect.objectContaining({ role: 'student' }));
  });
});
