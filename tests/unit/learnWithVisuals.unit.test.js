jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { learnWithVisuals } = require('../../services/curriculum/unitContentSections');

const text = (n) => Array.from({ length: n }, (_, i) => ({ type: 'explanation', text: `t${i}` }));
const flow = { kind: 'flow', steps: ['a', 'b'] };
const pic = { kind: 'image', url: 'https://x/p.png', caption: 'From the book, page 3.' };

test('puts the book picture first, then diagrams, between the text blocks', () => {
  const out = learnWithVisuals({ whatYoullLearn: ['w'], blocks: text(5) }, [{ visual: flow }, { visual: pic }]).blocks;
  expect(out.map((b) => b.type)).toEqual(['explanation', 'image', 'explanation', 'explanation', 'visual', 'explanation', 'explanation']);
  expect(out[1]).toEqual({ type: 'image', url: 'https://x/p.png', caption: 'From the book, page 3.' });
  expect(out[4]).toEqual({ type: 'visual', visual: flow });
});

test('never more than 4 visuals in a lesson, counting ones already there; no visuals means unchanged', () => {
  const many = Array.from({ length: 6 }, () => ({ visual: flow }));
  const out = learnWithVisuals({ blocks: [...text(10), { type: 'image', url: 'u', caption: 'c' }] }, many).blocks;
  expect(out.filter((b) => b.type === 'visual' || b.type === 'image')).toHaveLength(4);
  const learn = { blocks: text(3) };
  expect(learnWithVisuals(learn, [])).toBe(learn);
});
