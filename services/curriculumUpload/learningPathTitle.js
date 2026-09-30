// Name shown to teacher and students: the teacher's own title, else "Grade 6 Mathematics", else the file name.
function learningPathTitle(meta, fileName) {
  if (meta?.title && String(meta.title).trim()) return String(meta.title).trim();
  const grade = meta?.grade ? `Grade ${String(meta.grade).replace(/^grade\s*/i, '')}` : '';
  const auto = [grade, meta?.subject].filter(Boolean).join(' ');
  return auto || String(fileName || 'Learning Path').replace(/\.(pdf|docx|xlsx)$/i, '').replace(/[_-]+/g, ' ');
}

module.exports = { learningPathTitle };
