const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const FOLDER = 'aivorah/teacher-curricula';

async function uploadCurriculumFile(buffer, { fileName, mimeType }) {
  const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: FOLDER,
    public_id: `curriculum_${Date.now()}`,
    resource_type: 'raw',
    filename_override: fileName,
  });
  return { url: result.secure_url, publicId: result.public_id };
}

// A picture a teacher adds to a lesson.
async function uploadLessonImage(buffer, { mimeType }) {
  const result = await cloudinary.uploader.upload(`data:${mimeType};base64,${buffer.toString('base64')}`, {
    folder: 'aivorah/teacher-lesson-images',
    resource_type: 'image',
  });
  return { url: result.secure_url, width: result.width, height: result.height };
}

// A book (PDF) a teacher adds to a lesson; kept as a .pdf so browsers open it in place at a page.
async function uploadLessonBook(buffer, { fileName }) {
  const result = await cloudinary.uploader.upload(`data:application/pdf;base64,${buffer.toString('base64')}`, {
    folder: 'aivorah/teacher-lesson-books',
    resource_type: 'raw',
    public_id: `book_${Date.now()}.pdf`,
    filename_override: fileName,
  });
  return { url: result.secure_url, fileName };
}

// A file that must never be publicly reachable (e.g. official CISCE PDFs):
// authenticated delivery, so only signed URLs can fetch it.
async function uploadPrivateFile(buffer, { folder, publicId, fileName }) {
  const result = await cloudinary.uploader.upload(`data:application/pdf;base64,${buffer.toString('base64')}`, {
    folder,
    public_id: publicId,
    resource_type: 'raw',
    type: 'authenticated',
    overwrite: false,
    filename_override: fileName,
  });
  return { publicId: result.public_id, type: result.type };
}

async function deleteCurriculumFile(publicId) {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}

module.exports = { uploadCurriculumFile, deleteCurriculumFile, uploadLessonImage, uploadLessonBook, uploadPrivateFile };
