const mockOrder = jest.fn();
jest.mock('../../services/supabase', () => ({
  from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: (...a) => mockOrder(...a) })),
}));

const { mathTutorForTopic, _cache } = require('../../services/curriculum/mathTutorSections');

const rows = [
  { section_no: 1, section_title: '1.1 Square Numbers', page_from: 3, tutor: { keyIdea: 'If y = x², x is the square root of y.', examples: [{ title: 'Repeated subtraction', problem: 'Consider √81.' }] } },
  { section_no: 2, section_title: '1.2 Cubic Numbers', page_from: 11, tutor: { keyIdea: 'A cube is a number times itself three times.', examples: [{ title: 'Perfect cubes', problem: 'Is 3375 a perfect cube?' }] } },
];

beforeEach(() => { _cache.clear(); mockOrder.mockReset(); });

test('picks the section whose title and examples match the topic', async () => {
  mockOrder.mockResolvedValue({ data: rows, error: null });
  expect((await mathTutorForTopic('hegp101.pdf', 'Perfect Cubes')).section).toBe('1.2 Cubic Numbers');
  expect((await mathTutorForTopic('hegp101.pdf', 'Square Roots')).pdfPage).toBe(3);
  expect(mockOrder).toHaveBeenCalledTimes(1); // second lookup served from cache
});

test('falls back to the first section when nothing matches, and to null when the unit has no tutor', async () => {
  mockOrder.mockResolvedValueOnce({ data: rows, error: null });
  expect((await mathTutorForTopic('hegp101.pdf', 'Landmark history')).section).toBe('1.1 Square Numbers');
  mockOrder.mockResolvedValueOnce({ data: [], error: null });
  expect(await mathTutorForTopic('empty.pdf', 'Anything')).toBeNull();
  expect(await mathTutorForTopic(undefined, 'x')).toBeNull();
});

test('a missing table or query error means no tutor, not a crash', async () => {
  mockOrder.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });
  expect(await mathTutorForTopic('x.pdf', 'Square Roots')).toBeNull();
});
