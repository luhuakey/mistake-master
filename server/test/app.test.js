import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { DeepSeekAdapter } from '../src/adapters/deepseek.adapter.js';
import { assessQuestionCompliance, COMPLIANCE_BLOCKED_MESSAGE } from '../src/shared/content-compliance.js';
import { OcrAdapter } from '../src/adapters/ocr.adapter.js';
import { EmbeddingAdapter } from '../src/adapters/embedding.adapter.js';
import { VectorAdapter } from '../src/adapters/vector.adapter.js';
import { CloudBaseDataStore, MemoryDataStore } from '../src/data/store.js';
import { ProfileService } from '../src/services/profile.service.js';
import { PointsService, POINTS_TERMS_VERSION } from '../src/services/points.service.js';
import { env, getProductionConfigStatus } from '../src/config/env.js';
import { SUBJECT_KEYS } from '../src/shared/subjects.js';
import { id, nowIso } from '../src/shared/utils.js';
import { parseMath } from '../../miniprogram/utils/math.js';
import { stripOptionPrefix } from '../../miniprogram/utils/options.js';
import { learningReminderDelay, localDateKey } from '../../miniprogram/utils/learning-reminder.js';

const config = { ...env, nodeEnv: 'test', dataDriver: 'memory', mockExternalServices: true, sessionSecret: 'test-session-secret' };

const login = async (app, code = 'student') => {
  const response = await request(app).post('/v1/auth/wechat-login').send({
    code,
    agreement_consent: true,
    privacy_consent: true,
    consent_version: '2026-08-24'
  }).expect(200);
  return response.body.data;
};

const loginWithPoints = async (app, code = 'points-student') => {
  const response = await request(app).post('/v1/auth/wechat-login').send({
    code,
    agreement_consent: true,
    privacy_consent: true,
    consent_version: POINTS_TERMS_VERSION
  }).expect(200);
  return response.body.data;
};

const auth = (token) => ({ 'x-app-authorization': `Bearer ${token}` });

const waitForRecognition = async (app, token, taskId, attempts = 40) => {
  let task;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    task = (await request(app).get(`/v1/recognitions/${taskId}`).set(auth(token)).expect(200)).body.data;
    if (['succeeded', 'failed'].includes(task.status)) return task;
    await request(app).post(`/v1/recognitions/${taskId}/process`).set(auth(token)).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return task;
};

test('英文体验题中的普通下划线填空不会被数学解析器吞掉', () => {
  const stems = [
    'There ___ a book and two pens on the desk.',
    'She ___ to school by bus every day.',
    'The past tense of “go” is ___.',
    '—How often do you exercise? —___.'
  ];
  stems.forEach((stem) => assert.equal(parseMath(stem).map((segment) => segment.text || '').join(''), stem));
  assert.equal(parseMath('x_1').some((segment) => segment.type === 'sub' && segment.text === '1'), true);
});

test('普通与 LaTeX 选项标签在展示前会被统一去除', () => {
  assert.equal(stripOptionPrefix('( A ) 0.31492 × 10^8', 'A'), '0.31492 × 10^8');
  assert.equal(stripOptionPrefix('$$\\left( B \\right) 3.1492\\times10^7$$', 'B'), '3.1492\\times10^7$$');
  assert.equal(stripOptionPrefix('\\((C)\\) 31.492×10^6', 'C'), '31.492×10^6');
  assert.equal(stripOptionPrefix('D. 314.92×10^5', 'D'), '314.92×10^5');
});

test('前台学习提醒按时间、频率和每日一次规则触发', () => {
  const mondayBefore = new Date('2026-08-31T19:30:00+08:00');
  const mondayAfter = new Date('2026-08-31T20:05:00+08:00');
  const sunday = new Date('2026-08-30T20:05:00+08:00');
  const daily = { notification_enabled: true, reminder_time: '20:00', reminder_frequency: 'daily' };
  const weekdays = { ...daily, reminder_frequency: 'weekdays' };
  assert.equal(learningReminderDelay(daily, '', mondayBefore), 30 * 60 * 1000);
  assert.equal(learningReminderDelay(daily, '', mondayAfter), 0);
  assert.equal(learningReminderDelay(daily, localDateKey(mondayAfter), mondayAfter), null);
  assert.equal(learningReminderDelay(weekdays, '', sunday), null);
  assert.equal(learningReminderDelay({ ...daily, notification_enabled: false }, '', mondayAfter), null);
});

const question = (userId, index) => ({
  _id: id('q'), user_id: userId, subject: 'math', type: 'single_choice',
  stem: `测试题 ${index}：1 + ${index} = ?`,
  options: { A: String(index), B: String(index + 1), C: String(index + 2), D: String(index + 3) },
  correct_answer: 'B', analysis: '直接计算。', error_prone_point: '注意加法。',
  knowledge_points: ['基础运算'], difficulty: 'easy', mastery_status: 'unmastered', source: 'photo',
  image_file_id: '', markdown_file_id: '', index_status: 'ready', practice_count: 0, wrong_count: 0,
  last_practiced_at: null, created_at: nowIso(), updated_at: nowIso()
});

test('健康检查和认证保护正常', async () => {
  const app = createApp({ config });
  const health = await request(app).get('/health').expect(200);
  assert.equal(health.body.data.status, 'ok');
  assert.equal(health.body.data.capabilities.auth, true);
  const denied = await request(app).get('/v1/profile').expect(401);
  assert.equal(denied.body.error.code, 'AUTH_REQUIRED');
});

test('生产环境的 OCR 或向量配置缺失时不阻塞登录服务启动', async () => {
  const productionConfig = {
    ...config,
    nodeEnv: 'production',
    dataDriver: 'cloudbase',
    mockExternalServices: false,
    cloudbaseEnvId: 'production-env',
    wechatAppSecret: 'wechat-secret',
    tencentSecretId: '',
    tencentSecretKey: '',
    alibabaCloudAccessKeyId: '',
    alibabaCloudAccessKeySecret: '',
    deepseekApiKey: '',
    dashVectorEndpoint: '',
    dashVectorApiKey: '',
    dashScopeBaseUrl: '',
    dashScopeApiKey: ''
  };
  const status = getProductionConfigStatus(productionConfig);
  assert.equal(status.authReady, true);
  assert.equal(status.recognitionReady, false);
  assert.equal(status.searchReady, false);

  const aliyunReady = getProductionConfigStatus({
    ...productionConfig,
    alibabaCloudAccessKeyId: 'aliyun-access-key-id',
    alibabaCloudAccessKeySecret: 'aliyun-access-key-secret',
    deepseekApiKey: 'deepseek-api-key'
  });
  assert.equal(aliyunReady.recognitionReady, true);

  const dashScopeAiReady = getProductionConfigStatus({
    ...productionConfig,
    alibabaCloudAccessKeyId: 'aliyun-access-key-id',
    alibabaCloudAccessKeySecret: 'aliyun-access-key-secret',
    deepseekApiKey: '',
    deepseekBaseUrl: '',
    dashScopeBaseUrl: 'https://workspace.example.com/compatible-mode/v1',
    dashScopeApiKey: 'dashscope-api-key'
  });
  assert.equal(dashScopeAiReady.recognitionReady, true);

  const app = createApp({
    config: productionConfig,
    store: new MemoryDataStore(),
    storage: {}
  });
  const health = await request(app).get('/health').expect(200);
  assert.equal(health.body.data.status, 'ok');
  assert.deepEqual(health.body.data.capabilities, {
    auth: true,
    recognition: false,
    search: false
  });
});

test('生产环境登录核心配置缺失时保持健康检查可用并拒绝登录', async () => {
  const brokenConfig = {
    ...config,
    nodeEnv: 'production',
    dataDriver: 'memory',
    mockExternalServices: true,
    sessionSecret: 'development-only-session-secret',
    cloudbaseEnvId: '',
    wechatAppSecret: ''
  };
  const app = createApp({ config: brokenConfig });
  const health = await request(app).get('/health').expect(200);
  assert.equal(health.body.data.status, 'degraded');
  assert.equal(health.body.data.capabilities.auth, false);

  const response = await request(app).post('/v1/auth/wechat-login').send({
    code: 'student',
    agreement_consent: true,
    privacy_consent: true,
    consent_version: '2026-08-24'
  }).expect(503);
  assert.equal(response.body.error.code, 'SERVER_CONFIG_ERROR');
});

test('未主动同意用户协议和隐私政策时服务端拒绝登录', async () => {
  const app = createApp({ config });
  const response = await request(app).post('/v1/auth/wechat-login').send({ code: 'no-consent' }).expect(400);
  assert.equal(response.body.error.code, 'PRIVACY_CONSENT_REQUIRED');
});

test('首次登录使用微信头像和名称作为个人资料默认值', async () => {
  const app = createApp({ config });
  const response = await request(app).post('/v1/auth/wechat-login').send({
    code: 'wechat-profile-student',
    agreement_consent: true,
    privacy_consent: true,
    consent_version: '2026-08-24',
    wechat_profile: {
      nickname: '微信同学',
      avatar_url: 'https://thirdwx.qlogo.cn/example/avatar'
    }
  }).expect(200);

  assert.equal(response.body.data.user.nickname, '微信同学');
  assert.equal(response.body.data.user.avatar_url, 'https://thirdwx.qlogo.cn/example/avatar');
  const profile = await request(app)
    .get('/v1/profile')
    .set(auth(response.body.data.token))
    .expect(200);
  assert.equal(profile.body.data.user.nickname, '微信同学');
  assert.equal(profile.body.data.user.avatar_url, 'https://thirdwx.qlogo.cn/example/avatar');
});

test('重新登录不覆盖用户已保存的头像和名称', async () => {
  const app = createApp({ config });
  const session = await login(app, 'saved-profile-student');
  const headers = auth(session.token);
  await request(app).patch('/v1/profile').set(headers).send({ nickname: '我的名称' }).expect(200);
  await request(app)
    .post('/v1/profile/avatar')
    .set(headers)
    .attach('avatar', Buffer.from('saved-avatar'), { filename: 'avatar.png', contentType: 'image/png' })
    .expect(200);

  const relogin = await request(app).post('/v1/auth/wechat-login').send({
    code: 'saved-profile-student',
    agreement_consent: true,
    privacy_consent: true,
    consent_version: '2026-08-24',
    wechat_profile: {
      nickname: '新微信名称',
      avatar_url: 'https://thirdwx.qlogo.cn/new/avatar'
    }
  }).expect(200);

  assert.equal(relogin.body.data.user.nickname, '我的名称');
  const profile = await request(app)
    .get('/v1/profile')
    .set(auth(relogin.body.data.token))
    .expect(200);
  assert.equal(profile.body.data.user.nickname, '我的名称');
  assert.match(profile.body.data.user.avatar_url, /^memory:\/\/users\//);
});

test('用户可以保存昵称和头像并在个人中心读取最新资料', async () => {
  const app = createApp({ config });
  const session = await login(app, 'profile-student');
  const headers = auth(session.token);

  const nickname = await request(app).patch('/v1/profile').set(headers).send({ nickname: '微信学习昵称' }).expect(200);
  assert.equal(nickname.body.data.nickname, '微信学习昵称');

  const avatar = await request(app)
    .post('/v1/profile/avatar')
    .set(headers)
    .attach('avatar', Buffer.from('fake-avatar'), { filename: 'avatar.png', contentType: 'image/png' })
    .expect(200);
  assert.match(avatar.body.data.avatar_url, /^memory:\/\/users\//);

  const profile = await request(app).get('/v1/profile').set(headers).expect(200);
  assert.equal(profile.body.data.user.nickname, '微信学习昵称');
  assert.match(profile.body.data.user.avatar_url, /^memory:\/\/users\//);
  const firstStoredUser = await app.locals.services.store.get('users', session.user.id);
  assert.match(firstStoredUser.avatar_file_id, /\/profile\/avatar-asset_[a-f0-9]+\.png$/);
  assert.equal(app.locals.services.storage.memory.has(firstStoredUser.avatar_file_id.replace('memory://', '')), true);

  const replacedAvatar = await request(app)
    .post('/v1/profile/avatar')
    .set(headers)
    .attach('avatar', Buffer.from('new-fake-avatar'), { filename: 'avatar.png', contentType: 'image/png' })
    .expect(200);
  const replacedUser = await app.locals.services.store.get('users', session.user.id);
  assert.match(replacedAvatar.body.data.avatar_url, /^memory:\/\/users\//);
  assert.notEqual(replacedUser.avatar_file_id, firstStoredUser.avatar_file_id);
  assert.equal(app.locals.services.storage.memory.has(firstStoredUser.avatar_file_id.replace('memory://', '')), false);
  assert.equal(app.locals.services.storage.memory.has(replacedUser.avatar_file_id.replace('memory://', '')), true);
});

test('科目设置可持久化且部分更新不覆盖消息通知', async () => {
  const app = createApp({ config });
  const session = await login(app, 'subject-settings-student');
  const headers = auth(session.token);

  const defaults = await request(app).get('/v1/settings').set(headers).expect(200);
  assert.deepEqual(defaults.body.data.visible_subjects, [
    'chinese', 'math', 'english', 'physics', 'chemistry', 'biology', 'history', 'geography', 'politics'
  ]);
  assert.equal(defaults.body.data.recommendation_weak_first, true);
  assert.equal(defaults.body.data.recommendation_difficulty, 'adaptive');
  assert.equal(defaults.body.data.practice_question_limit, 10);
  assert.equal(defaults.body.data.mastered_question_ratio, 20);
  assert.equal(defaults.body.data.reminder_time, '20:00');
  assert.equal(defaults.body.data.reminder_frequency, 'daily');

  await request(app).patch('/v1/settings').set(headers).send({
    notification_enabled: true,
    reminder_time: '21:15',
    reminder_frequency: 'weekdays',
    recommendation_weak_first: false,
    recommendation_difficulty: 'hard',
    practice_question_limit: 15,
    mastered_question_ratio: 30
  }).expect(200);
  const updated = await request(app)
    .patch('/v1/settings')
    .set(headers)
    .send({ visible_subjects: ['chemistry', 'math', 'physics'] })
    .expect(200);
  assert.equal(updated.body.data.notification_enabled, true);
  assert.equal(updated.body.data.reminder_time, '21:15');
  assert.equal(updated.body.data.reminder_frequency, 'weekdays');
  assert.equal(updated.body.data.recommendation_weak_first, false);
  assert.equal(updated.body.data.recommendation_difficulty, 'hard');
  assert.equal(updated.body.data.practice_question_limit, 15);
  assert.equal(updated.body.data.mastered_question_ratio, 30);
  assert.deepEqual(updated.body.data.visible_subjects, ['chemistry', 'math', 'physics']);

  const stored = await request(app).get('/v1/settings').set(headers).expect(200);
  assert.equal(stored.body.data.notification_enabled, true);
  assert.equal(stored.body.data.reminder_time, '21:15');
  assert.equal(stored.body.data.reminder_frequency, 'weekdays');
  assert.equal(stored.body.data.recommendation_weak_first, false);
  assert.equal(stored.body.data.recommendation_difficulty, 'hard');
  assert.equal(stored.body.data.practice_question_limit, 15);
  assert.equal(stored.body.data.mastered_question_ratio, 30);
  assert.deepEqual(stored.body.data.visible_subjects, ['chemistry', 'math', 'physics']);
  await request(app).patch('/v1/settings').set(headers).send({ visible_subjects: [] }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ visible_subjects: ['math', 'unknown'] }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ recommendation_difficulty: 'extreme' }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ reminder_time: '25:99' }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ reminder_frequency: 'monthly' }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ practice_question_limit: 0 }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ practice_question_limit: 21 }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ mastered_question_ratio: -1 }).expect(400);
  await request(app).patch('/v1/settings').set(headers).send({ mastered_question_ratio: 51 }).expect(400);
});

test('连续学习在当天尚未练习时保留截至昨天的连续天数', () => {
  const service = new ProfileService();
  const now = new Date('2026-08-27T00:30:00+08:00');
  const records = [
    { submitted_at: '2026-08-26T21:00:00+08:00' },
    { submitted_at: '2026-08-25T09:00:00+08:00' },
    { submitted_at: '2026-08-24T23:30:00+08:00' }
  ];

  assert.equal(service.streak(records, now), 3);
});

test('连续学习按北京时间跨日并在完整漏学一天后归零', () => {
  const service = new ProfileService();
  const now = new Date('2026-08-27T00:30:00+08:00');
  const todayAndYesterday = [
    { submitted_at: '2026-08-26T16:10:00.000Z' },
    { submitted_at: '2026-08-25T16:10:00.000Z' }
  ];
  const missedYesterday = [
    { submitted_at: '2026-08-27T00:10:00+08:00' },
    { submitted_at: '2026-08-25T20:00:00+08:00' }
  ];

  assert.equal(service.streak(todayAndYesterday, now), 2);
  assert.equal(service.streak(missedYesterday, now), 1);
  assert.equal(service.streak([{ submitted_at: '2026-08-25T20:00:00+08:00' }], now), 0);
});

