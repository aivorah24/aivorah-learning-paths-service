const crypto  = require('crypto');
const supabase = require('./supabase');

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

// ── Write event to Supabase ──────────────────────────────────────────────────
async function logEvent(eventType, payload = {}) {
  try {
    const record = {
      id:         crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      event_type: eventType,
      timestamp:  new Date().toISOString(),
      user_email: normalizeEmail(payload.userEmail),
      role:       payload.role       || '',
      source:     payload.source     || '',
      page:       payload.page       || '',
      path:       payload.path       || '',
      status:     payload.status     || '',
      latency_ms: typeof payload.latencyMs === 'number' ? payload.latencyMs : null,
      model:      payload.model      || '',
      topic:      payload.topic      || '',
      subject:    payload.subject    || '',
      grade:      payload.grade      || '',
      score:      typeof payload.score === 'number' ? payload.score : null,
      comment:    payload.comment    || '',
      meta:       payload.meta       || {},
    };

    const { error } = await supabase.from('analytics_events').insert(record);
    if (error) throw error;

    // return camelCase shape so callers stay compatible
    return {
      id:        record.id,
      eventType: record.event_type,
      timestamp: record.timestamp,
      userEmail: record.user_email,
      role:      record.role,
      source:    record.source,
      page:      record.page,
      path:      record.path,
      status:    record.status,
      latencyMs: record.latency_ms,
      model:     record.model,
      topic:     record.topic,
      subject:   record.subject,
      grade:     record.grade,
      score:     record.score,
      comment:   record.comment,
      meta:      record.meta,
    };
  } catch (err) {
    console.error('[analytics] logEvent error:', err?.message);
    return null;
  }
}

module.exports = {
  logEvent,
  // Exported for direct unit testing — pure helper, no behavior change.
  normalizeEmail,
};
