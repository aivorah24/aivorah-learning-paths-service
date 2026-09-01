// Unit tests for resolveResourcesByTopicName() — Bug #8 (BUGS_AND_FIXES.md).
// Shapes Qdrant-resolved topic content into the same LearningResource array
// shape resolveAllResources() (the DB-id path) returns, so the frontend's
// useDbTopic parsing needs no special-casing between the two.

const mockResolveTopicContent = jest.fn();
jest.mock('../../services/qdrant', () => ({
  resolveTopicContent: (...args) => mockResolveTopicContent(...args),
}));
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { resolveResourcesByTopicName } = require('../../services/curriculum/resourceResolver');
const { RESOURCE_TYPES } = require('../../services/curriculum/types');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveResourcesByTopicName', () => {
  test('nothing found in Qdrant -> every resource type is a COMING_SOON placeholder', async () => {
    mockResolveTopicContent.mockResolvedValueOnce(null);
    const resources = await resolveResourcesByTopicName({ curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'Nonexistent Topic' });
    expect(resources).toHaveLength(RESOURCE_TYPES.length);
    expect(resources.every(r => r.status === 'COMING_SOON')).toBe(true);
  });

  test('a Qdrant hiccup degrades to placeholders, never a throw', async () => {
    mockResolveTopicContent.mockRejectedValueOnce(new Error('down'));
    const resources = await resolveResourcesByTopicName({ curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'X' });
    expect(resources.every(r => r.status === 'COMING_SOON')).toBe(true);
  });

  test('real content -> AI_EXPLANATION is READY with intro/body, other types stay placeholders', async () => {
    mockResolveTopicContent.mockResolvedValueOnce({
      intro: 'Ability Beyond Disability — intro.',
      body: ['Second part.'],
      sourceReference: 'NCERT English Grade 9 | iebe105.pdf',
      images: [],
    });
    const resources = await resolveResourcesByTopicName({ curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'Ability Beyond Disability' });

    const explanation = resources.find(r => r.resourceType === 'AI_EXPLANATION');
    expect(explanation.status).toBe('READY');
    expect(explanation.payload.intro).toBe('Ability Beyond Disability — intro.');
    expect(explanation.payload.body).toEqual(['Second part.']);
    expect(explanation.source).toBe('NCERT English Grade 9 | iebe105.pdf');

    const images = resources.find(r => r.resourceType === 'IMAGES');
    expect(images.status).toBe('COMING_SOON');

    const practice = resources.find(r => r.resourceType === 'PRACTICE');
    expect(practice.status).toBe('COMING_SOON');
  });

  // Regression: BookPane.tsx (the "View in Book" right pane) only renders
  // when topic.pdfFile is set — this was missing entirely from the byName
  // path's AI_EXPLANATION payload, so the real textbook pane silently never
  // appeared for any Qdrant-only topic, even with READY content on the left.
  // See BUGS_AND_FIXES.md, Bug #11 sixth finding.
  test('real content with a pdfFile -> AI_EXPLANATION payload carries pdfFile through for the "View in Book" pane', async () => {
    mockResolveTopicContent.mockResolvedValueOnce({
      intro: 'Transaction in Accounting — intro.', body: [],
      sourceReference: 'NCERT Accountancy Grade 11 | keac101.pdf',
      pdfFile: 'keac101.pdf',
      images: [],
    });
    const resources = await resolveResourcesByTopicName({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Transaction in Accounting' });
    const explanation = resources.find(r => r.resourceType === 'AI_EXPLANATION');
    expect(explanation.payload.pdfFile).toBe('keac101.pdf');
  });

  test('real content with no pdfFile (e.g. no PDF filename could be extracted) -> payload.pdfFile is undefined, not null/empty-string', async () => {
    mockResolveTopicContent.mockResolvedValueOnce({
      intro: 'text', body: [], sourceReference: null, pdfFile: null, images: [],
    });
    const resources = await resolveResourcesByTopicName({ curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'X' });
    const explanation = resources.find(r => r.resourceType === 'AI_EXPLANATION');
    expect(explanation.payload.pdfFile).toBeUndefined();
  });

  test('real content with images -> IMAGES resource is READY, matching useDbTopic\'s items[].description-as-url contract', async () => {
    mockResolveTopicContent.mockResolvedValueOnce({
      intro: 'text', body: [], sourceReference: null,
      images: [{ url: 'https://cdn.example/img.jpg', description: 'A diagram.' }],
    });
    const resources = await resolveResourcesByTopicName({ curriculum: 'NCERT', grade: 'Grade 9', subject: 'Science', topic: 'X' });
    const images = resources.find(r => r.resourceType === 'IMAGES');
    expect(images.status).toBe('READY');
    expect(images.payload.items[0].description).toBe('https://cdn.example/img.jpg');
  });
});