test('HTTP 链路兼容使用 Base64 JSON 上传头像和识别图片', async () => {
  const app = createApp({ config });
  const session = await login(app, 'cloud-upload-student');
  const headers = auth(session.token);
  const fileBase64 = Buffer.from('cloud-container-image').toString('base64');

  const avatar = await request(app)
    .post('/v1/profile/avatar')
    .set(headers)
    .send({ file_base64: fileBase64, file_name: 'avatar.png', mime_type: 'image/png' })
    .expect(200);
  assert.match(avatar.body.data.avatar_url, /^memory:\/\/users\//);

  const recognition = await request(app)
    .post('/v1/recognitions')
    .set(headers)
    .send({ file_base64: fileBase64, file_name: 'image.jpg', mime_type: 'image/jpeg' })
    .expect(201);
  assert.equal(recognition.body.data.status, 'created');
  const completed = await waitForRecognition(app, session.token, recognition.body.data.task_id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.stage, 'completed');
});

test('慢速 OCR 不阻塞识别任务创建接口', async () => {
  let resolveOcr;
  const ocr = {
    config,
    action: 'RecognizeEduQuestionOcr',
    recognize: () => new Promise((resolve) => { resolveOcr = resolve; })
  };
  const app = createApp({ config, ocr });
  const session = await login(app, 'async-recognition-student');
  const created = await request(app)
    .post('/v1/recognitions')
    .set(auth(session.token))
    .attach('image', Buffer.from('slow-image'), 'question.jpg')
    .expect(201);

  assert.equal(created.body.data.status, 'created');
  assert.equal(created.body.data.stage, 'uploaded');
  const processing = request(app)
    .post(`/v1/recognitions/${created.body.data.task_id}/process`)
    .set(auth(session.token))
    .expect(200)
    .then((response) => response);
  while (typeof resolveOcr !== 'function') await new Promise((resolve) => setTimeout(resolve, 1));
  resolveOcr('数学 单项选择题 1+1=（ ） A.1 B.2 C.3');
  await processing;
  const completed = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(completed.status, 'succeeded');
});

test('云托管链路通过云存储文件标识上传并清理临时图片', async () => {
  const downloaded = [];
  const deleted = [];
  const storage = {
    upload: async (path) => `memory://${path}`,
    download: async (fileId) => {
      downloaded.push(fileId);
      return Buffer.from('cloud-storage-image');
    },
    delete: async (fileId) => { deleted.push(fileId); },
    downloadUrl: async (fileId) => fileId
  };
  const app = createApp({ config, storage });
  const session = await login(app, 'cloud-file-id-student');
  const headers = auth(session.token);
  const avatarFileId = 'cloud://test-env.bucket/client-uploads/avatar/avatar.png';
  const recognitionFileId = 'cloud://test-env.bucket/client-uploads/image/question.jpg';

  const avatar = await request(app)
    .post('/v1/profile/avatar')
    .set(headers)
    .send({ cloud_file_id: avatarFileId, file_name: 'avatar.png', mime_type: 'image/png' })
    .expect(200);
  assert.match(avatar.body.data.avatar_url, /^memory:\/\/users\//);

  const recognition = await request(app)
    .post('/v1/recognitions')
    .set(headers)
    .send({ cloud_file_id: recognitionFileId, file_name: 'image.jpg', mime_type: 'image/jpeg' })
    .expect(201);
  assert.equal(recognition.body.data.status, 'created');
  const completed = await waitForRecognition(app, session.token, recognition.body.data.task_id);
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(downloaded.slice(0, 2), [avatarFileId, recognitionFileId]);
  assert.match(downloaded[2], /^memory:\/\/users\//);
  assert.deepEqual(deleted, [avatarFileId, recognitionFileId]);
});

test('CloudBase 数据层兼容 JS SDK v3 的 data.list 响应与直接字段写入', async () => {
  const rows = [{ _id: 'usr_cloudbase', nickname: '云端用户' }];
  const writes = [];
  const document = {
    get: async () => ({ data: { code: 'SUCCESS', list: rows } }),
    set: async (data) => { writes.push({ method: 'set', data }); },
    update: async (data) => { writes.push({ method: 'update', data }); return { updated: 1 }; }
  };
  const query = {
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    get: async () => ({ data: { code: 'SUCCESS', list: rows } })
  };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = { collection: () => ({ doc: () => document, where: () => query }) };

  assert.deepEqual(await store.find('users', { limit: 1 }), rows);
  assert.deepEqual(await store.get('users', 'usr_cloudbase'), rows[0]);
  await store.put('users', { _id: 'usr_cloudbase', nickname: '更新用户' });
  await store.update('users', 'usr_cloudbase', { nickname: '再次更新' });
  assert.deepEqual(writes, [
    { method: 'set', data: { nickname: '更新用户' } },
    { method: 'update', data: { nickname: '再次更新' } }
  ]);
});

test('CloudBase 积分事务使用同一事务上下文完成读取、写入、更新和查询', async () => {
  const calls = [];
  const rows = new Map([['point_account_user', { _id: 'point_account_user', balance: 2 }]]);
  const transaction = {
    collection(name) {
      return {
        doc(rowId) {
          return {
            get: async () => ({ data: { code: 'SUCCESS', list: rows.has(rowId) ? [rows.get(rowId)] : [] } }),
            set: async (data) => {
              calls.push(['set', name, rowId, data]);
              rows.set(rowId, { _id: rowId, ...data });
            },
            update: async (patch) => {
              calls.push(['update', name, rowId, patch]);
              rows.set(rowId, { ...rows.get(rowId), ...patch });
            }
          };
        },
        where(where) {
          calls.push(['where', name, where]);
          return {
            orderBy(field, direction) { calls.push(['orderBy', field, direction]); return this; },
            skip(offset) { calls.push(['skip', offset]); return this; },
            limit(limit) { calls.push(['limit', limit]); return this; },
            get: async () => ({ data: { code: 'SUCCESS', list: [...rows.values()] } })
          };
        }
      };
    }
  };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    runTransaction: async (callback) => {
      calls.push(['transaction']);
      return callback(transaction);
    }
  };

  const result = await store.runTransaction(async (tx) => {
    assert.deepEqual(await tx.get('point_accounts', 'point_account_user'), { _id: 'point_account_user', balance: 2 });
    await tx.put('point_transactions', { _id: 'txn_1', delta: 2 });
    await tx.update('point_accounts', 'point_account_user', { balance: 4 });
    const found = await tx.find('point_accounts', { where: { user_id: 'user' }, orderBy: 'created_at', direction: 'asc', offset: 1, limit: 20 });
    return found.length;
  });

  assert.equal(result, 2);
  assert.deepEqual(rows.get('point_account_user'), { _id: 'point_account_user', balance: 4 });
  assert.deepEqual(rows.get('txn_1'), { _id: 'txn_1', delta: 2 });
  assert.deepEqual(calls, [
    ['transaction'],
    ['set', 'point_transactions', 'txn_1', { delta: 2 }],
    ['update', 'point_accounts', 'point_account_user', { balance: 4 }],
    ['where', 'point_accounts', { user_id: 'user' }],
    ['orderBy', 'created_at', 'asc'],
    ['skip', 1],
    ['limit', 20]
  ]);
});

test('CloudBase 将不存在的普通文档和事务文档统一视为 null', async () => {
  const missing = Object.assign(new Error('Document not found'), { code: 'DOCUMENT_NOT_FOUND' });
  const document = { get: async () => { throw missing; } };
  const transaction = { collection: () => ({ doc: () => document }) };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    collection: () => ({ doc: () => document }),
    runTransaction: async (callback) => callback(transaction)
  };

  assert.equal(await store.get('point_accounts', 'missing'), null);
  assert.equal(await store.runTransaction((tx) => tx.get('point_accounts', 'missing')), null);
});

test('CloudBase 数据层可以读取旧版错误嵌套在 data 字段中的记录', async () => {
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    collection: () => ({
      where: () => ({
        limit() { return this; },
        get: async () => ({ data: { list: [{ _id: 'usr_legacy', data: { nickname: '旧数据' } }] } })
      })
    })
  };
  assert.deepEqual(await store.find('users'), [{ _id: 'usr_legacy', nickname: '旧数据' }]);
});

test('CloudBase 未确认嵌套字段更新时不再静默返回成功', async () => {
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: { code: 'SUCCESS', list: [{ _id: 'rec_unconfirmed', parsed_question: null }] } }),
        update: async () => ({ requestId: 'request-without-updated-count' }),
        set: async () => ({ requestId: 'fallback-request-without-write' })
      })
    })
  };
  await assert.rejects(
    () => store.update('recognition_tasks', 'rec_unconfirmed', { parsed_question: { subject: 'math' } }),
    (error) => error.code === 'CLOUDBASE_UPDATE_UNCONFIRMED' && error.status === 502
  );
});

test('CloudBase 更新响应缺少计数时通过回读确认 recognition_tasks 已落库', async () => {
  let readCount = 0;
  const before = { _id: 'rec_readback', status: 'created', stage: 'uploaded', parsed_questions: [] };
  const patch = {
    status: 'processing',
    stage: 'deepseek',
    parsed_questions: [{ item_id: 'item_1', status: 'valid' }]
  };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    collection: () => ({
      doc: () => ({
        get: async () => {
          readCount += 1;
          return { data: { code: 'SUCCESS', list: [{ ...before, ...(readCount > 1 ? patch : {}) }] } };
        },
        update: async () => ({ requestId: 'request-without-updated-count' })
      })
    })
  };

  const result = await store.update('recognition_tasks', before._id, patch);
  assert.equal(readCount, 2);
  assert.equal(result.stage, 'deepseek');
  assert.deepEqual(result.parsed_questions, patch.parsed_questions);
});

test('CloudBase update 未生效时使用 set 兜底并二次回读确认', async () => {
  let persisted = false;
  let readCount = 0;
  let setCount = 0;
  const before = { _id: 'rec_set_fallback', status: 'created', stage: 'uploaded' };
  const patch = { status: 'processing', stage: 'ocr', updated_at: '2026-08-29T01:00:00.000Z' };
  const document = {
    get: async () => {
      readCount += 1;
      return { data: { code: 'SUCCESS', list: [{ ...before, ...(persisted ? patch : {}) }] } };
    },
    update: async () => ({ requestId: 'update-without-count' }),
    set: async (data) => {
      setCount += 1;
      assert.equal(data._id, undefined);
      assert.equal(data.stage, 'ocr');
      persisted = true;
      return { requestId: 'set-fallback-success' };
    }
  };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = { collection: () => ({ doc: () => document }) };

  const result = await store.update('recognition_tasks', before._id, patch);
  assert.equal(readCount, 3);
  assert.equal(setCount, 1);
  assert.equal(result.status, 'processing');
  assert.equal(result.stage, 'ocr');
});

test('CloudBase 数据层支持历史向量索引的分页扫描', async () => {
  const calls = [];
  const query = {
    where() { return this; },
    orderBy(field, direction) { calls.push(['orderBy', field, direction]); return this; },
    skip(offset) { calls.push(['skip', offset]); return this; },
    limit(limit) { calls.push(['limit', limit]); return this; },
    get: async () => ({ data: { code: 'SUCCESS', list: [{ _id: 'q_page_2' }] } })
  };
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = { collection: () => ({ where: () => query }) };

  assert.deepEqual(
    await store.find('questions', { orderBy: '_id', direction: 'asc', offset: 100, limit: 100 }),
    [{ _id: 'q_page_2' }]
  );
  assert.deepEqual(calls, [['orderBy', '_id', 'asc'], ['skip', 100], ['limit', 100]]);
});

test('CloudBase 集合不存在时返回可操作的服务错误', async () => {
  const store = Object.create(CloudBaseDataStore.prototype);
  store.db = {
    collection: () => ({
      where: () => ({
        limit() { return this; },
        get: async () => ({
          code: 'DATABASE_COLLECTION_NOT_EXIST',
          data: { code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'Db or Table not exist', list: [] }
        })
      })
    })
  };
  await assert.rejects(
    () => store.find('users'),
    (error) => error.code === 'CLOUDBASE_COLLECTION_NOT_FOUND' && error.status === 503
  );
});

test('后端重启后内存用户丢失时旧令牌返回 401 而不是 500', async () => {
  const app = createApp({ config });
  const staleToken = jwt.sign({ sub: 'usr_missing_after_restart' }, config.sessionSecret, { expiresIn: '30d' });
  const headers = auth(staleToken);

  const profile = await request(app).get('/v1/profile').set(headers).expect(401);
  assert.equal(profile.body.error.code, 'AUTH_REQUIRED');

  const settings = await request(app).get('/v1/settings').set(headers).expect(401);
  assert.equal(settings.body.error.code, 'AUTH_REQUIRED');
});

test('图片识别、保存、详情与用户隔离形成闭环', async () => {
  const app = createApp({ config });
  const first = await login(app, 'first');
  const created = await request(app).post('/v1/recognitions').set(auth(first.token)).attach('image', Buffer.from('fake-image'), 'question.jpg').expect(201);
  const taskId = created.body.data.task_id;
  assert.equal(created.body.data.status, 'created');
  assert.equal(created.body.data.stage, 'uploaded');
  const task = await waitForRecognition(app, first.token, taskId);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.stage, 'completed');
  assert.equal(task.provider_mode, 'mock');
  assert.equal(task.ocr_engine, 'RecognizeEduQuestionOcr');
  assert.match(task.raw_text, /一元二次方程/);
  assert.equal(task.parsed_question.type, 'single_choice');
  const saved = await request(app).post(`/v1/recognitions/${taskId}/save`).set(auth(first.token)).expect(201);
  const questionId = saved.body.data.question_id;
  const detail = await request(app).get(`/v1/questions/${questionId}`).set(auth(first.token)).expect(200);
  assert.equal(detail.body.data.correct_answer, 'B');
  const exported = await request(app).post('/v1/exports').set(auth(first.token)).expect(201);
  assert.equal(exported.body.data.question_count, 1);
  assert.equal(exported.body.data.practice_record_count, 0);
  assert.match(exported.body.data.file_id, /^memory:\/\//);
  assert.match(exported.body.data.pdf_file_id, /^memory:\/\//);
  assert.match(exported.body.data.markdown_file_id, /^memory:\/\//);
  const second = await login(app, 'second');
  await request(app).get(`/v1/questions/${questionId}`).set(auth(second.token)).expect(404);
});

test('批量识别支持逐题校验、勾选保存与确定性幂等', async () => {
  const batchConfig = { ...config };
  const ocr = {
    config: batchConfig,
    action: 'RecognizeEduQuestionOcr',
    recognize: async () => ({
      rawText: '1. 1+1=?\nA.1\nB.2\n2. 2+2=?\nA.3\nB.4\n3. 题干被截断',
      angle: 0,
      lines: [
        '1. 1+1=?', 'A.1', 'B.2', '2. 2+2=?', 'A.3', 'B.4', '3. 题干被截断'
      ].map((text, index) => ({ index: index + 1, text, confidence: 99, item_polygon: { x: 0, y: index * 20, width: 200, height: 18 } }))
    })
  };
  const adapter = new DeepSeekAdapter({ ...batchConfig, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 3,
    has_more_questions: false,
    questions: [
      {
        source_complete: true, incomplete_reason: '', source_line_range: [1, 3], subject: 'math', type: 'single_choice',
        stem: '1+1=?', options: { A: '1', B: '2' }, correct_answer: 'B', analysis: '1+1=2。',
        error_prone_point: '注意加法。', knowledge_points: ['加法'], difficulty: 'easy'
      },
      {
        source_complete: true, incomplete_reason: '', source_line_range: [4, 6], subject: 'math', type: 'single_choice',
        stem: '2+2=?', options: { A: '3', B: '4' }, correct_answer: 'B', analysis: '2+2=4。',
        error_prone_point: '注意加法。', knowledge_points: ['加法'], difficulty: 'easy'
      },
      { source_complete: false, incomplete_reason: '第3题题干和选项被截断', source_line_range: [7, 7] }
    ]
  });
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config: batchConfig, ocr, deepseek: adapter, vector });
  const first = await login(app, 'batch-first');
  const created = await request(app)
    .post('/v1/recognitions?mode=batch')
    .set(auth(first.token))
    .attach('image', Buffer.from('batch-image'), 'questions.jpg')
    .expect(201);
  const taskId = created.body.data.task_id;
  const task = await waitForRecognition(app, first.token, taskId);
  assert.equal(task.mode, 'batch');
  assert.equal(task.detected_question_count, 3);
  assert.equal(task.valid_question_count, 2);
  assert.equal(task.parsed_questions[2].status, 'invalid');
  assert.match(task.parsed_questions[2].error_message, /截断/);

  await request(app).post(`/v1/recognitions/${taskId}/save`).set(auth(first.token)).send({}).expect(400);
  await request(app).post(`/v1/recognitions/${taskId}/save`).set(auth(first.token)).send({ item_ids: ['item_3'] }).expect(400);
  const firstSave = (await request(app)
    .post(`/v1/recognitions/${taskId}/save`)
    .set(auth(first.token))
    .send({ item_ids: ['item_1', 'item_2'] })
    .expect(201)).body.data;
  assert.equal(firstSave.question_ids.length, 2);
  assert.equal(firstSave.failed_items.length, 0);
  assert.equal(new Set(firstSave.question_ids).size, 2);

  const repeated = (await request(app)
    .post(`/v1/recognitions/${taskId}/save`)
    .set(auth(first.token))
    .send({ item_ids: ['item_1', 'item_2'] })
    .expect(201)).body.data;
  assert.deepEqual(repeated.question_ids, firstSave.question_ids);
  const stored = await app.locals.services.store.find('questions', { where: { user_id: first.user.id }, limit: 10 });
  assert.equal(stored.length, 2);
  assert(stored.every((item) => item.recognition_task_id === taskId && item.index_status === 'ready'));

  const second = await login(app, 'batch-second');
  await request(app).get(`/v1/recognitions/${taskId}`).set(auth(second.token)).expect(404);
});

