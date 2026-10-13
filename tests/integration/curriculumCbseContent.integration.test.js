// CBSE students must get exactly the NCERT-book content legacy "NCERT"
// students got: same subjects, same chapters, same Qdrant content key.
// Uses the real syllabus-map.js book data; only Qdrant is mocked.

const mockListSubjects = jest.fn();
const mockTopicCount = jest.fn();
jest.mock('../../services/qdrant', () => ({
  listSubjects: (...args) => mockListSubjects(...args),
  listSyllabus: jest.fn(),
  topicCount: (...args) => mockTopicCount(...args),
}));

const express = require('express');
const request = require('supertest');
const { normalizeCurriculumParams, toQdrantCurriculum } = require('../../services/curriculumName');

const app = express();
app.use(express.json());
app.use(normalizeCurriculumParams);
app.use('/curriculum', require('../../routes/curriculum'));

const subjectsFor = async (curriculum) =>
  (await request(app).get('/curriculum/subjects').query({ curriculum, grade: 'Grade 8' })).body;

describe('CBSE Grade 8 sees the same content NCERT Grade 8 did', () => {
  test('/curriculum/subjects: identical, non-empty subject + chapter lists', async () => {
    const cbse = await subjectsFor('CBSE');
    const ncert = await subjectsFor('NCERT');
    const lower = await subjectsFor(' ncert ');

    expect(cbse.subjects.length).toBeGreaterThan(0);
    expect(cbse.subjects.every((s) => (s.chapters || []).length > 0)).toBe(true);
    expect(ncert.subjects).toEqual(cbse.subjects);
    expect(lower.subjects).toEqual(cbse.subjects);
    // The response never echoes NCERT back as a curriculum.
    expect(ncert.curriculum).toBe('CBSE');
    expect(mockListSubjects).not.toHaveBeenCalled();
  });

  test('topic-count queries Qdrant with the same key for CBSE and NCERT', async () => {
    mockTopicCount.mockResolvedValue(42);
    await request(app).get('/curriculum/topic-count').query({ curriculum: 'NCERT', grade: 'Grade 8' });
    await request(app).get('/curriculum/topic-count').query({ curriculum: 'CBSE', grade: 'Grade 8' });
    expect(mockTopicCount.mock.calls).toEqual([['CBSE', 'Grade 8'], ['CBSE', 'Grade 8']]);
    expect(toQdrantCurriculum('CBSE')).toBe('NCERT');
  });
});
