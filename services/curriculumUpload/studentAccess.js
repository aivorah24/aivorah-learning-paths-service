const supabase = require('../supabase');

// teacher_student is the existing cross-service relationship table (written
// by aivorah-students-service when a teacher links a student account) — this
// reuses it rather than inventing a new teacher/student model.
async function isStudentOfTeacher(teacherId, studentId) {
  const { data, error } = await supabase
    .from('teacher_student')
    .select('teacher_id')
    .eq('teacher_id', teacherId)
    .eq('student_id', studentId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function listTeacherIdsForStudent(studentId) {
  const { data, error } = await supabase.from('teacher_student').select('teacher_id').eq('student_id', studentId);
  if (error) throw new Error(error.message);
  return [...new Set((data || []).map((r) => r.teacher_id))];
}

module.exports = { isStudentOfTeacher, listTeacherIdsForStudent };
