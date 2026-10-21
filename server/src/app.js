import express from 'express';
import multer from 'multer';
import { env, getProductionConfigStatus } from './config/env.js';
import { createDataStore } from './data/store.js';
import { StorageAdapter } from './adapters/storage.adapter.js';
import { OcrAdapter } from './adapters/ocr.adapter.js';
import { DeepSeekAdapter } from './adapters/deepseek.adapter.js';
import { EmbeddingAdapter } from './adapters/embedding.adapter.js';
import { VectorAdapter } from './adapters/vector.adapter.js';
import { AuthService } from './services/auth.service.js';
import { QuestionService } from './services/question.service.js';
import { RecognitionService } from './services/recognition.service.js';
import { SearchService } from './services/search.service.js';
import { PracticeService } from './services/practice.service.js';
import { ProfileService } from './services/profile.service.js';
import { LearningStatsService } from './services/learning-stats.service.js';
import { PointsService, POINTS_TERMS_VERSION } from './services/points.service.js';
import { ExportService } from './services/export.service.js';
import { asyncRoute, authMiddleware, errorMiddleware, notFoundMiddleware, ok, requestId } from './middleware/http.js';
import { AppError } from './shared/errors.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SERVICE_BUILD = '2026-09-01-learning-points-v3';
const validateFileBuffer = (buffer, mimetype, temporaryFileId = '') => {
  if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError(buffer?.length ? 'FILE_TOO_LARGE' : 'FILE_INVALID', buffer?.length ? '图片不能超过 10MB' : '请选择有效图片', buffer?.length ? 413 : 400);
  }
  return { buffer, mimetype, temporaryFileId };
};

const requestFile = async (req, storage) => {
  if (req.file?.buffer?.length) return req.file;
  const cloudFileId = String(req.body?.cloud_file_id || '').trim();
  if (cloudFileId) {
    if (!/^cloud:\/\//i.test(cloudFileId) || cloudFileId.length > 2048) {
      throw new AppError('CLOUD_FILE_INVALID', '云存储图片标识无效，请重新上传', 400);
    }
    let buffer;
    try {
      buffer = await storage.download(cloudFileId);
    } catch (error) {
      throw new AppError('CLOUD_FILE_DOWNLOAD_FAILED', '读取已上传图片失败，请重试', 400, { cause: error?.message });
    }
    return validateFileBuffer(buffer, String(req.body?.mime_type || 'image/jpeg'), cloudFileId);
  }
  const encoded = String(req.body?.file_base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!encoded) return null;
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) {
    throw new AppError('FILE_TOO_LARGE', '图片不能超过 10MB', 413);
  }
  const buffer = Buffer.from(encoded, 'base64');
  return validateFileBuffer(buffer, String(req.body?.mime_type || 'image/jpeg'));
};

const cleanupTemporaryFile = async (storage, file) => {
  if (!file?.temporaryFileId || typeof storage.delete !== 'function') return;
  try {
    await storage.delete(file.temporaryFileId);
  } catch (error) {
    console.warn('清理客户端临时上传文件失败', { fileId: file.temporaryFileId, message: error?.message });
  }
};

