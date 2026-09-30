const supabase = require('../supabase');

// One row per teacher + standard subject path: `draft` is the working copy, `published` what their students see.
const TABLE = 'teacher_subject_edits';

async function getSubjectEdits(teacherId, scope) {
  const { data, error } = await supabase.from(TABLE).select('*')
    .eq('teacher_id', teacherId).eq('curriculum', scope.curriculum).eq('grade', scope.grade).eq('subject', scope.subject)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function saveSubjectDraft(teacherId, scope, draft) {
  const { data, error } = await supabase.from(TABLE)
    .upsert({ teacher_id: teacherId, ...scope, draft, updated_at: new Date().toISOString() }, { onConflict: 'teacher_id,curriculum,grade,subject' })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function publishSubjectEdits(id, draft) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from(TABLE)
    .update({ published: draft, published_at: now, updated_at: now })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function listSubjectEditsForTeacher(teacherId) {
  const { data, error } = await supabase.from(TABLE)
    .select('curriculum, grade, subject, updated_at, published_at')
    .eq('teacher_id', teacherId).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// The latest published changes to this subject from any of the student's teachers.
async function publishedEditsForTeachers(teacherIds, scope) {
  if (!teacherIds.length) return null;
  const { data, error } = await supabase.from(TABLE)
    .select('teacher_id, published, published_at')
    .in('teacher_id', teacherIds).eq('curriculum', scope.curriculum).eq('grade', scope.grade).eq('subject', scope.subject)
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

module.exports = { getSubjectEdits, saveSubjectDraft, publishSubjectEdits, listSubjectEditsForTeacher, publishedEditsForTeachers };