test('含配图试题会按 OCR 题目边界裁取原图并贯穿详情与练习快照', async () => {
  const illustratedConfig = { ...config, mockExternalServices: false };
  const lines = [
    { index: 1, text: '1. 如图所示，波形在该时刻如何运动？', item_polygon: { x: 30, y: 40, width: 430, height: 28 } },
    { index: 2, text: 'A. 向上 B. 向下', item_polygon: { x: 50, y: 210, width: 300, height: 26 } },
    { index: 3, text: '2. 1+1等于多少？', item_polygon: { x: 30, y: 340, width: 300, height: 28 } },
    { index: 4, text: 'A. 1 B. 2', item_polygon: { x: 50, y: 410, width: 240, height: 26 } }
  ];
  const ocr = {
    config: illustratedConfig,
    action: 'RecognizeEduPaperCut',
    recognize: async () => ({
      rawText: lines.map((line) => line.text).join('\n'),
      lines,
      angle: 0,
      engine: 'RecognizeEduPaperCut',
      imageWidth: 800,
      imageHeight: 600,
      figures: [{ type: 'subject_pattern', rect: { x: 470, y: 70, width: 250, height: 180 } }],
      questionBlocks: [
        { index: 1, source_line_range: [1, 2], source_rect: { x: 30, y: 40, width: 690, height: 220 } },
        { index: 2, source_line_range: [3, 4], source_rect: { x: 30, y: 340, width: 310, height: 100 } }
      ]
    })
  };
  const parsedQuestion = (stem, answer = 'B') => ({
    subject: 'physics', subject_candidates: ['physics'], is_cross_subject: false,
    type: 'single_choice', stem, options: { A: '向上', B: '向下' }, correct_answer: answer,
    analysis: '根据图形判断。', error_prone_point: '需要结合图形。', knowledge_points: ['波形'], difficulty: 'medium'
  });
  const deepseek = {
    config: illustratedConfig,
    parseQuestions: async () => ({
      detected_count: 2,
      valid_question_count: 2,
      image_quality: { compliant: true, issues: [], message: '', tips: [] },
      parsed_questions: [
        { item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: [1, 2], question: parsedQuestion('如图所示，波形在该时刻如何运动？') },
        { item_id: 'item_2', order: 2, status: 'valid', error_message: '', source_line_range: [3, 4], question: { ...parsedQuestion('1+1等于多少？'), subject: 'math', subject_candidates: ['math'], knowledge_points: ['加法'] } }
      ]
    }),
    rankCandidateIds: async (items, count) => items.slice(0, count).map((item) => item.id)
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config, ocr, deepseek, vector });
  const session = await login(app, 'illustrated-question-student');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="white"/><path d="M480 180 C540 70 620 280 710 120" fill="none" stroke="black" stroke-width="6"/><line x1="470" y1="180" x2="730" y2="180" stroke="black" stroke-width="3"/><text x="30" y="70" font-size="28">1. illustrated question</text><text x="30" y="370" font-size="28">2. text question</text></svg>');
  const created = await request(app)
    .post('/v1/recognitions?mode=batch')
    .set(auth(session.token))
    .attach('image', svg, { filename: 'illustrated.svg', contentType: 'image/svg+xml' })
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.parsed_questions[0].question.has_illustration, true);
  assert.match(task.parsed_questions[0].question.question_image_file_id, /^memory:\/\//);
  assert.equal(task.parsed_questions[1].question.has_illustration, false);
  assert.equal(task.parsed_questions[1].question.question_image_file_id, undefined);

  const croppedPath = task.parsed_questions[0].question.question_image_file_id.replace('memory://', '');
  const croppedBuffer = app.locals.services.storage.memory.get(croppedPath);
  const croppedMetadata = await sharp(croppedBuffer).metadata();
  // 只裁图形部分：紧贴图像中的波形，不含题目文字
  assert(croppedMetadata.width >= 250 && croppedMetadata.width < 400);
  assert(croppedMetadata.height >= 60 && croppedMetadata.height < 120);
  assert.equal(task.parsed_questions[0].question.question_image_source, 'ocr_figure');
  assert.equal(task.parsed_questions[0].question.question_image_is_fallback, false);
  const localAsset = await request(app)
    .get('/v1/local-assets/question-image')
    .set(auth(session.token))
    .query({ file_id: task.parsed_questions[0].question.question_image_file_id })
    .expect('Content-Type', /image\/jpeg/)
    .expect(200);
  assert.equal(Buffer.compare(localAsset.body, croppedBuffer), 0);
  const otherSession = await login(app, 'illustrated-question-other-student');
  await request(app)
    .get('/v1/local-assets/question-image')
    .set(auth(otherSession.token))
    .query({ file_id: task.parsed_questions[0].question.question_image_file_id })
    .expect(404);

  const saved = (await request(app)
    .post(`/v1/recognitions/${created.body.data.task_id}/save`)
    .set(auth(session.token))
    .send({ item_ids: ['item_1'] })
    .expect(201)).body.data;
  const questionId = saved.question_ids[0];
  const detail = (await request(app).get(`/v1/questions/${questionId}`).set(auth(session.token)).expect(200)).body.data;
  assert.equal(detail.question_image_file_id, task.parsed_questions[0].question.question_image_file_id);

  const practice = (await request(app)
    .post('/v1/practice-sessions/from-questions')
    .set(auth(session.token))
    .send({ question_ids: [questionId], type: 'single' })
    .expect(201)).body.data;
  const practiceSession = (await request(app)
    .get(`/v1/practice-sessions/${practice.practice_session_id}`)
    .set(auth(session.token))
    .expect(200)).body.data;
  assert.equal(practiceSession.questions[0].question_image_file_id, detail.question_image_file_id);
  const submitted = (await request(app)
    .post(`/v1/practice-sessions/${practice.practice_session_id}/submit`)
    .set(auth(session.token))
    .send({ answers: { [questionId]: 'B' } })
    .expect(200)).body.data;
  const record = (await request(app)
    .get(`/v1/practice-records/${submitted.practice_record_id}`)
    .set(auth(session.token))
    .expect(200)).body.data;
  assert.equal(record.items[0].question_image_file_id, detail.question_image_file_id);
});



test('图形位于最后一道题下方且无下一题边界时，像素兜底完整裁入图形高度', async () => {
  const cfg = config;
  const line = { index: 1, text: '1. 如图所示，求该圆的面积。', item_polygon: { x: 30, y: 40, width: 600, height: 60 } };
  const ocr = {
    config: cfg,
    action: 'RecognizeEduPaperCut',
    recognize: async () => ({
      rawText: line.text,
      lines: [line],
      angle: 0,
      engine: 'RecognizeEduPaperCut',
      imageWidth: 800,
      imageHeight: 1000,
      figures: [],
      questionBlocks: [
        { index: 1, source_line_range: [1, 1], source_rect: { x: 30, y: 40, width: 600, height: 60 } }
      ]
    })
  };
  const parsedQuestion = (stem) => ({
    subject: 'math', subject_candidates: ['math'], is_cross_subject: false,
    type: 'short_answer', stem, options: {}, correct_answer: '略', analysis: '略',
    error_prone_point: '', knowledge_points: ['圆'], difficulty: 'medium'
  });
  const deepseek = {
    config: cfg,
    parseQuestions: async () => ({
      detected_count: 1,
      valid_question_count: 1,
      image_quality: { compliant: true, issues: [], message: '', tips: [] },
      parsed_questions: [
        { item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: [1, 1], question: parsedQuestion('如图所示，求该圆的面积。') }
      ]
    }),
    rankCandidateIds: async (items, count) => items.slice(0, count).map((item) => item.id)
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config: cfg, ocr, deepseek, vector });
  const session = await login(app, 'figure-below-last-student');
  // 圆画在文字下方，且 OCR 未返回图形矩形
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="white"/><circle cx="400" cy="220" r="90" fill="none" stroke="black" stroke-width="5"/><text x="30" y="80" font-size="28">1. figure question</text></svg>');
  const created = await request(app)
    .post('/v1/recognitions?mode=batch')
    .set(auth(session.token))
    .attach('image', svg, { filename: 'figure.svg', contentType: 'image/svg+xml' })
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  const item = task.parsed_questions[0];
  assert.equal(item.question.has_illustration, true);
  assert.equal(item.question.question_image_source, 'pixel_detected');
  assert.equal(item.question.question_image_is_fallback, false);
  const croppedBuffer = app.locals.services.storage.memory.get(item.question.question_image_file_id.replace('memory://', ''));
  const meta = await sharp(croppedBuffer).metadata();
  // 只裁图形部分：包含文字下方的圆，而不包含顶部文字行
  assert(meta.width >= 150 && meta.width < 300);
  assert(meta.height >= 150 && meta.height < 300);
});

test('图形在题目右侧同行但 OCR 未返回图形矩形时，能通过像素扫描整体裁入', async () => {
  const cfg = config;
  const line = { index: 1, text: '1. 如图所示，判断该波形。', item_polygon: { x: 20, y: 40, width: 300, height: 60 } };
  const ocr = {
    config: cfg,
    action: 'RecognizeEduPaperCut',
    recognize: async () => ({
      rawText: line.text,
      lines: [line],
      angle: 0,
      engine: 'RecognizeEduPaperCut',
      imageWidth: 800,
      imageHeight: 300,
      figures: [],
      questionBlocks: [
        { index: 1, source_line_range: [1, 1], source_rect: { x: 20, y: 40, width: 300, height: 60 } }
      ]
    })
  };
  const parsedQuestion = (stem) => ({
    subject: 'physics', subject_candidates: ['physics'], is_cross_subject: false,
    type: 'single_choice', stem, options: { A: '向上', B: '向下' }, correct_answer: 'A',
    analysis: '结合图形判断。', error_prone_point: '', knowledge_points: ['波形'], difficulty: 'medium'
  });
  const deepseek = {
    config: cfg,
    parseQuestions: async () => ({
      detected_count: 1,
      valid_question_count: 1,
      image_quality: { compliant: true, issues: [], message: '', tips: [] },
      parsed_questions: [
        { item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: [1, 1], question: parsedQuestion('如图所示，判断该波形。') }
      ]
    }),
    rankCandidateIds: async (items, count) => items.slice(0, count).map((item) => item.id)
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config: cfg, ocr, deepseek, vector });
  const session = await login(app, 'figure-side-student');
  // 图形画在文字右侧同行，且 OCR 未返回图形矩形
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="white"/><rect x="520" y="40" width="200" height="180" fill="none" stroke="black" stroke-width="5"/><text x="20" y="80" font-size="28">1. figure question</text></svg>');
  const created = await request(app)
    .post('/v1/recognitions?mode=batch')
    .set(auth(session.token))
    .attach('image', svg, { filename: 'side-figure.svg', contentType: 'image/svg+xml' })
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  const item = task.parsed_questions[0];
  assert.equal(item.question.has_illustration, true);
  assert.equal(item.question.question_image_source, 'pixel_detected');
  const croppedBuffer = app.locals.services.storage.memory.get(item.question.question_image_file_id.replace('memory://', ''));
  const meta = await sharp(croppedBuffer).metadata();
  // 只裁图形部分：包含右侧同行图形，而不包含左侧文字
  assert(meta.width >= 180 && meta.width < 400);
  assert(meta.height >= 150 && meta.height < 250);
});

test('多栏/多题批量试卷中图形归属到正确题目，不与相邻题图混入', async () => {
  const cfg = config;
  const line1 = { index: 1, text: '1. 如图所示，求左图。', item_polygon: { x: 20, y: 50, width: 200, height: 20 } };
  const line2 = { index: 2, text: '2. 如图所示，求右图。', item_polygon: { x: 420, y: 50, width: 200, height: 20 } };
  const ocr = {
    config: cfg,
    action: 'RecognizeEduPaperCut',
    recognize: async () => ({
      rawText: [line1, line2].map((item) => item.text).join('\n'),
      lines: [line1, line2],
      angle: 0,
      engine: 'RecognizeEduPaperCut',
      imageWidth: 800,
      imageHeight: 400,
      figures: [
        { type: 'subject_pattern', rect: { x: 220, y: 70, width: 100, height: 80 } },
        { type: 'subject_pattern', rect: { x: 520, y: 70, width: 100, height: 80 } }
      ],
      questionBlocks: [
        { index: 1, source_line_range: [1, 1], source_rect: { x: 20, y: 40, width: 320, height: 120 } },
        { index: 2, source_line_range: [2, 2], source_rect: { x: 420, y: 40, width: 320, height: 120 } }
      ]
    })
  };
  const parsedQuestion = (stem) => ({
    subject: 'math', subject_candidates: ['math'], is_cross_subject: false,
    type: 'short_answer', stem, options: {}, correct_answer: '略', analysis: '略',
    error_prone_point: '', knowledge_points: ['几何'], difficulty: 'medium'
  });
  const deepseek = {
    config: cfg,
    parseQuestions: async () => ({
      detected_count: 2,
      valid_question_count: 2,
      image_quality: { compliant: true, issues: [], message: '', tips: [] },
      parsed_questions: [
        { item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: [1, 1], question: parsedQuestion('如图所示，求左图。') },
        { item_id: 'item_2', order: 2, status: 'valid', error_message: '', source_line_range: [2, 2], question: parsedQuestion('如图所示，求右图。') }
      ]
    }),
    rankCandidateIds: async (items, count) => items.slice(0, count).map((item) => item.id)
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config: cfg, ocr, deepseek, vector });
  const session = await login(app, 'multi-column-student');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="white"/><rect x="220" y="70" width="100" height="80" fill="none" stroke="black" stroke-width="4"/><rect x="520" y="70" width="100" height="80" fill="none" stroke="black" stroke-width="4"/><text x="20" y="65" font-size="24">1. left</text><text x="420" y="65" font-size="24">2. right</text></svg>');
  const created = await request(app)
    .post('/v1/recognitions?mode=batch')
    .set(auth(session.token))
    .attach('image', svg, { filename: 'multi-column.svg', contentType: 'image/svg+xml' })
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  const [item1, item2] = task.parsed_questions;
  assert.equal(item1.question.has_illustration, true);
  assert.equal(item1.question.question_image_source, 'ocr_figure');
  assert.equal(item2.question.has_illustration, true);
  assert.equal(item2.question.question_image_source, 'ocr_figure');
  const meta1 = await sharp(app.locals.services.storage.memory.get(item1.question.question_image_file_id.replace('memory://', ''))).metadata();
  const meta2 = await sharp(app.locals.services.storage.memory.get(item2.question.question_image_file_id.replace('memory://', ''))).metadata();
  // 左侧题图只包含左栏图形，不混入右栏；右侧同理
  assert(meta1.width < 420);
  assert(meta2.width < 420);
});

test('单题模式下无 OCR 图形坐标的配图题回退为整张裁剪图', async () => {
  const cfg = config;
  const line = { index: 1, text: '1. 如图所示，求 x 的值。', item_polygon: { x: 20, y: 40, width: 500, height: 60 } };
  const ocr = {
    config: cfg,
    action: 'RecognizeEduQuestionOcr',
    recognize: async () => ({
      rawText: line.text,
      lines: [line],
      angle: 0,
      engine: 'RecognizeEduQuestionOcr',
      imageWidth: 800,
      imageHeight: 300,
      figures: [],
      questionBlocks: [
        { index: 1, source_line_range: [1, 1], source_rect: { x: 20, y: 40, width: 500, height: 60 } }
      ]
    })
  };
  const deepseek = {
    config: cfg,
    parseQuestion: async () => ({
      subject: 'math', subject_candidates: ['math'], is_cross_subject: false,
      type: 'short_answer', stem: '如图所示，求 x 的值。', options: {},
      correct_answer: '略', analysis: '略', error_prone_point: '', knowledge_points: ['方程'],
      difficulty: 'medium'
    }),
    rankCandidateIds: async (items, count) => items.slice(0, count).map((item) => item.id)
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config: cfg, ocr, deepseek, vector });
  const session = await login(app, 'single-fallback-student');
  // 纯文字、无图形内容，像素扫描应无结果，单题模式回退整张上传裁剪图
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="white"/><text x="20" y="80" font-size="28">1. 如图所示，求 x 的值。</text></svg>');
  const created = await request(app)
    .post('/v1/recognitions')
    .set(auth(session.token))
    .attach('image', svg, { filename: 'single.svg', contentType: 'image/svg+xml' })
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  const question = task.parsed_question;
  assert.equal(question.has_illustration, true);
  assert.equal(question.question_image_is_fallback, true);
  assert.equal(question.question_image_source, 'full_image_fallback');
});

test('批量保存部分失败后可只重试失败项且不重复入库', async () => {
  let questionUploadCount = 0;
  let failedOnce = false;
  const storage = {
    upload: async (path) => {
      if (path.includes('/questions/')) {
        questionUploadCount += 1;
        if (questionUploadCount === 2 && !failedOnce) {
          failedOnce = true;
          throw new Error('模拟第二道题文件上传失败');
        }
      }
      return `memory://${path}`;
    },
    downloadUrl: async (fileId) => fileId
  };
  const vector = { upsert: async () => {}, upsertMany: async () => {}, search: async () => [] };
  const app = createApp({ config, storage, vector });
  const userId = 'usr_partial_batch';
  const taskId = 'rec_partial_batch';
  const parsedQuestion = (stem) => ({
    subject: 'math', type: 'single_choice', stem, options: { A: '1', B: '2' }, correct_answer: 'B',
    analysis: '解析', error_prone_point: '易错点', knowledge_points: ['加法'], difficulty: 'easy'
  });
  await app.locals.services.store.put('recognition_tasks', {
    _id: taskId,
    user_id: userId,
    image_file_id: 'memory://batch.jpg',
    mode: 'batch',
    status: 'succeeded',
    stage: 'completed',
    parsed_questions: [
      { item_id: 'item_1', order: 1, status: 'valid', question: parsedQuestion('第一题') },
      { item_id: 'item_2', order: 2, status: 'valid', question: parsedQuestion('第二题') }
    ],
    saved_items: [],
    created_at: nowIso(),
    updated_at: nowIso()
  });

  const first = await app.locals.services.recognitions.save(userId, taskId, ['item_1', 'item_2']);
  assert.equal(first.question_ids.length, 1);
  assert.equal(first.failed_items.length, 1);
  assert.equal(first.failed_items[0].item_id, 'item_2');
  const partialTask = await app.locals.services.store.get('recognition_tasks', taskId);
  assert.equal(partialTask.status, 'partially_saved');

  const retried = await app.locals.services.recognitions.save(userId, taskId, ['item_2']);
  assert.equal(retried.question_ids.length, 1);
  assert.equal(retried.failed_items.length, 0);
  const questions = await app.locals.services.store.find('questions', { where: { user_id: userId }, limit: 10 });
  assert.equal(questions.length, 2);
  assert.equal(new Set(questions.map((item) => item._id)).size, 2);
});

