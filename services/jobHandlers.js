const { registerHandler } = require('./jobQueue');
const { getCurriculumById, updateCurriculumStatus } = require('./curriculumUpload/curriculumRepository');
const { downloadCurriculumFile } = require('./curriculumUpload/downloadCurriculumFile');
const { extractCurriculumContent, isExtractionEmpty, CurriculumExtractionError } = require('./curriculumUpload/extraction');
const { normalizeCurriculumStructure, validateNormalizedCurriculum } = require('./curriculumUpload/normalization');
const { generateLearningPathDraft } = require('./curriculumUpload/aiGeneration');
const { createDraftLearningPath } = require('./curriculumUpload/learningPathRepository');

async function handleCurriculumExtract({ curriculumId }) {
  const curriculum = await getCurriculumById(curriculumId);
  if (!curriculum) throw new Error(`teacher_curricula row ${curriculumId} not found`);

  try {
    const buffer = await downloadCurriculumFile(curriculum.file_url);
    const extracted = await extractCurriculumContent(buffer, curriculum.mime_type);
    if (isExtractionEmpty(extracted)) {
      throw new CurriculumExtractionError('Document contains no extractable content');
    }
    const uploadConfig = curriculum.extracted_structure?.uploadConfig;
    await updateCurriculumStatus(curriculumId, 'processed', { extracted_structure: uploadConfig ? { ...extracted, uploadConfig } : extracted, error: null });
    return { status: 'processed' };
  } catch (err) {
    // file_url/cloudinary_public_id are never touched here — the original
    // upload stays retrievable for a future reprocessing attempt.
    await updateCurriculumStatus(curriculumId, 'failed', { error: err.message });
    throw err;
  }
}

async function handleCurriculumGenerate({ curriculumId }) {
  const curriculum = await getCurriculumById(curriculumId);
  if (!curriculum) throw new Error(`teacher_curricula row ${curriculumId} not found`);

  await updateCurriculumStatus(curriculumId, 'generating');
  try {
    const normalized = normalizeCurriculumStructure(curriculum.extracted_structure);
    validateNormalizedCurriculum(normalized);

    const draftContent = await generateLearningPathDraft(normalized);
    const learningPath = await createDraftLearningPath({
      curriculumId,
      teacherId: curriculum.teacher_id,
      content: draftContent,
    });

    await updateCurriculumStatus(curriculumId, 'generated', { error: null });
    return { status: 'generated', learningPathId: learningPath.id };
  } catch (err) {
    await updateCurriculumStatus(curriculumId, 'failed', { error: err.message });
    throw err;
  }
}

registerHandler('curriculum_extract', handleCurriculumExtract);
registerHandler('curriculum_generate', handleCurriculumGenerate);

module.exports = { handleCurriculumExtract, handleCurriculumGenerate };
