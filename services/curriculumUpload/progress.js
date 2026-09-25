const supabase = require('../supabase');

const STATUS_STAGE = { processing: 'extracting', generating: 'generating', generated: 'done', failed: 'failed' };

const makeProgress = (stage, topicsDone = null, topicsTotal = null) => ({
  stage, topicsDone, topicsTotal, updatedAt: new Date().toISOString(),
});

// Merges progress into the job payload; never throws (progress must not fail a job).
async function writeJobProgress(job, stage, topicsDone, topicsTotal) {
  if (!job?.id) return;
  try {
    job.payload = { ...job.payload, progress: makeProgress(stage, topicsDone, topicsTotal) };
    await supabase.from('upload_jobs').update({ payload: job.payload, updated_at: new Date().toISOString() }).eq('id', job.id);
  } catch (err) {
    console.error('[progress] write failed:', err.message);
  }
}

async function getProgress(curriculum) {
  const fallback = () => {
    const stage = STATUS_STAGE[curriculum.status];
    return stage ? { ...makeProgress(stage), updatedAt: curriculum.updated_at || new Date().toISOString() } : null;
  };
  if (curriculum.status === 'failed') return fallback();
  try {
    const { data } = await supabase.from('upload_jobs').select('payload, updated_at')
      .eq('payload->>curriculumId', curriculum.id).order('created_at', { ascending: false }).limit(1);
    const row = data?.[0];
    if (row?.payload?.progress) return { ...row.payload.progress };
  } catch (err) {
    console.error('[progress] read failed:', err.message);
  }
  return fallback();
}

module.exports = { writeJobProgress, getProgress };
