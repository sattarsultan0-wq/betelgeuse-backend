import { ZodError } from 'zod';
import multer from 'multer';
export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError)
    return res.status(400).json({
      code: 'VALIDATION',
      message: 'Проверьте введённые данные',
      issues: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  if (error instanceof multer.MulterError)
    return res.status(400).json({
      code: 'UPLOAD',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Файл превышает допустимый размер'
          : 'Некорректная загрузка файла',
    });
  if (error.code === 'P2002')
    return res.status(409).json({ code: 'CONFLICT', message: 'Запись уже существует' });
  if (error instanceof AppError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.code === 'CSRF' && error.reason ? { reason: error.reason } : {}),
      ...(error.code === 'PRICE_CHANGED' ? { currentQuote: error.currentQuote } : {}),
    });
  if (error.status === 400)
    return res.status(400).json({ code: 'BODY', message: 'Некорректное тело запроса' });
  if (error.status === 413)
    return res.status(413).json({ code: 'BODY_TOO_LARGE', message: 'Запрос слишком большой' });
  console.error(
    JSON.stringify({
      event: 'request_error',
      requestId: req.requestId,
      name: error.name,
      code: error.code || 'INTERNAL',
    }),
  );
  return res.status(503).json({
    code: 'UNAVAILABLE',
    message: 'Сервис временно недоступен. Попробуйте позже.',
  });
}
