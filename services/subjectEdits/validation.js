// Shape of a teacher's edits to one subject:
// { chapters: [{ key, title?, hidden?, added?, topics: [{ key, name?, hidden?, added? }] }],
//   topics: { [topicKey]: lesson content (whatYoullLearn, blocks, listenScript/listenParts, mathTutor, practiceQuiz, pdfFile, pdfPage) } }
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHAPTERS = 200;
const MAX_TOPICS_PER_CHAPTER = 200;
const LESSON_FIELDS = ['whatYoullLearn', 'blocks', 'listenScript', 'listenParts', 'mathTutor', 'practiceQuiz', 'pdfFile', 'pdfPage', 'bookPath', 'bookUrl', 'bookTitle'];

class SubjectEditsValidationError extends Error {}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function cleanTopicRef(t) {
  const key = str(t?.key);
  if (!key) throw new SubjectEditsValidationError('Every topic needs a key');
  return JSON.parse(JSON.stringify({ key, name: str(t.name), hidden: t.hidden === true || undefined, added: t.added === true || undefined }));
}

function cleanChapter(c) {
  const key = str(c?.key);
  if (!key) throw new SubjectEditsValidationError('Every chapter needs a key');
  const topics = Array.isArray(c.topics) ? c.topics : [];
  if (topics.length > MAX_TOPICS_PER_CHAPTER) throw new SubjectEditsValidationError('Too many topics in one chapter');
  return JSON.parse(JSON.stringify({
    key, title: str(c.title), hidden: c.hidden === true || undefined, added: c.added === true || undefined, topics: topics.map(cleanTopicRef),
  }));
}

function cleanLesson(lesson) {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) throw new SubjectEditsValidationError('A topic lesson must be an object');
  return Object.fromEntries(LESSON_FIELDS.filter((f) => lesson[f] !== undefined).map((f) => [f, lesson[f]]));
}

function validateSubjectEdits(edits) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw new SubjectEditsValidationError('edits must be an object');
  if (JSON.stringify(edits).length > MAX_BYTES) throw new SubjectEditsValidationError('These changes are too large to save');
  const chapters = Array.isArray(edits.chapters) ? edits.chapters : [];
  if (chapters.length > MAX_CHAPTERS) throw new SubjectEditsValidationError('Too many chapters');
  const topics = edits.topics && typeof edits.topics === 'object' && !Array.isArray(edits.topics) ? edits.topics : {};
  return {
    chapters: chapters.map(cleanChapter),
    topics: Object.fromEntries(Object.entries(topics).map(([k, v]) => [k.slice(0, 300), cleanLesson(v)])),
  };
}

module.exports = { validateSubjectEdits, SubjectEditsValidationError, LESSON_FIELDS };
