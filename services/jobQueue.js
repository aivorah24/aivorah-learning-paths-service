const crypto = require('crypto');
const supabase = require('./supabase');

const DRIVER = (process.env.QUEUE_DRIVER || 'db').toLowerCase();
const TOPIC = process.env.KAFKA_TOPIC || 'uploads';

const handlers = new Map();
// Optional prefix so a local run never shares job types with the deployed worker polling the same table.
const JOB_NAMESPACE = process.env.JOB_NAMESPACE || '';

function registerHandler(type, fn) { handlers.set(`${JOB_NAMESPACE}${type}`, fn); }

let _kafka = null, _producer = null, _producerPromise = null;
function getKafka() {
  if (_kafka) return _kafka;
  const { Kafka } = require('kafkajs');
  _kafka = new Kafka({
    clientId: 'aivorah',
    brokers: (process.env.KAFKA_BROKERS || '').split(',').map(s => s.trim()).filter(Boolean),
    ssl: process.env.KAFKA_SSL !== 'false',
    sasl: process.env.KAFKA_USERNAME ? {
      mechanism: process.env.KAFKA_SASL_MECHANISM || 'plain',
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
    } : undefined,
  });
  return _kafka;
}
async function getProducer() {
  if (_producer) return _producer;
  if (!_producerPromise) {
    _producerPromise = (async () => {
      const producer = getKafka().producer();
      await producer.connect();
      _producer = producer;
      return producer;
    })();
  }
  return _producerPromise;
}

async function publishJob(baseType, payload = {}) {
  const id = crypto.randomUUID();
  const type = `${JOB_NAMESPACE}${baseType}`;
  const { error } = await supabase.from('upload_jobs').insert({ id, type, payload, status: 'pending' });
  if (error) throw new Error(`[jobQueue] enqueue failed (${error.message})`);
  if (DRIVER === 'kafka') {
    const producer = await getProducer();
    await producer.send({ topic: TOPIC, messages: [{ key: id, value: JSON.stringify({ jobId: id, type }) }] });
  }
  return { jobId: id };
}

async function processJobById(id) {
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from('upload_jobs')
    .update({ status: 'processing', locked_at: now, updated_at: now })
    .eq('id', id).eq('status', 'pending')
    .select();
  if (!claimed || claimed.length === 0) return false;

  const job = claimed[0];
  try {
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
    const result = await handler(job.payload, job);
    await supabase.from('upload_jobs')
      .update({ status: 'done', result: result ?? null, updated_at: new Date().toISOString() })
      .eq('id', id);
    return true;
  } catch (err) {
    await supabase.from('upload_jobs')
      .update({ status: 'failed', error: String(err?.message || err), updated_at: new Date().toISOString() })
      .eq('id', id);
    console.error(`[jobQueue] job ${id} (${job.type}) failed:`, err?.message || err);
    return false;
  }
}

// A job still 'processing' this long after it was claimed lost its worker (restart/crash) — put it back in the queue.
const STALE_LOCK_MS = 15 * 60 * 1000;

async function reclaimStaleJobs(knownTypes) {
  if (!knownTypes.length) return;
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  await supabase.from('upload_jobs')
    .update({ status: 'pending', locked_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'processing').lt('locked_at', cutoff).in('type', knownTypes);
}

async function runWorkerOnce(limit = 5) {
  // This service and aivorah-assignments-service share the same Supabase
  // upload_jobs table; scoping the poll to registered types avoids both
  // instances racing to claim job types they can't handle.
  const knownTypes = [...handlers.keys()];
  await reclaimStaleJobs(knownTypes).catch((err) => console.error('[jobQueue] reclaim failed:', err.message));
  let query = supabase
    .from('upload_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (knownTypes.length > 0) query = query.in('type', knownTypes);
  const { data: pending, error } = await query;
  if (error) throw new Error(`[jobQueue] drain failed (${error.message})`);
  let processed = 0;
  for (const row of (pending || [])) {
    if (await processJobById(row.id)) processed++;
  }
  return { claimed: (pending || []).length, processed };
}

async function startConsumer() {
  if (DRIVER !== 'kafka') return;
  const consumer = getKafka().consumer({ groupId: process.env.KAFKA_GROUP_ID || 'aivorah-workers' });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const { jobId } = JSON.parse(message.value.toString());
        if (jobId) await processJobById(jobId);
      } catch (err) {
        console.error('[jobQueue] bad message:', err?.message || err);
      }
    },
  });
}

async function getJob(id) {
  const { data } = await supabase.from('upload_jobs').select('*').eq('id', id).maybeSingle();
  return data || null;
}

module.exports = { DRIVER, publishJob, registerHandler, runWorkerOnce, processJobById, startConsumer, getJob };
