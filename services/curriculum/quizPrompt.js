// Shared quiz-question prompt builder — extracted from routes/ibpyp.js
// POST /quiz so aiGeneration.js's generateCompanions produces the exact
// same question shape the student Quiz screen already consumes. Route
// behaviour is unchanged: same SUBJECT_CONTEXT/GRADE_AGE tables, same text.

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

const GRADE_AGE = { 'Grade 3': '8-9', 'Grade 4': '9-10', 'Grade 5': '10-11' };

function buildQuizPrompt({ topic, grade = 'Grade 3', subject = 'Mathematics', curriculum = 'IB PYP', passageText }) {
  const ctx = SUBJECT_CONTEXT[subject] || { focus: `key concepts in ${subject}`, rule: 'Test conceptual understanding.' };
  const ageRange = GRADE_AGE[grade] || '8-11';
  const isIB = /ib[\s_]?pyp/i.test(curriculum);
  const programLabel = isIB ? 'IB PYP' : String(curriculum || 'CBSE').toUpperCase();
  const arithmeticRule = subject === 'Mathematics'
    ? '\n6. CRITICAL for fill_blank: double-check your arithmetic before writing the "correct" value. If a question involves calculation (e.g. "2 cats have ___ legs total"), compute the exact answer (2×4=8, so correct:"8"). Never write a wrong answer.'
    : '';
  const groundingBlock = passageText
    ? `\n\nSource material — base EVERY question strictly on this text, do not invent facts outside it or drift to an unrelated topic/subject:\n"""\n${String(passageText).slice(0, 4000)}\n"""`
    : '';

  return `You are an expert ${programLabel} ${grade} ${subject} teacher. Create a practice quiz for the topic: "${topic}".

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
}

module.exports = { buildQuizPrompt, SUBJECT_CONTEXT, GRADE_AGE };
