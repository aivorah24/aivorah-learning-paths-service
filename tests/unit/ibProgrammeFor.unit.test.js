const { ibProgrammeFor } = require('../../routes/curriculum');

test('IB DP + Grade 9 is served IB MYP', () => expect(ibProgrammeFor('IB DP', 'Grade 9')).toBe('IB MYP'));
test('IB MYP + Grade 11 is served IB DP', () => expect(ibProgrammeFor('IB MYP', 'Grade 11')).toBe('IB DP'));
test('IB_PYP + Grade 7 is served IB MYP', () => expect(ibProgrammeFor('IB_PYP', 'Grade 7')).toBe('IB MYP'));
test('valid IB pairs and other boards are unchanged', () => {
  expect(ibProgrammeFor('IB DP', 'Grade 12')).toBe('IB DP');
  expect(ibProgrammeFor('Cambridge', 'Grade 9')).toBe('Cambridge');
  expect(ibProgrammeFor('IB PYP', 'UKG')).toBe('IB PYP');
});
