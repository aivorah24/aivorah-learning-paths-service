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
        const text = pageLines((await page.getTextContent()).items, { isHeaderRow, columnGapPx: COLUMN_GAP_PX });
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
