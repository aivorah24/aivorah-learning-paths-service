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

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

function normaliseGrade(grade) {
  const m = String(grade || '').match(/(\d+)/);
  return m ? `Grade ${m[1]}` : grade;
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
    const isNcert = /^(ncert|cbse)$/i.test(String(curriculum).trim());
    let collection, qCurriculum, qGrade;
    if (isNcert) {
      // NCERT collection stores grade as an integer (6, 7, ...), not "Grade N".
      collection = TOPIC_COUNT_NCERT_COLLECTION;
      qCurriculum = 'NCERT';
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
  const points = await scrollAll(IB_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: curriculum } },
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
    if (topicName && !entry.topics.has(topicName)) {
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
  const points = await scrollAll(IB_COLLECTION, {
    must: [
      { key: 'curriculum', match: { value: curriculum } },
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
    if (topicName && !unit.topics.has(topicName)) {
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
    .map((u) => ({ unitNo: u.unitNo, title: u.title, topics: [...u.topics.values()], pending: u.topics.size === 0 }));
}

module.exports = { listSubjects, listSyllabus, topicCount, IB_COLLECTION };
