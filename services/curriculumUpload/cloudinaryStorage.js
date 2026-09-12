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

async function deleteCurriculumFile(publicId) {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}

module.exports = { uploadCurriculumFile, deleteCurriculumFile };
