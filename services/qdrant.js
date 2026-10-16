/**
 * services/qdrant.js
 * Read-only curriculum browsing for the student Learning Path flow — lists
 * subjects and units/topics straight out of Qdrant, the same curriculum
 * store aivorah-ai-coach-service already reads for RAG grounding (see its
 * services/qdrant.js, collection `ai_mentor_content`). This file only ever
 * *lists* what's already indexed (scroll + filter, no vectors) — it does not
 * duplicate ai-coach-service's embedding/search logic, and it does not write
 * to Qdrant; ingestion stays wherever it already lives.
 */
const { QdrantClient } = require('@qdrant/js-client-rest');

// Non-NCERT curricula (IB PYP, CBSE, Cambridge, … and now IB DP) live here,
// same as ai-coach-service's resolveCollection() convention.
const IB_COLLECTION = 'ai_mentor_content';

// NCERT content itself (chapter titles, chunk text, images) lives in a
// SEPARATE collection — confirmed via live queries during the Bug #6/#8
// investigation (aivorah-frontend/BUGS_AND_FIXES.md). listSubjects/
// listSyllabus above intentionally never touch this collection for CBSE —
// syllabus-map.js's book-derived chapter data is the source of truth there
// (see routes/curriculum.js's own comment). This collection is only for
// resolveTopicContent() below: fetching real lesson content by topic name
// for topics that have no syllabus_topics DB row (see Bug #8).
const NCERT_COLLECTION = 'aivorah_curriculum_chunks_v1';

// The rest of the app calls this curriculum "CBSE" (users.curriculum,
// syllabus-map.js's book data, every frontend route param) — Qdrant's own
// NCERT_COLLECTION tags the exact same content "NCERT" instead (Bug #8/#11).
// Every NCERT_COLLECTION query must go through toQdrantCurriculum() first;
// it lives in curriculumName.js with the rest of the CBSE/NCERT mapping.
const { isCbse, toQdrantCurriculum } = require('./curriculumName');

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

function normaliseGrade(grade) {
  const m = String(grade || '').match(/(\d+)/);
  return m ? `Grade ${m[1]}` : grade;
}

// IB PYP is the one curriculum whose Qdrant-stored `curriculum` payload value
// (`IB_PYP`, underscore) doesn't match its display name (`IB PYP`, space) —
// confirmed by live query comparison against the monolith's own
// resolveCollection(), which applies this exact same translation before
// hitting Qdrant. Every other curriculum (Cambridge, IB DP, IB MYP, ...) is
// stored under its plain display name and needs no translation.
function normaliseCurriculumForQdrant(curriculum) {
  return /^ib.?pyp$/i.test(String(curriculum || '').trim()) ? 'IB_PYP' : curriculum;
}

async function scrollAll(collection, filter) {
  const points = [];
  let offset;
  do {
    const res = await client.scroll(collection, { limit: 250, offset, with_payload: true, with_vector: false, filter });
    points.push(...res.points);
    offset = res.next_page_offset;
  } while (offset);
  return points;
}

// NCERT/CBSE content lives in a SEPARATE Qdrant collection from every other
// curriculum (IB PYP, Cambridge, ...) — private to topicCount() below, not
// shared with listSubjects/listSyllabus (which never touch Qdrant for CBSE;
// syllabus-map.js's book data is their source of truth instead).
const TOPIC_COUNT_NCERT_COLLECTION = 'aivorah_curriculum_chunks_v1';

// 30-min in-memory cache for topic counts, mirroring the cache the
// monolith's own fetchTotalTopicsFromQdrant() used (ai-mentor/server/
// routes/student.js) before this endpoint replaced it — avoids repeated
// Qdrant pagination on every parent/children list load.
const _topicCountCache = new Map(); // key -> { count, expiresAt }
const TOPIC_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Total distinct (subject, topic) pairs ingested for one curriculum+grade.
 * Feeds aivorah-students-service's GET /parent/:email/children (totalTopics
 * per child) so that service never has to own Qdrant directly — this is the
 * curriculum/content domain's job. Collection-resolution rules ported from
 * the monolith's resolveCollection()/normalizeCurriculum() (ai-mentor/
 * server/services/qdrant.js + utils/curriculum.js) since those aren't
 * shared modules.
 */