test('批量题目入库后向量索引失败不回滚题库数据', async () => {
  const vector = { upsert: async () => {}, upsertMany: async () => { throw new Error('vector unavailable'); }, search: async () => [] };
  const app = createApp({ config, vector });
  const userId = 'usr_vector_failed_batch';
  const taskId = 'rec_vector_failed_batch';
  await app.locals.services.store.put('recognition_tasks', {
    _id: taskId, user_id: userId, image_file_id: 'memory://batch.jpg', mode: 'batch', status: 'succeeded', stage: 'completed',
    parsed_questions: [{
      item_id: 'item_1', order: 1, status: 'valid', source_line_range: [1, 3],
      question: {
        subject: 'math', type: 'single_choice', stem: '1+1=?', options: { A: '1', B: '2' }, correct_answer: 'B',
        analysis: '1+1=2。', error_prone_point: '注意计算。', knowledge_points: ['加法'], difficulty: 'easy'
      }
    }],
    saved_items: [], created_at: nowIso(), updated_at: nowIso()
  });
  const result = await app.locals.services.recognitions.save(userId, taskId, ['item_1']);
  assert.equal(result.question_ids.length, 1);
  assert.equal(result.failed_items.length, 0);
  const stored = await app.locals.services.store.get('questions', result.question_ids[0]);
  assert.equal(stored.index_status, 'failed');
});

test('题库列表返回当前条件下的掌握状态统计并支持组合筛选', async () => {
  const app = createApp({ config });
  const session = await login(app, 'library-mastery-filter-student');
  const store = app.locals.services.store;
  const unmasteredMath = question(session.user.id, 1);
  const masteredMath = { ...question(session.user.id, 2), difficulty: 'hard', mastery_status: 'mastered' };
  const masteredEnglish = { ...question(session.user.id, 3), subject: 'english', mastery_status: 'mastered' };
  await store.put('questions', unmasteredMath);
  await store.put('questions', masteredMath);
  await store.put('questions', masteredEnglish);

  const response = await request(app)
    .get('/v1/questions?subject=math&mastery_status=unmastered')
    .set(auth(session.token))
    .expect(200);

  assert.deepEqual(response.body.data.mastery_summary, {
    total_count: 2,
    unmastered_count: 1,
    mastered_count: 1
  });
  assert.equal(response.body.data.items.length, 1);
  assert.equal(response.body.data.items[0].id, unmasteredMath._id);

  const difficultyResponse = await request(app)
    .get('/v1/questions?difficulty=hard')
    .set(auth(session.token))
    .expect(200);
  assert.equal(difficultyResponse.body.data.items.length, 1);
  assert.equal(difficultyResponse.body.data.items[0].id, masteredMath._id);
});

test('题库列表使用游标加载全部数据且不受单次一百条查询上限影响', async () => {
  const app = createApp({ config });
  const session = await login(app, 'library-pagination-student');
  const store = app.locals.services.store;
  for (let index = 1; index <= 105; index += 1) {
    await store.put('questions', question(session.user.id, index));
  }

  const collectedIds = [];
  let cursor = '';
  do {
    const response = await request(app)
      .get(`/v1/questions?limit=20${cursor ? `&cursor=${cursor}` : ''}`)
      .set(auth(session.token))
      .expect(200);
    collectedIds.push(...response.body.data.items.map((item) => item.id));
    assert.equal(response.body.data.mastery_summary.total_count, 105);
    cursor = response.body.data.next_cursor || '';
  } while (cursor);

  assert.equal(collectedIds.length, 105);
  assert.equal(new Set(collectedIds).size, 105);
});

test('查看相关题目时使用当前题目的全部知识点进行联合匹配', async () => {
  const app = createApp({ config });
  const session = await login(app, 'related-knowledge-student');
  const store = app.locals.services.store;
  const fraction = { ...question(session.user.id, 1), _id: 'q_related_fraction', knowledge_points: ['分数运算'] };
  const equation = { ...question(session.user.id, 2), _id: 'q_related_equation', knowledge_points: ['一元一次方程'] };
  const geometry = { ...question(session.user.id, 3), _id: 'q_unrelated_geometry', knowledge_points: ['平面几何'] };
  await store.put('questions', fraction);
  await store.put('questions', equation);
  await store.put('questions', geometry);

  const response = await request(app)
    .get(`/v1/questions?knowledge_points=${encodeURIComponent('分数运算')}&knowledge_points=${encodeURIComponent('一元一次方程')}`)
    .set(auth(session.token))
    .expect(200);

  assert.deepEqual(
    new Set(response.body.data.items.map((item) => item.id)),
    new Set([fraction._id, equation._id])
  );
  assert.equal(response.body.data.mastery_summary.total_count, 2);
});

test('数据导出生成可预览 PDF 并包含错题和学习记录', async () => {
  const app = createApp({ config });
  const session = await login(app, 'export-student');
  const storedQuestion = question(session.user.id, 1);
  await app.locals.services.store.put('questions', storedQuestion);
  await app.locals.services.store.put('practice_records', {
    _id: 'pr_export',
    session_id: 'ps_export',
    user_id: session.user.id,
    subject: 'math',
    type: 'recommended',
    total_count: 1,
    correct_count: 1,
    wrong_count: 0,
    accuracy: 100,
    items: [],
    submitted_at: nowIso()
  });

  const response = await request(app).post('/v1/exports').set(auth(session.token)).expect(201);
  const exported = response.body.data;
  assert.equal(exported.question_count, 1);
  assert.equal(exported.practice_record_count, 1);

  const storage = app.locals.services.storage.memory;
  const pdf = storage.get(exported.pdf_file_id.replace('memory://', ''));
  const md = storage.get(exported.markdown_file_id.replace('memory://', ''));
  const zip = storage.get(exported.file_id.replace('memory://', ''));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.match(md.toString(), /错题记录（1 道）/);
  assert.match(md.toString(), /学习记录（1 次）/);
  assert.match(md.toString(), /正确率：100%/);
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
});

test('后端重启遗留的识别任务可复用 OCR 原文重新解析', async () => {
  const app = createApp({ config: { ...config, recognitionTaskTimeoutMs: 1000 } });
  const session = await login(app, 'stale-recognition-student');
  const taskId = 'rec_interrupted';
  const oldTime = new Date(Date.now() - 5000).toISOString();
  await app.locals.services.store.put('recognition_tasks', {
    _id: taskId,
    user_id: session.user.id,
    status: 'processing',
    stage: 'deepseek',
    image_file_id: 'memory://stale.jpg',
    raw_text: '已完成 OCR',
    parsed_question: null,
    error_code: null,
    created_at: oldTime,
    updated_at: oldTime
  });

  await request(app).post(`/v1/recognitions/${taskId}/retry`).set(auth(session.token)).expect(200);
  const completed = await waitForRecognition(app, session.token, taskId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.stage, 'completed');
});

test('OCR 已完成的中断任务可直接重新执行 DeepSeek 解析', async () => {
  const app = createApp({ config });
  const session = await login(app, 'retry-recognition-student');
  const taskId = 'rec_retry_deepseek';
  await app.locals.services.store.put('recognition_tasks', {
    _id: taskId,
    user_id: session.user.id,
    status: 'failed',
    stage: 'failed',
    image_file_id: 'memory://retry.jpg',
    raw_text: '数学 单项选择题 1+1=（ ） A.1 B.2 C.3',
    parsed_question: null,
    error_code: 'RECOGNITION_INTERRUPTED',
    error_message: '任务中断',
    created_at: nowIso(),
    updated_at: nowIso()
  });

  await request(app).post(`/v1/recognitions/${taskId}/retry`).set(auth(session.token)).expect(200);
  const result = await waitForRecognition(app, session.token, taskId);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.stage, 'completed');
  assert.equal(result.parsed_question.correct_answer, 'B');
});

test('DeepSeek 易错点或知识点出现违规内容时按合规拦截', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    source_complete: true,
    incomplete_reason: '',
    subject: 'math',
    type: 'single_choice',
    stem: '1+1=?',
    options: { A: '1', B: '2' },
    correct_answer: 'B',
    analysis: '1+1=2。',
    error_prone_point: '不要被干扰。',
    knowledge_points: ['制造炸弹'],
    difficulty: 'easy'
  });

  await assert.rejects(
    () => adapter.parseQuestion('测试 OCR 文本'),
    (error) => error.code === 'CONTENT_NOT_ALLOWED'
      && error.status === 422
      && error.message === COMPLIANCE_BLOCKED_MESSAGE
      && error.details.category === 'violence_self_harm'
  );
});

test('DeepSeek 明确拒绝时映射为内容不合规而非图片不完整', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    source_complete: false,
    incomplete_reason: '内容不符合要求，无法解析'
  });

  await assert.rejects(
    () => adapter.parseQuestion('测试 OCR 文本'),
    (error) => error.code === 'CONTENT_NOT_ALLOWED' && error.status === 422
  );
});

test('合规过滤不误伤合法课程内容', () => {
  const legalCases = [
    { stem: '我国宪法规定，中华人民共和国的一切权力属于人民。', knowledge_points: ['宪法'] },
    { stem: '阅读材料并结合所学，说明鸦片战争对中国近代社会的影响。', knowledge_points: ['鸦片战争'] },
    { stem: '学校开展禁毒教育，下列做法正确的是远离毒品并学会拒绝诱惑。', knowledge_points: ['禁毒教育'] },
    { stem: '面对校园欺凌，下列做法正确的是及时向老师和家长求助。', knowledge_points: ['校园欺凌'] }
  ];
  legalCases.forEach((question) => {
    assert.deepEqual(assessQuestionCompliance({
      ...question,
      options: {},
      correct_answer: 'A',
      analysis: '结合课程知识作答。',
      error_prone_point: '注意审题。'
    }), { compliant: true, category: '' });
  });
});

test('DeepSeek 批量解析合规拦截单题并保留其他题', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async (messages) => {
    assert.match(messages[0].content, /未成年人网络保护/);
    return {
      detected_count: 2,
      image_quality: { compliant: true, issues: [], message: '', tips: [] },
      questions: [
        {
          source_complete: true, incomplete_reason: '', source_line_range: [1, 2], subject: 'math', type: 'single_choice',
          stem: '1+1=?', options: { A: '1', B: '2' }, correct_answer: 'B', analysis: '1+1=2。',
          error_prone_point: '注意计算。', knowledge_points: ['如何绕过安全限制'], difficulty: 'easy'
        },
        {
          source_complete: true, incomplete_reason: '', source_line_range: [3, 4], subject: 'math', type: 'single_choice',
          stem: '2+2=?', options: { A: '3', B: '4' }, correct_answer: 'B', analysis: '2+2=4。',
          error_prone_point: '注意计算。', knowledge_points: ['加法'], difficulty: 'easy'
        }
      ]
    };
  };

  const result = await adapter.parseQuestions('1+1=? A.1 B.2\n2+2=? A.3 B.4');
  assert.equal(result.valid_question_count, 1);
  assert.equal(result.parsed_questions[0].status, 'invalid');
  assert.equal(result.parsed_questions[0].error_message, COMPLIANCE_BLOCKED_MESSAGE);
  assert.equal(result.parsed_questions[1].status, 'valid');
});

test('DeepSeek 批量解析全部违规时抛出内容不合规错误', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    image_quality: { compliant: true, issues: [], message: '', tips: [] },
    questions: [{
      source_complete: true, incomplete_reason: '', source_line_range: [1, 2], subject: 'math', type: 'single_choice',
      stem: '1+1=?', options: { A: '1', B: '2' }, correct_answer: 'B', analysis: '1+1=2。',
      error_prone_point: '注意计算。', knowledge_points: ['色情内容'], difficulty: 'easy'
    }]
  });

  await assert.rejects(
    () => adapter.parseQuestions('1+1=? A.1 B.2'),
    (error) => error.code === 'CONTENT_NOT_ALLOWED' && error.status === 422
  );
});

test('DeepSeek 结构化解析支持二至六个连续选项', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    source_complete: true,
    incomplete_reason: '',
    subject: 'math',
    type: 'single_choice',
    stem: '既是质数，又是偶数的自然数有几个？',
    options: { A: '$$\\left( A \\right) 2 个', B: 'B. 0 个', C: '\\((C)\\) 1 个' },
    correct_answer: 'C',
    analysis: '2 是唯一的偶质数。',
    error_prone_point: '忽略 2 的特殊性。',
    knowledge_points: ['质数'],
    difficulty: 'easy'
  });

  const parsed = await adapter.parseQuestion('测试 OCR 文本');
  assert.deepEqual(Object.keys(parsed.options), ['A', 'B', 'C']);
  assert.deepEqual(parsed.options, { A: '2 个', B: '0 个', C: '1 个' });
  assert.equal(parsed.correct_answer, 'C');
});

test('DeepSeek 结构化解析接受物理等新增科目', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    source_complete: true,
    incomplete_reason: '',
    subject: 'physics',
    type: 'single_choice',
    stem: '一物体做匀速直线运动，其速度为（ ）',
    options: { A: '2 m/s', B: '4 m/s' },
    correct_answer: 'B',
    analysis: '根据路程和时间计算速度。',
    error_prone_point: '注意单位换算。',
    knowledge_points: ['速度'],
    difficulty: 'easy'
  });

  const parsed = await adapter.parseQuestion('物理选择题 OCR 文本');
  assert.equal(parsed.subject, 'physics');
});

test('DeepSeek 拒绝包含多题或被裁断的不完整图片', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    source_complete: false,
    incomplete_reason: '图片中出现了两道题，无法确认当前题目的全部选项'
  });

  await assert.rejects(
    () => adapter.parseQuestion('两道题混合的 OCR 文本'),
    (error) => error.code === 'QUESTION_IMAGE_INCOMPLETE'
      && error.status === 422
      && error.message.includes('两道题')
  );
});

test('DeepSeek 批量解析保留有效题并标记单题校验失败', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 2,
    has_more_questions: false,
    questions: [
      {
        source_complete: true, incomplete_reason: '', source_line_range: [1, 3], subject: 'math', type: 'single_choice',
        stem: '1+1=?', options: { A: '1', B: '2' }, correct_answer: 'B', analysis: '1+1=2。',
        error_prone_point: '注意计算。', knowledge_points: ['加法'], difficulty: 'easy'
      },
      { source_complete: false, incomplete_reason: '第2题缺少全部选项', source_line_range: [4, 5] }
    ]
  });
  const result = await adapter.parseQuestions({
    rawText: '1+1=? A.1 B.2\n第2题',
    lines: ['1+1=?', 'A.1', 'B.2', '第2题', 'A.'].map((text, index) => ({ index: index + 1, text }))
  }, 5);
  assert.equal(result.detected_count, 2);
  assert.equal(result.valid_question_count, 1);
  assert.equal(result.parsed_questions[0].status, 'valid');
  assert.equal(result.parsed_questions[1].status, 'invalid');
  assert.match(result.parsed_questions[1].error_message, /缺少/);
});

test('通用 OCR 丢失科学计数法上标时禁止保存该题', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    has_more_questions: false,
    questions: [{
      source_complete: true,
      incomplete_reason: '',
      source_line_range: [1, 5],
      subject: 'math',
      type: 'single_choice',
      stem: '将31492000用科学计数法表示',
      options: { A: '0.31492x108', B: '3.1492x107', C: '31.492x106', D: '314.92x105' },
      correct_answer: 'B',
      analysis: '科学计数法要求系数大于等于1且小于10。',
      error_prone_point: '注意指数。',
      knowledge_points: ['科学计数法'],
      difficulty: 'easy'
    }]
  });
  await assert.rejects(
    () => adapter.parseQuestions({
      engine: 'RecognizeEduPaperOcr',
      rawText: '将31492000用科学计数法表示\nA.0.31492x108\nB.3.1492x107\nC.31.492x106\nD.314.92x105',
      lines: [
        '将31492000用科学计数法表示', 'A.0.31492x108', 'B.3.1492x107', 'C.31.492x106', 'D.314.92x105'
      ].map((text, index) => ({ index: index + 1, text }))
    }),
    (error) => error.code === 'NO_VALID_QUESTIONS' && /指数上标/.test(error.message)
  );
});

