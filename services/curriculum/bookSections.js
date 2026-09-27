const supabase = require('../supabase');

// Real, pre-built book sections (unit_content_sections for most subjects, math_tutor_sections for Maths) used as the
// topics of a unit, and looked up again by title when a student opens one.
const isMaths = (subject) => /math/i.test(String(subject || ''));
const gradeNo = (grade) => parseInt(String(grade || '').replace(/\D/g, ''), 10);

// pdfFile (lower-case) -> [{ no, title, page }] for the given unit PDFs.
async function sectionsByPdf(subject, pdfFiles) {
  const files = [...new Set(pdfFiles.filter(Boolean))];
  const out = new Map();
  if (!files.length) return out;
  const table = isMaths(subject) ? 'math_tutor_sections' : 'unit_content_sections';
  const { data, error } = await supabase.from(table).select('pdf_file, section_no, section_title, page_from').in('pdf_file', files).order('section_no');
  if (error || !data) return out;
  for (const r of data) {
    const key = String(r.pdf_file).toLowerCase();
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ no: r.section_no, title: r.section_title, page: r.page_from });
  }
  return out;
}

// Learn blocks for a Maths section, built from the tutor's own book examples.
function mathsLearnBlocks(t) {
  return [
    ...(t.intro ? [{ type: 'overview', text: t.intro }] : []),
    ...(t.keyIdea ? [{ type: 'key_points', items: [t.keyIdea] }] : []),
    ...(t.examples || []).map((e) => ({
      type: 'worked_example', problem: e.problem,
      steps: (e.steps || []).map((s) => ({ explanation: s.say, calculation: s.show || '' })),
      finalAnswer: e.answer,
    })),
  ];
}

// The section a student opened by its exact title, with everything the lesson needs; null when it is not a built section.
async function sectionByTitle(grade, subject, title) {
  const g = gradeNo(grade);
  if (!g || !title) return null;
  if (isMaths(subject)) {
    const { data } = await supabase.from('math_tutor_sections').select('pdf_file, section_title, page_from, tutor')
      .eq('grade', g).eq('section_title', title).limit(1);
    const r = data?.[0];
    if (!r) return null;
    return { pdfFile: r.pdf_file, pdfPage: r.page_from, section: r.section_title, lang: 'en',
      learn: { whatYoullLearn: r.tutor.keyIdea ? [r.tutor.keyIdea] : [], blocks: mathsLearnBlocks(r.tutor) }, listen: [], quiz: [], mathTutor: r.tutor };
  }
  const { data } = await supabase.from('unit_content_sections').select('pdf_file, section_title, page_from, lang, learn, listen, quiz')
    .eq('grade', g).eq('subject', subject).eq('section_title', title).limit(1);
  const r = data?.[0];
  if (!r) return null;
  return { pdfFile: r.pdf_file, pdfPage: r.page_from, section: r.section_title, lang: r.lang, learn: r.learn, listen: r.listen || [], quiz: r.quiz || [] };
}

module.exports = { sectionsByPdf, sectionByTitle, mathsLearnBlocks };
