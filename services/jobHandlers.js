const { registerHandler, publishJob } = require('./jobQueue');
const { getCurriculumById, updateCurriculumStatus } = require('./curriculumUpload/curriculumRepository');
const { downloadCurriculumFile } = require('./curriculumUpload/downloadCurriculumFile');
const { extractCurriculumContent, isExtractionEmpty, CurriculumExtractionError } = require('./curriculumUpload/extraction');
const { normalizeCurriculumStructure, validateNormalizedCurriculum } = require('./curriculumUpload/normalization');
const { writeJobProgress } = require('./curriculumUpload/progress');
const { structureWithAI } = require('./curriculumUpload/aiStructure');
const { generateLearningPathDraft } = require('./curriculumUpload/aiGeneration');
const { createDraftLearningPath } = require('./curriculumUpload/learningPathRepository');

async function handleCurriculumExtract({ curriculumId }, job) {
  const curriculum = await getCurriculumById(curriculumId);
  if (!curriculum) throw new Error(`teacher_curricula row ${curriculumId} not found`);

  await writeJobProgress(job, 'extracting');
  try {
    const buffer = await downloadCurriculumFile(curriculum.file_url);
    const extracted = await extractCurriculumContent(buffer, curriculum.mime_type);
    if (isExtractionEmpty(extracted)) {
      throw new CurriculumExtractionError('Document contains no extractable content');
    }
    const uploadConfig = curriculum.extracted_structure?.uploadConfig;
    await writeJobProgress(job, 'analysing');
    const aiStructure = await structureWithAI(extracted).catch((err) => {
      console.error('[curriculum_extract] AI structure failed, using rules:', err.message);
      return null;
    });
    const stored = { ...extracted, ...(uploadConfig ? { uploadConfig } : {}), ...(aiStructure ? { aiStructure } : {}) };
    await updateCurriculumStatus(curriculumId, 'processed', { extracted_structure: stored, error: null });
    // Chain generation server-side so the pipeline no longer needs the browser.
    await publishJob('curriculum_generate', { curriculumId, progress: { stage: 'queued', topicsDone: null, topicsTotal: null, updatedAt: new Date().toISOString() } });
    await updateCurriculumStatus(curriculumId, 'generating');
    return { status: 'processed' };
  } catch (err) {
    // file_url/cloudinary_public_id are never touched here — the original
    // upload stays retrievable for a future reprocessing attempt.
    await updateCurriculumStatus(curriculumId, 'failed', { error: err.message });
    throw err;
  }
}

async function handleCurriculumGenerate({ curriculumId }, job) {
  const curriculum = await getCurriculumById(curriculumId);
  if (!curriculum) throw new Error(`teacher_curricula row ${curriculumId} not found`);

  await updateCurriculumStatus(curriculumId, 'generating');
  try {
    const normalized = normalizeCurriculumStructure(curriculum.extracted_structure);
    validateNormalizedCurriculum(normalized);

    const total = normalized.units.reduce((n, u) => n + u.topics.filter((t) => t.title).length, 0);
    await writeJobProgress(job, 'analysing', 0, total);
    await writeJobProgress(job, 'generating', 0, total);
    const draftContent = await generateLearningPathDraft(normalized, (done, of) => writeJobProgress(job, 'generating', done, of));
    await writeJobProgress(job, 'saving', total, total);
    const learningPath = await createDraftLearningPath({
      curriculumId,
      teacherId: curriculum.teacher_id,
      content: draftContent,
    });

    await updateCurriculumStatus(curriculumId, 'generated', { error: null });
    await writeJobProgress(job, 'done', total, total);
    return { status: 'generated', learningPathId: learningPath.id };
  } catch (err) {
    await updateCurriculumStatus(curriculumId, 'failed', { error: err.message });
    throw err;
  }
}

registerHandler('curriculum_extract', handleCurriculumExtract);
registerHandler('curriculum_generate', handleCurriculumGenerate);

module.exports = { handleCurriculumExtract, handleCurriculumGenerate };