test('通用 OCR 出现孤立分母行时禁止保存断裂分式', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    has_more_questions: false,
    questions: [{
      source_complete: true,
      incomplete_reason: '',
      source_line_range: [1, 6],
      subject: 'math',
      type: 'single_choice',
      stem: 'tan45°-√2cos45°的值等于',
      options: { A: '0', B: '1', C: '1-2', D: '1-√2' },
      correct_answer: 'A',
      analysis: '代入特殊角三角函数值。',
      error_prone_point: '注意根式。',
      knowledge_points: ['特殊角三角函数'],
      difficulty: 'easy'
    }]
  });
  await assert.rejects(
    () => adapter.parseQuestions({
      engine: 'RecognizeEduPaperOcr',
      rawText: 'tan45°-√2cos45°的值等于\nA.0\nB.1\nC.1-2\nD.1-√2\n2',
      lines: ['tan45°-√2cos45°的值等于', 'A.0', 'B.1', 'C.1-2', 'D.1-√2', '2']
        .map((text, index) => ({ index: index + 1, text }))
    }),
    (error) => error.code === 'NO_VALID_QUESTIONS' && /分式被拆成多行/.test(error.message)
  );
});

test('试卷切题返回的 LaTeX 上标与分式可以通过公式质量校验', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    has_more_questions: false,
    questions: [{
      source_complete: true,
      incomplete_reason: '',
      source_line_range: [1, 3],
      subject: 'math',
      type: 'single_choice',
      stem: '表达式的值为',
      options: { A: '$3.1492\\times10^{7}$', B: '$1-\\frac{\\sqrt{2}}{2}$' },
      correct_answer: 'A',
      analysis: '保留原始公式结构。',
      error_prone_point: '注意公式结构。',
      knowledge_points: ['数学公式'],
      difficulty: 'easy'
    }]
  });
  const result = await adapter.parseQuestions({
    engine: 'RecognizeEduPaperCut',
    rawText: '表达式的值为\nA.$3.1492\\times10^{7}$\nB.$1-\\frac{\\sqrt{2}}{2}$',
    lines: ['表达式的值为', 'A.$3.1492\\times10^{7}$', 'B.$1-\\frac{\\sqrt{2}}{2}$']
      .map((text, index) => ({ index: index + 1, text }))
  });
  assert.equal(result.valid_question_count, 1);
  assert.equal(result.parsed_questions[0].question.options.B, '$1-\\frac{\\sqrt{2}}{2}$');
});

test('坐标对齐的高置信度负号会在交给 DeepSeek 前自动补回', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async (messages) => {
    assert.match(messages[1].content, /高置信度符号修正/);
    assert.match(messages[1].content, /y=-9\/x/);
    assert(messages[1].content.includes('[1] 反比例函数$y=-\\frac{9}{x}$'));
    return {
      detected_count: 1,
      has_more_questions: false,
      questions: [{
        source_complete: true,
        incomplete_reason: '',
        source_line_range: [1, 5],
        subject: 'math',
        type: 'single_choice',
        stem: '若A、B、C都在反比例函数$y=-\\frac{9}{x}$的图象上，比较纵坐标大小',
        options: { A: 'y1<y2<y3', B: 'y3<y2<y1', C: 'y1<y3<y2', D: 'y2<y3<y1' },
        correct_answer: 'D',
        analysis: '分别代入横坐标计算。',
        error_prone_point: '注意负号。',
        knowledge_points: ['反比例函数'],
        difficulty: 'medium'
      }]
    };
  };
  const result = await adapter.parseQuestions({
    engine: 'RecognizeEduPaperCut',
    rawText: '反比例函数$y=\\frac{9}{x}$\nA.y1<y2<y3\nB.y3<y2<y1\nC.y1<y3<y2\nD.y2<y3<y1',
    lines: ['反比例函数$y=\\frac{9}{x}$', 'A.y1<y2<y3', 'B.y3<y2<y1', 'C.y1<y3<y2', 'D.y2<y3<y1']
      .map((text, index) => ({ index: index + 1, text, group_type: index ? 'option' : 'question', option_key: index ? 'ABCD'[index - 1] : '', item_polygon: { x: 0, y: index * 30, width: 360, height: 22 } })),
    questionBlocks: [{ index: 1, source_line_range: [1, 5] }],
    verificationText: '反比例函数 y=-9/x',
    verificationLines: [{ index: 1, text: '反比例函数 y=-9/x', confidence: 99, item_polygon: { x: 0, y: 0, width: 260, height: 22 } }],
    verificationEngine: 'RecognizeEduPaperOcr'
  });
  assert.match(result.parsed_questions[0].question.stem, /y=-/);
});

test('完成坐标纠正后模型仍丢失负号时禁止保存', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    has_more_questions: false,
    questions: [{
      source_complete: true, incomplete_reason: '', source_line_range: [1, 3], subject: 'math', type: 'single_choice',
      stem: '反比例函数$y=\\frac{9}{x}$', options: { A: '1', B: '2' }, correct_answer: 'A',
      analysis: '计算。', error_prone_point: '注意符号。', knowledge_points: ['反比例函数'], difficulty: 'medium'
    }]
  });
  await assert.rejects(
    () => adapter.parseQuestions({
      engine: 'RecognizeEduPaperCut',
      rawText: '反比例函数$y=\\frac{9}{x}$\nA.1\nB.2',
      lines: ['反比例函数$y=\\frac{9}{x}$', 'A.1', 'B.2'].map((text, index) => ({
        index: index + 1, text, group_type: index ? 'option' : 'question', option_key: index ? 'AB'[index - 1] : '',
        item_polygon: { x: 0, y: index * 30, width: 260, height: 22 }
      })),
      questionBlocks: [{ index: 1, source_line_range: [1, 3] }],
      verificationText: '反比例函数 y=-9/x',
      verificationLines: [{ index: 1, text: '反比例函数 y=-9/x', confidence: 99, item_polygon: { x: 0, y: 0, width: 240, height: 22 } }]
    }),
    (error) => error.code === 'NO_VALID_QUESTIONS' && /负号/.test(error.message)
  );
});

test('坐标和选项编号一致时自动补回选项开头的负号', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async (messages) => {
    assert(messages[1].content.includes('[4] C. -\\sqrt{2}'));
    return {
      detected_count: 1,
      has_more_questions: false,
      questions: [{
        source_complete: true, incomplete_reason: '', source_line_range: [1, 4], subject: 'math', type: 'single_choice',
        stem: '下列数中最小的是', options: { A: '0', B: '1', C: '-\\sqrt{2}' }, correct_answer: 'C',
        analysis: '负数小于零和正数。', error_prone_point: '注意负号。', knowledge_points: ['实数比较'], difficulty: 'easy'
      }]
    };
  };
  const result = await adapter.parseQuestions({
    engine: 'RecognizeEduPaperCut',
    rawText: '下列数中最小的是\nA. 0\nB. 1\nC. \\sqrt{2}',
    lines: ['下列数中最小的是', 'A. 0', 'B. 1', 'C. \\sqrt{2}'].map((text, index) => ({
      index: index + 1, text, group_type: index ? 'option' : 'question', option_key: index ? 'ABC'[index - 1] : '',
      item_polygon: { x: 0, y: index * 30, width: 260, height: 22 }
    })),
    questionBlocks: [{ index: 1, source_line_range: [1, 4] }],
    verificationText: 'C.-√2',
    verificationLines: [{ index: 1, text: 'C.-√2', confidence: 98, item_polygon: { x: 0, y: 90, width: 100, height: 22 } }]
  });
  assert.equal(result.parsed_questions[0].question.options.C, '-\\sqrt{2}');
  assert.equal(result.parsed_questions[0].symbol_corrections[0].type, 'option_leading_negative');
});

test('校对符号只应用到坐标重合的题目，不跨题修正', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async (messages) => {
    assert(messages[1].content.includes('[1] 反比例函数$y=\\frac{4}{x}$'));
    assert(messages[1].content.includes('[4] 反比例函数$y=-\\frac{9}{x}$'));
    return {
      detected_count: 2,
      has_more_questions: false,
      questions: [
        {
          source_complete: true, incomplete_reason: '', source_line_range: [1, 3], subject: 'math', type: 'single_choice',
          stem: '反比例函数$y=\\frac{4}{x}$', options: { A: '1', B: '2' }, correct_answer: 'A',
          analysis: '按题意计算。', error_prone_point: '注意符号。', knowledge_points: ['反比例函数'], difficulty: 'medium'
        },
        {
          source_complete: true, incomplete_reason: '', source_line_range: [4, 6], subject: 'math', type: 'single_choice',
          stem: '反比例函数$y=-\\frac{9}{x}$', options: { A: '3', B: '4' }, correct_answer: 'B',
          analysis: '按题意计算。', error_prone_point: '注意负号。', knowledge_points: ['反比例函数'], difficulty: 'medium'
        }
      ]
    };
  };
  const sourceTexts = ['反比例函数$y=\\frac{4}{x}$', 'A.1', 'B.2', '反比例函数$y=\\frac{9}{x}$', 'A.3', 'B.4'];
  const result = await adapter.parseQuestions({
    engine: 'RecognizeEduPaperCut', rawText: sourceTexts.join('\n'),
    lines: sourceTexts.map((text, index) => ({
      index: index + 1, text, group_type: index % 3 ? 'option' : 'question', option_key: index % 3 ? 'AB'[(index % 3) - 1] : '',
      item_polygon: { x: 0, y: index * 60, width: 300, height: 24 }
    })),
    questionBlocks: [{ index: 1, source_line_range: [1, 3] }, { index: 2, source_line_range: [4, 6] }],
    verificationText: '反比例函数 y=-9/x',
    verificationLines: [{ index: 1, text: '反比例函数 y=-9/x', confidence: 99, item_polygon: { x: 0, y: 180, width: 250, height: 24 } }]
  });
  assert.match(result.parsed_questions[0].question.stem, /y=\\frac/);
  assert.doesNotMatch(result.parsed_questions[0].question.stem, /y=-/);
  assert.match(result.parsed_questions[1].question.stem, /y=-/);
});

test('DeepSeek 批量解析支持超过五题且不静默截断', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 6,
    image_quality: { compliant: true, issues: [], message: '', tips: [] },
    questions: Array.from({ length: 6 }, (_, index) => ({
      source_complete: true,
      incomplete_reason: '',
      source_line_range: [index * 3 + 1, index * 3 + 3],
      subject: 'math',
      subject_candidates: ['math'],
      is_cross_subject: false,
      type: 'single_choice',
      stem: `第${index + 1}题`,
      options: { A: '1', B: '2' },
      correct_answer: 'B',
      analysis: '解析。',
      error_prone_point: '注意审题。',
      knowledge_points: ['基础运算'],
      difficulty: 'easy'
    }))
  });
  const result = await adapter.parseQuestions('六道选择题');
  assert.equal(result.detected_count, 6);
  assert.equal(result.parsed_questions.length, 6);
  assert.equal(result.valid_question_count, 6);
});

test('DeepSeek 批量解析支持非选择题并返回交叉学科候选标识', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 2,
    image_quality: { compliant: true, issues: [], message: '', tips: [] },
    questions: [
      {
        source_complete: true, incomplete_reason: '', source_line_range: [1, 2],
        subject: 'math', subject_candidates: ['math'], is_cross_subject: false, type: 'fill_blank',
        stem: '2+3=____。', options: {}, correct_answer: '5', analysis: '直接相加。',
        error_prone_point: '注意进位。', knowledge_points: ['加法'], difficulty: 'easy'
      },
      {
        source_complete: true, incomplete_reason: '', source_line_range: [3, 5],
        subject: 'geography', subject_candidates: ['geography', 'biology'], is_cross_subject: true, type: 'short_answer',
        stem: '说明湿地对生物多样性的作用。', options: {}, correct_answer: '提供栖息地并维持生态系统稳定。', analysis: '从生态功能作答。',
        error_prone_point: '只描述景观价值。', knowledge_points: ['湿地', '生物多样性'], difficulty: 'medium'
      }
    ]
  });
  const result = await adapter.parseQuestions('两道非选择题');
  assert.equal(result.parsed_questions[0].question.type, 'fill_blank');
  assert.deepEqual(result.parsed_questions[0].question.options, {});
  assert.equal(result.parsed_questions[1].question.is_cross_subject, true);
  assert.deepEqual(result.parsed_questions[1].question.subject_candidates, ['geography', 'biology']);
});

test('DeepSeek 科目中文别名会标准化且不会导致整题失败', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    image_quality: { compliant: true, issues: [], message: '', tips: [] },
    questions: [{
      source_complete: true, incomplete_reason: '', source_line_range: [1, 4],
      subject: '数学', subject_candidates: ['数学'], is_cross_subject: false, type: 'single_choice',
      stem: '家里热水器的容量是（ ）。', options: { A: '6升', B: '60升', C: '600升' }, correct_answer: 'B',
      analysis: '结合常见家用热水器容量估计，60升较合理。', error_prone_point: '缺少生活经验。',
      knowledge_points: ['容量估算'], difficulty: 'easy'
    }]
  });
  const result = await adapter.parseQuestions('家里热水器的容量是\nA.6升\nB.60升\nC.600升');
  assert.equal(result.valid_question_count, 1);
  assert.equal(result.parsed_questions[0].question.subject, 'math');
  assert.deepEqual(result.parsed_questions[0].question.subject_candidates, ['math']);
});

test('DeepSeek 返回未知科目时根据题干和知识点自动兜底归类', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 1,
    image_quality: { compliant: true, issues: [], message: '', tips: [] },
    questions: [{
      source_complete: true, incomplete_reason: '', source_line_range: [1, 4],
      subject: 'science', subject_candidates: [], is_cross_subject: false, type: 'single_choice',
      stem: '家里热水器的容量是（ ）。', options: { A: '6升', B: '60升', C: '600升' }, correct_answer: 'B',
      analysis: '60升符合常见家用热水器容量。', error_prone_point: '单位和数量级判断错误。',
      knowledge_points: ['容量', '生活中的量'], difficulty: 'easy'
    }]
  });
  const result = await adapter.parseQuestions('家里热水器的容量是\nA.6升\nB.60升\nC.600升');
  assert.equal(result.valid_question_count, 1);
  assert.equal(result.parsed_questions[0].question.subject, 'math');
  assert(result.parsed_questions[0].question.subject_candidates.includes('math'));
});

test('不规范试题图片返回友好原因和拍摄建议', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => ({
    detected_count: 0,
    image_quality: {
      compliant: false,
      issues: ['题干被裁断', '图片模糊'],
      message: '没有拍到完整题干，请重新对焦并让整道题入镜。',
      tips: ['保留完整题干和作答要求', '镜头与纸面保持平行']
    },
    questions: []
  });
  await assert.rejects(
    () => adapter.parseQuestions('模糊且被裁断的文字'),
    (error) => error.code === 'NO_QUESTIONS_DETECTED'
      && /完整题干/.test(error.message)
      && error.details.compliant === false
      && error.details.tips.length === 2
  );
});

test('交叉学科题保存时记录用户确认的科目与 AI 分类标识', async () => {
  const app = createApp({ config });
  const userId = 'usr_cross_subject';
  const taskId = 'rec_cross_subject';
  await app.locals.services.store.put('recognition_tasks', {
    _id: taskId, user_id: userId, image_file_id: 'memory://cross.jpg', mode: 'batch', status: 'succeeded', stage: 'completed',
    parsed_questions: [{
      item_id: 'item_1', order: 1, status: 'valid', error_message: '', source_line_range: [1, 3],
      question: {
        subject: 'geography', subject_candidates: ['geography', 'biology'], is_cross_subject: true, type: 'short_answer',
        stem: '分析湿地生态价值。', options: {}, correct_answer: '维持生物多样性。', analysis: '结合生态系统功能分析。',
        error_prone_point: '遗漏生态功能。', knowledge_points: ['湿地生态'], difficulty: 'medium'
      }
    }], saved_items: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  const saved = await app.locals.services.recognitions.save(userId, taskId, {
    item_ids: ['item_1'], subject_overrides: { item_1: 'biology' }
  });
  const question = await app.locals.services.store.get('questions', saved.question_id);
  assert.equal(question.subject, 'biology');
  assert.equal(question.classification.type, 'short_answer');
  assert.equal(question.classification.difficulty, 'medium');
  assert.equal(question.classification.source, 'ai');
  assert.equal(question.classification.user_confirmed_subject, true);
});

test('DeepSeek JSON 输出被 token 上限截断时返回明确错误', async () => {
  const adapter = new DeepSeekAdapter({
    ...config,
    mockExternalServices: false,
    deepseekApiKey: 'deepseek-test-key',
    fetch: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"questions":[' } }] })
    })
  });
  await assert.rejects(
    () => adapter.parseQuestions('一道超长题目', 5),
    (error) => error.code === 'AI_OUTPUT_TRUNCATED' && error.status === 422
  );
});

test('读光题目 OCR 保留坐标并按单栏纵向顺序重建文本', async () => {
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduQuestionOcr: async (request) => {
        assert.equal(request.needRotate, true);
        return { body: { data: JSON.stringify({
          angle: 1.5,
          prism_wordsInfo: [
            { word: 'B. 2', prob: 98, pos: [{ x: 10, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 80 }, { x: 10, y: 80 }] },
            { word: '题干', prob: 99, pos: [{ x: 8, y: 10 }, { x: 108, y: 10 }, { x: 108, y: 30 }, { x: 8, y: 30 }] },
            { word: 'A. 1', prob: 97, pos: [{ x: 10, y: 40 }, { x: 90, y: 40 }, { x: 90, y: 60 }, { x: 10, y: 60 }] }
          ]
        }) } };
      }
    }
  });
  const result = await adapter.recognize(Buffer.from('image'));
  assert.equal(result.rawText, '题干\nA. 1\nB. 2');
  assert.equal(result.angle, 1.5);
  assert.deepEqual(result.lines.map((line) => line.index), [1, 2, 3]);
  assert.deepEqual(result.lines[0].item_polygon, { x: 8, y: 10, width: 100, height: 20 });
});

