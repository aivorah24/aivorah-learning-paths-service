// Grade-fit check: rule-based readability (no LLM) + a quality judge
// (1 call/topic, via the shared LLM_CHAIN fallback). Both feed into
// aiGeneration.js's bounded regen-once pass.
const { callWithFallback } = require('../llm/fallback');

// Lazy — enrichment.js constructs Groq/Supabase clients at module load,
// which breaks jest.requireActual in tests that don't set those env vars.
let _checkRecipe = null;
function checkRecipe(blocks) {
  if (!_checkRecipe) _checkRecipe = require('./enrichment').checkRecipe;
  return _checkRecipe(blocks);
}

// Vowel-group heuristic, drops a silent trailing "e".
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) || [];
  let count = groups.length;
  if (w.endsWith('e') && count > 1) count -= 1;
  return Math.max(count, 1);
}

// Flesch-Kincaid grade level, plus avg sentence length and % long (3+ syllable) words.
function readabilityStats(text) {
  const clean = String(text || '').trim();
  if (!clean) return { grade: 0, avgSentenceLen: 0, longWordPct: 0 };
  const sentences = clean.split(/[.!?]+/).filter((s) => s.trim());
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length || 1;
  const sentenceCount = sentences.length || 1;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSentenceLen = wordCount / sentenceCount;
  const avgSyllablesPerWord = syllables / wordCount;
  const grade = 0.39 * avgSentenceLen + 11.8 * avgSyllablesPerWord - 15.59;
  const longWordPct = (words.filter((w) => countSyllables(w) >= 3).length / wordCount) * 100;
  return {
    grade: Math.max(0, Math.round(grade * 10) / 10),
    avgSentenceLen: Math.round(avgSentenceLen * 10) / 10,
    longWordPct: Math.round(longWordPct * 10) / 10,
  };
}

function blocksLearnText(blocks) {
  return (blocks || []).map((b) => b.text || b.explanation || '').filter(Boolean).join(' ');
}
function listenPartsText(listenParts) {
  return (listenParts || []).map((p) => p.text || '').filter(Boolean).join(' ');
}

// Flags Learn/Audio text too advanced for the student's grade, plus cheap
// content-shape checks (exponent notation, thin explanations/tables) that
// don't need an LLM call.
function ruleCheck(content, studentGrade) {
  const grade = Number(studentGrade) || 6;
  const blocks = content?.blocks || [];
  const learnStats = readabilityStats(blocksLearnText(blocks));
  const audioText = listenPartsText(content?.listenParts);
  const issues = [];
  if (learnStats.grade > grade + 2) issues.push(`Learn text reading grade ${learnStats.grade} is too high for Grade ${grade}`);
  if (learnStats.avgSentenceLen > 20) issues.push(`Learn text sentences average ${learnStats.avgSentenceLen} words (over 20)`);
  if (audioText) {
    const audioStats = readabilityStats(audioText);
    if (audioStats.grade > grade + 2) issues.push(`Audio script reading grade ${audioStats.grade} is too high for Grade ${grade}`);
    if (audioStats.avgSentenceLen > 20) issues.push(`Audio script sentences average ${audioStats.avgSentenceLen} words (over 20)`);
  }

  // Grade 6 has not learned exponents/powers yet.
  if (grade === 6 && /\d\s*\^\s*\d|10\^\{?\d|\d\s*[×x]\s*10\^/.test(blocksLearnText(blocks))) {
    issues.push('Learn text uses exponent/power notation, not appropriate before Grade 7');
  }

  // Thin content: very short explanation blocks, or a table with only 1 column.
  const thinExplanations = blocks.filter((b) => b.type === 'explanation' && String(b.text || '').split(/\s+/).filter(Boolean).length < 15);
  if (thinExplanations.length > 0) issues.push(`${thinExplanations.length} explanation block(s) are too short (under 15 words)`);
  const thinTables = blocks.filter((b) => b.type === 'table' && Array.isArray(b.headers) && b.headers.length < 2);
  if (thinTables.length > 0) issues.push('A table block has fewer than 2 columns');

  return { readingGrade: learnStats.grade, sentenceLength: learnStats.avgSentenceLen, issues };
}

function buildJudgePrompt({ topicTitle, chapterTitle, grade, subject, subtopics, learnText, audioText, practiceQuestions }) {
  const practiceText = (practiceQuestions || []).map((q) => q.question).filter(Boolean).join('\n');
  const subtopicList = (subtopics || []).filter(Boolean).join(', ');
  return `You are a strict Grade ${grade} ${subject} curriculum reviewer. Score this lesson "${topicTitle}" (chapter "${chapterTitle}") for a Grade ${grade} student.
${subtopicList ? `\nSUBTOPICS THIS TOPIC MUST COVER: ${subtopicList}\nFor any subtopic not actually taught in the Learn content, add an issue "subtopic '<name>' not taught".` : ''}

LEARN CONTENT:
"""${(learnText || '').slice(0, 3000)}"""

AUDIO SCRIPT:
"""${(audioText || '(none)').slice(0, 2200)}"""

PRACTICE QUESTIONS:
"""${(practiceText || '(none)').slice(0, 1500)}"""

Score Learn, Audio and Practice each on: ageAppropriate, matchesChapter, factuallySound, clearExamples (1-5, 5=best).
Also check: the content stays within the listed subtopics/chapter scope (flag anything that teaches material beyond scope, e.g. unlisted operations or techniques), and it never contains meta/instructional text about itself (e.g. "this example shows...", "the chapter tells us..."). List concrete issues for anything wrong.
Respond with ONLY this JSON shape:
{"learn":{"ageAppropriate":1,"matchesChapter":1,"factuallySound":1,"clearExamples":1},"audio":{"ageAppropriate":1,"matchesChapter":1,"factuallySound":1,"clearExamples":1},"practice":{"ageAppropriate":1,"matchesChapter":1,"factuallySound":1,"clearExamples":1},"issues":["..."]}`;
}

async function judgeTopic(input) {
  const content = await callWithFallback(buildJudgePrompt(input), { json: true, temperature: 0.2, task: 'judge' });
  const parsed = JSON.parse(content || '{}');
  const scores = {};
  let minScore = 5;
  ['learn', 'audio', 'practice'].forEach((s) => {
    const sec = parsed[s] || {};
    scores[s] = {
      ageAppropriate: Number(sec.ageAppropriate) || 0,
      matchesChapter: Number(sec.matchesChapter) || 0,
      factuallySound: Number(sec.factuallySound) || 0,
      clearExamples: Number(sec.clearExamples) || 0,
    };
    Object.values(scores[s]).forEach((v) => { if (v < minScore) minScore = v; });
  });
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === 'string') : [];
  return { scores, issues, minScore };
}

