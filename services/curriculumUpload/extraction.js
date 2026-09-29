const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

class CurriculumExtractionError extends Error {}

// Text of one PDF page as lines; table rows keep their cells apart with tabs. Once a header row with a "Topic"
// column is seen, later rows are laid out on that header's columns (a cell that wraps onto a second line joins its
// row), so a curriculum table survives extraction instead of running every cell together.
const SAME_LINE_PX = 2;
const CELL_GAP_PX = 2;
function pageLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= SAME_LINE_PX);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, end: x + (it.width || 0), str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);

  const out = [];
  let columns = null;
  for (const row of rows) {
    const items = row.items.sort((a, b) => a.x - b.x);
    // Split the row into cells wherever a new item does not continue the previous one.
    const cells = [];
    for (const it of items) {
      const prev = cells[cells.length - 1];
      if (prev && it.x - prev.end <= CELL_GAP_PX && it.x >= prev.end - 0.5) {
        prev.text += it.str;
        prev.end = it.end;
      } else {
        cells.push({ x: it.x, end: it.end, text: it.str });
      }
    }
    const texts = cells.map((c) => c.text.trim());
    if (texts.some((t) => /^topics?$/i.test(t)) && cells.length > 1) {
      columns = cells.map((c) => c.x);
      out.push(texts.join('\t'));
      continue;
    }
    if (columns && cells.length > 1 && cells[0].x >= columns[0] - 4) {
      const aligned = columns.map(() => '');
      for (const c of cells) {
        let col = 0;
        columns.forEach((cx, i) => { if (c.x >= cx - 4) col = i; });
        aligned[col] = aligned[col] ? `${aligned[col]} ${c.text.trim()}` : c.text.trim();
      }
      out.push(aligned.join('\t'));
      continue;
    }
    if (columns && cells.length === 1 && cells[0].x > columns[0] + 4 && out.length) {
      // A wrapped cell continuing on its own line: attach it to the column it sits in on the previous row.
      let col = 0;
      columns.forEach((cx, i) => { if (cells[0].x >= cx - 4) col = i; });
      const prev = out[out.length - 1].split('\t');
      if (prev.length === columns.length) {
        prev[col] = prev[col] ? `${prev[col]} ${texts[0]}` : texts[0];
        out[out.length - 1] = prev.join('\t');
        continue;
      }
    }
    columns = null;
    out.push(texts.join(' ').replace(/\s+/g, ' ').trim());
  }
  return out.join('\n');
}

async function extractPdf(buffer) {
  let result;
  try {
    result = await pdfParse(buffer, {
      pagerender: async (page) => pageLines((await page.getTextContent()).items),
    });
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse PDF: ${err.message}`);
  }
  return { format: 'pdf', text: (result.text || '').trim(), pageCount: result.numpages };
}

const decodeEntities = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (s) => decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Word: paragraphs, headings and list items become lines; each table row becomes one tab-separated line.
function docxHtmlToText(html) {
  const lines = [];
  const re = /<table[\s\S]*?<\/table>|<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].toLowerCase().startsWith('<table')) {
      for (const row of m[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
        const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
        if (cells.some(Boolean)) lines.push(cells.join('\t'));
      }
    } else {
      const text = stripTags(m[2]);
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

async function extractDocx(buffer) {
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    const text = docxHtmlToText(html || '');
    if (text) return { format: 'docx', text };
  } catch {
    // fall back to plain text below
  }
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse DOCX: ${err.message}`);
  }
  return { format: 'docx', text: (result.value || '').trim() };
}

function extractXlsx(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse XLSX: ${err.message}`);
  }
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new CurriculumExtractionError('XLSX file contains no sheets');
  }
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false }),
  }));
  return { format: 'xlsx', sheets };
}

async function extractCurriculumContent(buffer, mimeType) {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdf(buffer);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return extractXlsx(buffer);
    default:
      throw new CurriculumExtractionError(`Unsupported mimetype for extraction: ${mimeType}`);
  }
}

function isExtractionEmpty(extracted) {
  if (extracted.format === 'xlsx') {
    return !extracted.sheets.some((sheet) =>
      sheet.rows.some((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    );
  }
  return !extracted.text || extracted.text.trim().length === 0;
}

module.exports = { extractCurriculumContent, isExtractionEmpty, CurriculumExtractionError, pageLines, docxHtmlToText };
