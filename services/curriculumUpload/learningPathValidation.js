class LearningPathValidationError extends Error {}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// listenParts/practiceQuiz are optional (Phase 2 companions) — when present
// they must match the shape LessonScreen/ListenTab and the Quiz screen
// consume, so a teacher's PUT edit can't silently corrupt them.
function validateCompanions(content, ui, ti) {
  if (!content || typeof content !== 'object') return;
  const prefix = `units[${ui}].topics[${ti}].content`;

  if (content.listenParts !== undefined) {
    if (!Array.isArray(content.listenParts)) {
      throw new LearningPathValidationError(`${prefix}.listenParts must be an array`);
    }
    content.listenParts.forEach((p, pi) => {
      if (!p || !isNonEmptyString(p.heading) || !isNonEmptyString(p.text)) {
        throw new LearningPathValidationError(`${prefix}.listenParts[${pi}] must have non-empty heading and text`);
      }
      if (p.pauseThink !== undefined) {
        const pt = p.pauseThink;
        if (!pt || !isNonEmptyString(pt.question) || !Array.isArray(pt.options) || !pt.options.every(isNonEmptyString) || typeof pt.correctIndex !== 'number') {
          throw new LearningPathValidationError(`${prefix}.listenParts[${pi}].pauseThink must be {question, options[], correctIndex}`);
        }
      }
    });
  }

  if (content.practiceQuiz !== undefined) {
    if (!Array.isArray(content.practiceQuiz)) {
      throw new LearningPathValidationError(`${prefix}.practiceQuiz must be an array`);
    }
    content.practiceQuiz.forEach((q, qi) => {
      if (!q || !isNonEmptyString(q.question) || !Array.isArray(q.options) || (q.correct !== undefined && typeof q.correct !== 'number' && typeof q.correct !== 'string')) {
        throw new LearningPathValidationError(`${prefix}.practiceQuiz[${qi}] must have {question, options[], correct}`);
      }
    });
  }
}

// quality (Phase 3 grade-fit) is optional; when present just check its shape.
function validateQuality(quality, ui, ti) {
  if (quality === undefined || quality === null) return;
  const prefix = `units[${ui}].topics[${ti}].quality`;
  if (typeof quality !== 'object' || !Array.isArray(quality.issues)) {
    throw new LearningPathValidationError(`${prefix} must be an object with an issues array`);
  }
}

function validateLearningPathContent(content) {
  if (!content || typeof content !== 'object') {
    throw new LearningPathValidationError('content must be an object');
  }
  if (!Array.isArray(content.units) || content.units.length === 0) {
    throw new LearningPathValidationError('content.units must be a non-empty array');
  }

  const unitOrders = new Set();
  content.units.forEach((unit, ui) => {
    if (typeof unit.order !== 'number') {
      throw new LearningPathValidationError(`units[${ui}] missing numeric order`);
    }
    if (unitOrders.has(unit.order)) {
      throw new LearningPathValidationError(`units[${ui}] has a duplicate order value`);
    }
    unitOrders.add(unit.order);
    if (unit.title !== null && !isNonEmptyString(unit.title)) {
      throw new LearningPathValidationError(`units[${ui}].title must be a non-empty string or null`);
    }
    if (!Array.isArray(unit.topics)) {
      throw new LearningPathValidationError(`units[${ui}].topics must be an array`);
    }

    const topicOrders = new Set();
    unit.topics.forEach((topic, ti) => {
      if (typeof topic.order !== 'number') {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}] missing numeric order`);
      }
      if (topicOrders.has(topic.order)) {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}] has a duplicate order value`);
      }
      topicOrders.add(topic.order);
      if (topic.title !== null && !isNonEmptyString(topic.title)) {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}].title must be a non-empty string or null`);
      }
      if (!Array.isArray(topic.objectives) || !topic.objectives.every(isNonEmptyString)) {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}].objectives must be an array of non-empty strings`);
      }
      if (!Array.isArray(topic.lessons) || !topic.lessons.every((l) => l && isNonEmptyString(l.title) && typeof l.summary === 'string')) {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}].lessons must be an array of {title, summary}`);
      }
      if (!Array.isArray(topic.subtopics)) {
        throw new LearningPathValidationError(`units[${ui}].topics[${ti}].subtopics must be an array`);
      }
      validateCompanions(topic.content, ui, ti);
      validateQuality(topic.quality, ui, ti);

      const subtopicOrders = new Set();
      topic.subtopics.forEach((sub, si) => {
        if (typeof sub.order !== 'number') {
          throw new LearningPathValidationError(`units[${ui}].topics[${ti}].subtopics[${si}] missing numeric order`);
        }
        if (subtopicOrders.has(sub.order)) {
          throw new LearningPathValidationError(`units[${ui}].topics[${ti}].subtopics[${si}] has a duplicate order value`);
        }
        subtopicOrders.add(sub.order);
        if (!isNonEmptyString(sub.title)) {
          throw new LearningPathValidationError(`units[${ui}].topics[${ti}].subtopics[${si}].title must be a non-empty string`);
        }
      });
    });
  });

  return true;
}

module.exports = { validateLearningPathContent, LearningPathValidationError };