test('读光题目 OCR 对双栏选项先按同行聚合再从左到右排序', async () => {
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduQuestionOcr: async () => ({ body: { data: JSON.stringify({
        prism_wordsInfo: [
          { word: 'B. 3.1492×10^7', pos: [{ x: 600, y: 98 }, { x: 780, y: 98 }, { x: 780, y: 118 }, { x: 600, y: 118 }] },
          { word: 'A. 0.31492×10^8', pos: [{ x: 10, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 120 }, { x: 10, y: 120 }] },
          { word: 'D. 314.92×10^5', pos: [{ x: 600, y: 139 }, { x: 780, y: 139 }, { x: 780, y: 159 }, { x: 600, y: 159 }] },
          { word: 'C. 31.492×10^6', pos: [{ x: 10, y: 141 }, { x: 200, y: 141 }, { x: 200, y: 161 }, { x: 10, y: 161 }] }
        ]
      }) } })
    }
  });
  const result = await adapter.recognize(Buffer.from('image'));
  assert.deepEqual(result.lines.map((line) => line.text), [
    'A. 0.31492×10^8', 'B. 3.1492×10^7', 'C. 31.492×10^6', 'D. 314.92×10^5'
  ]);
});

test('批量识别优先使用读光试卷切题并保留 LaTeX 公式与选项结构', async () => {
  const calls = [];
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduPaperCut: async (request) => {
        calls.push({ action: 'RecognizeEduPaperCut', request });
        return { body: { data: JSON.stringify({ page_list: [{
          angle: 0.5,
          doc_index: 1,
          subject_list: [{
            text: '将31492000用科学计数法表示 A. $0.31492\\times10^{8}$ B. $3.1492\\times10^{7}$',
            prism_wordsInfo: [
              { word: '将31492000用科学计数法表示', pos: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 20 }, { x: 0, y: 20 }] },
              { word: 'B. $3.1492\\times10^{7}$', pos: [{ x: 200, y: 30 }, { x: 380, y: 30 }, { x: 380, y: 50 }, { x: 200, y: 50 }] },
              { word: 'A. $0.31492\\times10^{8}$', pos: [{ x: 0, y: 30 }, { x: 180, y: 30 }, { x: 180, y: 50 }, { x: 0, y: 50 }] }
            ]
          }]
        }] }) } };
      },
      recognizeEduPaperOcr: async (request) => {
        calls.push({ action: 'RecognizeEduPaperOcr', request });
        return { body: { data: JSON.stringify({
          prism_wordsInfo: [{ word: '将31492000用科学计数法表示', pos: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 20 }, { x: 0, y: 20 }] }]
        }) } };
      }
    }
  });
  const result = await adapter.recognize(Buffer.from('image'), { mode: 'batch' });
  assert.deepEqual(calls.map((call) => call.action), ['RecognizeEduPaperCut', 'RecognizeEduPaperOcr']);
  assert.equal(calls[0].request.cutType, 'question');
  assert.equal(calls[0].request.imageType, 'photo');
  assert.equal(result.engine, 'RecognizeEduPaperCut');
  assert.equal(result.angle, 0.5);
  assert.deepEqual(result.lines.map((line) => line.text), [
    '将31492000用科学计数法表示',
    'A. $0.31492\\times10^{8}$',
    'B. $3.1492\\times10^{7}$'
  ]);
  assert.deepEqual(result.questionBlocks[0].source_line_range, [1, 3]);
  assert.equal(result.verificationEngine, 'RecognizeEduPaperOcr');
  assert.match(result.verificationText, /科学计数法/);
});

test('读光试卷切题未开通时自动回退整页试卷 OCR', async () => {
  let callCount = 0;
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduPaperCut: async () => {
        callCount += 1;
        return { body: { code: 'noPermission', message: '服务未开通' } };
      },
      recognizeEduPaperOcr: async () => {
        callCount += 1;
        return { body: { data: JSON.stringify({
          prism_wordsInfo: [{ word: '普通文字题', prob: 99, pos: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }] }]
        }) } };
      }
    }
  });
  const result = await adapter.recognize(Buffer.from('image'), { mode: 'batch' });
  assert.equal(callCount, 2);
  assert.equal(result.engine, 'RecognizeEduPaperOcr');
  assert.equal(result.rawText, '普通文字题');
});

test('读光试卷切题漏掉末题时从整页 OCR 按连续题号补回', async () => {
  const asWords = (values) => values.map((word) => ({ word }));
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduPaperCut: async () => ({ body: { data: JSON.stringify({ page_list: [{
        subject_list: [
          { prism_wordsInfo: asWords(['(5)科学记数法', '$$\\left( A \\right) 3.1492\\times10^{7}$$']) },
          { prism_wordsInfo: asWords(['$$\\left( 6 \\right) \\tan45^\\circ$$', '(A)0']) },
          { prism_wordsInfo: asWords(['(7)反比例函数', '(A)y1<y2<y3']) }
        ]
      }] }) } }),
      recognizeEduPaperOcr: async () => ({ body: { data: JSON.stringify({
        prism_wordsInfo: asWords([
          '(5)科学记数法', '\\left( A \\right) 3.1492\\times10^{7}',
          '\\left( 6 \\right) \\tan45^\\circ', '(A)0',
          '(7)反比例函数', '(A)y1<y2<y3',
          '(8)良马追慢马', '(A)240x=150(x+12)'
        ])
      }) } })
    }
  });

  const result = await adapter.recognize(Buffer.from('image'), { mode: 'batch' });
  assert.equal(result.questionBlocks.length, 4);
  assert.deepEqual(result.questionBlocks.map((block) => block.question_number), [5, 6, 7, 8]);
  assert.equal(result.questionBlocks[3].segmentation_source, 'verification_recovery');
  assert.equal(result.questionBlocks[0].options.A, '$$\\left( A \\right) 3.1492\\times10^{7}$$');
  assert.equal(result.recoveredQuestionCount, 1);
  assert.match(result.rawText, /\(8\)良马追慢马/);
});

test('无题号口算网格会合并 OCR 碎片并按每个算式建立独立题块', async () => {
  const fragments = [
    '7×3+75=()', '38+6×8', '=', '()', '5+8×8=', '()',
    '9×8+2=()', '9×5+6=()', '4×9+57=', '()',
    '6×6+52=()', '37+5×7=()', '30+2×9=', '()',
    '58+6×5=()', '1×1+53=()', '2×6+22=', '()'
  ];
  const ocrData = { prism_wordsInfo: fragments.map((word) => ({ word })) };
  const adapter = new OcrAdapter({
    ...config,
    mockExternalServices: false,
    alibabaCloudAccessKeyId: 'id',
    alibabaCloudAccessKeySecret: 'key',
    aliyunOcrClient: {
      recognizeEduPaperCut: async () => ({ body: { data: JSON.stringify({
        page_list: [{ subject_list: [{ ...ocrData, text: fragments.join(' ') }] }]
      }) } }),
      recognizeEduPaperOcr: async () => ({ body: { data: JSON.stringify(ocrData) } })
    }
  });

  const result = await adapter.recognize(Buffer.from('image'), { mode: 'batch' });
  assert.equal(result.lines.length, 12);
  assert.equal(result.questionBlocks.length, 12);
  assert.equal(result.lines[0].text, '7 × 3 + 75 = ( )');
  assert.equal(result.lines[1].text, '38 + 6 × 8 = ( )');
  assert.equal(result.lines[11].text, '2 × 6 + 22 = ( )');
  assert(result.questionBlocks.every((block, index) => (
    block.question_kind === 'oral_calculation'
      && block.source_line_range[0] === index + 1
      && block.source_line_range[1] === index + 1
  )));
});

test('DeepSeek 不得把 OCR 已确认的多个普通题块合并成一道题', async () => {
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async (messages) => {
    assert.match(messages[0].content, /每个边界至少对应一道独立题目/);
    return {
      detected_count: 1,
      questions: [{
        source_complete: true, incomplete_reason: '', source_line_range: [1, 3], subject: 'math', type: 'calculation',
        stem: '三道口算', options: {}, correct_answer: '96，86，69', analysis: '分别计算。',
        error_prone_point: '注意运算顺序。', knowledge_points: ['混合运算'], difficulty: 'easy'
      }]
    };
  };
  await assert.rejects(
    () => adapter.parseQuestions({
      rawText: '7×3+75=()\n38+6×8=()\n5+8×8=()',
      lines: ['7×3+75=()', '38+6×8=()', '5+8×8=()'].map((text, index) => ({ index: index + 1, text })),
      questionBlocks: [1, 2, 3].map((index) => ({ index, source_line_range: [index, index], segmentation_source: 'numbered_lines' }))
    }),
    (error) => error.code === 'AI_PARSE_COUNT_MISMATCH' && /OCR 已确认 3 道/.test(error.message)
  );
});

test('口算题块由服务端逐式计算，不再交给 DeepSeek 合并归纳', async () => {
  const expressions = [
    '7 × 3 + 75 = ( )', '38 + 6 × 8 = ( )', '5 + 8 × 8 = ( )',
    '9 × 8 + 2 = ( )', '9 × 5 + 6 = ( )', '4 × 9 + 57 = ( )',
    '6 × 6 + 52 = ( )', '37 + 5 × 7 = ( )', '30 + 2 × 9 = ( )',
    '58 + 6 × 5 = ( )', '1 × 1 + 53 = ( )', '2 × 6 + 22 = ( )'
  ];
  const adapter = new DeepSeekAdapter({ ...config, mockExternalServices: false });
  adapter.chat = async () => { throw new Error('口算分题不应调用 DeepSeek'); };
  const result = await adapter.parseQuestions({
    rawText: expressions.join('\n'),
    lines: expressions.map((text, index) => ({ index: index + 1, text })),
    questionBlocks: expressions.map((text, index) => ({
      index: index + 1,
      source_line_range: [index + 1, index + 1],
      question_text: text,
      question_kind: 'oral_calculation'
    }))
  });
  assert.equal(result.detected_count, 12);
  assert.equal(result.valid_question_count, 12);
  assert.deepEqual(result.parsed_questions.map((item) => item.question.correct_answer), [
    '96', '86', '69', '74', '51', '93', '88', '72', '48', '88', '54', '34'
  ]);
  assert(result.parsed_questions.every((item) => item.question.type === 'calculation'));
});

test('DeepSeek 请求超时时返回明确的可重试错误', async () => {
  const adapter = new DeepSeekAdapter({
    ...config,
    mockExternalServices: false,
    deepseekApiKey: 'deepseek-test-key',
    fetch: async () => { throw new Error('The operation was aborted due to timeout'); }
  });
  await assert.rejects(
    () => adapter.parseQuestion('测试 OCR 文本'),
    (error) => error.code === 'AI_PARSE_TIMEOUT' && error.status === 504
  );
});

test('DeepSeek 优先使用独立服务配置，未配置时复用百炼兼容模式', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
    };
  };
  const shared = {
    ...config,
    mockExternalServices: false,
    deepseekModel: 'deepseek-v3.2',
    dashScopeBaseUrl: 'https://workspace.example.com/compatible-mode/v1',
    dashScopeApiKey: 'dashscope-key',
    fetch
  };

  await new DeepSeekAdapter({
    ...shared,
    deepseekApiKey: 'independent-key',
    deepseekBaseUrl: 'https://deepseek.example.com/v1/'
  }).chat([{ role: 'user', content: '测试' }]);
  assert.equal(calls[0].url, 'https://deepseek.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer independent-key');
  assert.equal(JSON.parse(calls[0].options.body).model, 'deepseek-v3.2');
  assert.equal(JSON.parse(calls[0].options.body).enable_thinking, undefined);

  await new DeepSeekAdapter({
    ...shared,
    deepseekApiKey: '',
    deepseekBaseUrl: ''
  }).chat([{ role: 'user', content: '测试' }]);
  assert.equal(calls[1].url, 'https://workspace.example.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[1].options.headers.authorization, 'Bearer dashscope-key');
  assert.equal(JSON.parse(calls[1].options.body).enable_thinking, false);
});

test('百炼 text-embedding-v4 按 1024 维批量返回向量', async () => {
  const calls = [];
  const embeddingConfig = {
    ...config,
    mockExternalServices: false,
    dashScopeBaseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    dashScopeApiKey: 'dashscope-test-key',
    embeddingModel: 'text-embedding-v4',
    embeddingDimension: 3,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 1, embedding: [0.4, 0.5, 0.6] },
            { index: 0, embedding: [0.1, 0.2, 0.3] }
          ]
        })
      };
    }
  };

  const vectors = await new EmbeddingAdapter(embeddingConfig).embedMany(['第一题', '第二题']);
  assert.deepEqual(vectors, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  assert.equal(calls[0].url, `${embeddingConfig.dashScopeBaseUrl}/embeddings`);
  assert.equal(calls[0].options.headers.authorization, 'Bearer dashscope-test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'text-embedding-v4',
    input: ['第一题', '第二题'],
    dimensions: 3,
    encoding_format: 'float'
  });
});

test('DashVector 写入元数据并按用户与科目隔离语义检索', async () => {
  const calls = [];
  const vectorConfig = {
    ...config,
    mockExternalServices: false,
    vectorProvider: 'dashvector',
    dashVectorEndpoint: 'dashvector-shenzhen.example.com/v1/',
    dashVectorApiKey: 'dashvector-test-key',
    dashVectorCollection: 'questions',
    embeddingDimension: 3,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('/query')
          ? { code: '0', data: { output: [{ id: 'q_vector', score: 0.2, fields: { user_id: "usr_o'hara", subject: 'math' } }] } }
          : { code: '0', message: 'Success' }
      };
    }
  };
  const embedding = {
    isConfigured: () => true,
    embedMany: async () => [[0.1, 0.2, 0.3]],
    embed: async () => [0.1, 0.2, 0.3]
  };
  const vector = new VectorAdapter(vectorConfig, embedding);
  const row = { ...question("usr_o'hara", 1), _id: 'q_vector' };

  await vector.createCollection();
  await vector.upsert(row);
  const result = await vector.search({ userId: "usr_o'hara", keyword: '基础运算', subject: 'math', limit: 10 });

  assert.deepEqual(calls[0].body, {
    name: 'questions',
    dimension: 3,
    dtype: 'FLOAT',
    metric: 'cosine',
    fields_schema: { user_id: 'STRING', subject: 'STRING', question_type: 'STRING' }
  });
  assert.equal(calls[0].url, 'https://dashvector-shenzhen.example.com/v1/collections');
  assert.equal(calls[1].body.docs[0].id, 'q_vector');
  assert.deepEqual(calls[1].body.docs[0].vector, [0.1, 0.2, 0.3]);
  assert.equal(calls[1].body.docs[0].fields.user_id, "usr_o'hara");
  assert.equal(calls[2].body.filter, "user_id = 'usr_o''hara' and subject = 'math'");
  assert.equal(calls[2].options.headers['dashvector-auth-token'], 'dashvector-test-key');
  assert.deepEqual(result, [{ id: 'q_vector', score: 0.8 }]);
});

test('DashVector 云端访问被白名单拒绝时返回可定位的错误码', async () => {
  const vector = new VectorAdapter({
    ...config,
    mockExternalServices: false,
    vectorProvider: 'dashvector',
    dashVectorEndpoint: 'dashvector-shanghai.example.com',
    dashVectorApiKey: 'dashvector-test-key',
    dashVectorCollection: 'questions',
    fetch: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ code: 403, message: 'source IP is not in the whitelist' })
    })
  }, {
    isConfigured: () => true,
    embed: async () => [0.1, 0.2, 0.3]
  });

  await assert.rejects(
    () => vector.search({ userId: 'usr_cloud', keyword: '英语语态试题' }),
    (error) => error.code === 'VECTOR_ACCESS_DENIED'
      && error.details?.reason === 'access_denied'
      && error.details?.http_status === 403
  );
});

test('超过十道题保存时向量索引按服务上限自动分批且不限制总量', async () => {
  const embeddingBatchSizes = [];
  const upsertBatchSizes = [];
  const vectorConfig = {
    ...config,
    mockExternalServices: false,
    vectorProvider: 'dashvector',
    dashVectorEndpoint: 'dashvector.example.com',
    dashVectorApiKey: 'dashvector-test-key',
    dashVectorCollection: 'questions',
    embeddingDimension: 3,
    fetch: async (_url, options) => {
      upsertBatchSizes.push(JSON.parse(options.body).docs.length);
      return { ok: true, status: 200, json: async () => ({ code: 0, message: 'Success' }) };
    }
  };
  const embedding = {
    isConfigured: () => true,
    embedMany: async (texts) => {
      embeddingBatchSizes.push(texts.length);
      return texts.map(() => [0.1, 0.2, 0.3]);
    }
  };
  const vector = new VectorAdapter(vectorConfig, embedding);
  await vector.upsertMany(Array.from({ length: 23 }, (_, index) => ({ ...question('usr_many', index), _id: `q_many_${index}` })));
  assert.deepEqual(embeddingBatchSizes, [10, 10, 3]);
  assert.deepEqual(upsertBatchSizes, [10, 10, 3]);
});