async function topicCount(curriculum, grade) {
  const cacheKey = `${curriculum}|${grade}`;
  const cached = _topicCountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  try {
    let collection, qCurriculum, qGrade;
    if (isCbse(curriculum)) {
      // NCERT collection stores grade as an integer (6, 7, ...), not "Grade N".
      collection = TOPIC_COUNT_NCERT_COLLECTION;
      qCurriculum = toQdrantCurriculum(curriculum);
      const m = String(grade || '').match(/(\d+)/);
      qGrade = m ? parseInt(m[1], 10) : grade;
    } else {
      collection = IB_COLLECTION;
      // ai_mentor_content stores IB PYP with an underscore; every other
      // curriculum (IB MYP, IB DP, Cambridge, ...) is stored as typed.
      qCurriculum = /^ib\s*pyp$/i.test(String(curriculum).trim()) ? 'IB_PYP' : curriculum;
      qGrade = normaliseGrade(grade);
    }
    const points = await scrollAll(collection, {
      must: [
        { key: 'curriculum', match: { value: qCurriculum } },
        { key: 'grade', match: { value: qGrade } },
      ],
    });
    const seen = new Set();
    for (const p of points) {
      if (p.payload.subject && p.payload.topic) seen.add(`${p.payload.subject}|${p.payload.topic}`);
    }
    const count = seen.size;
    _topicCountCache.set(cacheKey, { count, expiresAt: Date.now() + TOPIC_CACHE_TTL_MS });
    return count;
  } catch {
    // A Qdrant hiccup reads as "0 topics", not a broken caller — same
    // graceful-fallback contract the monolith's version had.
    return 0;
  }
}

/**
 * Distinct subjects (+ their topics) for one curriculum+grade — feeds the
 * Learning Path "Subjects" grid. An empty result means nothing has been
 * ingested for this curriculum/grade yet, not an error — the caller shows
 * that honestly rather than inventing a subject list.
 */
async function listSubjects(curriculum, grade) {
  const qGrade = normaliseGrade(grade);
  const qCurriculum = normaliseCurriculumForQdrant(curriculum);
  const points = await scrollAll(IB_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: qCurriculum } },
      { key: 'grade', match: { value: qGrade } },
    ],
  });

  const bySubject = new Map();
  for (const p of points) {
    const subject = p.payload.subject;
    if (!subject) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, { topics: new Map(), units: new Map() });
    const entry = bySubject.get(subject);
    const topicName = p.payload.topic;
    const unitTitle = typeof p.payload.chapter === 'number' ? `Chapter ${p.payload.chapter}` : (p.payload.textbook || '');
    // Same junk-chunk filter topicsByPdfFile() already applies below (Bug #6) —
    // without it, raw PDF-code placeholders like "bemr101"/"iemr101" that
    // ended up in a Qdrant point's `topic` payload were surfaced straight to
    // the teacher as a topic-suggestion chip (B01: internal codes shown to
    // teacher instead of a human-readable topic name).
    if (topicName && looksLikeRealTopicName(topicName) && !entry.topics.has(topicName)) {
      entry.topics.set(topicName, {
        topic: topicName,
        unit: unitTitle,
        description: p.payload.text || p.payload.content || '',
        grade: qGrade,
      });
    }
    // Real unit/chapter title (not the generic "Chapter N" label) — this is
    // what consumers like the student Dashboard's chapter list need; keyed
    // by chapter number so it stays deduped and in syllabus order.
    if (p.payload.textbook && typeof p.payload.chapter === 'number' && !entry.units.has(p.payload.chapter)) {
      entry.units.set(p.payload.chapter, p.payload.textbook);
    }
  }

  return [...bySubject.entries()].map(([subject, entry]) => ({
    subject,
    topicCount: entry.topics.size,
    topics: [...entry.topics.values()],
    units: [...entry.units.entries()].sort((a, b) => a[0] - b[0]).map(([, title]) => title),
  }));
}

/**
 * Unit/chapter -> topic tree for one subject — feeds the Subject Syllabus
 * screen. Chapter number becomes unitNo (same convention syllabus-map.js
 * uses for NCERT book chapters); a topic with no lesson content ingested
 * yet still appears, just with nothing to open — the route layer marks it
 * COMING_SOON rather than dropping it.
 */
