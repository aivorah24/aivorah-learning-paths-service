jest.mock('cloudinary', () => {
  const uploader = { upload: jest.fn(), destroy: jest.fn() };
  return { v2: { config: jest.fn(), uploader } };
});

const cloudinary = require('cloudinary').v2;
const { uploadCurriculumFile, deleteCurriculumFile, uploadLessonImage } = require('../../services/curriculumUpload/cloudinaryStorage');

describe('cloudinaryStorage', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uploads a buffer as a base64 data URI and returns url + publicId', async () => {
    cloudinary.uploader.upload.mockResolvedValueOnce({
      secure_url: 'https://res.cloudinary.com/x/raw/upload/curriculum_1.pdf',
      public_id: 'aivorah/teacher-curricula/curriculum_1',
    });

    const result = await uploadCurriculumFile(Buffer.from('pdf-bytes'), {
      fileName: 'syllabus.pdf',
      mimeType: 'application/pdf',
    });

    expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^data:application\/pdf;base64,/),
      expect.objectContaining({ folder: 'aivorah/teacher-curricula', resource_type: 'raw' })
    );
    expect(result).toEqual({
      url: 'https://res.cloudinary.com/x/raw/upload/curriculum_1.pdf',
      publicId: 'aivorah/teacher-curricula/curriculum_1',
    });
  });

  test('propagates upload errors', async () => {
    cloudinary.uploader.upload.mockRejectedValueOnce(new Error('cloudinary down'));
    await expect(
      uploadCurriculumFile(Buffer.from('x'), { fileName: 'a.pdf', mimeType: 'application/pdf' })
    ).rejects.toThrow('cloudinary down');
  });

  test('deletes a file by public id as a raw resource', async () => {
    cloudinary.uploader.destroy.mockResolvedValueOnce({ result: 'ok' });
    await deleteCurriculumFile('aivorah/teacher-curricula/curriculum_1');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
      'aivorah/teacher-curricula/curriculum_1',
      { resource_type: 'raw' }
    );
  });
});

test('uploads a lesson picture as an image', async () => {
  cloudinary.uploader.upload.mockResolvedValueOnce({ secure_url: 'https://res.cloudinary.com/x/image/upload/a.png', width: 40, height: 30 });
  const out = await uploadLessonImage(Buffer.from('png'), { mimeType: 'image/png' });
  expect(cloudinary.uploader.upload).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), expect.objectContaining({ resource_type: 'image', folder: 'aivorah/teacher-lesson-images' }));
  expect(out).toEqual({ url: 'https://res.cloudinary.com/x/image/upload/a.png', width: 40, height: 30 });
});