test('三选一题目可以进入练习并正常判分', async () => {
  const app = createApp({ config });
  const session = await login(app, 'three-option-student');
  const row = {
    ...question(session.user.id, 1),
    stem: '既是质数，又是偶数的自然数有几个？',
    options: { A: '2 个', B: '0 个', C: '1 个' },
    correct_answer: 'C'
  };
  await app.locals.services.store.put('questions', row);

  const recommended = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(201);
  assert.equal(recommended.body.data.available, true);
  const practice = await request(app).get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`).set(auth(session.token)).expect(200);
  assert.deepEqual(Object.keys(practice.body.data.questions[0].options), ['A', 'B', 'C']);

  const submitted = await request(app)
    .post(`/v1/practice-sessions/${recommended.body.data.practice_session_id}/submit`)
    .set(auth(session.token))
    .send({ answers: { [row._id]: 'C' } })
    .expect(200);
  const result = await request(app).get(`/v1/practice-records/${submitted.body.data.practice_record_id}`).set(auth(session.token)).expect(200);
  assert.equal(result.body.data.correct_count, 1);
});

test('计算题可以从详情页加入练习并按数值等价判分', async () => {
  const app = createApp({ config });
  const session = await login(app, 'calculation-practice-student');
  const row = {
    ...question(session.user.id, 1),
    type: 'calculation',
    stem: '7 × 3 + 75 = ( )',
    options: {},
    correct_answer: '96'
  };
  await app.locals.services.store.put('questions', row);

  const created = await request(app)
    .post('/v1/practice-sessions/from-questions')
    .set(auth(session.token))
    .send({ question_ids: [row._id], type: 'single' })
    .expect(201);
  const practice = await request(app)
    .get(`/v1/practice-sessions/${created.body.data.practice_session_id}`)
    .set(auth(session.token))
    .expect(200);
  assert.equal(practice.body.data.questions[0].type, 'calculation');
  assert.deepEqual(practice.body.data.questions[0].options, {});

  const submitted = await request(app)
    .post(`/v1/practice-sessions/${created.body.data.practice_session_id}/submit`)
    .set(auth(session.token))
    .send({ answers: { [row._id]: '96.0' } })
    .expect(200);
  const result = await request(app)
    .get(`/v1/practice-records/${submitted.body.data.practice_record_id}`)
    .set(auth(session.token))
    .expect(200);
  assert.equal(result.body.data.correct_count, 1);
  assert.equal(result.body.data.items[0].user_answer, '96.0');
});

test('所有可录入题型都能进入练习，客观题自动判分且主观题支持自评', async () => {
  const app = createApp({ config });
  const session = await login(app, 'all-question-types-practice-student');
  const definitions = [
    { type: 'single_choice', options: { A: '甲', B: '乙' }, correct_answer: 'B', answer: 'b' },
    { type: 'multiple_choice', options: { A: '甲', B: '乙', C: '丙' }, correct_answer: 'AC', answer: 'CA' },
    { type: 'fill_blank', correct_answer: '北京', answer: '北京' },
    { type: 'true_false', correct_answer: '正确', answer: '对' },
    { type: 'calculation', correct_answer: '1/2', answer: '0.5' },
    { type: 'short_answer', correct_answer: '参考要点', answer: '我的简答' },
    { type: 'proof', correct_answer: '证明过程', answer: '我的证明' },
    { type: 'reading', correct_answer: '阅读参考答案', answer: '我的阅读回答' },
    { type: 'composition', correct_answer: '作文评分要点', answer: '我的作文' },
    { type: 'other', correct_answer: '其他题参考答案', answer: '我的作答' }
  ];
  const rows = definitions.map((definition, index) => ({
    ...question(session.user.id, index + 1),
    type: definition.type,
    stem: `${definition.type} 测试题`,
    options: definition.options || {},
    correct_answer: definition.correct_answer
  }));
  for (const row of rows) await app.locals.services.store.put('questions', row);

  const created = await request(app)
    .post('/v1/practice-sessions/from-questions')
    .set(auth(session.token))
    .send({ question_ids: rows.map((row) => row._id), type: 'review' })
    .expect(201);
  const practice = await request(app)
    .get(`/v1/practice-sessions/${created.body.data.practice_session_id}`)
    .set(auth(session.token))
    .expect(200);
  assert.deepEqual(practice.body.data.questions.map((row) => row.type), definitions.map((row) => row.type));

  const answers = Object.fromEntries(rows.map((row, index) => [row._id, definitions[index].answer]));
  const submitted = await request(app)
    .post(`/v1/practice-sessions/${created.body.data.practice_session_id}/submit`)
    .set(auth(session.token))
    .send({ answers })
    .expect(200);
  const recordId = submitted.body.data.practice_record_id;
  let record = (await request(app).get(`/v1/practice-records/${recordId}`).set(auth(session.token)).expect(200)).body.data;
  assert.equal(record.total_count, 10);
  assert.equal(record.correct_count, 5);
  assert.equal(record.wrong_count, 0);
  assert.equal(record.pending_count, 5);
  assert.equal(record.accuracy, 100);
  assert(record.items.slice(5).every((item) => item.grading_mode === 'self_review' && item.is_correct === null));

  const assessments = [true, false, true, false, true];
  for (let index = 0; index < assessments.length; index += 1) {
    record = (await request(app)
      .post(`/v1/practice-records/${recordId}/items/${rows[index + 5]._id}/self-assess`)
      .set(auth(session.token))
      .send({ is_correct: assessments[index] })
      .expect(200)).body.data;
  }
  assert.equal(record.pending_count, 0);
  assert.equal(record.correct_count, 8);
  assert.equal(record.wrong_count, 2);
  assert.equal(record.accuracy, 80);
});

test('练习提交兼容字符串化题目 ID 并按题序兜底恢复答案', async () => {
  const app = createApp({ config });
  const session = await login(app, 'ordered-answer-student');
  const row = {
    ...question(session.user.id, 1),
    options: { A: '一个因数', B: '两个因数', C: '三个因数' },
    correct_answer: 'C'
  };
  await app.locals.services.store.put('questions', row);
  const recommended = await request(app)
    .post('/v1/practice-sessions/recommended')
    .set(auth(session.token))
    .send({ subject: 'math' })
    .expect(201);

  const submitted = await request(app)
    .post(`/v1/practice-sessions/${recommended.body.data.practice_session_id}/submit`)
    .set(auth(session.token))
    .send({ answers: { unrelated_id: 'A' }, ordered_answers: [' c '] })
    .expect(200);
  const result = await request(app)
    .get(`/v1/practice-records/${submitted.body.data.practice_record_id}`)
    .set(auth(session.token))
    .expect(200);
  assert.equal(result.body.data.correct_count, 1);
  assert.equal(result.body.data.items[0].user_answer, 'C');
});

test('新增科目支持首页统计、题库筛选和推荐练习', async () => {
  const app = createApp({ config });
  const session = await login(app, 'physics-home-student');
  const row = { ...question(session.user.id, 1), subject: 'physics', stem: '关于浮力，下列说法正确的是（ ）' };
  await app.locals.services.store.put('questions', row);

  for (const subject of SUBJECT_KEYS) {
    const response = await request(app).get(`/v1/home?subject=${subject}`).set(auth(session.token)).expect(200);
    assert.equal(response.body.data.subject, subject);
  }

  const home = await request(app).get('/v1/home?subject=physics').set(auth(session.token)).expect(200);
  assert.equal(home.body.data.subject, 'physics');
  assert.equal(home.body.data.summary.collected_count, 1);
  assert.equal(home.body.data.recent_questions[0].id, row._id);

  const library = await request(app).get('/v1/questions?subject=physics').set(auth(session.token)).expect(200);
  assert.equal(library.body.data.items.length, 1);
  assert.equal(library.body.data.items[0].subject, 'physics');

  const recommended = await request(app)
    .post('/v1/practice-sessions/recommended')
    .set(auth(session.token))
    .send({ subject: 'physics' })
    .expect(201);
  assert.equal(recommended.body.data.available, true);
  const practice = await request(app)
    .get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`)
    .set(auth(session.token))
    .expect(200);
  assert.equal(practice.body.data.subject, 'physics');
  assert.equal(practice.body.data.questions[0].subject, 'physics');
});

test('超过十题时最多推荐十题，提交后正确判分并刷新巩固顺序', async () => {
  const app = createApp({ config });
  const session = await login(app, 'practice-student');
  const store = app.locals.services.store;
  const questions = [];
  for (let index = 1; index <= 12; index++) {
    const row = question(session.user.id, index);
    questions.push(row);
    await store.put('questions', row);
  }
  const recommended = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(201);
  const sessionId = recommended.body.data.practice_session_id;
  const practice = await request(app).get(`/v1/practice-sessions/${sessionId}`).set(auth(session.token)).expect(200);
  assert.equal(practice.body.data.questions.length, 10);
  assert.equal(practice.body.data.questions[0].correct_answer, undefined);
  assert.equal(practice.body.data.questions[0].analysis, undefined);
  const answers = Object.fromEntries(questions.map((row) => [row._id, 'B']));
  const submitted = await request(app).post(`/v1/practice-sessions/${sessionId}/submit`).set(auth(session.token)).send({ answers }).expect(200);
  const result = await request(app).get(`/v1/practice-records/${submitted.body.data.practice_record_id}`).set(auth(session.token)).expect(200);
  assert.equal(result.body.data.correct_count, 10);
  assert.equal(result.body.data.accuracy, 100);
  const sameDay = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(201);
  const secondSession = await request(app).get(`/v1/practice-sessions/${sameDay.body.data.practice_session_id}`).set(auth(session.token)).expect(200);
  const firstIds = practice.body.data.questions.map((row) => row.id);
  const secondIds = secondSession.body.data.questions.map((row) => row.id);
  assert.equal(secondIds.length, 10);
  assert.equal(secondIds.filter((questionId) => !firstIds.includes(questionId)).length, 2);
});

test('练习题数可在设置中调整并即时刷新当日推荐', async () => {
  const app = createApp({ config });
  const session = await login(app, 'practice-limit-student');
  const headers = auth(session.token);
  for (let index = 1; index <= 12; index++) {
    await app.locals.services.store.put('questions', question(session.user.id, index));
  }

  await request(app).patch('/v1/settings').set(headers).send({ practice_question_limit: 5 }).expect(200);
  const first = await request(app).post('/v1/practice-sessions/recommended').set(headers).send({ subject: 'math' }).expect(201);
  assert.equal(first.body.data.total_count, 5);

  await request(app).patch('/v1/settings').set(headers).send({ practice_question_limit: 15 }).expect(200);
  const refreshed = await request(app).post('/v1/practice-sessions/recommended').set(headers).send({ subject: 'math' }).expect(201);
  assert.equal(refreshed.body.data.total_count, 12);
});

test('不足十题时全部进入练习，新增错题后刷新当日题集', async () => {
  const app = createApp({ config });
  const session = await login(app, 'small-library-student');
  const store = app.locals.services.store;
  const questions = [];
  for (let index = 1; index <= 3; index++) {
    const row = question(session.user.id, index);
    questions.push(row);
    await store.put('questions', row);
  }

  const first = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(201);
  assert.equal(first.body.data.total_count, 3);
  const firstSession = await request(app).get(`/v1/practice-sessions/${first.body.data.practice_session_id}`).set(auth(session.token)).expect(200);
  assert.deepEqual(new Set(firstSession.body.data.questions.map((row) => row.id)), new Set(questions.map((row) => row._id)));

  const added = question(session.user.id, 4);
  await store.put('questions', added);
  const refreshed = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(201);
  assert.equal(refreshed.body.data.total_count, 4);
});

test('底部综合练习跨数学和英语统计总题量', async () => {
  const app = createApp({ config });
  const session = await login(app, 'mixed-subject-student');
  const store = app.locals.services.store;
  const mathQuestion = question(session.user.id, 1);
  const englishQuestion = { ...question(session.user.id, 2), subject: 'english', stem: 'Choose the correct answer.' };
  await store.put('questions', mathQuestion);
  await store.put('questions', englishQuestion);

  const recommended = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'all', mode: 'comprehensive' }).expect(201);
  assert.equal(recommended.body.data.total_count, 2);
  const practice = await request(app).get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`).set(auth(session.token)).expect(200);
  assert.equal(practice.body.data.subject, 'all');
  assert.equal(practice.body.data.type, 'comprehensive');
  assert.deepEqual(new Set(practice.body.data.questions.map((row) => row.subject)), new Set(['math', 'english']));
});

test('综合练习默认最多包含百分之二十已掌握题且题量不足时自动补足', async () => {
  const app = createApp({ config });
  const session = await login(app, 'comprehensive-mastery-ratio-student');
  const headers = auth(session.token);
  const store = app.locals.services.store;
  for (let index = 1; index <= 6; index++) {
    await store.put('questions', { ...question(session.user.id, index), _id: `q_ratio_unmastered_${index}` });
  }
  for (let index = 1; index <= 6; index++) {
    await store.put('questions', {
      ...question(session.user.id, index + 10),
      _id: `q_ratio_mastered_${index}`,
      mastery_status: 'mastered'
    });
  }

  const recommended = await request(app).post('/v1/practice-sessions/recommended')
    .set(headers).send({ subject: 'all', mode: 'comprehensive' }).expect(201);
  const practice = await request(app).get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`)
    .set(headers).expect(200);
  const masteredIds = new Set(Array.from({ length: 6 }, (_, index) => `q_ratio_mastered_${index + 1}`));
  assert.equal(practice.body.data.questions.length, 10);
  assert.equal(practice.body.data.questions.filter((item) => masteredIds.has(item.id)).length, 4);

  // 只有 6 道未掌握题，超过 20% 的部分属于为补足 10 道练习而启用的兜底。
  await request(app).patch('/v1/settings').set(headers).send({ practice_question_limit: 5, mastered_question_ratio: 20 }).expect(200);
  const limited = await request(app).post('/v1/practice-sessions/recommended')
    .set(headers).send({ subject: 'all', mode: 'comprehensive' }).expect(201);
  const limitedPractice = await request(app).get(`/v1/practice-sessions/${limited.body.data.practice_session_id}`)
    .set(headers).expect(200);
  assert.equal(limitedPractice.body.data.questions.length, 5);
  assert.equal(limitedPractice.body.data.questions.filter((item) => masteredIds.has(item.id)).length, 1);
});