async function listSyllabus(curriculum, grade, subject) {
  const qGrade = normaliseGrade(grade);
  const qCurriculum = normaliseCurriculumForQdrant(curriculum);
  const points = await scrollAll(IB_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: qCurriculum } },
      { key: 'grade', match: { value: qGrade } },
      { key: 'subject', match: { value: subject } },
    ],
  });

  const byUnit = new Map();
  for (const p of points) {
    const unitNo = typeof p.payload.chapter === 'number' ? p.payload.chapter : 0;
    const title = p.payload.textbook || `Unit ${unitNo}`;
    if (!byUnit.has(unitNo)) byUnit.set(unitNo, { unitNo, title, topics: new Map() });
    const unit = byUnit.get(unitNo);
    const topicName = p.payload.topic;
    // Same junk-chunk filter as listSubjects() above — see B01/Bug #6.
    if (topicName && looksLikeRealTopicName(topicName) && !unit.topics.has(topicName)) {
      unit.topics.set(topicName, {
        id: `qdrant:${curriculum}:${qGrade}:${subject}:${unitNo}:${topicName}`,
        name: topicName,
        kind: 'qdrant',
        page: '',
      });
    }
  }

  return [...byUnit.values()]
    .sort((a, b) => a.unitNo - b.unitNo)
    .map((u) => ({ unitNo: u.unitNo, title: u.title, topics: byTopicCode([...u.topics.values()]), pending: u.topics.size === 0 }));
}

// Syllabus codes ("A2.1 Origins of cells", "A.3 Work…") order the topics when
// every topic in the unit has one; otherwise the stored order is kept.
const TOPIC_CODE = /^([A-Z]?\d*\.?\d+(?:\.\d+)*|[A-Z]\.\d+)\s/;
function byTopicCode(topics) {
  if (topics.length < 2 || !topics.every((t) => TOPIC_CODE.test(t.name))) return topics;
  const code = (t) => t.name.match(TOPIC_CODE)[1];
  return [...topics].sort((a, b) => code(a).localeCompare(code(b), undefined, { numeric: true }));
}

// Extracts the PDF filename (lowercased, e.g. "iebe105.pdf") a Qdrant point
// was sourced from, out of whichever field it happens to carry it in — the
// payload shape is inconsistent between ingestion batches: some points have
// `source` ("ncert_books/grade9/english/iemr101.pdf"), others only
// `source_reference` ("NCERT English Grade 9 | iebe105.pdf | Page 22").
// Neither reliably carries a numeric `chapter` field — an earlier version of
// this function assumed one did and always returned an empty set.
const PDF_FILENAME_RE = /([a-z0-9]+\.pdf)/i;
function pdfFileFromPayload(payload) {
  const m = String(payload.source || payload.source_reference || '').match(PDF_FILENAME_RE);
  return m ? m[1].toLowerCase() : null;
}

// Same junk-chunk filter the legacy CBSE reader uses (image-caption chunks
// used as a "topic" name, and raw PDF-code placeholders like "iemr101" —
// see Bug #6, BUGS_AND_FIXES.md) — a real browsable topic list must not
// include either.
function looksLikeRealTopicName(topic) {
  const t = String(topic || '').trim();
  if (!t) return false;
  if (/^\[?IMAGE\]?/i.test(t) || /^this image/i.test(t)) return false;
  if (/^[a-z]+\d{2,4}$/i.test(t)) return false; // raw PDF code, e.g. "iemr101"
  return true;
}

/**
 * Real topic names, grouped by source PDF file, for one NCERT
 * curriculum+grade+subject — lets a chapter marked not-pending (Bug #11)
 * actually show what it has, instead of an empty "0 topics" list. `chapter.
 * topics` (syllabus_topics DB rows) stays empty for virtually all NCERT
 * content — these are real Qdrant topics instead, in the same
 * `{id, name, kind, page}` shape listSyllabus() already uses elsewhere, so
 * the frontend needs no special-casing. Each id is Qdrant-name-addressable
 * (`qdrant:...`) — matches what Bug #8's byName lesson-resolution path
 * already expects, so tapping one of these topics reaches real content.
 */
