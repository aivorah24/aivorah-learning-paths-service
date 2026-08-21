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
const Groq    = require('groq-sdk');
const { logEvent } = require('../services/analytics');
const supabase = require('../services/supabase');
const { normalizeQuizQuestion } = require('../services/quizNormalize');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Subject-specific instructions for better quiz quality
const SUBJECT_CONTEXT = {
  Mathematics: {
    focus: 'numbers, arithmetic, geometry, measurement, patterns, and data handling',
    rule: 'Every question should test a mathematical concept. Prefer questions with a number as the answer.',
  },
  Science: {
    focus: 'living things, plants, animals, earth & space, weather, matter, forces, and environment',
    rule: 'Base questions on observable science concepts. Use real-world examples kids can relate to.',
  },
  'Social Studies': {
    focus: 'community, culture, geography, history, maps, countries, and global connections',
    rule: 'Focus on understanding concepts, not memorising facts. Use scenarios kids encounter.',
  },
  English: {
    focus: 'reading comprehension, grammar, vocabulary, story elements, and writing skills',
    rule: 'Test language understanding, not obscure vocabulary. Use age-appropriate passages if needed.',
  },
  Arts: {
    focus: 'art elements (colour, line, shape, texture), music concepts (rhythm, beat), and creative expression',
    rule: 'Keep questions visual and practical. Ask about what students create or observe.',
  },
  'Physical Education': {
    focus: 'sports rules, health, body systems, movement skills, and team play',
    rule: 'Focus on health literacy and sport concepts. Keep it practical and fun.',
  },
  ICT: {
    focus: 'computer basics, internet safety, digital tools, coding concepts, and online communication',
    rule: 'Focus on digital literacy. Use scenarios about using devices safely and responsibly.',
  },
};

// Grade → student age range
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

    const ctx      = SUBJECT_CONTEXT[subject] || { focus: `key concepts in ${subject}`, rule: 'Test conceptual understanding.' };
    const ageRange = GRADE_AGE[grade] || '8-11';
    const isIB     = /ib[\s_]?pyp/i.test(curriculum);
    const programLabel = isIB ? 'IB PYP' : String(curriculum || 'CBSE').toUpperCase();
    // The arithmetic double-check instruction is Maths-specific — including it
    // for every subject was priming the model to reach for its own math-word-
    // problem example even when quizzing an English story or a Science topic.
    const arithmeticRule = subject === 'Mathematics'
      ? '\n6. CRITICAL for fill_blank: double-check your arithmetic before writing the "correct" value. If a question involves calculation (e.g. "2 cats have ___ legs total"), compute the exact answer (2×4=8, so correct:"8"). Never write a wrong answer.'
      : '';
    const groundingBlock = passageText
      ? `\n\nSource material — base EVERY question strictly on this text, do not invent facts outside it or drift to an unrelated topic/subject:\n"""\n${String(passageText).slice(0, 4000)}\n"""`
      : '';

    const prompt = `You are an expert ${programLabel} ${grade} ${subject} teacher. Create a practice quiz for the topic: "${topic}".

Student profile: ${programLabel} ${grade}, ages ${ageRange}
Subject focus: ${ctx.focus}
Teaching rule: ${ctx.rule}${groundingBlock}

Generate EXACTLY 5 questions — a mix of:
- 3 multiple-choice questions (type "mcq"): 4 options each, correct is 0-based index
- 2 fill-in-the-blank questions (type "fill_blank"): question contains "___", correct is a short answer (1-4 words)

Requirements:
1. Simple, clear language appropriate for ages ${ageRange}
2. Questions increase slightly in difficulty from Q1 to Q5
3. Each question must have a "hint" — one gentle clue that does NOT give away the answer
4. Each explanation must be encouraging and use a real-world example
5. Questions must directly test the topic "${topic}"${passageText ? ' using ONLY the source material above' : ` — ${programLabel} style (concept-based, inquiry-driven)`}${arithmeticRule}

Return ONLY valid JSON — no markdown, no extra text:
{
  "questions": [
    {
      "type": "mcq",
      "question": "...",
      "options": ["option 1", "option 2", "option 3", "option 4"],
      "correct": 0,
      "hint": "Think about...",
      "explanation": "Short encouraging explanation (2 sentences max)"
    },
    {
      "type": "fill_blank",
      "question": "The process by which plants make food is called ___.",
      "correct": "photosynthesis",
      "hint": "It involves sunlight and leaves",
      "explanation": "Plants use sunlight, water and carbon dioxide to make their own food."
    }
  ]
}`;

    const completion = await groq.chat.completions.create({
      model:       'openai/gpt-oss-20b',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens:  1800,
    });

    const raw  = completion.choices[0]?.message?.content || '';
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return res.status(500).json({ error: 'Failed to parse quiz response' });

    const parsed = JSON.parse(json);

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

    const completion = await groq.chat.completions.create({
      model:       'openai/gpt-oss-20b',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens:  220,
    });

    res.json({ explanation: completion.choices[0]?.message?.content?.trim() || '' });
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