const READABILITY_ISSUE_RE = /reading grade|sentences average/i;

// Splits issues by which regeneration target they belong to — Learn content
// (rules/recipe + judge's "learn" scores) vs companions (audio/practice
// rule flags + judge's "audio"/"practice" scores) — so a failure only
// regenerates the part that's actually wrong.
function classifyIssues(rules, recipeMissing, judge) {
  const contentIssues = [];
  const companionsIssues = [];
  rules.issues.forEach((i) => (/^Audio script/i.test(i) ? companionsIssues : contentIssues).push(i));
  recipeMissing.forEach((m) => contentIssues.push(`Recipe: missing ${m}`));
  if (judge) {
    const learnLow = Object.values(judge.scores.learn).some((v) => v < 4);
    const companionsLow = Object.values(judge.scores.audio).some((v) => v < 4) || Object.values(judge.scores.practice).some((v) => v < 4);
    // Judge issues aren't pre-split by section; attribute to whichever side
    // scored low (content, if both, since content regen also re-runs companions).
    if (learnLow || (!companionsLow && judge.issues.length)) contentIssues.push(...judge.issues);
    else if (companionsLow) companionsIssues.push(...judge.issues);
  }
  return { contentIssues, companionsIssues };
}

// One rules pass (free) + one judge call + checkRecipe's missing list folded
// in as issues. Judge errors are swallowed — quality.judge stays null, the
// topic is never failed just because the judge call itself failed.
//
// `failed` (real failure, worth regenerating) vs `minorOnly` (all judge
// scores >=3 and the only rule flags are readability — keep content, just
// surface the issues to the teacher via quality.issues, status stays ready).
async function checkGradeFit({ topicTitle, chapterTitle, grade, subject, subtopics, content }) {
  const rules = ruleCheck(content, grade);
  const recipeMissing = checkRecipe(content?.blocks);

  let judge = null;
  let judgeIssues = [];
  try {
    judge = await judgeTopic({
      topicTitle, chapterTitle, grade, subject, subtopics,
      learnText: blocksLearnText(content?.blocks),
      audioText: listenPartsText(content?.listenParts),
      practiceQuestions: content?.practiceQuiz,
    });
    judgeIssues = judge.issues;
  } catch {
    judge = null;
  }

  const nonReadabilityRuleIssues = rules.issues.filter((i) => !READABILITY_ISSUE_RE.test(i));
  const allJudgeScoresAtLeast3 = !judge || Object.values(judge.scores).every((sec) => Object.values(sec).every((v) => v >= 3));
  const failed = nonReadabilityRuleIssues.length > 0 || recipeMissing.length > 0 || (judge != null && judge.minScore < 3);
  const minorOnly = !failed && allJudgeScoresAtLeast3 && (rules.issues.length > 0 || (judge != null && judge.minScore < 4));

  const issues = [...rules.issues, ...recipeMissing.map((m) => `Recipe: missing ${m}`), ...judgeIssues];
  const { contentIssues, companionsIssues } = classifyIssues(rules, recipeMissing, judge);

  return {
    quality: { readingGrade: rules.readingGrade, sentenceLength: rules.sentenceLength, judgeScores: judge ? judge.scores : null, issues },
    failed,
    minorOnly,
    contentIssues,
    companionsIssues,
  };
}

module.exports = { readabilityStats, ruleCheck, judgeTopic, checkGradeFit };
