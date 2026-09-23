/**
 * routes/ibpyp.js
 * IB PYP Quiz & Adaptive Practice — Grades 3, 4, 5
 * Mirrors the NCERT quiz pattern but works for any subject + grade
 *
 * Extracted from ai-mentor/server/routes/ibpyp.js — GET /lesson-content
 * (legacy scene-based lesson generation, used only by TopicLessonScreen)
 * deliberately stayed behind in the monolith since it's outside the
 * Learning Path flow this service covers and pulls in the Qdrant client
 * plus the data/lessons/pyp file set as extra dependencies.
 */
const express = require('express');
const router  = express.Router();
const { logEvent } = require('../services/analytics');
const supabase = require('../services/supabase');
const { normalizeQuizQuestion } = require('../services/quizNormalize');
const { buildQuizPrompt } = require('../services/curriculum/quizPrompt');
const { callWithFallback } = require('../services/llm/fallback');

// Grade → student age range (SUBJECT_CONTEXT moved into quizPrompt.js, shared with generateCompanions)
const GRADE_AGE = { 'Grade 3': '8-9', 'Grade 4': '9-10', 'Grade 5': '10-11' };

// ── POST /ibpyp/quiz ──────────────────────────────────────────────────────────
// Generate 5 MCQ practice questions for any IB PYP topic
router.post('/quiz', async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      topic,
      grade       = 'Grade 3',
      subject     = 'Mathematics',
      curriculum  = 'IB PYP',
      // Real lesson text (story/passage/chapter content) forwarded by the client
      // when available — e.g. LessonScreen sends the curated CBSE story text.
      // Without this, the model had NOTHING but the bare topic string to go on
      // and would fall back on its own generic knowledge (or, worse, copy the
      // prompt's own illustrative example verbatim — this is why an English
      // story quiz once produced "If 3 cats have 4 legs each..." unrelated math).
      passageText,
      topicId,
      userEmail,
      role,
    } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    // Prefer the textbook's OWN exercises when we've stored them for this topic —
    // a question lifted straight from the NCERT book ("Let us write") is the most
    // grounded question possible, so we serve it verbatim instead of generating.
    // Falls through to LLM generation when no stored practiceQuiz exists.
    if (topicId) {
      try {
        const { data: r } = await supabase
          .from('topic_resources')
          .select('static_payload')
          .eq('topic_id', topicId)
          .eq('resource_type', 'AI_EXPLANATION')
          .maybeSingle();
        const pq = r?.static_payload?.practiceQuiz;
        if (Array.isArray(pq) && pq.length > 0) {
          return res.json({ questions: pq, source: 'textbook_exercises' });
        }
      } catch (e) { /* fall back to generation */ }
    }

    const prompt = buildQuizPrompt({ topic, grade, subject, curriculum, passageText });

    // 1800 max_tokens was tight enough that a longer passage/explanation set
    // could get cut off mid-array — the model's own `finish_reason: 'length'`
    // confirms this happens, and a truncated response is never valid JSON, so
    // JSON.parse always threw ("Expected ',' or ']' after array element").
    // Raised the budget and added one retry (fresh completion, not a repair
    // of the broken text — a partial JSON string can't be reliably patched)
    // before giving up, so a single unlucky generation doesn't surface as a
    // user-facing failure.
    async function generateAndParseQuiz() {
      const raw = await callWithFallback(prompt, { json: true, temperature: 0.4 });
      const json = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('no JSON in response');
      return JSON.parse(json);
    }

    let parsed;
    try {
      parsed = await generateAndParseQuiz();
    } catch (firstErr) {
      console.error('POST /ibpyp/quiz first attempt failed, retrying once:', firstErr.message);
      parsed = await generateAndParseQuiz();
    }

    // Normalise: handle both MCQ and fill_blank + shuffle options to fix position bias
    const questions = (parsed.questions || []).map(normalizeQuizQuestion);

    logEvent('ibpyp_quiz_generated', {
      userEmail, role,
      source: 'ibpyp_quiz',
      status: 'success',
      latencyMs: Date.now() - startedAt,
      topic, subject, grade,
    }).catch(() => {});

    res.json({ questions, topic, grade, subject });
  } catch (err) {
    console.error('POST /ibpyp/quiz error:', err.message);
    logEvent('ibpyp_quiz_generated', {
      userEmail: req.body?.userEmail,
      source: 'ibpyp_quiz',
      status: 'error',
      latencyMs: Date.now() - startedAt,
      topic: req.body?.topic,
      subject: req.body?.subject,
      grade: req.body?.grade,
      meta: { error: err.message },
    }).catch(() => {});
    res.status(500).json({ error: 'Quiz generation failed' });
  }
});

// ── POST /ibpyp/explain-wrong ─────────────────────────────────────────────────
// Adaptive explanation when a student answers incorrectly
router.post('/explain-wrong', async (req, res) => {
  try {
    const {
      topic,
      subject     = 'Mathematics',
      grade       = 'Grade 3',
      question,
      wrongAnswer,
      correctAnswer,
    } = req.body;

    if (!question || !wrongAnswer || !correctAnswer) {
      return res.status(400).json({ error: 'question, wrongAnswer, correctAnswer are required' });
    }

    const ageRange = GRADE_AGE[grade] || '8-11';

    const prompt = `You are a warm, patient IB PYP ${grade} ${subject} teacher helping a student who got a question wrong.

Topic: "${topic}"
Question: "${question}"
Student's answer: "${wrongAnswer}"
Correct answer: "${correctAnswer}"

Write a short, kind explanation (2-3 sentences) that:
1. Starts with something encouraging (NOT "That's wrong" — say something like "Almost!" or "Good try!")
2. Explains simply WHY the correct answer is right
3. Uses a real-world example or analogy a ${ageRange}-year-old can picture
4. Ends with motivation ("You've got this!", "Try again — you're so close!", "I believe in you!")

Keep it warm, simple, and age-appropriate for ${grade} (ages ${ageRange}).`;

    const explanation = await callWithFallback(prompt, { temperature: 0.5 });

    res.json({ explanation: explanation?.trim() || '' });
  } catch (err) {
    console.error('POST /ibpyp/explain-wrong error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /ibpyp/track-result ──────────────────────────────────────────────────
// Called after a student completes a practice quiz — logs score to analytics
router.post('/track-result', async (req, res) => {
  try {
    const {
      userEmail,
      topic,
      subject,
      grade,
      score,           // 0-100
      totalQuestions,
      correctAnswers,
      role = 'student',
      firstAttemptCorrect,   // questions correct on first try (no hints used)
      attemptNumber,         // which attempt number is this? (1st, 2nd, 3rd time redoing quiz)
      perQuestionAttempts,   // array like [1, 2, 1, 3, 1] — tries per question
    } = req.body;

    await logEvent('ibpyp_quiz_result', {
      userEmail, role,
      source: 'ibpyp_quiz',
      status: 'success',
      topic, subject, grade,
      score,
      meta: { totalQuestions, correctAnswers, firstAttemptCorrect, attemptNumber, perQuestionAttempts },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
