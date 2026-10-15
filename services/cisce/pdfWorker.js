// Child process for PDF parsing. pdf-parse's bundled pdf.js can leave
// unhandled promise rejections behind on malformed files (which would kill
// the parent on Node ≥15) or hang; isolating each parse in its own process
// means a bad PDF fails only itself. Used by services/cisce/pdf.js.
const pdfParse = require('pdf-parse');
const { pageLines, isDefaultHeaderRow } = require('../curriculumUpload/extraction');

// CISCE frameworks also lay tables out with the classes as columns.
const CLASS_CELL = /^\s*class(es)?\s*[-–:]?\s*([ivx]{1,4}|\d{1,2})\s*$/i;
// Wider than any word space at body text sizes, narrower than a table's column gutter.
const COLUMN_GAP_PX = 12;
const isHeaderRow = (texts) => isDefaultHeaderRow(texts) || texts.filter((t) => CLASS_CELL.test(t)).length >= 2;

// Two-column pages (e.g. ISC syllabuses) are read left column then right;
// otherwise pageLines joins both columns into one line per row and headings
// in the right column are lost. Detected by an empty gutter near the middle
// that almost no text crosses, with real text on both sides.
function splitColumns(items, pageWidth) {
  const text = items.filter((it) => it.str && it.str.trim());
  if (!pageWidth || text.length < 20) return null;
  const x = (it) => it.transform[4];
  for (const frac of [0.5, 0.48, 0.52, 0.46, 0.54]) {
    const mid = pageWidth * frac;
    const crossing = text.filter((it) => x(it) < mid - 2 && x(it) + (it.width || 0) > mid + 2).length;
    const left = text.filter((it) => x(it) + (it.width || 0) <= mid + 2);
    const right = text.filter((it) => x(it) >= mid - 2);
    const chars = (arr) => arr.reduce((n, it) => n + it.str.length, 0);
    const total = chars(text);
    if (crossing / text.length < 0.03 && chars(left) > total * 0.25 && chars(right) > total * 0.25) {
      return [items.filter((it) => x(it) < mid), items.filter((it) => x(it) >= mid)];
    }
  }
  return null;
}

// Newer bundled pdf.js — same fallback extraction.js uses for PDFs the default rejects.
const PDF_FALLBACK_VERSION = 'v2.0.550';

process.on('unhandledRejection', () => {});

// pdf.js often fails a damaged-xref file on the first attempt and succeeds
// once it has rebuilt the xref, so a few attempts are made before giving up.
async function parsePages(buffer, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const pages = [];
    const options = {
      pagerender: async (page) => {
        const { items } = await page.getTextContent();
        const opts = { isHeaderRow, columnGapPx: COLUMN_GAP_PX };
        const cols = splitColumns(items, page.view ? page.view[2] - page.view[0] : 0);
        const text = cols ? cols.map((c) => pageLines(c, opts)).join('\n') : pageLines(items, opts);
        pages.push(text);
        return text;
      },
    };
    if (i === attempts - 1) options.version = PDF_FALLBACK_VERSION;
    try {
      const result = await pdfParse(Buffer.from(buffer), options);
      return { pageCount: result.numpages, pages };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`unparseable PDF: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

process.on('message', async ({ base64 }) => {
  try {
    process.send({ ok: true, ...(await parsePages(Buffer.from(base64, 'base64'))) }, () => process.exit(0));
  } catch (err) {
    process.send({ ok: false, error: err.message }, () => process.exit(0));
  }
});
