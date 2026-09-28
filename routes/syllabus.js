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

  // Real topic content already ingested into Qdrant, grouped by source PDF
  // file — see Bug #11 (BUGS_AND_FIXES.md): `pending` used to be computed
  // only from syllabus_topics (this Supabase table), which is empty for
  // NCERT content, so every NCERT chapter showed "Coming Soon" regardless of
  // whether real lesson content already existed in Qdrant. Also fixes the
  // follow-up: once correctly marked not-pending, a chapter still showed
  // "0 topics" because `chapter.topics` (that same empty DB table) has
  // nothing — these real Qdrant topics fill that in instead. Qdrant tags
  // NCERT content as curriculum "NCERT", not "CBSE" (the value this route
  // actually receives — same curriculum, different label between systems,
  // same class of mismatch already seen elsewhere this session) — map it
  // before querying. Grouped by PDF filename (not chapter number) — Qdrant
  // points have no reliable numeric chapter field, but every point's source
  // PDF filename is present and is the same `pdfFile` identifier
  // syllabus-map.js's chapter records already carry.
  let qdrantTopicsByPdfFile = new Map();
  try {
    const { topicsByPdfFile } = require('../services/qdrant');
    qdrantTopicsByPdfFile = await topicsByPdfFile(curriculum, grade, subject);
  } catch (e) {
    console.error('[syllabus/current] Qdrant content check unavailable:', e.message);
    // Degrade to the old (DB-only) pending logic below — never breaks the screen.
  }

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
      for (const ch of full) {
        // Multi-volume books repeat chapter NUMBERS across volumes — that's
        // the real "two identical accordions" case, and it always collides
        // on `chapter` too (see the 'two multi-volume book chapters sharing
        // the same real title' test below), so number alone already catches
        // it. A separate title-only dedupe used to ALSO skip any chapter
        // whose title simply repeated — but a single real primer can
        // legitimately reuse a generic section label across many genuinely
        // different chapters (S04: Grade 2 Hindi's "आनंदमयी कविता"/"Joyful
        // Poem" labels 6 different real poems) — that dropped 14 of 25 real
        // chapters. Number-based dedupe is the correct, sufficient signal.
        if (seen.has(ch.chapter)) continue;
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
        const pdfFileKey = String(ch.pdfFile || '').toLowerCase();
        const qdrantTopics = qdrantTopicsByPdfFile.get(pdfFileKey) || [];
        const dbTopics = existing ? existing.topics : [];
        units.push({
          unitNo: ch.chapter,
          book: ch.book || null,
          title: useLive ? liveTitle : ch.title,
          bookPath: ch.bookPath || null,
          pdfFile: ch.pdfFile || null,
          subtopics: (ch.subtopics || []).map(s => s.title),
          // Real DB-linked topics (teacher-uploaded) take priority when they
          // exist; otherwise show the real Qdrant topics for this chapter —
          // never leave a not-pending chapter showing 0 topics.
          topics: dbTopics.length ? dbTopics : qdrantTopics,
          pending: dbTopics.length === 0 && qdrantTopics.length === 0,
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
            // u.topics is real and non-empty here (guarded above), so the
            // merged host always has real topics — never re-pend it.
            host.topics = [...(host.topics || []), ...u.topics];
            host.pending = false;
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

  // A unit whose sections have been built from the book shows those real sections as its topics, and a placeholder
  // "Chapter N" name gives way to the book's first section title.
  try {
    const { sectionsByPdf } = require('../services/curriculum/bookSections');
    const bySection = await sectionsByPdf(subject, units.map((u) => u.pdfFile).filter(Boolean));
    units = units.map((u) => {
      const secs = bySection.get(String(u.pdfFile || '').toLowerCase());
      if (!secs || !secs.length) return u;
      const placeholder = /^chapter\s*\d+$/i.test(String(u.title || '').trim());
      return {
        ...u,
        ...(placeholder ? { title: secs[0].title } : {}),
        topics: secs.map((x) => ({ name: x.title, kind: 'section', page: x.page })),
        pending: false,
      };
    });
  } catch (e) {
    console.error('[syllabus/current] book sections unavailable:', e.message);
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

// ── GET /teacher/syllabus/topic-by-name/resources ─────────────────────────
// Same shape as /topic/:topicId/resources, but for a topic that has no
// syllabus_topics DB row — resolved by name straight from Qdrant. See
// Bug #8 (BUGS_AND_FIXES.md): the Dashboard's "Continue Learning" card used
// to fall back to the deprecated VideoLesson screen for any topic without a
// curated syllabusRegistry.ts entry (which currently only covers Grade 6) —
// this lets a real topic like "Ability Beyond Disability" (Grade 9 English,
// Qdrant-only) reach the current Learn/AI Tutor/Ask Aivorah/Practice flow.
// The rich lesson is built by a free-tier LLM. When that is rate-limited a call can wait for minutes, which left
// the Learn tab on a spinner. So: (1) only the first opener of a topic waits, briefly, while one shared generation
// finishes in the background and caches; (2) after repeated failures the LLM is treated as down for a few minutes
// and only already-saved rich lessons are served; (3) a failed topic backs off so quota isn't burned.
const ENRICH_WAIT_MS = Number(process.env.ENRICH_WAIT_MS) || 5000;
const ENRICH_RETRY_AFTER_MS = 5 * 60 * 1000;
const LLM_DOWN_MS = 3 * 60 * 1000;
const LLM_STRIKES_TO_TRIP = 3;
const enrichInflight = new Map();
const enrichFailedAt = new Map();
let llmStrikes = 0;
let llmDownUntil = 0;

const strike = () => {
  llmStrikes += 1;
  if (llmStrikes >= LLM_STRIKES_TO_TRIP) { llmDownUntil = Date.now() + LLM_DOWN_MS; llmStrikes = 0; }
};

async function cachedOnly(args) {
  const { getCachedEnrichment } = require('../services/curriculum/enrichment');
  if (typeof getCachedEnrichment !== 'function') return null;
  const row = await getCachedEnrichment(args);
  return row ? { whatYoullLearn: row.structured_content?.whatYoullLearn || [], blocks: row.structured_content?.blocks || [], contentType: row.content_type, pdfPage: row.structured_content?.pdfPage, listenScript: row.structured_content?.listenScript, mathTutor: row.structured_content?.mathTutor } : null;
}

function enrichWithinBudget(key, args, generate) {
  if (Date.now() < llmDownUntil) return cachedOnly(args).catch(() => null);
  const failedAt = enrichFailedAt.get(key);
  if (failedAt && Date.now() - failedAt < ENRICH_RETRY_AFTER_MS) return cachedOnly(args).catch(() => null);

  let entry = enrichInflight.get(key);
  if (entry && entry.timedOut) return Promise.resolve(null); // still generating for an earlier opener: don't make this student wait too
  if (!entry) {
    entry = { timedOut: false };
    entry.promise = Promise.resolve()
      .then(generate)
      .then(
        (r) => { if (r) { llmStrikes = 0; enrichFailedAt.delete(key); } else { enrichFailedAt.set(key, Date.now()); strike(); } return r; },
        (e) => { enrichFailedAt.set(key, Date.now()); strike(); throw e; },
      )
      .finally(() => enrichInflight.delete(key));
    enrichInflight.set(key, entry);
    entry.promise.catch(() => {});
  }
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { entry.timedOut = true; strike(); resolve(null); }, ENRICH_WAIT_MS); });
  return Promise.race([entry.promise, timeout]).finally(() => clearTimeout(timer));
}

router.__resetEnrichState = () => { enrichInflight.clear(); enrichFailedAt.clear(); llmStrikes = 0; llmDownUntil = 0; };

router.get('/topic-by-name/resources', async (req, res) => {
  try {
    const { curriculum, grade, subject, topic } = req.query;
    if (!curriculum || !grade || !subject || !topic) {
      return res.status(400).json({ error: 'curriculum, grade, subject and topic are required.' });
    }
    const { resolveResourcesByTopicName } = require('../services/curriculum/resourceResolver');
    const resources = await resolveResourcesByTopicName({ curriculum, grade, subject, topic });

    // AI enrichment pilot (Learn tab left-side structured content). Kept
    // OUTSIDE resolveResourcesByTopicName() on purpose — that function's own
    // unit tests mock services/qdrant.js only and must keep passing
    // unmodified; this is an additive merge onto the AI_EXPLANATION payload,
    // wrapped so any failure (LLM down, Groq quota, bad JSON, Supabase
    // hiccup) leaves the existing raw intro/body pass-through exactly as it
    // was before this pilot — the Learn tab never breaks or goes blank.
    let explanation = resources.find((r) => r.resourceType === 'AI_EXPLANATION');

    let bookSection = null;
    try {
      const { sectionByTitle } = require('../services/curriculum/bookSections');
      bookSection = await sectionByTitle(grade, subject, topic);
    } catch (e) {
      console.error('[syllabus/topic-by-name/resources] book section error:', e.message);
    }
    if (bookSection) {
      const base = { intro: bookSection.learn?.whatYoullLearn?.[0] || bookSection.section, body: [], pdfFile: bookSection.pdfFile };
      if (!explanation) {
        explanation = { resourceType: 'AI_EXPLANATION', status: 'READY', payload: base };
        resources.push(explanation);
      } else {
        explanation.status = 'READY';
        explanation.payload = { ...base, ...(explanation.payload || {}), pdfFile: bookSection.pdfFile };
      }
    }

    // Section content built ahead of time (Learn, Listen with visuals, quiz) for non-Maths units. When it exists the
    // lesson never waits on a live LLM: only an already-saved topic lesson may take priority over it.
    let unitContent = bookSection && !/math/i.test(subject) ? bookSection : null;
    if (!unitContent && explanation?.payload?.pdfFile && !/math/i.test(subject)) {
      try {
        const { unitContentForTopic } = require('../services/curriculum/unitContentSections');
        unitContent = await unitContentForTopic(explanation.payload.pdfFile, topic);
      } catch (e) {
        console.error('[syllabus/topic-by-name/resources] unit content error:', e.message);
      }
    }

    if (explanation && explanation.status === 'READY') {
      try {
        const { getOrGenerateEnrichment, getCachedEnrichment } = require('../services/curriculum/enrichment');
        const enrichArgs = { curriculum, grade, subject, topic };
        const enriched = unitContent || bookSection
          ? await getCachedEnrichment(enrichArgs)
          : await enrichWithinBudget(
            `${curriculum}|${grade}|${subject}|${topic}`,
            enrichArgs,
            () => getOrGenerateEnrichment(enrichArgs),
          );
        if (enriched) {
          explanation.payload = {
            ...explanation.payload,
            whatYoullLearn: enriched.whatYoullLearn,
            blocks: enriched.blocks,
            contentType: enriched.contentType,
            // Page the book viewer should open at (the app reads payload.pdfPage; defaults to page 1 when absent).
            ...(enriched.pdfPage ? { pdfPage: enriched.pdfPage } : {}),
            // Spoken narration for the Listen tab: [{ card, heading, text }] (card = index of the visual card it explains, or null).
            ...(Array.isArray(enriched.listenScript) && enriched.listenScript.length ? { listenScript: enriched.listenScript } : {}),
            ...(Array.isArray(enriched.mathTutor?.examples) && enriched.mathTutor.examples.length ? { mathTutor: enriched.mathTutor } : {}),
          };
        }
      } catch (enrichErr) {
        console.error('[syllabus/topic-by-name/resources] enrichment error:', enrichErr.message);
      }
    }

    if (explanation && explanation.payload && unitContent) {
      const p = explanation.payload;
      explanation.payload = {
        ...p,
        ...(!(Array.isArray(p.blocks) && p.blocks.length) && unitContent.learn?.blocks?.length
          ? (() => {
            const { learnWithVisuals } = require('../services/curriculum/unitContentSections');
            const learn = learnWithVisuals(unitContent.learn, unitContent.listen);
            return { whatYoullLearn: learn.whatYoullLearn, blocks: learn.blocks };
          })() : {}),
        ...(!(Array.isArray(p.listenScript) && p.listenScript.length) && unitContent.listen.length ? { listenScript: unitContent.listen } : {}),
        ...(unitContent.quiz.length ? { practiceQuiz: unitContent.quiz } : {}),
        ...(p.pdfPage ? {} : { pdfPage: unitContent.pdfPage }),
        section: unitContent.section,
        lang: unitContent.lang,
      };
    }

    if (explanation && explanation.payload && bookSection && /math/i.test(subject)) {
      const p = explanation.payload;
      explanation.payload = {
        ...p,
        ...(!(Array.isArray(p.blocks) && p.blocks.length) ? { whatYoullLearn: bookSection.learn.whatYoullLearn, blocks: bookSection.learn.blocks } : {}),
        mathTutor: p.mathTutor || bookSection.mathTutor,
        pdfPage: p.pdfPage || bookSection.pdfPage,
        section: bookSection.section,
      };
    }

    // Maths AI Tutor: a topic without its own tutor gets its unit's best-matching section tutor.
    if (explanation && explanation.payload && /math/i.test(subject) && !explanation.payload.mathTutor) {
      try {
        const { mathTutorForTopic } = require('../services/curriculum/mathTutorSections');
        const tutor = await mathTutorForTopic(explanation.payload.pdfFile, topic);
        if (tutor && Array.isArray(tutor.examples) && tutor.examples.length) {
          const { pdfPage, ...mathTutor } = tutor;
          explanation.payload = { ...explanation.payload, mathTutor, ...(explanation.payload.pdfPage ? {} : { pdfPage }) };
        }
      } catch (tutorErr) {
        console.error('[syllabus/topic-by-name/resources] math tutor error:', tutorErr.message);
      }
    }

    res.json({ ok: true, resources });
  } catch (err) {
    console.error('[syllabus/topic-by-name/resources] error:', err.message);
    res.status(500).json({ error: 'Could not resolve topic resources.' });
  }
});

module.exports = router;
