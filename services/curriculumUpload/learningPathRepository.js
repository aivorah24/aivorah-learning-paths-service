const supabase = require('../supabase');
const { learningPathTitle } = require('./learningPathTitle');

// One row per curriculum: `content` is the teacher's working copy (always editable), `published_content` is what
// students see. Publishing copies the working copy across; status 'published' means it has been published at least once.

async function createDraftLearningPath({ curriculumId, teacherId, content }) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .insert({ curriculum_id: curriculumId, teacher_id: teacherId, content, status: 'draft' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// The teacher's working copy for a curriculum, whether or not it has been published.
async function getDraftByCurriculumId(curriculumId) {
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

// Only the working copy changes; students keep seeing published_content until the next publish.
async function updateDraftContent(id, content) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getLearningPathByCurriculumId(curriculumId) {
  return getDraftByCurriculumId(curriculumId);
}

// First publish and every later "Publish updates": the working copy becomes what students see.
async function publishLearningPath(id, content) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .update({ status: 'published', published_content: content, published_at: now, updated_at: now })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function listPublishedLearningPathsForTeachers(teacherIds) {
  if (teacherIds.length === 0) return [];
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .select('id, curriculum_id, teacher_id, published_at, meta:published_content->metadata')
    .eq('status', 'published')
    .in('teacher_id', teacherIds)
    .order('published_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// The teacher's own paths for the "My Learning Paths" list — metadata only, never the full content.
async function listLearningPathsForTeacher(teacherId) {
  const { data, error } = await supabase
    .from('teacher_learning_paths')
    .select('id, curriculum_id, status, created_at, updated_at, published_at, meta:content->metadata')
    .eq('teacher_id', teacherId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteLearningPathsForCurriculum(curriculumId) {
  const { error } = await supabase.from('teacher_learning_paths').delete().eq('curriculum_id', curriculumId);
  if (error) throw new Error(error.message);
}

module.exports = {
  createDraftLearningPath,
  getDraftByCurriculumId,
  updateDraftContent,
  getLearningPathByCurriculumId,
  publishLearningPath,
  listPublishedLearningPathsForTeachers,
  listLearningPathsForTeacher,
  deleteLearningPathsForCurriculum,
  learningPathTitle,
};
