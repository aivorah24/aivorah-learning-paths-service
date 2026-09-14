const AI_COACH_SERVICE_URL = process.env.AI_COACH_SERVICE_URL || 'https://aivorah-ai-coach-service.onrender.com';

// Calibrated against real retrieval on the validation document: a genuinely
// on-topic chapter match (e.g. "Understanding Fractions" -> a real NCERT
// "Fractions" chapter) scored 0.46-0.63; a merely-adjacent chapter (e.g.
// "Whole Numbers" -> chapters about negative numbers / prime factorisation)
// topped out at 0.32-0.38. Qdrant's own "strict_topic" mode is an exact
// string match on the topic payload, which essentially never matches a
// teacher's free-text topic title — the retrieval SCORE, not the
// strict/broad label, is the real precision signal here.
const MIN_TOPIC_MATCH_SCORE = 0.4;

// Real NCERT/vector retrieval, via the same production RAG pipeline AI Tutor
// uses (aivorah-ai-coach-service/services/rag.js) — not a second retrieval
// system. Returns null when retrieval is genuinely insufficient (no
// matching vector content above the existing score thresholds) so callers
// can explicitly fall back rather than fabricate grounding.
async function retrieveGroundingContext({ curriculum, grade, subject, topic, subtopics }) {
  const question = [topic, ...(subtopics || [])].filter(Boolean).join(', ');
  if (!question || !grade || !subject) return null;

  try {
    const res = await fetch(`${AI_COACH_SERVICE_URL}/curriculum-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Default to NCERT, not CBSE, when the uploaded document has no explicit
      // "Curriculum:" line — the only content ingested into Qdrant so far is
      // NCERT-tagged (confirmed: aivorah-ai-coach-service/services/rag.js hardcodes
      // curriculum: 'NCERT' for its own NCERT-image lookups). "CBSE" filters
      // against a curriculum tag with little/no matching Qdrant content, which
      // silently degraded real topics (e.g. "Whole Numbers") below the grounding
      // score threshold even though a strong NCERT match existed.
      body: JSON.stringify({ question, curriculum: curriculum || 'NCERT', grade, subject, topic }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.context || !data.meta || !data.meta.selected) return null;

    const topScore = Math.max(0, ...(data.sources || []).map((s) => s.score || 0));
    if (topScore < MIN_TOPIC_MATCH_SCORE) return null;

    return data;
  } catch (err) {
    console.error('[groundedContent] retrieval failed:', err.message);
    return null;
  }
}

module.exports = { retrieveGroundingContext, AI_COACH_SERVICE_URL };
