// NCERT publishes the CBSE textbooks — it is not a curriculum. Any incoming
// "NCERT" (any case/spacing) is CBSE. The Qdrant book collection is the one
// place that still keys this content "NCERT" (see toQdrantCurriculum).
function normalizeCurriculum(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return /^(ncert|cbse)$/i.test(s.replace(/\s+/g, '')) ? 'CBSE' : s;
}

function isCbse(value) {
  return normalizeCurriculum(value) === 'CBSE';
}

// CBSE content lives in Qdrant tagged "NCERT"; every other curriculum as typed.
function toQdrantCurriculum(value) {
  return isCbse(value) ? 'NCERT' : value;
}

// Normalises ?curriculum= and JSON body.curriculum once, before any route sees them.
function normalizeCurriculumParams(req, _res, next) {
  if (typeof req.query?.curriculum === 'string') req.query.curriculum = normalizeCurriculum(req.query.curriculum);
  if (typeof req.body?.curriculum === 'string') req.body.curriculum = normalizeCurriculum(req.body.curriculum);
  next();
}

module.exports = { normalizeCurriculum, isCbse, toQdrantCurriculum, normalizeCurriculumParams };
