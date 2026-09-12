class LearningPathValidationError extends Error {}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
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
