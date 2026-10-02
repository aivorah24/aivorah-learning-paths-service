const { SEED_PASSAGES, CALIBRATION_PASSAGES } = require('./passageData');
const { splitWords } = require('./wordMatching');
const { lexileToLevel } = require('./lexile');

const DEFAULT_GRADE = 'Grade 3';
const DEFAULT_ICON = 'book-open';
const DEFAULT_GRADIENT = ['#93B0AC', '#C3DCD8'];

// Only Grades 3-5 have passages; every other grade reads the Grade 3 set.
function passagesForGrade(grade) {
  return SEED_PASSAGES[grade] || SEED_PASSAGES[DEFAULT_GRADE];
}

function toSummary(p) {
  return {
    title: p.title,
    topic: p.topic,
    level: p.level,
    icon: p.icon || DEFAULT_ICON,
    gradient: p.gradient || DEFAULT_GRADIENT,
    wordCount: splitWords(p.text).length,
  };
}

// With a Lexile, the recommended level comes first, then the neighbouring ones.
function listPassages(grade, lexile) {
  const passages = passagesForGrade(grade);
  if (lexile == null) return { recommendedLevel: null, passages: passages.map(toSummary) };
  const target = lexileToLevel(lexile);
  const order = target === 'easy' ? ['easy', 'medium'] : target === 'hard' ? ['hard', 'medium'] : ['medium', 'easy', 'hard'];
  const rank = (level) => (order.includes(level) ? order.indexOf(level) : 99);
  const sorted = passages.slice().sort((a, b) => rank(a.level) - rank(b.level));
  return { recommendedLevel: target, passages: sorted.map(toSummary) };
}

// `topic` is a passage title or theme; no topic = "Surprise me" from any level unless one is asked for.
function pickPassage({ grade, topic, level } = {}, random = Math.random) {
  const all = passagesForGrade(grade);
  let matching = all;
  if (topic) {
    const t = String(topic).toLowerCase();
    const exact = all.filter((p) => p.title.toLowerCase() === t);
    const partial = all.filter((p) => p.topic.toLowerCase().includes(t) || p.title.toLowerCase().includes(t));
    if (exact.length) matching = exact;
    else if (partial.length) matching = partial;
  }
  if (level && level !== 'any') {
    const byLevel = matching.filter((p) => p.level === level);
    if (byLevel.length) matching = byLevel;
  }
  const passage = matching[Math.floor(random() * matching.length)];
  return { ...toSummary(passage), text: passage.text, source: 'curated' };
}

function calibrationPassage(grade) {
  const p = CALIBRATION_PASSAGES[grade] || CALIBRATION_PASSAGES[DEFAULT_GRADE];
  return { title: p.title, text: p.text, wordCount: splitWords(p.text).length };
}

// Speech is only made for passage text we ship, so the TTS route can't be used for arbitrary text.
const KNOWN_TEXTS = new Set([
  ...Object.values(SEED_PASSAGES).flat().map((p) => p.text),
  ...Object.values(CALIBRATION_PASSAGES).map((p) => p.text),
]);

function isKnownPassageText(text) {
  return KNOWN_TEXTS.has(text);
}

module.exports = { listPassages, pickPassage, calibrationPassage, isKnownPassageText, passagesForGrade };
