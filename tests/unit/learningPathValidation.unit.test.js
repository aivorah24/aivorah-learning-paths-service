const { validateLearningPathContent, LearningPathValidationError } = require('../../services/curriculumUpload/learningPathValidation');

function validContent() {
  return {
    version: 1,
    units: [
      {
        title: 'Numbers',
        order: 0,
        topics: [
          {
            title: 'Whole Numbers',
            order: 0,
            objectives: ['Add two numbers'],
            lessons: [{ title: 'Intro', summary: 'Basic addition' }],
            subtopics: [{ title: 'Addition', order: 0 }],
          },
        ],
      },
    ],
  };
}

describe('validateLearningPathContent', () => {
  test('accepts a well-formed edited draft', () => {
    expect(validateLearningPathContent(validContent())).toBe(true);
  });

  test('accepts a null unit/topic title (untitled nodes stay valid)', () => {
    const content = validContent();
    content.units[0].title = null;
    expect(validateLearningPathContent(content)).toBe(true);
  });

  test('rejects missing content', () => {
    expect(() => validateLearningPathContent(null)).toThrow(LearningPathValidationError);
  });

  test('rejects an empty units array', () => {
    expect(() => validateLearningPathContent({ units: [] })).toThrow(/non-empty array/);
  });

  test('rejects a unit missing a numeric order', () => {
    const content = validContent();
    delete content.units[0].order;
    expect(() => validateLearningPathContent(content)).toThrow(/missing numeric order/);
  });

  test('rejects duplicate order values among sibling units', () => {
    const content = validContent();
    content.units.push({ ...content.units[0], order: 0 });
    expect(() => validateLearningPathContent(content)).toThrow(/duplicate order/);
  });

  test('rejects a blank-string unit title', () => {
    const content = validContent();
    content.units[0].title = '   ';
    expect(() => validateLearningPathContent(content)).toThrow(/non-empty string or null/);
  });

  test('rejects non-array objectives', () => {
    const content = validContent();
    content.units[0].topics[0].objectives = 'not an array';
    expect(() => validateLearningPathContent(content)).toThrow(/objectives must be an array/);
  });

  test('rejects a lesson missing a title', () => {
    const content = validContent();
    content.units[0].topics[0].lessons = [{ summary: 'x' }];
    expect(() => validateLearningPathContent(content)).toThrow(/lessons must be an array/);
  });

  test('rejects duplicate order values among sibling subtopics', () => {
    const content = validContent();
    content.units[0].topics[0].subtopics.push({ title: 'Subtraction', order: 0 });
    expect(() => validateLearningPathContent(content)).toThrow(/duplicate order/);
  });

  test('rejects a subtopic with a blank title', () => {
    const content = validContent();
    content.units[0].topics[0].subtopics[0].title = '';
    expect(() => validateLearningPathContent(content)).toThrow(/non-empty string/);
  });

  test('accepts well-formed listenParts and practiceQuiz on topic.content', () => {
    const content = validContent();
    content.units[0].topics[0].content = {
      listenParts: [{ heading: 'Intro', text: 'Hello there.', keyIdea: 'Numbers are everywhere', pauseThink: { question: 'What is 2+2?', options: ['3', '4', '5', '6'], correctIndex: 1 } }],
      practiceQuiz: [{ type: 'mcq', question: 'What is 2+2?', options: ['3', '4', '5', '6'], correct: 1 }],
    };
    expect(validateLearningPathContent(content)).toBe(true);
  });

  test('rejects a listenPart missing text', () => {
    const content = validContent();
    content.units[0].topics[0].content = { listenParts: [{ heading: 'Intro' }] };
    expect(() => validateLearningPathContent(content)).toThrow(/listenParts/);
  });

  test('rejects a pauseThink missing options', () => {
    const content = validContent();
    content.units[0].topics[0].content = {
      listenParts: [{ heading: 'Intro', text: 'Hi', pauseThink: { question: 'Q?' } }],
    };
    expect(() => validateLearningPathContent(content)).toThrow(/pauseThink/);
  });

  test('rejects a practiceQuiz question missing options', () => {
    const content = validContent();
    content.units[0].topics[0].content = { practiceQuiz: [{ question: 'Q?' }] };
    expect(() => validateLearningPathContent(content)).toThrow(/practiceQuiz/);
  });
});
