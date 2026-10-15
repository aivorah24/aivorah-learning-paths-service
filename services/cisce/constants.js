/**
 * services/cisce/constants.js
 * Shared constants for the official CISCE curriculum pipeline
 * (scripts/cisce-ingest.cjs). Official data lives in its own namespace —
 * curriculum_id "cisce", Supabase cisce_* tables, Qdrant CISCE_COLLECTION —
 * and never in the CBSE/NCERT, IB or Cambridge stores.
 */
const { classLabel } = require('../boardSyllabus');
const { IB_COLLECTION, NCERT_COLLECTION } = require('../qdrant');

const CURRICULUM_ID = 'cisce';
const BOARD = 'CISCE';
const PIPELINE_VERSION = 1;

// A separate collection, not a namespaced payload in ai_mentor_content:
// boardSyllabus.js already scrolls ai_mentor_content by curriculum "ICSE", so
// official points there would silently merge with the AI-generated outline.
const CISCE_COLLECTION = 'cisce_curriculum_v1';
const PROTECTED_COLLECTIONS = [IB_COLLECTION, NCERT_COLLECTION, 'school_quizzes'];

// Same model the monolith used for ai_mentor_content (Xenova/all-MiniLM-L6-v2),
// so any consumer that already embeds queries with it can search this collection.
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_SIZE = 384;

// cisce.org answers 403 to bot user agents.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MIN_REQUEST_INTERVAL_MS = 1000;

// Preschool, then Class I..Class XII — labels built by boardSyllabus.classLabel.
const PRESCHOOL = 'Preschool';
const GRADE_LABELS = [PRESCHOOL, ...Array.from({ length: 12 }, (_, i) => classLabel(i + 1))];
const gradeNumberOf = (label) => (label === PRESCHOOL ? 0 : GRADE_LABELS.indexOf(label));
const studentGradeOf = (label) => (label === PRESCHOOL ? PRESCHOOL : `Grade ${gradeNumberOf(label)}`);

const PROGRAMME_GRADES = {
  ICSE: [classLabel(9), classLabel(10)],
  ISC: [classLabel(11), classLabel(12)],
};

const LINK_STATUS = ['UNVERIFIED', 'VERIFIED', 'DEAD', 'UNREACHABLE', 'INVALID_PDF', 'AWAITING_SOURCE'];
const PROVENANCE = { VERIFIED_OFFICIAL: 'VERIFIED_OFFICIAL', OFFICIAL_PARTIAL: 'OFFICIAL_PARTIAL' };
const COVERAGE_STATUS = ['VERIFIED_OFFICIAL', 'OFFICIAL_PARTIAL', 'SUPPLEMENTARY_ONLY', 'AWAITING_SOURCE', 'EXTRACTION_FAILED'];
const FRAMEWORK_SUBJECT = 'All subjects (framework)';

// Supabase project refs. Writes go to Dev only; Test/Prod refs are always refused.
const DEV_SUPABASE_REF = 'evlqkcozespsfrnuhevf';
const REFUSED_SUPABASE_REFS = [
  'xmwzifxlpmgsrxgxsgan', // Test
  // Refs listed in the aivorah-db README (aivorah-dev/test/prod) — never a target for this pipeline.
  'ernsrofvmszhmfhxeehx', 'vgqrrseziwnljkencqpy', 'jwlepxmclbkrmfzrumch',
];

const STAGES = ['discover', 'download', 'extract', 'normalise', 'validate', 'persist', 'index'];

module.exports = {
  CURRICULUM_ID, BOARD, PIPELINE_VERSION, CISCE_COLLECTION, PROTECTED_COLLECTIONS, EMBEDDING_MODEL, VECTOR_SIZE,
  BROWSER_UA, MIN_REQUEST_INTERVAL_MS, PRESCHOOL, GRADE_LABELS, gradeNumberOf, studentGradeOf, PROGRAMME_GRADES,
  LINK_STATUS, PROVENANCE, COVERAGE_STATUS, FRAMEWORK_SUBJECT, DEV_SUPABASE_REF, REFUSED_SUPABASE_REFS, STAGES,
};
