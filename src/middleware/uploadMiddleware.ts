import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';
import path from 'path';
import fs from 'fs';

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    cb(null, uploadsDir);
  },
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    // Generate unique filename: timestamp-random-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `profile-${uniqueSuffix}${ext}`);
  },
});

// File filter - only allow images
const fileFilter = (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed'));
  }
};

// Configure multer
export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter,
});

// Configure storage for leave documents
const leaveStorage = multer.diskStorage({
  destination: (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    const leaveUploadsDir = path.join(__dirname, '../../public/uploads/leaves');
    if (!fs.existsSync(leaveUploadsDir)) {
      fs.mkdirSync(leaveUploadsDir, { recursive: true });
    }
    cb(null, leaveUploadsDir);
  },
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    // Generate unique filename: timestamp-random-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `leave-${uniqueSuffix}${ext}`);
  },
});

// File filter for leave documents - allow PDF and images
const leaveFileFilter = (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];
  const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
  
  const isValidExtension = allowedExtensions.includes(fileExt);
  const isValidMimeType = allowedMimeTypes.includes(file.mimetype);

  if (isValidExtension && isValidMimeType) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF and image files (jpeg, jpg, png) are allowed'));
  }
};

// Configure multer for leave document uploads
export const uploadLeaveDocument = multer({
  storage: leaveStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for documents
  },
  fileFilter: leaveFileFilter,
});