async function topicsByPdfFile(curriculum, grade, subject) {
  const byFile = new Map();
  if (!curriculum || !grade || !subject) return byFile;
  const qCurriculum = toQdrantCurriculum(curriculum);
  const qGrade = Number(String(grade).match(/(\d+)/)?.[1]) || grade;
  const points = await scrollAll(NCERT_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: qCurriculum } },
      { key: 'grade', match: { value: qGrade } },
      { key: 'subject', match: { value: subject } },
    ],
  });
  for (const p of points) {
    const pdfFile = pdfFileFromPayload(p.payload);
    const topicName = p.payload.topic;
    if (!pdfFile || !looksLikeRealTopicName(topicName)) continue;
    if (!byFile.has(pdfFile)) byFile.set(pdfFile, new Map());
    const topics = byFile.get(pdfFile);
    if (!topics.has(topicName)) {
      topics.set(topicName, {
        id: `qdrant:${curriculum}:${qGrade}:${subject}:${topicName}`,
        name: topicName, kind: 'qdrant', page: '',
      });
    }
  }
  const result = new Map();
  for (const [pdfFile, topics] of byFile) result.set(pdfFile, [...topics.values()]);
  return result;
}

/**
 * Real lesson content for one NCERT topic, resolved directly from Qdrant by
 * name (curriculum+grade+subject+topic) — no syllabus_topics DB row needed.
 * Built for Bug #8: topics that only exist in Qdrant (e.g. "Ability Beyond
 * Disability", Grade 9 English) had no way to reach the current Learn/AI
 * Tutor/Ask Aivorah/Practice flow, which only worked for topics with a real
 * DB id — this lets it work for any real topic instead.
 *
 * Filters out the same junk chunks the CBSE reader already excludes
 * (image-caption-as-text chunks) — this is prose content, not a caption.
 *
 * Returns null if nothing matches (caller treats that as "not found", same
 * as an unresolved topicId — never fabricates content).
 */
async function resolveTopicContent(curriculum, grade, subject, topic) {
  if (!curriculum || !grade || !subject || !topic) return null;
  const qCurriculum = toQdrantCurriculum(curriculum);
  const qGrade = Number(String(grade).match(/(\d+)/)?.[1]) || grade;
  const points = await scrollAll(NCERT_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: qCurriculum } },
      { key: 'grade', match: { value: qGrade } },
      { key: 'subject', match: { value: subject } },
      { key: 'topic', match: { value: topic } },
    ],
  });
  if (!points.length) return null;

  // S04: the bulk NCERT chunker (ingest-all-ncert.js / ocr-ingest.cjs) stores
  // chunk text under `content`, not `text` — a different payload shape than
  // the richer micro-topic pipeline this resolver was originally written
  // against. Accept either so real content ingested either way resolves.
  const chunkText = (p) => (typeof p.payload.text === 'string' && p.payload.text.trim())
    || (typeof p.payload.content === 'string' && p.payload.content.trim())
    || '';
  const textChunks = points
    .filter(p => p.payload.content_type !== 'image' && chunkText(p))
    .sort((a, b) => (a.payload.chunk_index ?? 0) - (b.payload.chunk_index ?? 0))
    .map(chunkText);
  const imageChunks = points.filter(p => p.payload.content_type === 'image' && p.payload.image_url);

  if (!textChunks.length && !imageChunks.length) return null;

  return {
    intro: textChunks[0] || '',
    body: textChunks.slice(1),
    sourceReference: points[0].payload.source_reference || null,
    // The real textbook PDF filename this content was extracted from — lets
    // the "View in Book" pane render for byName-resolved topics the same way
    // it already does for DB-backed ones (BookPane.tsx only shows when
    // topic.pdfFile is set — see the Bug #11 sixth finding, BUGS_AND_FIXES.md).
    // No page number is available in this payload shape (unlike the DB
    // path), so the frontend opens the book at page 1 — the same fallback
    // useDbTopic.ts already applies whenever pdfPage is missing.
    pdfFile: pdfFileFromPayload(points[0].payload),
    images: imageChunks.map(p => ({ url: p.payload.image_url, description: p.payload.text || '' })),
  };
}

