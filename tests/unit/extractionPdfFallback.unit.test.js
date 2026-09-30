// A real table PDF made with ReportLab: the default pdf.js rejects it ("bad XRef entry"); it must still be read.
const fs = require('fs');
const path = require('path');
const { extractCurriculumContent } = require('../../services/curriculumUpload/extraction');

test('a PDF the default reader rejects is read with the newer one, keeping the table rows', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'reportlab-table.pdf'));
  const out = await extractCurriculumContent(buffer, 'application/pdf');
  expect(out.format).toBe('pdf');
  expect(out.text).toMatch(/Grade 8 Social Science Syllabus/);
  expect(out.text).toMatch(/The Rise of the Marathas/);
  expect(out.text).toMatch(/Factors of Production/);
});

test('a file that is not a PDF at all still fails clearly', async () => {
  await expect(extractCurriculumContent(Buffer.from('%PDF-1.4 not really'), 'application/pdf')).rejects.toThrow(/Failed to parse PDF/);
});

test('a table whose header says "Chapter / Topic" keeps each row whole, with wrapped cells joined in their own column', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'reportlab-table.pdf'));
  const lines = (await extractCurriculumContent(buffer, 'application/pdf')).text.split('\n');
  expect(lines).toContain('Unit\tChapter / Topic\tSub-topics\tLearning Outcomes\tPeriods');
  expect(lines).toContain('Civics\tUniversal Franchise and India’s Electoral System\tRight to vote; Election Commission; How elections are held\tExplains how Indian elections work\t5');
  expect(lines).toContain('Geography\tNatural Resources and Their Use\tTypes of resources; Renewable and non-renewable; Sustainable use\tClassifies resources and suggests ways to conserve them\t6');
});
