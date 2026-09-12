const supabase = require('../supabase');

async function createDraftLearningPath({ curriculumId, teacherId, content }) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .insert({ curriculum_id: curriculumId, teacher_id: teacherId, content, status: 'draft' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getDraftByCurriculumId(curriculumId) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .select('*')
    .eq('curriculum_id', curriculumId)
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Scoped to status='draft' so this can never silently overwrite a published
// learning path's content — publishing is handled elsewhere with its own row.
async function updateDraftContent(id, content) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getLearningPathByCurriculumId(curriculumId) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .select('*')
    .eq('curriculum_id', curriculumId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// The status='draft' filter makes this a single atomic conditional UPDATE —
// if two publish requests race, only one matches a row; the other gets back
// null and the caller treats that as "someone else already published it".
async function publishLearningPath(id, content) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .update({ status: 'published', published_content: content, published_at: now, updated_at: now })
    .eq('id', id)
    .eq('status', 'draft')
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function listPublishedLearningPathsForTeachers(teacherIds) {
  if (teacherIds.length === 0) return [];
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .select('id, curriculum_id, teacher_id, published_at')
    .eq('status', 'published')
    .in('teacher_id', teacherIds)
    .order('published_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  createDraftLearningPath,
  getDraftByCurriculumId,
  updateDraftContent,
  getLearningPathByCurriculumId,
  publishLearningPath,
  listPublishedLearningPathsForTeachers,
};