test('首页推荐与底部综合练习使用独立会话并优先避开已有题目', async () => {
  const app = createApp({ config });
  const session = await login(app, 'isolated-practice-entry-student');
  const store = app.locals.services.store;
  for (let index = 1; index <= 12; index++) await store.put('questions', question(session.user.id, index));

  const comprehensive = await request(app)
    .post('/v1/practice-sessions/recommended')
    .set(auth(session.token))
    .send({ subject: 'all', mode: 'comprehensive' })
    .expect(201);
  const comprehensiveSession = await request(app)
    .get(`/v1/practice-sessions/${comprehensive.body.data.practice_session_id}`)
    .set(auth(session.token))
    .expect(200);
  const comprehensiveIds = comprehensiveSession.body.data.questions.map((row) => row.id);

  const recommended = await request(app)
    .post('/v1/practice-sessions/recommended')
    .set(auth(session.token))
    .send({ subject: 'math', mode: 'recommended', exclude_question_ids: comprehensiveIds })
    .expect(201);
  const recommendedSession = await request(app)
    .get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`)
    .set(auth(session.token))
    .expect(200);

  assert.equal(recommendedSession.body.data.type, 'recommended');
  assert.equal(recommendedSession.body.data.subject, 'math');
  assert.equal(recommendedSession.body.data.questions.length, 2);
  assert.equal(recommendedSession.body.data.questions.some((row) => comprehensiveIds.includes(row.id)), false);
});

test('向量数据库不可用时智能搜索自动降级为个人题库关键词检索', async () => {
  const vector = {
    upsert: async () => {},
    search: async () => { throw new Error('VectorDB unavailable'); }
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'fallback-search-student');
  const row = { ...question(session.user.id, 1), knowledge_points: ['质数'] };
  await app.locals.services.store.put('questions', row);

  const response = await request(app).post('/v1/search/questions').set(auth(session.token)).send({ keyword: '质数' }).expect(200);
  assert.equal(response.body.data.search_mode, 'keyword_fallback');
  assert.equal(response.body.data.degradation_code, 'SEMANTIC_SEARCH_UNAVAILABLE');
  assert.equal(response.body.data.total, 1);
  assert.equal(response.body.data.items[0].id, row._id);
  const status = await request(app).get('/v1/search/status').set(auth(session.token)).expect(200);
  assert.equal(status.body.data.available, false);
  assert.equal(status.body.data.code, 'SEMANTIC_SEARCH_UNAVAILABLE');
});

test('关键词降级检索过滤仅有单字符重合的低相似度结果', async () => {
  const vector = {
    upsert: async () => {},
    search: async () => { throw new Error('VectorDB unavailable'); }
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'fallback-search-threshold-student');
  const exact = {
    ...question(session.user.id, 1),
    _id: 'q_day_exact',
    subject: 'english',
    stem: "M Henny Teachers' Day Miss Wang"
  };
  const noise = {
    ...question(session.user.id, 2),
    _id: 'q_day_noise',
    analysis: 'A',
    knowledge_points: ['分数']
  };
  await app.locals.services.store.put('questions', exact);
  await app.locals.services.store.put('questions', noise);

  const response = await request(app)
    .post('/v1/search/questions')
    .set(auth(session.token))
    .send({ keyword: 'Day' })
    .expect(200);

  assert.equal(response.body.data.total, 1);
  assert.equal(response.body.data.items[0].id, exact._id);
  assert.equal(response.body.data.items[0].similarity, 100);
});

test('语义检索按实测低分区间过滤背景噪声', async () => {
  const vector = {
    upsert: async () => {},
    search: async () => [
      { id: 'q_semantic_relevant', score: 0.3 },
      { id: 'q_semantic_noise', score: 0.2 }
    ]
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'semantic-search-threshold-student');
  await app.locals.services.store.put('questions', {
    ...question(session.user.id, 1),
    _id: 'q_semantic_relevant',
    stem: '相关题目'
  });
  await app.locals.services.store.put('questions', {
    ...question(session.user.id, 2),
    _id: 'q_semantic_noise',
    stem: '无关题目'
  });

  const response = await request(app)
    .post('/v1/search/questions')
    .set(auth(session.token))
    .send({ keyword: '按含义寻找' })
    .expect(200);

  assert.equal(response.body.data.search_mode, 'hybrid');
  assert.equal(response.body.data.total, 1);
  assert.equal(response.body.data.items[0].id, 'q_semantic_relevant');
  assert.equal(response.body.data.items[0].similarity, 30);
});

test('语义搜索短暂失败时自动重试并与关键词结果合并', async () => {
  let attempts = 0;
  const vector = {
    upsert: async () => {},
    search: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary unavailable');
      return [{ id: 'q_semantic_retry', score: 0.86 }];
    }
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'semantic-retry-student');
  const row = { ...question(session.user.id, 1), _id: 'q_semantic_retry', stem: '完全不同的题干' };
  await app.locals.services.store.put('questions', row);

  const response = await request(app)
    .post('/v1/search/questions')
    .set(auth(session.token))
    .send({ keyword: '按含义寻找' })
    .expect(200);

  assert.equal(attempts, 2);
  assert.equal(response.body.data.search_mode, 'hybrid');
  assert.equal(response.body.data.degradation_code, '');
  assert.equal(response.body.data.items[0].id, row._id);
});

test('语义搜索自动补建历史题目的缺失向量索引', async () => {
  const repairedIds = [];
  const vector = {
    upsertMany: async (questions) => repairedIds.push(...questions.map((item) => item._id)),
    search: async () => [{ id: 'q_pending_index', score: 0.91 }]
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'semantic-index-repair-student');
  await app.locals.services.store.put('questions', {
    ...question(session.user.id, 1),
    _id: 'q_pending_index',
    index_status: 'failed',
    stem: '求三角形面积的应用题'
  });

  const response = await request(app)
    .post('/v1/search/questions')
    .set(auth(session.token))
    .send({ keyword: '图形面积' })
    .expect(200);

  assert.deepEqual(repairedIds, ['q_pending_index']);
  assert.equal(response.body.data.repaired_index_count, 1);
  assert.equal(response.body.data.items[0].id, 'q_pending_index');
  assert.equal((await app.locals.services.store.get('questions', 'q_pending_index')).index_status, 'ready');
});

test('实时语义服务短暂失败时复用最近成功结果而不降级为纯关键词', async () => {
  let available = true;
  const vector = {
    search: async () => {
      if (!available) throw new Error('temporary provider outage');
      return [{ id: 'q_semantic_cached', score: 0.88 }];
    }
  };
  const app = createApp({ config, vector });
  const session = await login(app, 'semantic-cache-student');
  await app.locals.services.store.put('questions', {
    ...question(session.user.id, 1), _id: 'q_semantic_cached', stem: '分数基本性质'
  });
  await request(app).post('/v1/search/questions').set(auth(session.token)).send({ keyword: '分数含义' }).expect(200);
  available = false;
  const cached = await request(app).post('/v1/search/questions')
    .set(auth(session.token)).send({ keyword: '分数含义' }).expect(200);
  assert.equal(cached.body.data.search_mode, 'hybrid');
  assert.equal(cached.body.data.semantic_cache_used, true);
  assert.equal(cached.body.data.degradation_code, '');
  assert.equal(cached.body.data.items[0].id, 'q_semantic_cached');
});

test('知识点掌握度使用真实作答统计并让已练习知识点优先进入雷达图', async () => {
  const app = createApp({ config });
  const session = await login(app, 'mastery-student');
  const store = app.locals.services.store;
  const practiced = { ...question(session.user.id, 1), knowledge_points: ['一元二次方程'] };
  const unpracticed = { ...question(session.user.id, 2), knowledge_points: ['素数', '合数', '因数', '连续偶数', '质数的定义'] };
  await store.put('questions', practiced);
  await store.put('questions', unpracticed);
  await store.put('knowledge_point_stats', {
    _id: id('kp'),
    user_id: session.user.id,
    subject: 'math',
    knowledge_point: '一元二次方程',
    attempt_count: 4,
    correct_count: 1,
    mastery_rate: 99,
    updated_at: nowIso()
  });

  const response = await request(app).get('/v1/mastery?subject=math').set(auth(session.token)).expect(200);
  const result = response.body.data;
  assert.equal(result.items[0].knowledge_point, '一元二次方程');
  assert.equal(result.items[0].mastery_rate, 25);
  assert.equal(result.items[0].attempt_count, 4);
  assert.equal(result.items[0].correct_count, 1);
  assert.equal(result.radar[0].knowledge_point, '一元二次方程');
});

test('智能推题优先巩固低掌握知识点并在掌握度变化后刷新当日排序', async () => {
  const app = createApp({ config });
  const session = await login(app, 'mastery-recommendation-student');
  const store = app.locals.services.store;
  const weakQuestion = { ...question(session.user.id, 1), _id: 'q_weak_mastery', knowledge_points: ['分数运算'] };
  const strongQuestion = { ...question(session.user.id, 2), _id: 'q_strong_mastery', knowledge_points: ['整数运算'] };
  await store.put('questions', weakQuestion);
  await store.put('questions', strongQuestion);
  await store.put('knowledge_point_stats', {
    _id: 'kp_weak_recommendation', user_id: session.user.id, subject: 'math', knowledge_point: '分数运算',
    attempt_count: 10, correct_count: 1, mastery_rate: 10, updated_at: '2026-08-29T08:00:00.000Z'
  });
  await store.put('knowledge_point_stats', {
    _id: 'kp_strong_recommendation', user_id: session.user.id, subject: 'math', knowledge_point: '整数运算',
    attempt_count: 10, correct_count: 9, mastery_rate: 90, updated_at: '2026-08-29T08:00:00.000Z'
  });

  const first = await request(app).post('/v1/practice-sessions/recommended')
    .set(auth(session.token)).send({ subject: 'math' }).expect(201);
  const firstSession = await request(app).get(`/v1/practice-sessions/${first.body.data.practice_session_id}`)
    .set(auth(session.token)).expect(200);
  assert.equal(firstSession.body.data.questions[0].id, 'q_weak_mastery');

  await store.update('knowledge_point_stats', 'kp_weak_recommendation', {
    correct_count: 9, mastery_rate: 90, updated_at: '2026-08-29T09:00:00.000Z'
  });
  await store.update('knowledge_point_stats', 'kp_strong_recommendation', {
    correct_count: 1, mastery_rate: 10, updated_at: '2026-08-29T09:00:00.000Z'
  });
  const refreshed = await request(app).post('/v1/practice-sessions/recommended')
    .set(auth(session.token)).send({ subject: 'math' }).expect(201);
  const refreshedSession = await request(app).get(`/v1/practice-sessions/${refreshed.body.data.practice_session_id}`)
    .set(auth(session.token)).expect(200);
  assert.equal(refreshedSession.body.data.questions[0].id, 'q_strong_mastery');
});

test('推题难度设置会实际优先匹配所选难度', async () => {
  const app = createApp({ config });
  const session = await login(app, 'difficulty-preference-student');
  const store = app.locals.services.store;
  await request(app).patch('/v1/settings').set(auth(session.token))
    .send({ recommendation_difficulty: 'hard' }).expect(200);
  await store.put('questions', { ...question(session.user.id, 1), _id: 'q_preference_easy', difficulty: 'easy' });
  await store.put('questions', { ...question(session.user.id, 2), _id: 'q_preference_hard', difficulty: 'hard' });
  const recommended = await request(app).post('/v1/practice-sessions/recommended')
    .set(auth(session.token)).send({ subject: 'math' }).expect(201);
  const practice = await request(app).get(`/v1/practice-sessions/${recommended.body.data.practice_session_id}`)
    .set(auth(session.token)).expect(200);
  assert.equal(practice.body.data.questions[0].id, 'q_preference_hard');
});

test('没有可练习错题时返回正常业务结果并提示先上传', async () => {
  const app = createApp({ config });
  const session = await login(app, 'new-student');
  const response = await request(app).post('/v1/practice-sessions/recommended').set(auth(session.token)).send({ subject: 'math' }).expect(200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.available, false);
  assert.equal(response.body.data.practice_session_id, '');
  assert.equal(response.body.data.total_count, 0);
  assert.equal(response.body.data.subject, 'math');
  assert.equal(response.body.data.message, '数学暂无可练习错题，请先上传错题');
  const createdSessions = await app.locals.services.store.find('practice_sessions', { where: { user_id: session.user.id }, limit: 10 });
  assert.equal(createdSessions.length, 0);
});

test('旧协议用户需主动开启积分且不追溯开启前行为', async () => {
  const app = createApp({ config });
  const session = await login(app, 'points-existing-user');
  const headers = auth(session.token);
  const beforeActivation = {
    ...question(session.user.id, 1),
    _id: 'q_points_before_activation',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z'
  };
  await app.locals.services.store.put('questions', beforeActivation);

  const inactive = await request(app).get('/v1/points').set(headers).expect(200);
  assert.equal(inactive.body.data.status, 'inactive');
  assert.equal(inactive.body.data.balance, 0);
  assert.deepEqual(inactive.body.data.recent_transactions, []);
  assert.equal(inactive.body.data.rules[0].daily_limit, 5);
  await request(app).post('/v1/points/activate').set(headers).send({}).expect(400);
  await request(app).post('/v1/points/activate').set(headers).send({
    agreement_consent: true,
    privacy_consent: true,
    terms_version: POINTS_TERMS_VERSION
  }).expect(201);
  const activated = await request(app).get('/v1/points').set(headers).expect(200);
  assert.equal(activated.body.data.status, 'active');
  assert.equal(activated.body.data.balance, 0);
  const consentedUser = await app.locals.services.store.get('users', session.user.id);
  assert.equal(consentedUser.agreement_consent_version, POINTS_TERMS_VERSION);
  assert.equal(consentedUser.privacy_consent_version, POINTS_TERMS_VERSION);

  const afterActivation = { ...question(session.user.id, 2), _id: 'q_points_after_activation' };
  await app.locals.services.store.put('questions', afterActivation);
  const reward = await app.locals.services.points.awardSavedQuestions(session.user.id, [afterActivation._id]);
  assert.equal(reward.amount, 2);
  const summary = await request(app).get('/v1/points').set(headers).expect(200);
  assert.equal(summary.body.data.balance, 2);
  assert.equal(summary.body.data.recent_transactions.length, 1);
  assert.equal(summary.body.data.recent_transactions[0].delta, 2);
});

test('积分面板首屏不执行全量历史对账并一次返回最近明细', async () => {
  const app = createApp({ config });
  const session = await loginWithPoints(app, 'points-fast-dashboard-user');
  const row = { ...question(session.user.id, 1), _id: 'q_points_fast_dashboard' };
  await app.locals.services.store.put('questions', row);
  await app.locals.services.points.awardSavedQuestions(session.user.id, [row._id]);

  const findCalls = [];
  const originalFind = app.locals.services.store.find.bind(app.locals.services.store);
  app.locals.services.store.find = async (name, options) => {
    findCalls.push({ name, options });
    return originalFind(name, options);
  };
  const dashboard = await request(app).get('/v1/points').set(auth(session.token)).expect(200);
  assert.equal(dashboard.body.data.balance, 2);
  assert.equal(dashboard.body.data.recent_transactions[0].rule_code, 'question_saved');
  assert.equal(findCalls.some((call) => call.name === 'questions'), false);
  assert.equal(findCalls.filter((call) => call.name === 'point_transactions').length, 1);
});

test('积分明细使用增量游标分页且跳过未发放的封顶流水', async () => {
  const userId = 'usr_points_paging';
  const baseTime = new Date('2026-09-01T08:00:00.000Z').getTime();
  const rows = Array.from({ length: 240 }, (_, index) => ({
    _id: `txn_page_${index}`,
    user_id: userId,
    type: 'earn',
    rule_code: 'practice_completed',
    delta: index % 3 === 0 ? 0 : 1,
    status: index % 3 === 0 ? 'capped' : 'awarded',
    description: '完成练习',
    created_at: new Date(baseTime - index * 1000).toISOString()
  }));
  const store = new MemoryDataStore({
    point_accounts: [{ _id: userId, user_id: userId, balance: 160, activated_at: '2026-09-01T00:00:00.000Z' }],
    point_transactions: rows
  });
  const findCalls = [];
  const originalFind = store.find.bind(store);
  store.find = async (name, options) => {
    findCalls.push({ name, ...options });
    return originalFind(name, options);
  };
  const points = new PointsService(store, { pointsEnabled: true });

  const first = await points.transactions(userId, '', 5);
  assert.deepEqual(first.items.map((item) => item.id), ['txn_page_1', 'txn_page_2', 'txn_page_4', 'txn_page_5', 'txn_page_7']);
  assert.equal(first.next_cursor, '8');
  assert.equal(findCalls.length, 1);
  assert.equal(findCalls[0].limit, 100);
  assert.equal(findCalls[0].offset, 0);

  const second = await points.transactions(userId, first.next_cursor, 5);
  assert.equal(second.items[0].id, 'txn_page_8');
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 10);
  assert.equal(findCalls[1].offset, 8);
});

test('积分按内容和学习来源幂等发放并严格执行每日上限', async () => {
  const app = createApp({ config });
  const session = await loginWithPoints(app, 'points-rules-user');
  const headers = auth(session.token);
  const rows = Array.from({ length: 12 }, (_, index) => ({
    ...question(session.user.id, index + 1),
    _id: `q_points_rule_${index + 1}`
  }));
  const duplicate = { ...rows[0], _id: 'q_points_duplicate_content' };
  for (const row of [...rows, duplicate]) await app.locals.services.store.put('questions', row);

  const saved = await app.locals.services.points.awardSavedQuestions(session.user.id, [rows[0]._id, duplicate._id]);
  assert.equal(saved.amount, 2);
  assert.equal((await app.locals.services.points.awardSavedQuestions(session.user.id, [rows[0]._id])).amount, 0);
  const remainingSaved = await app.locals.services.points.awardSavedQuestions(session.user.id, rows.slice(1, 5).map((row) => row._id));
  assert.equal(remainingSaved.amount, 8);

  const submittedAt = nowIso();
  const practiceRecord = {
    _id: 'pr_points_daily_limit',
    session_id: 'ps_points_daily_limit',
    user_id: session.user.id,
    subject: 'math',
    type: 'review',
    total_count: rows.length,
    graded_count: rows.length,
    pending_count: 0,
    correct_count: rows.length,
    wrong_count: 0,
    accuracy: 100,
    items: rows.map((row) => ({ question_id: row._id, is_correct: true })),
    submitted_at: submittedAt
  };
  await app.locals.services.store.put('practice_records', practiceRecord);
  const practiced = await app.locals.services.points.awardPracticeRecord(session.user.id, practiceRecord._id);
  assert.equal(practiced.amount, 10);
  assert.equal((await app.locals.services.points.awardPracticeRecord(session.user.id, practiceRecord._id)).amount, 0);

  for (const row of rows.slice(0, 4)) {
    await app.locals.services.store.update('questions', row._id, {
      mastery_status: 'mastered', first_mastered_at: submittedAt, updated_at: submittedAt
    });
  }
  const mastered = await app.locals.services.points.awardEligibleMastery(session.user.id, rows.slice(0, 4).map((row) => row._id));
  assert.equal(mastered.amount, 15);
  assert.equal((await app.locals.services.points.awardEligibleMastery(session.user.id, rows.slice(0, 4).map((row) => row._id))).amount, 0);

  const summary = await request(app).get('/v1/points').set(headers).expect(200);
  assert.equal(summary.body.data.balance, 35);
  assert.equal(summary.body.data.rules.find((rule) => rule.code === 'practice_completed').progress, 10);
  assert.equal(summary.body.data.rules.find((rule) => rule.code === 'question_mastered').progress, 3);
  const history = await request(app).get('/v1/points/transactions').set(headers).expect(200);
  assert.equal(history.body.data.items.reduce((sum, item) => sum + item.delta, 0), 35);

  const another = await loginWithPoints(app, 'points-isolated-user');
  const isolated = await request(app).get('/v1/points/transactions').set(auth(another.token)).expect(200);
  assert.deepEqual(isolated.body.data.items, []);
  await request(app).post('/v1/points/award').set(headers).send({ delta: 999999 }).expect(404);
});

test('积分只在识别保存成功后发放且不改变 OCR 结果', async () => {
  const app = createApp({ config });
  const session = await loginWithPoints(app, 'points-ocr-user');
  const headers = auth(session.token);
  const created = await request(app)
    .post('/v1/recognitions')
    .set(headers)
    .attach('image', Buffer.from('points-ocr-image'), 'question.jpg')
    .expect(201);
  const task = await waitForRecognition(app, session.token, created.body.data.task_id);
  assert.equal(task.status, 'succeeded');
  assert.match(task.raw_text, /一元二次方程/);
  assert.equal((await request(app).get('/v1/points').set(headers).expect(200)).body.data.balance, 0);

  const saved = await request(app).post(`/v1/recognitions/${task.task_id}/save`).set(headers).expect(201);
  assert.equal(saved.body.data.points_reward.amount, 2);
  const repeated = await request(app).post(`/v1/recognitions/${task.task_id}/save`).set(headers).expect(201);
  assert.equal(repeated.body.data.points_reward.amount, 0);
  const unchanged = await request(app).get(`/v1/recognitions/${task.task_id}`).set(headers).expect(200);
  assert.equal(unchanged.body.data.raw_text, task.raw_text);
  assert.deepEqual(unchanged.body.data.parsed_question, task.parsed_question);
});
