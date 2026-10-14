import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { upload, getImage } from '../controllers/upload.controller.js';
const router = Router();
router.use(authenticate);
const middleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  fileFilter(req, file, callback) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
      return callback(new AppError(400, 'Поддерживаются JPEG, PNG, WebP'));
    callback(null, true);
  },
});
router.post(
  '/',
  rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много загрузок' },
  }),
  middleware.single('image'),
  upload,
);
router.get('/:id', getImage);
export default router;
