const supabase = require('../supabase');

async function createCurriculum({ teacherId, fileName, mimeType, fileUrl, cloudinaryPublicId, uploadConfig }) {
  const { data, error } = await supabase
    .from('teacher_curricula')
    .insert({
      teacher_id: teacherId,
      file_name: fileName,
      mime_type: mimeType,
      file_url: fileUrl,
      cloudinary_public_id: cloudinaryPublicId,
      ...(uploadConfig ? { extracted_structure: { uploadConfig } } : {}),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateCurriculumStatus(id, status, extra = {}) {
  const { data, error } = await supabase
    .from('teacher_curricula')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getCurriculumById(id) {
  const { data, error } = await supabase.from('teacher_curricula').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getCurriculaByIds(ids) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('teacher_curricula').select('id, file_name').in('id', ids);
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteCurriculum(id) {
  const { error } = await supabase.from('teacher_curricula').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = { createCurriculum, updateCurriculumStatus, getCurriculumById, getCurriculaByIds, deleteCurriculum };