/**
 * Grounding source for the AI enrichment pilot (see aivorah-learning-paths-
 * service's topic_ai_enrichment table / services/curriculum/enrichment.js).
 *
 * Investigated (not assumed) why resolveTopicContent() so often returns a
 * single ~200-char chunk for a topic: the ingestion pipeline chunked each
 * NCERT PDF into many fine-grained MICRO-topics (often 20-100+ per chapter),
 * each with its own distinct `topic` payload value and a `source_id` like
 * "ncert_g11_accountancy_keac1_487990fc_0012" (book code + page-group hash +
 * chunk_index). A topic genuinely having exactly one matching point is real
 * NCERT granularity, not a retrieval bug — "Relevance of Information" really
 * is that short in the source book.
 *
 * There is no chapter/unit field to group by. The closest real signal is:
 * same source PDF (source_reference/source) + nearby chunk_index. This
 * function returns the topic's own matching point(s) as `primary` (the only
 * thing the AI is allowed to claim as this topic's content) plus a small
 * window of neighboring same-PDF chunks as `context` (background only, to
 * help the model phrase a coherent explanation — never a source of new
 * facts/claims for THIS topic, so the prompt must say so explicitly).
 */
async function resolveTopicWithContext(curriculum, grade, subject, topic, { contextWindow = 2 } = {}) {
  if (!curriculum || !grade || !subject || !topic) return null;
  const qCurriculum = toQdrantCurriculum(curriculum);
  const qGrade = Number(String(grade).match(/(\d+)/)?.[1]) || grade;

  const subjectPoints = await scrollAll(NCERT_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: qCurriculum } },
      { key: 'grade', match: { value: qGrade } },
      { key: 'subject', match: { value: subject } },
    ],
  });
  if (!subjectPoints.length) return null;

  const primaryPoints = subjectPoints.filter(
    (p) => p.payload.topic === topic && p.payload.content_type !== 'image' && typeof p.payload.text === 'string' && p.payload.text.trim()
  );
  if (!primaryPoints.length) return null;

  // Neighbors = same source PDF, nearby chunk_index, excluding the primary
  // topic's own points and any other distinct topic's points that happen to
  // share an index (keeps context free of a DIFFERENT topic's full content).
  const primaryPdf = pdfFileFromPayload(primaryPoints[0].payload);
  const primaryIndexes = new Set(primaryPoints.map((p) => p.payload.chunk_index));
  const contextPoints = subjectPoints
    .filter((p) => {
      if (p.payload.topic === topic) return false;
      if (p.payload.content_type === 'image') return false;
      if (typeof p.payload.text !== 'string' || !p.payload.text.trim()) return false;
      if (pdfFileFromPayload(p.payload) !== primaryPdf) return false;
      const idx = p.payload.chunk_index;
      if (typeof idx !== 'number') return false;
      return [...primaryIndexes].some((pi) => Math.abs(idx - pi) <= contextWindow);
    })
    .sort((a, b) => (a.payload.chunk_index ?? 0) - (b.payload.chunk_index ?? 0))
    .slice(0, 6);

  const imageChunks = subjectPoints.filter(
    (p) => p.payload.topic === topic && p.payload.content_type === 'image' && p.payload.image_url
  );

  return {
    primary: primaryPoints.map((p) => ({ id: p.id, text: p.payload.text.trim(), chunkIndex: p.payload.chunk_index })),
    context: contextPoints.map((p) => ({ id: p.id, text: p.payload.text.trim(), topic: p.payload.topic })),
    sourceReference: primaryPoints[0].payload.source_reference || primaryPoints[0].payload.source || null,
    pdfFile: primaryPdf,
    images: imageChunks.map((p) => ({ url: p.payload.image_url, description: p.payload.text || '' })),
  };
}

// Includes vision-caption filler words ("illustrates the concept of...")
// which would otherwise inflate overlap scores across unrelated images.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'its', 'into',
  'depicts', 'shows', 'image', 'showing', 'a', 'an', 'of', 'in', 'is', 'to', 'on', 'as', 'illustrates', 'illustrating',
  'concept', 'concepts', 'different', 'various', 'specifically', 'focusing', 'process', 'processes', 'representing',
  'used', 'using', 'related', 'type', 'types', 'example', 'examples', 'diagram', 'figure', 'labeled', 'label',
]);
function keywords(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOPWORDS.has(w)) || []);
}

