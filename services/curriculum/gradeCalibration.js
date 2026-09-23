// Shared grade-band pedagogy calibration, used by BOTH generation paths:
// - services/curriculumUpload/aiGeneration.js's ungrounded batch-fallback prompt
// - services/curriculum/enrichment.js's buildPrompt (the GROUNDED path)
// Extracted here (rather than living in either file) to avoid a circular
// require: aiGeneration.js already lazily requires enrichment.js.
//
// 4-tier cognitive-guidance taxonomy:
//   Foundational   Grades 1-2  concrete/story-driven
//   Preparatory    Grades 3-5  accessible vocabulary, sequential steps
//   Middle         Grades 6-8  domain terminology, multi-step reasoning
//   Secondary      Grades 9-12 formal/analytical, abstract models
function gradeCalibrationNote(grade) {
  const g = Number(String(grade || '').match(/(\d+)/)?.[1]);
  if (!g) return '';
  if (g <= 2) {
    return 'GRADE CALIBRATION (Foundational, Grades 1-2): Concrete, story-driven explanations only. Use basic phonics-level vocabulary, sentences under 12 words, and physical analogies (counting objects, animals, toys). Keep each lesson bite-sized. Never use abstract definitions.';
  }
  if (g <= 5) {
    return 'GRADE CALIBRATION (Preparatory, Grades 3-5): Elementary. Use accessible vocabulary with inline explanations of any new term, sequential numbered steps, and visual anchors a child can picture.';
  }
  if (g === 6) {
    return 'GRADE CALIBRATION (Middle, Grade 6): Use domain-specific terminology with structured definitions, multi-step reasoning, and real-world context. Do NOT use exponent/power notation (e.g. "4 x 10^4") — Grade 6 has not learned powers yet; write large numbers in expanded form (e.g. "4 x 10,000"). For large numbers, use the Indian numbering system (lakhs, crores; commas as in 9,63,001), not Western thousands/millions.';
  }
  if (g <= 8) {
    return 'GRADE CALIBRATION (Middle, Grades 7-8): Use domain-specific terminology with structured definitions, multi-step reasoning, and real-world context.';
  }
  return 'GRADE CALIBRATION (Secondary/Higher, Grades 9-12): Use advanced technical/academic prose, abstract models, and formal multi-step problem-solving where relevant.';
}

module.exports = { gradeCalibrationNote };
