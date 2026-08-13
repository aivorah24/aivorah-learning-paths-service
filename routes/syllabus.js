/**
 * routes/syllabus.js
 * Read-only syllabus/topic-resource endpoints the STUDENT Learning Path flow
 * depends on.
 *
 * Extracted from ai-mentor/server/routes/syllabusImport.js — the teacher-
 * authoring endpoints (POST /extract-batch, /extract, /publish, GET
 * /extraction/:jobId) deliberately stayed behind in the monolith. Those
 * belong to the "Manage Syllabus" teacher-side upload/review/publish
 * workflow, a separate concern from what students read here, and pull in
 * multer file uploads, the syllabus-extraction job queue, and job handlers
 * as extra dependencies this service doesn't need.
 */
const express = require('express');
const router  = express.Router();
const supabase = require('../services/supabase');

// ── GET /teacher/syllabus/current ─────────────────────────────────────────
router.get('/current', async (req, res) => {
  const { grade, subject, curriculum = 'CBSE', schoolId } = req.query;
  const { data: chapters } = await supabase
    .from('syllabus_chapters').select('id, unit_no, title')
    .match({ grade, subject, curriculum, ...(schoolId ? { school_id: schoolId } : {}) })
    .order('unit_no');
  const chapterIds = (chapters || []).map(c => c.id);
  // Include `id` (topic_resources joins on this) so the student app can
  // fetch resolved Read/Listen/Practice content for a specific topic without
  // a second round-trip to figure out which row it means.
  const { data: topics } = chapterIds.length
    ? await supabase.from('syllabus_topics').select('id, chapter_id, topic_order, name, kind, page').in('chapter_id', chapterIds).order('topic_order')
    : { data: [] };
  const byChapter = {};
  for (const t of topics || []) (byChapter[t.chapter_id] ||= []).push(t);

  const live = (chapters || []).map(c => ({
    unitNo: c.unit_no,
    title: c.title,
    topics: (byChapter[c.id] || []).map(t => ({ id: t.id, name: t.name, kind: t.kind, page: t.page })),
  }));

  // Return the book's FULL chapter list, not only the chapters that happen to
  // have generated lessons. Previously a chapter with no content simply did not
  // appear, so Class 11 Maths jumped Sets -> Trigonometric Functions and the
  // second item in the list was chapter 3 — which reads as an off-by-one bug and
  // hides half the syllabus. Chapters without lessons are returned with an empty
  // topics array and `pending: true` so the UI can show them greyed out, still
  // openable to the textbook PDF.
  let units = live;
  try {
    const syllabus = require('../services/syllabus-map');
    const gradeNum = parseInt(String(grade || '').replace(/\D/g, ''), 10);
    const full = syllabus.chaptersFor(gradeNum, subject);
    if (full.length) {
      // Match a live chapter to a book chapter by TITLE first, number second.
      // Grades that have not been migrated still carry the old publish() output:
      // one row per topic, all with unit_no = 1. Keying only on the number
      // collapsed every one of them onto book chapter 1 and dropped the rest —
      // Grade 6 went from 657 visible lessons to 1.
      const byTitle = new Map(live.map(u => [String(u.title || '').toLowerCase(), u]));
      const byNo = new Map();
      for (const u of live) if (!byNo.has(u.unitNo)) byNo.set(u.unitNo, u);
      const usedTitles = new Set();
      const seen = new Set();
      units = [];
      const seenTitles = new Set();
      for (const ch of full) {
        if (seen.has(ch.chapter)) continue;         // multi-volume books repeat numbers
        // …and repeat TITLES too: two volumes of the same subject can each open
        // with the same section name, which rendered as two identical accordions.
        const tkey = String(ch.title || '').trim().toLowerCase();
        if (tkey && !/^chapter\s*\d+$/i.test(tkey)) {
          if (seenTitles.has(tkey)) continue;
          seenTitles.add(tkey);
        }
        seen.add(ch.chapter);
        const byTitleHit = byTitle.get(String(ch.title || '').toLowerCase());
        const existing = byTitleHit || byNo.get(ch.chapter);
        if (existing) usedTitles.add(String(existing.title || '').toLowerCase());
        // Prefer the title stored on the live chapter row when it is a real
        // name. Verified titles (the Hindi catalog, for one) are written to the
        // database, but this merge was always taking the map's title — so a
        // corrected title never reached the screen. The map still supplies the
        // name whenever the database row is only a "Chapter N" placeholder.
        const liveTitle = existing && String(existing.title || '').trim();
        const useLive = liveTitle && !/^chapter\s*\d+$/i.test(liveTitle);
        units.push({
          unitNo: ch.chapter,
          title: useLive ? liveTitle : ch.title,
          bookPath: ch.bookPath || null,
          subtopics: (ch.subtopics || []).map(s => s.title),
          topics: existing ? existing.topics : [],
          pending: !existing || existing.topics.length === 0,
        });
      }
      // Anything live but not matched above still belongs to the student — on an
      // unmigrated grade that is most of the content, so it must never be lost.
      for (const u of live) {
        if (usedTitles.has(String(u.title || '').toLowerCase())) continue;
        if (!u.topics.length) continue;             // empty legacy row, nothing to show
        // A leftover row whose title is just "Chapter 7" duplicates the book
        // chapter of that number, and the app showed both — two accordions,
        // one of them empty of meaning. Fold it into the mapped chapter instead.
        const placeholder = /^chapter\s*\d+$/i.test(String(u.title || '').trim());
        if (placeholder) {
          const host = units.find(x => x.unitNo === u.unitNo);
          if (host) {
            host.topics = [...(host.topics || []), ...u.topics];
            host.pending = host.topics.length === 0;
            continue;
          }
        }
        units.push({ ...u, pending: false, unmapped: true });
      }
      units.sort((a, b) => (a.unitNo || 0) - (b.unitNo || 0));
    }
  } catch (e) {
    console.error('[syllabus/current] syllabus map unavailable:', e.message);
  }

  res.json({ units });
});

// ── GET /teacher/syllabus/topic/:topicId/resources ────────────────────────
// Resolves all 8 resource types for one DB-backed topic — reuses the same
// resourceResolver.js the CurriculumProvider layer already uses, so this is
// exactly what a student would see, not a separate parallel read path.
router.get('/topic/:topicId/resources', async (req, res) => {
  try {
    const { resolveAllResources } = require('../services/curriculum/resourceResolver');
    const resources = await resolveAllResources({ topicId: req.params.topicId });
    res.json({ ok: true, topicId: req.params.topicId, resources });
  } catch (err) {
    console.error('[syllabus/topic/resources] error:', err.message);
    res.status(500).json({ error: 'Could not resolve topic resources.' });
  }
});

module.exports = router;
