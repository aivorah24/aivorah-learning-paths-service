const express = require('express');
const multer = require('multer');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { scopeOf } = require('../services/subjectEdits/scope');
const { validateSubjectEdits, SubjectEditsValidationError } = require('../services/subjectEdits/validation');
const {
  getSubjectEdits, saveSubjectDraft, publishSubjectEdits, listSubjectEditsForTeacher,
} = require('../services/subjectEdits/repository');
const { uploadLessonImage, uploadLessonBook } = require('../services/curriculumUpload/cloudinaryStorage');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BOOK_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const uploadBook = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BOOK_BYTES } });

function summary(row) {
  if (!row) return { status: 'none', updatedAt: null, publishedAt: null, hasUnpublishedChanges: false };
  const published = !!row.published_at;
  return {
    status: published ? 'published' : 'draft',
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
    hasUnpublishedChanges: published && new Date(row.updated_at) > new Date(row.published_at),
  };
}

function scopeOr400(source, res) {
  const scope = scopeOf(source);
  if (!scope) res.status(400).json({ error: 'curriculum, grade and subject are required' });
  return scope;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await listSubjectEditsForTeacher(req.auth.teacherId);
    res.json({ subjects: rows.map((r) => ({ curriculum: r.curriculum, grade: r.grade, subject: r.subject, ...summary(r) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/subject', requireAuth, async (req, res) => {
  const scope = scopeOr400(req.query, res);
  if (!scope) return;
  try {
    const row = await getSubjectEdits(req.auth.teacherId, scope);
    res.json({ edits: row?.draft || { chapters: [], topics: {} }, ...summary(row) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/subject', requireAuth, async (req, res) => {
  const scope = scopeOr400(req.body, res);
  if (!scope) return;
  try {
    const draft = validateSubjectEdits(req.body.edits);
    const row = await saveSubjectDraft(req.auth.teacherId, scope, draft);
    res.json({ edits: row.draft, ...summary(row) });
  } catch (err) {
    if (err instanceof SubjectEditsValidationError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// The working copy becomes what this teacher's students see.
router.post('/subject/publish', requireAuth, async (req, res) => {
  const scope = scopeOr400(req.body, res);
  if (!scope) return;
  try {
    const row = await getSubjectEdits(req.auth.teacherId, scope);
    if (!row) return res.status(404).json({ error: 'No changes saved for this subject yet' });
    const published = await publishSubjectEdits(row.id, row.draft);
    res.json({ edits: published.draft, ...summary(published) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/images', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Pictures must be under 5MB' : err.message });
    if (!req.file || !/^image\/(png|jpe?g|gif|webp)$/.test(req.file.mimetype)) {
      return res.status(400).json({ error: 'Choose a PNG, JPG, GIF or WebP picture' });
    }
    try {
      res.json(await uploadLessonImage(req.file.buffer, { mimeType: req.file.mimetype }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// A teacher's own book (PDF) shown next to a lesson instead of the standard book.
router.post('/books', requireAuth, (req, res) => {
  uploadBook.single('book')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Books must be under 10MB — upload the chapter you need' : err.message });
    if (!req.file || req.file.buffer.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Choose a PDF file' });
    try {
      res.json(await uploadLessonBook(req.file.buffer, { fileName: String(req.file.originalname || 'book.pdf').slice(0, 120) }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