export function createApp(overrides = {}) {
  const config = overrides.config || env;
  const store = overrides.store || createDataStore(config);
  const storage = overrides.storage || new StorageAdapter(config);
  const ocr = overrides.ocr || new OcrAdapter(config);
  const deepseek = overrides.deepseek || new DeepSeekAdapter(config);
  const embedding = overrides.embedding || new EmbeddingAdapter(config);
  const vector = overrides.vector || new VectorAdapter(config, embedding);
  const auth = new AuthService(store, config);
  const questions = new QuestionService(store);
  const recognitions = new RecognitionService({ store, storage, ocr, deepseek, vector });
  const search = new SearchService(store, vector, questions);
  const learningStats = new LearningStatsService(store);
  const practices = new PracticeService(store, questions, deepseek, learningStats);
  const points = new PointsService(store, config);
  const profile = new ProfileService(store, questions, practices, storage, points, learningStats);
  const exportsService = new ExportService(store, storage, config);
  const services = { store, storage, ocr, deepseek, embedding, vector, auth, questions, recognitions, search, practices, profile, points, learningStats, exports: exportsService };
  const configStatus = getProductionConfigStatus(config);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));
  app.use(requestId);

  app.get('/health', (req, res) => ok(req, res, {
    status: configStatus.authReady ? 'ok' : 'degraded',
    build: SERVICE_BUILD,
    capabilities: {
      auth: configStatus.authReady,
      recognition: configStatus.authReady && configStatus.recognitionReady,
      search: configStatus.authReady && configStatus.searchReady
    }
  }));

  app.use('/v1', (req, res, next) => {
    if (configStatus.authReady) return next();
    return next(new AppError(
      'SERVER_CONFIG_ERROR',
      '服务端登录配置不完整，请联系管理员',
      503,
      { missing: configStatus.authMissing }
    ));
  });

  app.post('/v1/auth/wechat-login', asyncRoute(async (req, res) => {
    const consent = {
      agreementConsent: req.body?.agreement_consent,
      privacyConsent: req.body?.privacy_consent,
      consentVersion: req.body?.consent_version
    };
    const { is_new: isNew, ...result } = await auth.login(req.body?.code, consent, req.body?.wechat_profile);
    if (points.enabled && isNew && consent.consentVersion === POINTS_TERMS_VERSION) {
      try { await points.activate(result.user.id, {}, { newUser: true }); }
      catch (error) { console.error('[points-activate-new-user]', { userId: result.user.id, message: error?.message }); }
    }
    return ok(req, res, result);
  }));

  app.use('/v1', authMiddleware(auth));

  // 本地开发使用内存存储时，由客户端鉴权下载后写入 wxfile 临时文件。
  // 生产 CloudBase 存储不会进入此分支，且路径必须属于当前登录用户。
  app.get('/v1/local-assets/question-image', asyncRoute(async (req, res) => {
    const fileId = String(req.query?.file_id || '');
    const matched = fileId.match(/^memory:\/\/users\/([a-zA-Z0-9_-]+)\/recognitions\/[a-zA-Z0-9_-]+\/question-images\/[a-zA-Z0-9_-]+\.(jpe?g|png|webp)$/i);
    if (config.dataDriver !== 'memory' || !matched || matched[1] !== req.user.id) {
      throw new AppError('QUESTION_IMAGE_NOT_FOUND', '题目配图不存在', 404);
    }
    const content = await storage.download(fileId);
    if (!content?.length) throw new AppError('QUESTION_IMAGE_NOT_FOUND', '题目配图不存在', 404);
    const contentTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    res.set('Content-Type', contentTypes[matched[2].toLowerCase()] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(content);
  }));

  app.get('/v1/home', asyncRoute(async (req, res) => ok(req, res, await questions.home(req.user.id, req.query.subject || 'math'))));

  app.post('/v1/recognitions', upload.single('image'), asyncRoute(async (req, res) => {
    const file = await requestFile(req, storage);
    try {
      const mode = req.query.mode || req.body?.mode || 'single';
      return ok(req, res, await recognitions.create(req.user.id, file?.buffer, file?.mimetype, mode), 201);
    } finally {
      await cleanupTemporaryFile(storage, file);
    }
  }));
  app.get('/v1/recognitions/:id', asyncRoute(async (req, res) => ok(req, res, await recognitions.get(req.user.id, req.params.id))));
  app.post('/v1/recognitions/:id/process', asyncRoute(async (req, res) => ok(req, res, await recognitions.processNext(req.user.id, req.params.id))));
  app.post('/v1/recognitions/:id/retry', asyncRoute(async (req, res) => ok(req, res, await recognitions.retry(req.user.id, req.params.id))));
  app.post('/v1/recognitions/:id/save', asyncRoute(async (req, res) => {
    const result = await recognitions.save(req.user.id, req.params.id, req.body || {});
    let pointsReward = { amount: 0, balance: 0, reason_codes: [] };
    try { pointsReward = await points.awardSavedQuestions(req.user.id, result.question_ids || (result.question_id ? [result.question_id] : [])); }
    catch (error) { console.error('[points-award-save]', { userId: req.user.id, message: error?.message }); }
    return ok(req, res, { ...result, points_reward: pointsReward }, 201);
  }));

  app.get('/v1/questions', asyncRoute(async (req, res) => ok(req, res, await questions.list(req.user.id, req.query))));
  app.get('/v1/questions/:id', asyncRoute(async (req, res) => ok(req, res, await questions.detail(req.user.id, req.params.id))));
  app.patch('/v1/questions/:id/mastery', asyncRoute(async (req, res) => {
    const question = await questions.updateMastery(req.user.id, req.params.id, req.body?.mastery_status);
    let pointsReward = { amount: 0, balance: 0, reason_codes: [] };
    try { pointsReward = await points.awardMastery(req.user.id, question._id); }
    catch (error) { console.error('[points-award-mastery]', { userId: req.user.id, message: error?.message }); }
    return ok(req, res, { ...question, points_reward: pointsReward });
  }));
  app.post('/v1/search/questions', asyncRoute(async (req, res) => ok(req, res, await search.search(req.user.id, req.body || {}))));
  app.get('/v1/search/status', asyncRoute(async (req, res) => ok(req, res, search.status())));

  app.post('/v1/practice-sessions/recommended', asyncRoute(async (req, res) => {
    const result = await practices.recommended(
      req.user.id,
      req.body?.subject || 'math',
      { mode: req.body?.mode, excludeQuestionIds: req.body?.exclude_question_ids }
    );
    return ok(req, res, result, result.available ? 201 : 200);
  }));
  app.post('/v1/practice-sessions/from-questions', asyncRoute(async (req, res) => ok(req, res, await practices.createFromQuestions(req.user.id, req.body?.question_ids, req.body?.type), 201)));
  app.get('/v1/practice-sessions/:id', asyncRoute(async (req, res) => ok(req, res, await practices.getSession(req.user.id, req.params.id))));
  app.post('/v1/practice-sessions/:id/submit', asyncRoute(async (req, res) => {
    const result = await practices.submit(
      req.user.id,
      req.params.id,
      req.body?.answers,
      req.body?.ordered_answers
    );
    let pointsReward = { amount: 0, balance: 0, reason_codes: [] };
    try { pointsReward = await points.awardPracticeRecord(req.user.id, result.practice_record_id); }
    catch (error) { console.error('[points-award-practice]', { userId: req.user.id, message: error?.message }); }
    return ok(req, res, { ...result, points_reward: pointsReward });
  }));
  app.get('/v1/practice-records', asyncRoute(async (req, res) => ok(req, res, await practices.history(req.user.id, req.query.limit))));
  app.get('/v1/practice-records/:id', asyncRoute(async (req, res) => ok(req, res, await practices.getRecord(req.user.id, req.params.id))));
  app.post('/v1/practice-records/:id/items/:questionId/self-assess', asyncRoute(async (req, res) => ok(req, res, await practices.selfAssess(
    req.user.id,
    req.params.id,
    req.params.questionId,
    req.body?.is_correct
  ))));

  app.get('/v1/mastery', asyncRoute(async (req, res) => ok(req, res, await profile.mastery(req.user.id, req.query.subject || 'math'))));
  app.get('/v1/profile/checkin', asyncRoute(async (req, res) => ok(req, res, await profile.checkin(req.user.id, req.query))));
  app.get('/v1/profile', asyncRoute(async (req, res) => ok(req, res, await profile.profile(req.user.id))));
  app.patch('/v1/profile', asyncRoute(async (req, res) => ok(req, res, await profile.updateProfile(req.user.id, req.body || {}))));
  app.post('/v1/profile/avatar', upload.single('avatar'), asyncRoute(async (req, res) => {
    const file = await requestFile(req, storage);
    try {
      return ok(req, res, await profile.updateAvatar(req.user.id, file?.buffer, file?.mimetype));
    } finally {
      await cleanupTemporaryFile(storage, file);
    }
  }));
  app.get('/v1/settings', asyncRoute(async (req, res) => ok(req, res, await profile.getSettings(req.user.id))));
  app.patch('/v1/settings', asyncRoute(async (req, res) => ok(req, res, await profile.updateSettings(req.user.id, req.body || {}))));
  app.post('/v1/points/activate', asyncRoute(async (req, res) => ok(req, res, await points.activate(req.user.id, {
    agreementConsent: req.body?.agreement_consent,
    privacyConsent: req.body?.privacy_consent,
    termsVersion: req.body?.terms_version
  }), 201)));
  app.get('/v1/points', asyncRoute(async (req, res) => {
    const dashboard = await points.dashboard(req.user.id, 5);
    points.scheduleReconcile(req.user.id);
    return ok(req, res, dashboard);
  }));
  app.get('/v1/points/transactions', asyncRoute(async (req, res) => ok(req, res, await points.transactions(
    req.user.id,
    req.query.cursor,
    req.query.limit
  ))));
  app.post('/v1/exports', asyncRoute(async (req, res) => ok(req, res, await exportsService.create(req.user.id), 201)));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  app.locals.services = services;
  return app;
}
