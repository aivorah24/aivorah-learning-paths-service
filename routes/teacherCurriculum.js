const express = require('express');
const multer = require('multer');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { requireOwnedCurriculum } = require('../middleware/ownership');
const {
  validateCurriculumFile,
  CurriculumFileValidationError,
  MAX_FILE_BYTES,
} = require('../services/curriculumUpload/fileValidation');
const { uploadCurriculumFile } = require('../services/curriculumUpload/cloudinaryStorage');
const { createCurriculum, updateCurriculumStatus, getCurriculaByIds, deleteCurriculum } = require('../services/curriculumUpload/curriculumRepository');
const {
  getDraftByCurriculumId,
  updateDraftContent,
  getLearningPathByCurriculumId,
  publishLearningPath,
  listLearningPathsForTeacher,
  deleteLearningPathsForCurriculum,
  learningPathTitle,
} = require('../services/curriculumUpload/learningPathRepository');
const {
  validateLearningPathContent,
  LearningPathValidationError,
} = require('../services/curriculumUpload/learningPathValidation');
const { getProgress } = require('../services/curriculumUpload/progress');
const supabase = require('../services/supabase');
const { publishJob } = require('../services/jobQueue');
const { loadBookSections } = require('../services/curriculumUpload/bookMatch');
const { normalizeCurriculumStructure } = require('../services/curriculumUpload/normalization');
const { rebuildTopic } = require('../services/curriculumUpload/aiGeneration');
const { normalizeCurriculum } = require('../services/curriculumName');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

// Grade/subject/curriculum picked on the upload screen; they override any lines inside the document.
function uploadConfigFrom(body = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);
  const config = { grade: pick(body.grade)?.match(/\d+/)?.[0], subject: pick(body.subject), curriculum: normalizeCurriculum(pick(body.curriculum)) };
  return Object.values(config).some(Boolean) ? JSON.parse(JSON.stringify(config)) : null;
}

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
    }
    return res.status(400).json({ error: err.message });
  });
}

router.post('/upload', requireAuth, handleUpload, async (req, res) => {
  try {
    validateCurriculumFile(req.file);
  } catch (err) {
    if (err instanceof CurriculumFileValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  let curriculum;
  try {
    const { url, publicId } = await uploadCurriculumFile(req.file.buffer, {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    curriculum = await createCurriculum({
      teacherId: req.auth.teacherId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileUrl: url,
      cloudinaryPublicId: publicId,
      uploadConfig: uploadConfigFrom(req.body),
    });
  } catch (err) {
    console.error('[teacher-curriculum/upload] storage failed:', err.message);
    return res.status(502).json({ error: 'Failed to store the uploaded file' });
  }

  try {
    const { jobId } = await publishJob('curriculum_extract', { curriculumId: curriculum.id });
    curriculum = await updateCurriculumStatus(curriculum.id, 'processing');
    return res.status(201).json({ curriculum, jobId });
  } catch (err) {
    console.error('[teacher-curriculum/upload] job creation failed:', err.message);
    // The file is already durably stored in Cloudinary and the row exists —
    // marking it failed (not deleting) lets a retry re-enqueue the same
    // curriculum instead of forcing a re-upload.
    const failed = await updateCurriculumStatus(curriculum.id, 'failed', { error: 'Failed to queue processing job' });
    return res.status(500).json({ error: 'Upload succeeded but processing could not be started', curriculum: failed });
  }
});

// Book sections a teacher can pick from when changing a subtopic's page (same + neighbouring grades).
router.get('/book-sections', requireAuth, async (req, res) => {
  try {
    const sections = await loadBookSections(req.query.grade, req.query.subject);
    return res.json({ sections: sections.map(({ tutor, learn, id, ...s }) => s) });
  } catch (err) {
    console.error('[teacher-curriculum/book-sections] failed:', err.message);
    return res.status(500).json({ error: 'Failed to load book sections' });
  }
});

// "My Learning Paths": every path this teacher has, newest edit first, with its name and publish state.
router.get('/learning-paths', requireAuth, async (req, res) => {
  try {
    const rows = await listLearningPathsForTeacher(req.auth.teacherId);
    const curricula = await getCurriculaByIds([...new Set(rows.map((r) => r.curriculum_id))]);
    const fileById = new Map(curricula.map((c) => [c.id, c.file_name]));
    return res.json({
      learningPaths: rows.map((r) => ({
        id: r.id,
        curriculumId: r.curriculum_id,
        title: learningPathTitle(r.meta, fileById.get(r.curriculum_id)),
        fileName: fileById.get(r.curriculum_id) || null,
        grade: r.meta?.grade || null,
        subject: r.meta?.subject || null,
        status: r.status,
        updatedAt: r.updated_at,
        publishedAt: r.published_at,
        // Edited after the last publish -> students still see the older version.
        hasUnpublishedChanges: r.status === 'published' && !!r.published_at && new Date(r.updated_at) > new Date(r.published_at),
      })),
    });
  } catch (err) {
    console.error('[teacher-curriculum/learning-paths] list failed:', err.message);
    return res.status(500).json({ error: 'Failed to list learning paths' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const { data, error } = await supabase.from('teacher_curricula')
    .select('id, file_name, status, error, created_at, updated_at')
    .eq('teacher_id', req.auth.teacherId).order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: 'Failed to list curricula' });
  const curricula = data || [];
  if (curricula.length > 0) curricula[0] = { ...curricula[0], progress: await getProgress(curricula[0]) };
  return res.json({ curricula });
});

router.get('/:id', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  res.json({ curriculum: req.curriculum, progress: await getProgress(req.curriculum) });
});

// Removes the curriculum and its learning path (students lose access). The uploaded file stays in storage.
router.delete('/:id', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  try {
    await deleteLearningPathsForCurriculum(req.params.id);
    await deleteCurriculum(req.params.id);
    return res.status(204).end();
  } catch (err) {
    console.error('[teacher-curriculum/delete] failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete the learning path' });
  }
});

router.post('/:id/retry', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  if (req.curriculum.status !== 'failed') {
    return res.status(409).json({ error: `Cannot retry from status "${req.curriculum.status}"` });
  }
  const regenerate = !!req.curriculum.extracted_structure?.format;
  try {
    const { jobId } = await publishJob(regenerate ? 'curriculum_generate' : 'curriculum_extract', { curriculumId: req.params.id });
    const curriculum = await updateCurriculumStatus(req.params.id, regenerate ? 'generating' : 'processing', { error: null });
    return res.status(202).json({ curriculum, jobId });
  } catch (err) {
    console.error('[teacher-curriculum/retry] job creation failed:', err.message);
    return res.status(500).json({ error: 'Failed to retry processing' });
  }
});

router.post('/:id/generate', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  if (req.curriculum.status !== 'processed') {
    return res.status(409).json({ error: `Cannot start generation from status "${req.curriculum.status}"` });
  }
  try {
    const { jobId } = await publishJob('curriculum_generate', { curriculumId: req.params.id });
    const curriculum = await updateCurriculumStatus(req.params.id, 'generating');
    return res.status(202).json({ curriculum, jobId });
  } catch (err) {
    console.error('[teacher-curriculum/generate] job creation failed:', err.message);
    const failed = await updateCurriculumStatus(req.params.id, 'failed', { error: 'Failed to queue generation job' });
    return res.status(500).json({ error: 'Failed to start generation', curriculum: failed });
  }
});

