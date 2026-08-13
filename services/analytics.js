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

// ── Read all events from Supabase (camelCase) ────────────────────────────────
async function readEvents(filters = {}) {
  try {
    let query = supabase
      .from('analytics_events')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(filters.limit || 5000);

    if (filters.userEmail) query = query.eq('user_email', normalizeEmail(filters.userEmail));
    if (filters.eventType) query = query.eq('event_type', filters.eventType);

    const { data, error } = await query;
    if (error) throw error;

    return (data ?? []).map(mapRow);
  } catch (err) {
    console.error('[analytics] readEvents error:', err?.message);
    return [];
  }
}

function mapRow(e) {
  return {
    id:        e.id,
    eventType: e.event_type,
    timestamp: e.timestamp,
    userEmail: e.user_email,
    role:      e.role      || '',
    source:    e.source    || '',
    page:      e.page      || '',
    path:      e.path      || '',
    status:    e.status    || '',
    latencyMs: e.latency_ms,
    model:     e.model     || '',
    topic:     e.topic     || '',
    subject:   e.subject   || '',
    grade:     e.grade     || '',
    score:     e.score,
    comment:   e.comment   || '',
    meta:      e.meta      || {},
  };
}

// ── Summarize (unchanged logic, works on camelCase rows) ─────────────────────
function summarizeEvents(events) {
  const aiEvents       = events.filter((e) => String(e.eventType || '').startsWith('ai_'));
  const feedbackEvents = events.filter((e) => e.eventType === 'ai_feedback');
  const accessEvents   = events.filter((e) => e.eventType === 'app_access' || e.eventType === 'page_view');

  const usersMap = {};
  for (const e of accessEvents) {
    if (!e.userEmail) continue;
    const prev = usersMap[e.userEmail];
    if (!prev || prev.lastSeen < e.timestamp) {
      usersMap[e.userEmail] = { email: e.userEmail, role: e.role || '', lastSeen: e.timestamp };
    }
  }

  const endpointMetrics = {};
  for (const e of aiEvents) {
    const key = e.eventType;
    if (!endpointMetrics[key]) {
      endpointMetrics[key] = { total: 0, success: 0, failed: 0, totalLatencyMs: 0, samples: 0 };
    }
    endpointMetrics[key].total += 1;
    if (e.status === 'success') endpointMetrics[key].success += 1;
    if (e.status === 'error')   endpointMetrics[key].failed  += 1;
    if (typeof e.latencyMs === 'number') {
      endpointMetrics[key].totalLatencyMs += e.latencyMs;
      endpointMetrics[key].samples        += 1;
    }
  }

  const aiMetrics = Object.entries(endpointMetrics).map(([eventType, m]) => ({
    eventType,
    total:        m.total,
    success:      m.success,
    failed:       m.failed,
    avgLatencyMs: m.samples > 0 ? Math.round(m.totalLatencyMs / m.samples) : null,
  }));

  const feedbackBreakdown = {
    total:    feedbackEvents.length,
    positive: feedbackEvents.filter((e) => e.score != null && e.score >= 4).length,
    neutral:  feedbackEvents.filter((e) => e.score != null && e.score === 3).length,
    negative: feedbackEvents.filter((e) => e.score != null && e.score <= 2).length,
  };

  const recentFeedback = feedbackEvents
    .slice()
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, 20)
    .map(e => ({
      userEmail: e.userEmail || '',
      role:      e.role      || '',
      source:    e.source    || '',
      topic:     e.topic     || '',
      subject:   e.subject   || '',
      score:     e.score     ?? null,
      comment:   e.comment   || '',
      timestamp: e.timestamp || '',
    }));

  return {
    totalEvents:   events.length,
    accessCount:   accessEvents.length,
    uniqueUsers:   Object.keys(usersMap).length,
    usersLastSeen: Object.values(usersMap).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))),
    aiMetrics,
    feedback:      feedbackBreakdown,
    recentFeedback,
  };
}

module.exports = { logEvent, readEvents, summarizeEvents };
