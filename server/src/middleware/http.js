import crypto from 'node:crypto';
import { AppError, unauthorized } from '../shared/errors.js';

export const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export const requestId = (req, res, next) => {
  req.requestId = req.get('x-request-id') || `req_${crypto.randomUUID().replaceAll('-', '')}`;
  res.set('x-request-id', req.requestId);
  next();
};

export const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, request_id: req.requestId });

export const authMiddleware = (authService) => async (req, _res, next) => {
  const authorization = req.get('x-app-authorization') || req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return next(unauthorized());
  try {
    const user = await authService.authenticate(token);
    req.user = { id: user._id };
    next();
  } catch (error) {
    next(error);
  }
};

export const notFoundMiddleware = (req, _res, next) => next(new AppError('ROUTE_NOT_FOUND', `接口不存在：${req.method} ${req.path}`, 404));

export const errorMiddleware = (error, req, res, _next) => {
  const status = error.status || 500;
  const expose = error instanceof AppError || status < 500;
  res.status(status).json({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: expose ? error.message : '服务暂时不可用，请稍后重试',
      ...(error.details === undefined ? {} : { details: error.details })
    },
    request_id: req.requestId
  });
};
