// Tables from aivorah-db migration 0008_read_aloud.sql.
const supabase = require('../supabase');

const HISTORY_LIMIT = 50;

async function getLevel(studentId) {
  const { data, error } = await supabase
    .from('read_aloud_levels')
    .select('lexile, history')
    .eq('student_id', studentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { lexile: data.lexile, history: data.history || [] } : null;
}

// Keeps the last 50 level changes alongside the current Lexile.
async function saveLevel(studentId, lexile, entry, previous) {
  const history = [...(previous?.history || []), { date: new Date().toISOString(), lexile, ...entry }].slice(-HISTORY_LIMIT);
  const { error } = await supabase
    .from('read_aloud_levels')
    .upsert({ student_id: studentId, lexile, history, updated_at: new Date().toISOString() }, { onConflict: 'student_id' });
  if (error) throw new Error(error.message);
  return { lexile, history };
}

async function addSession(studentId, session) {
  const { error } = await supabase.from('read_aloud_sessions').insert({
    student_id: studentId,
    topic: session.topic,
    grade: session.grade,
    accuracy: session.accuracy,
    wcpm: session.wcpm,
    level: session.level,
    total_words: session.totalWords,
    duration_seconds: session.duration,
    stars_earned: session.starsEarned,
    lexile: session.lexile,
  });
  if (error) throw new Error(error.message);
}

async function listSessions(studentId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from('read_aloud_sessions')
    .select('created_at, topic, grade, accuracy, wcpm, level, total_words, duration_seconds, stars_earned, lexile')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    date: r.created_at,
    topic: r.topic,
    grade: r.grade,
    accuracy: r.accuracy,
    wcpm: r.wcpm,
    level: r.level,
    totalWords: r.total_words,
    duration: r.duration_seconds,
    starsEarned: r.stars_earned,
    lexile: r.lexile,
  }));
}

module.exports = { getLevel, saveLevel, addSession, listSessions };
