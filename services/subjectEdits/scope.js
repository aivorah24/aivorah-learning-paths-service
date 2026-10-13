const { isCbse } = require('../curriculumName');

// One key per standard subject path, however the app spells it ("CBSE"/"NCERT", "Grade 6"/"6", "Maths"/"mathematics").
function scopeOf({ curriculum, grade, subject } = {}) {
  const c = String(curriculum || '').trim().toLowerCase();
  const g = String(grade || '').match(/\d+/)?.[0] || String(grade || '').trim().toLowerCase();
  const s = String(subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!c || !g || !s) return null;
  return { curriculum: isCbse(c) ? 'cbse' : c, grade: g, subject: s === 'maths' || s === 'math' ? 'mathematics' : s };
}

module.exports = { scopeOf };