router.get('/:id/learning-path', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  try {
    const learningPath = await getDraftByCurriculumId(req.params.id);
    if (!learningPath) return res.status(404).json({ error: 'No draft learning path for this curriculum yet' });
    return res.json({ learningPath });
  } catch (err) {
    console.error('[teacher-curriculum/learning-path] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to load the learning path' });
  }
});

router.put('/:id/learning-path', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  try {
    validateLearningPathContent(req.body.content);
  } catch (err) {
    if (err instanceof LearningPathValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  let existing;
  try {
    existing = await getDraftByCurriculumId(req.params.id);
  } catch (err) {
    console.error('[teacher-curriculum/learning-path] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to load the learning path' });
  }
  if (!existing) return res.status(404).json({ error: 'No draft learning path for this curriculum yet' });

  try {
    const updated = await updateDraftContent(existing.id, req.body.content);
    return res.json({ learningPath: updated });
  } catch (err) {
    console.error('[teacher-curriculum/learning-path] update failed:', err.message);
    return res.status(500).json({ error: 'Failed to save learning path edits' });
  }
});

router.post('/:id/learning-path/topics/rebuild', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  const { unitOrder, topicOrder, subtopicSections } = req.body || {};
  if (typeof unitOrder !== 'number' || typeof topicOrder !== 'number' || !Array.isArray(subtopicSections)) {
    return res.status(400).json({ error: 'unitOrder, topicOrder and subtopicSections are required' });
  }
  try {
    const draft = await getDraftByCurriculumId(req.params.id);
    if (!draft) return res.status(404).json({ error: 'No draft learning path for this curriculum yet' });
    const normalized = normalizeCurriculumStructure(req.curriculum.extracted_structure);
    normalized.metadata = { ...normalized.metadata, ...(draft.content.metadata || {}) };
    const fields = await rebuildTopic(normalized, unitOrder, topicOrder, subtopicSections);
    const content = {
      ...draft.content,
      units: draft.content.units.map((u) => (u.order !== unitOrder ? u : {
        ...u, topics: u.topics.map((t) => (t.order !== topicOrder ? t : { ...t, ...fields })),
      })),
    };
    const learningPath = await updateDraftContent(draft.id, content);
    return res.json({ learningPath });
  } catch (err) {
    console.error('[teacher-curriculum/topics/rebuild] failed:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to rebuild the topic' });
  }
});

router.post('/:id/learning-path/publish', requireAuth, requireOwnedCurriculum('id'), async (req, res) => {
  let learningPath;
  try {
    learningPath = await getLearningPathByCurriculumId(req.params.id);
  } catch (err) {
    console.error('[teacher-curriculum/learning-path/publish] fetch failed:', err.message);
    return res.status(500).json({ error: 'Failed to load the learning path' });
  }
  if (!learningPath) return res.status(404).json({ error: 'No draft learning path for this curriculum yet' });


  try {
    validateLearningPathContent(learningPath.content);
  } catch (err) {
    if (err instanceof LearningPathValidationError) {
      return res.status(400).json({ error: `Draft failed validation: ${err.message}` });
    }
    throw err;
  }

  try {
    const published = await publishLearningPath(learningPath.id, learningPath.content);
    if (!published) return res.status(404).json({ error: 'No learning path for this curriculum yet' });
    return res.status(200).json({ learningPath: published });
  } catch (err) {
    console.error('[teacher-curriculum/learning-path/publish] publish failed:', err.message);
    return res.status(500).json({ error: 'Failed to publish the learning path' });
  }
});

module.exports = router;
