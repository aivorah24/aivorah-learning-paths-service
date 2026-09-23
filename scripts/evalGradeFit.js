// Repeatable grade-fit eval: runs 10 fixed Grade 6 topics through the REAL
// generation path (grounding/knowledge + companions + grade-fit) and prints
// a compact table, so a prompt change's effect can be measured.
// Sequential (one topic at a time) to respect Groq's free-tier rate limits.
require('dotenv').config();
const { generateLearningPathDraft } = require('../services/curriculumUpload/aiGeneration');

const TOPICS = [
  { subject: 'Mathematics', unitTitle: 'Knowing Our Numbers', topicTitle: 'Knowing Our Numbers', subtopics: ['Reading and writing large numbers', 'Comparing and ordering numbers'] },
  { subject: 'Mathematics', unitTitle: 'Fractions', topicTitle: 'Understanding Fractions', subtopics: ['Equivalent fractions', 'Comparing fractions'] },
  { subject: 'Mathematics', unitTitle: 'Whole Numbers', topicTitle: 'Whole Numbers', subtopics: ['Successor and predecessor'] },
  { subject: 'Mathematics', unitTitle: 'Basic Geometrical Ideas', topicTitle: 'Basic Geometrical Ideas', subtopics: ['Points, lines and line segments'] },
  { subject: 'Science', unitTitle: 'Food: Where Does It Come From?', topicTitle: 'Food: Where Does It Come From?', subtopics: ['Plant-based and animal-based food'] },
  { subject: 'Science', unitTitle: 'Components of Food', topicTitle: 'Components of Food', subtopics: ['Nutrients in food'] },
  { subject: 'Science', unitTitle: 'Sorting Materials into Groups', topicTitle: 'Sorting Materials into Groups', subtopics: ['Properties of materials'] },
  { subject: 'English', unitTitle: 'Honeysuckle', topicTitle: 'Who Did Patrick\'s Homework?', subtopics: ['Story comprehension'] },
  { subject: 'English', unitTitle: 'A Pact with the Sun', topicTitle: 'A Tale of Two Birds', subtopics: ['Moral of the story'] },
  { subject: 'Social Science', unitTitle: 'What, Where, How and When?', topicTitle: 'What, Where, How and When?', subtopics: ['Sources of history'] },
];

function normalizedFor(t, i) {
  return {
    metadata: { grade: '6', subject: t.subject, curriculum: 'CBSE' },
    units: [{ title: t.unitTitle, order: 0, topics: [
      { title: t.topicTitle, order: 0, subtopics: t.subtopics.map((s, si) => ({ title: s, order: si })), content: [] },
    ] }],
  };
}

function fmtRow(cols) {
  return cols.map((c) => String(c)).join(' | ');
}

async function main() {
  const rows = [];
  for (let i = 0; i < TOPICS.length; i++) {
    const t = TOPICS[i];
    process.stderr.write(`[${i + 1}/${TOPICS.length}] ${t.subject}: ${t.topicTitle}...\n`);
    try {
      const draft = await generateLearningPathDraft(normalizedFor(t, i));
      const topic = draft.units[0].topics[0];
      const quality = topic.quality || {};
      const minScore = quality.judgeScores
        ? Math.min(...Object.values(quality.judgeScores).flatMap((s) => Object.values(s)))
        : null;
      const recipeIssues = (quality.issues || []).filter((iss) => iss.startsWith('Recipe:')).length;
      const imageCount = (topic.content?.blocks || []).filter((b) => b.type === 'image').length;
      rows.push({
        topic: t.topicTitle,
        groundingSource: topic.groundingSource,
        readingGrade: quality.readingGrade ?? '-',
        minJudgeScore: minScore ?? '-',
        recipeMissing: recipeIssues,
        images: imageCount,
        status: topic.status,
      });
    } catch (e) {
      rows.push({ topic: t.topicTitle, groundingSource: 'ERROR', readingGrade: '-', minJudgeScore: '-', recipeMissing: '-', images: '-', status: e.message });
    }
  }

  console.log('\n' + fmtRow(['Topic', 'Grounding', 'ReadingGrade', 'MinJudge', 'RecipeMissing', 'Images', 'Status']));
  console.log('-'.repeat(100));
  rows.forEach((r) => console.log(fmtRow([r.topic, r.groundingSource, r.readingGrade, r.minJudgeScore, r.recipeMissing, r.images, r.status])));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
