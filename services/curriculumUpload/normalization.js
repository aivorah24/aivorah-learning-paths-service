class CurriculumNormalizationError extends Error {}

const CHAPTER_KEYWORD_RE = /^(?:chapter|unit)\s+([0-9]+|[ivxlcdm]+)\s*[:.\-]?\s*(.*)$/i;
const NUMBERED_RE = /^(\d+(?:\.\d+)*)\s*[:.\-]?\s+(.+)$/;

function normalizeCurriculumStructure(extracted) {
  if (!extracted || typeof extracted !== 'object') {
    throw new CurriculumNormalizationError('extracted_structure is missing or not an object');
  }
  switch (extracted.format) {
    case 'pdf':
    case 'docx':
      return { sourceFormat: extracted.format, ...normalizeTextStructure(extracted.text) };
    case 'xlsx':
      return { sourceFormat: 'xlsx', ...normalizeXlsxStructure(extracted.sheets) };
    default:
      throw new CurriculumNormalizationError(`Unsupported extracted format: ${extracted.format}`);
  }
}

function normalizeTextStructure(text) {
  if (typeof text !== 'string') {
    throw new CurriculumNormalizationError('extracted_structure.text must be a string');
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const units = [];
  const preambleLines = [];
  let currentUnit = null;
  let currentTopic = null;

  lines.forEach((line, lineIndex) => {
    const chapterMatch = CHAPTER_KEYWORD_RE.exec(line);
    const numberedMatch = !chapterMatch ? NUMBERED_RE.exec(line) : null;

    if (chapterMatch) {
      currentUnit = newUnit(chapterMatch[2].trim() || line, units.length, lineIndex);
      units.push(currentUnit);
      currentTopic = null;
      return;
    }

    if (numberedMatch) {
      const depth = numberedMatch[1].split('.').length;
      const title = numberedMatch[2].trim();

      if (depth === 1) {
        currentUnit = newUnit(title, units.length, lineIndex);
        units.push(currentUnit);
        currentTopic = null;
        return;
      }
      if (!currentUnit) {
        currentUnit = newUnit(null, units.length, lineIndex);
        units.push(currentUnit);
      }
      if (depth === 2) {
        currentTopic = newTopic(title, currentUnit.topics.length, lineIndex);
        currentUnit.topics.push(currentTopic);
        return;
      }
      if (!currentTopic) {
        currentTopic = newTopic(null, currentUnit.topics.length, lineIndex);
        currentUnit.topics.push(currentTopic);
      }
      currentTopic.subtopics.push({ title, order: currentTopic.subtopics.length, sourceRef: { lineIndex } });
      return;
    }

    if (currentTopic) currentTopic.content.push(line);
    else if (currentUnit) currentUnit.content.push(line);
    else preambleLines.push(line);
  });

  if (units.length === 0) {
    return {
      unstructured: true,
      preambleText: '',
      units: [newUnit(null, 0, 0, preambleLines)],
    };
  }
  return { unstructured: false, preambleText: preambleLines.join('\n'), units };
}

function newUnit(title, order, lineIndex, content = []) {
  return { title: title || null, order, content, topics: [], sourceRef: { lineIndex } };
}

function newTopic(title, order, lineIndex) {
  return { title: title || null, order, content: [], subtopics: [], sourceRef: { lineIndex } };
}

function normalizeXlsxStructure(sheets) {
  if (!Array.isArray(sheets)) {
    throw new CurriculumNormalizationError('extracted_structure.sheets must be an array');
  }

  const units = [];
  sheets.forEach((sheet) => {
    extractUnitsFromSheet(sheet).forEach((unit) => {
      units.push({ ...unit, order: units.length });
    });
  });

  return { unstructured: units.length === 0, preambleText: '', units };
}

function extractUnitsFromSheet(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (dataRows.length === 0) return [];

  const header = rows[0].map((cell) => String(cell ?? '').trim().toLowerCase());
  const chapterColIdx = header.findIndex((h) => /chapter|unit/.test(h));
  const topicColIdx = header.findIndex((h) => /topic/.test(h));
  const subtopicColIdx = header.findIndex((h) => /subtopic|sub-topic/.test(h));

  if (topicColIdx === -1) {
    const topics = dataRows.map((row, rowIndex) => ({
      title: String(row.find((c) => String(c ?? '').trim() !== '') ?? '').trim(),
      order: rowIndex,
      subtopics: [],
      sourceRef: { sheet: sheet.name, rowIndex: rowIndex + 1 },
    }));
    return [{ title: sheet.name, content: [], topics, sourceRef: { sheet: sheet.name } }];
  }

  const unitsByTitle = new Map();
  dataRows.forEach((row, rowIndex) => {
    const unitTitle = chapterColIdx !== -1 ? String(row[chapterColIdx] ?? '').trim() || sheet.name : sheet.name;
    const topicTitle = String(row[topicColIdx] ?? '').trim();
    const subtopicTitle = subtopicColIdx !== -1 ? String(row[subtopicColIdx] ?? '').trim() : '';

    if (!unitsByTitle.has(unitTitle)) {
      unitsByTitle.set(unitTitle, { title: unitTitle, content: [], topics: [], sourceRef: { sheet: sheet.name } });
    }
    const unit = unitsByTitle.get(unitTitle);

    let topic = topicTitle ? unit.topics.find((t) => t.title === topicTitle) : null;
    if (!topic && topicTitle) {
      topic = { title: topicTitle, order: unit.topics.length, subtopics: [], sourceRef: { sheet: sheet.name, rowIndex: rowIndex + 1 } };
      unit.topics.push(topic);
    }
    if (topic && subtopicTitle) {
      topic.subtopics.push({ title: subtopicTitle, order: topic.subtopics.length, sourceRef: { sheet: sheet.name, rowIndex: rowIndex + 1 } });
    }
  });

  return [...unitsByTitle.values()];
}

function validateNormalizedCurriculum(normalized) {
  if (!normalized || typeof normalized !== 'object') {
    throw new CurriculumNormalizationError('Normalized curriculum must be an object');
  }
  if (!['pdf', 'docx', 'xlsx'].includes(normalized.sourceFormat)) {
    throw new CurriculumNormalizationError('Normalized curriculum has an invalid sourceFormat');
  }
  if (!Array.isArray(normalized.units) || normalized.units.length === 0) {
    throw new CurriculumNormalizationError('Normalized curriculum has no units');
  }

  normalized.units.forEach((unit, unitIndex) => {
    if (typeof unit.order !== 'number') {
      throw new CurriculumNormalizationError(`Unit at index ${unitIndex} is missing a numeric order`);
    }
    if (!Array.isArray(unit.topics)) {
      throw new CurriculumNormalizationError(`Unit at index ${unitIndex} is missing a topics array`);
    }
    unit.topics.forEach((topic, topicIndex) => {
      if (typeof topic.order !== 'number') {
        throw new CurriculumNormalizationError(`Topic at index ${topicIndex} in unit ${unitIndex} is missing a numeric order`);
      }
      if (!Array.isArray(topic.subtopics)) {
        throw new CurriculumNormalizationError(`Topic at index ${topicIndex} in unit ${unitIndex} is missing a subtopics array`);
      }
    });
  });

  const hasAnyTitledNode = normalized.units.some(
    (unit) => unit.title || unit.topics.some((topic) => topic.title || topic.subtopics.some((s) => s.title))
  );
  if (!hasAnyTitledNode && !normalized.unstructured) {
    throw new CurriculumNormalizationError('Normalized curriculum has structure but no titled content anywhere');
  }

  return true;
}

module.exports = {
  normalizeCurriculumStructure,
  validateNormalizedCurriculum,
  CurriculumNormalizationError,
};
