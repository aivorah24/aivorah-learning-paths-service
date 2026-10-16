const { byTopicCode } = require('../../services/qdrant');

const names = (list) => list.map((n) => ({ name: n }));

test('IB codes sort numerically within a theme', () => {
  const out = byTopicCode(names(['A3.1 Diversity of organisms', 'A2.2 Cell structure', 'A2.1 Origins of cells (HL only)']));
  expect(out.map((t) => t.name.split(' ')[0])).toEqual(['A2.1', 'A2.2', 'A3.1']);
});

test('dotted codes sort with 10 after 9', () => {
  const out = byTopicCode(names(['A.10 Last', 'A.5 Relativity', 'A.1 Kinematics', 'A.3 Work']));
  expect(out.map((t) => t.name.split(' ')[0])).toEqual(['A.1', 'A.3', 'A.5', 'A.10']);
});

test('topics without codes keep their order', () => {
  const list = names(['Speed', 'A.1 Kinematics']);
  expect(byTopicCode(list)).toEqual(list);
});