// Caption = the description's first sentence, stripped of vision-model
// boilerplate ("[IMAGE]", "This image depicts/shows...").
function captionFromDescription(text) {
  const firstSentence = String(text || '').split(/(?<=[.!?])\s+/)[0] || '';
  return firstSentence
    .replace(/^\[IMAGE\]\s*/i, '')
    .replace(/^this image (depicts|shows|illustrates)\s*(the concept of)?\s*/i, '')
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * Textbook image lookup for Grade 6 lesson visuals (Phase 2b). Filters the
 * NCERT image chunks by grade/subject/chapter (via the chapter's pdfFile —
 * source_reference embeds that same filename), then ranks by how many
 * keywords the vision description shares with the topic title/subtopics/
 * key terms. Conservative on purpose: an irrelevant image is worse than
 * none, so callers get an empty array unless there's a real overlap.
 */
async function findTopicImages({ grade, subject, pdfFile, topicTitle, subtopics, keyTerms, limit = 2 }) {
  if (!grade || !subject) return [];
  const qGrade = Number(String(grade).match(/(\d+)/)?.[1]) || grade;
  try {
    const points = await scrollAll(NCERT_COLLECTION, {
      must: [
        { key: 'grade', match: { value: qGrade } },
        { key: 'subject', match: { value: subject } },
        { key: 'content_type', match: { value: 'image' } },
      ],
    });
    // Chapter match (via pdfFile) is now a HARD filter when the chapter is
    // known — keyword overlap alone let an unrelated chapter's image through
    // on generic shared words (e.g. "place value", "digits"). Falls back to
    // keyword-only ranking only when the chapter genuinely can't be resolved.
    const chapterCode = pdfFile ? String(pdfFile).replace(/\.pdf$/i, '') : null;

    const targetWords = keywords([topicTitle, ...(subtopics || []), ...(keyTerms || [])].join(' '));
    if (targetWords.size === 0) return [];

    const ranked = points
      .filter((p) => p.payload.image_url)
      .filter((p) => !chapterCode || String(p.payload.source_reference || '').includes(chapterCode))
      .map((p) => {
        const descWords = keywords(p.payload.text || p.payload.topic || '');
        const overlap = [...descWords].filter((w) => targetWords.has(w)).length;
        return { point: p, overlap, score: overlap };
      })
      // Conservative threshold: require at least 3 shared meaningful words
      // (2 let through unrelated captions sharing only generic vocabulary).
      .filter((r) => r.overlap >= 3)
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, limit).map((r) => ({
      url: r.point.payload.image_url,
      caption: captionFromDescription(r.point.payload.text || r.point.payload.topic || '') || topicTitle,
    }));
  } catch (e) {
    console.error('[qdrant] findTopicImages failed:', e.message);
    return [];
  }
}

async function saveSchoolQuiz(quizId, vector, payload) {
  const QUIZ_COLLECTION = 'school_quizzes';
  try {
    const { collections } = await client.getCollections();
    if (!collections.some(c => c.name === QUIZ_COLLECTION)) {
      await client.createCollection(QUIZ_COLLECTION, { vectors: { size: 384, distance: 'Cosine' } });
      for (const f of ['subject', 'grade', 'curriculum', 'school_id', 'status', 'school', 'teacher_name']) {
        await client.createPayloadIndex(QUIZ_COLLECTION, { field_name: f, field_schema: 'keyword' });
      }
    }
  } catch (e) {
    console.warn('[qdrant] ensure collection failed:', e.message);
  }

  await client.upsert(QUIZ_COLLECTION, {
    points: [{
      id: quizId,
      vector,
      payload
    }],
    wait: true,
  });
}
module.exports = { saveSchoolQuiz, scrollAll, listSubjects, listSyllabus, byTopicCode, resolveTopicContent, resolveTopicWithContext, topicsByPdfFile, topicCount, toQdrantCurriculum, findTopicImages, IB_COLLECTION, NCERT_COLLECTION };
