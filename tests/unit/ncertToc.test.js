const { parseToc, titleCase, blockList } = require('../../scripts/lib/ncertToc.cjs');

describe('ncertToc', () => {
  test('parses numbered lines with glued page numbers', () => {
    const t = 'Contents\n1.Real Numbers1\n2.Polynomials17\n3.Pair of Linear Equations in Two Variables\n34\n';
    expect(parseToc(t)).toEqual({ 1: 'Real Numbers', 2: 'Polynomials', 3: 'Pair of Linear Equations in Two Variables' });
  });

  test('parses CHAPTER N heading layout and normalises caps', () => {
    const t = 'CHAPTER 1\nUNITS AND MEASUREMENTS\n1.1 Introduction\nCHAPTER 2\nMOTION IN A STRAIGHT LINE\n2.1 Introduction\n';
    expect(parseToc(t)).toEqual({ 1: 'Units and Measurements', 2: 'Motion in a Straight Line' });
  });

  test('keeps numbers that belong to the title', () => {
    expect(titleCase('Making 10')).toBe('Making 10');
  });

  test('block list only accepted when the count matches', () => {
    const t = 'विषय-सूची\nआमुख\nसाखी\nपद\nमनुष्यता\n\n12\n';
    expect(blockList(t, 3)).toEqual({ 1: 'साखी', 2: 'पद', 3: 'मनुष्यता' });
    expect(blockList(t, 4)).toEqual({});
  });
});
