/**
 * Coverage report: Preschool–Class XII × subject, one status per cell.
 *
 *   VERIFIED_OFFICIAL  official source verified, every page read, unit + topic structure found
 *   OFFICIAL_PARTIAL   official source, but framework text only / structure missing / pages unread
 *   EXTRACTION_FAILED  an official source is registered but could not be downloaded, validated or parsed
 *   SUPPLEMENTARY_ONLY no official data; only the existing AI-generated ICSE outline (monolith import)
 *   AWAITING_SOURCE    nothing official yet
 *
 * Built only from what the pipeline actually extracted. Gaps stay gaps.
 */
const { GRADE_LABELS, FRAMEWORK_SUBJECT, PROGRAMME_GRADES } = require('./constants');
const { gradeNumber, classLabel } = require('../boardSyllabus');

const ALL = 'All subjects';
const RANK = { VERIFIED_OFFICIAL: 5, OFFICIAL_PARTIAL: 4, EXTRACTION_FAILED: 3, SUPPLEMENTARY_ONLY: 2, AWAITING_SOURCE: 1 };

// "Class II" | "Grade 2" | "2" → "Class II" (via boardSyllabus).
const toLabel = (grade) => (/^pre/i.test(String(grade)) ? 'Preschool' : classLabel(gradeNumber(grade)));

/**
 * @param {object} args
 * @param {object[]} args.documents  canonical documents that passed validation
 * @param {object[]} args.registry   registry.sources
 * @param {Record<string,{stage:string,reason:string}>} [args.failures] source id → failure
 * @param {{grade:string,subject:string,chapters:number}[]|null} [args.supplementary] rows from icse_supplementary_content, or null if not checked
 */
function buildCoverage({ documents = [], registry = [], failures = {}, supplementary = null }) {
  const cells = new Map();
  const cell = (grade, subject) => {
    const key = `${grade}\u0000${subject.toLowerCase()}`;
    if (!cells.has(key)) cells.set(key, { grade_label: grade, subject, status: 'AWAITING_SOURCE', source_ids: [], unit_count: 0, topic_count: 0, notes: [] });
    return cells.get(key);
  };
  const raise = (c, status) => { if (RANK[status] > RANK[c.status]) c.status = status; };

  for (const doc of documents) {
    for (const g of doc.grades) {
      const c = cell(g.grade_label, doc.subject);
      raise(c, doc.provenance_status);
      if (!c.source_ids.includes(doc.source.source_id)) c.source_ids.push(doc.source.source_id);
      c.unit_count += g.nodes.filter((n) => n.level === 'UNIT').length;
      c.topic_count += g.nodes.filter((n) => n.level === 'TOPIC').length;
      if (doc.subject === FRAMEWORK_SUBJECT) c.notes.push('framework only, no chapters');
    }
  }

  // Registered syllabus PDFs on the primary version that failed somewhere.
  for (const s of registry.filter((x) => x.kind === 'SYLLABUS_PDF' && x.subject)) {
    const failed = failures[s.id] || (['DEAD', 'INVALID_PDF', 'UNREACHABLE'].includes(s.link_status) ? { stage: 'download', reason: s.link_status } : null);
    for (const g of s.grades?.length ? s.grades : PROGRAMME_GRADES[s.programme] || []) {
      const c = cell(g, s.subject);
      if (failed && s.is_primary_version) {
        raise(c, 'EXTRACTION_FAILED');
        c.notes.push(`${s.id}: ${failed.stage} failed (${failed.reason})`);
      } else if (!c.source_ids.length && s.is_primary_version) {
        c.notes.push(`${s.id}: registered, not extracted yet`);
      }
    }
  }

  if (supplementary) {
    for (const row of supplementary) {
      const label = toLabel(row.grade);
      if (!label) continue;
      const c = cell(label, row.subject);
      raise(c, 'SUPPLEMENTARY_ONLY');
      c.notes.push(`AI-generated ICSE outline present (${row.chapters} chapter(s)) — supplementary only`);
    }
  }

  // Every grade gets at least one row.
  for (const g of GRADE_LABELS) {
    if (![...cells.values()].some((c) => c.grade_label === g)) cell(g, ALL).notes.push('no official source extracted for this grade');
  }

  const rows = [...cells.values()]
    .map((c) => ({ ...c, notes: [...new Set(c.notes)].join('; ') || null }))
    .sort((a, b) => GRADE_LABELS.indexOf(a.grade_label) - GRADE_LABELS.indexOf(b.grade_label) || a.subject.localeCompare(b.subject));

  const summary = {};
  for (const r of rows) {
    summary[r.grade_label] ||= { VERIFIED_OFFICIAL: 0, OFFICIAL_PARTIAL: 0, EXTRACTION_FAILED: 0, SUPPLEMENTARY_ONLY: 0, AWAITING_SOURCE: 0 };
    summary[r.grade_label][r.status]++;
  }
  return { rows, summary, supplementary_checked: supplementary !== null };
}

function coverageMarkdown(report, { title = 'CISCE coverage', generatedAt = new Date().toISOString(), context = [] } = {}) {
  const statuses = Object.keys(RANK).sort((a, b) => RANK[b] - RANK[a]);
  const lines = [`# ${title}`, '', `Generated ${generatedAt}.`, ...context.map((c) => `- ${c}`), ''];
  if (!report.supplementary_checked) lines.push('Existing AI-generated ICSE rows were **not checked** (no DB access for this run); SUPPLEMENTARY_ONLY cannot appear.', '');
  lines.push('## Summary (cells per status)', '', `| Grade | ${statuses.join(' | ')} |`, `|---|${statuses.map(() => '---').join('|')}|`);
  for (const g of GRADE_LABELS) lines.push(`| ${g} | ${statuses.map((s) => report.summary[g]?.[s] || 0).join(' | ')} |`);
  lines.push('', '## Cells', '', '| Grade | Subject | Status | Units | Topics | Sources | Notes |', '|---|---|---|---|---|---|---|');
  for (const r of report.rows) lines.push(`| ${r.grade_label} | ${r.subject} | ${r.status} | ${r.unit_count} | ${r.topic_count} | ${r.source_ids.join(', ')} | ${r.notes || ''} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = { buildCoverage, coverageMarkdown, toLabel };
