// Discover stage: index pages → year pages → PDF links. cisce.org builds its
// pages with Elementor, so PDF links appear both as plain hrefs and inside
// data-ra-element-link JSON attributes; both are read.
const { PROGRAMME_GRADES } = require('./constants');
const { sourceIdFor } = require('./ids');
const { upsertSource } = require('./registry');

const ENTITIES = { '&quot;': '"', '&#34;': '"', '&#039;': "'", '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#038;': '&', '&amp;': '&' };
const decodeEntities = (s) => String(s).replace(/&(quot|#34|#039|#39|apos|lt|gt|#038|amp);/g, (m) => ENTITIES[m]);

function resolveUrl(href, base) {
  try {
    const u = new URL(decodeEntities(href).trim(), base);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// Every string value under any "url"/"link" key in a parsed JSON blob.
function urlsInJson(node, out = []) {
  if (typeof node === 'string') { if (/^(https?:)?\/\//.test(node) || node.startsWith('/')) out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((n) => urlsInJson(n, out)); return out; }
  if (node && typeof node === 'object') Object.values(node).forEach((v) => urlsInJson(v, out));
  return out;
}

/** All links on a page: [{ url, text }], de-duplicated, resolved against baseUrl. */
function extractLinks(html, baseUrl) {
  const found = new Map();
  const add = (href, text = '') => {
    const url = resolveUrl(href, baseUrl);
    if (url && !found.has(url)) found.set(url, { url, text: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  };
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) add(m[2], decodeEntities(m[3]));
  for (const m of html.matchAll(/\bdata-ra-element-link\s*=\s*(["'])(.*?)\1/gi)) {
    const raw = decodeEntities(m[2]);
    let urls;
    try {
      urls = urlsInJson(JSON.parse(raw));
    } catch {
      urls = raw.match(/https?:\\?\/\\?\/[^"'\s]+/g) || [];
    }
    urls.forEach((u) => add(u.replace(/\\\//g, '/')));
  }
  return [...found.values()];
}

const isPdfUrl = (url) => /\.pdf$/i.test(new URL(url).pathname);

// "/regulations-and-syllabus-isc-2026-revised/" → { programme: 'ISC', examYear: 2026, revised: true }
function parseYearPageUrl(url) {
  const m = new URL(url).pathname.match(/regulations?-and-syllabus(?:es)?-(icse|isc)-(\d{4})(-revised)?\/?$/i);
  if (!m) return null;
  return { programme: m[1].toUpperCase(), examYear: parseInt(m[2], 10), revised: !!m[3] };
}

/** Classifies a PDF link from its file name — no network, no guessing beyond the name. */
function classifyPdf(url, { programme, examYear, version, linkText } = {}) {
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
  const name = file.replace(/^\d+[.)]?[-_\s]*/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const label = (linkText && linkText.length > 2 && !/^(download|view|click here)$/i.test(linkText)) ? linkText : name;
  let kind = 'SYLLABUS_PDF';
  if (/amendment/i.test(name)) kind = 'AMENDMENT_CIRCULAR';
  else if (/regulation/i.test(name)) kind = 'REGULATIONS_PDF';
  else if (/curriculum|framework/i.test(name)) kind = 'FRAMEWORK_PDF';
  else if (/notice|circular|revised syllabus/i.test(name)) kind = 'NOTICE_PDF';
  return {
    kind,
    programme: programme || 'CISCE',
    exam_year: examYear || null,
    version: version || null,
    subject: kind === 'SYLLABUS_PDF' ? name : null,
    title: [programme, examYear, '—', label].filter(Boolean).join(' '),
    grades: kind === 'SYLLABUS_PDF' ? (PROGRAMME_GRADES[programme] || []) : [],
  };
}

function markPage(source, res, when) {
  Object.assign(source, {
    http_status: res.status,
    final_url: res.finalUrl,
    content_type: res.contentType,
    checked_at: when,
    checked_from: 'local-cli',
    link_status: res.ok ? 'VERIFIED' : (res.status === 404 || res.status === 410) ? 'DEAD' : 'UNREACHABLE',
  });
}

/**
 * Walks INDEX_PAGE → YEAR_PAGE → PDFs and PUBLICATION_PAGE → PDFs, adding
 * every new link to the registry. Returns { added, pages } for the run log.
 */
async function discover(registry, http, { log = () => {}, now = () => new Date().toISOString(), only } = {}) {
  const added = [];
  const pageResults = [];
  const fetchPage = async (source) => {
    const res = await http.get(source.url);
    markPage(source, res, now());
    pageResults.push({ id: source.id, status: res.status });
    log(`discover ${source.id}: HTTP ${res.status}`);
    return res.ok ? res.body.toString('utf8') : null;
  };
  const add = (s) => {
    const before = registry.sources.length;
    const src = upsertSource(registry, s);
    if (registry.sources.length > before) added.push(src.id);
    return src;
  };

  // 1. Index pages → year pages.
  for (const index of registry.sources.filter((s) => s.kind === 'INDEX_PAGE' && s.link_status !== 'DEAD')) {
    const html = await fetchPage(index);
    if (!html) continue;
    for (const link of extractLinks(html, index.url)) {
      const y = parseYearPageUrl(link.url);
      if (!y || y.programme !== index.programme) continue;
      add({
        id: `${y.programme.toLowerCase()}-${y.examYear}${y.revised ? '-revised' : ''}-page`,
        url: link.url, kind: 'YEAR_PAGE', programme: y.programme, exam_year: y.examYear,
        version: `${y.programme.toLowerCase()}-${y.examYear}${y.revised ? '-revised' : ''}`,
        title: link.text || null, discovered_from: index.id,
      });
    }
  }

  // The newest non-revised exam year per programme is the primary version.
  const newest = {};
  for (const s of registry.sources.filter((x) => x.kind === 'YEAR_PAGE' && !/revised/.test(x.version || ''))) {
    newest[s.programme] = Math.max(newest[s.programme] || 0, s.exam_year || 0);
  }
  for (const s of registry.sources.filter((x) => x.kind === 'YEAR_PAGE')) {
    s.is_primary_version = s.exam_year === newest[s.programme] && !/revised/.test(s.version || '');
  }

  // 2. Year / publication pages → PDFs.
  const pages = registry.sources.filter((s) => ['YEAR_PAGE', 'PUBLICATION_PAGE'].includes(s.kind) && s.link_status !== 'DEAD')
    .filter((s) => !only || only.includes(s.id));
  for (const page of pages) {
    const html = await fetchPage(page);
    if (!html) continue;
    for (const link of extractLinks(html, page.url)) {
      if (!isPdfUrl(link.url)) continue;
      const host = new URL(link.url).hostname.replace(/^www\./, '');
      if (host !== 'cisce.org') continue;
      const c = classifyPdf(link.url, { programme: page.kind === 'YEAR_PAGE' ? page.programme : null, examYear: page.exam_year, version: page.version, linkText: link.text });
      add({
        ...c,
        id: sourceIdFor({ url: link.url, programme: c.programme, examYear: c.exam_year, name: c.subject || c.kind }),
        url: link.url,
        is_primary_version: !!page.is_primary_version,
        discovered_from: page.id,
      });
    }
  }
  return { added, pages: pageResults };
}

module.exports = { discover, extractLinks, classifyPdf, parseYearPageUrl, decodeEntities, isPdfUrl };
