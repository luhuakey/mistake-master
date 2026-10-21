export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (message = '资源不存在') => new AppError('NOT_FOUND', message, 404);
export const unauthorized = () => new AppError('AUTH_REQUIRED', '请先登录', 401);

export const assert = (condition, code, message, status = 400) => {
  if (!condition) throw new AppError(code, message, status);
};
