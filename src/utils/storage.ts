import { Storage } from '@google-cloud/storage';

export interface ImageUploadModel {
  imageUrl: string;
  fileName: string;
}

export const uploadImage = async (binaryImage: string, fileName: string): Promise<ImageUploadModel> => {
  //extract base64
  const base64String = binaryImage.split('base64,');

  //get extension type
  const fileExtension = getFileExtension(base64String[0] ?? '');

  //convert to buffer type
  const imageBuffer = Buffer.from(base64String[1] ?? '', 'base64');

  const storage = new Storage();
  const bucket = storage.bucket('images-csp');
  const newFilename = `${Date.now()}-${fileName}`;
  const fileUpload = bucket.file(newFilename);

  const stream = fileUpload.createWriteStream({
    metadata: {
      contentType: fileExtension,
      // Set the access control to "public-read"
      acl: [{ entity: 'allUsers', role: 'READER' }],
    },
  });

  return new Promise((resolve, reject) => {
    stream.on('error', (error) => {
      reject(error);
    });

    stream.on('finish', () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileUpload.name}`;
      resolve({
        imageUrl: publicUrl,
        fileName: fileUpload.name,
      } as ImageUploadModel);
    });

    stream.end(imageBuffer);
  });
};

const getFileExtension = (fileName: string) => {
  return fileName?.match(/(?<=data:)(.*?)(?=;base64)/)?.[0];
};
