import dotenv from 'dotenv';

dotenv.config();

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
};

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  dataDriver: process.env.DATA_DRIVER || 'memory',
  mockExternalServices: bool(process.env.MOCK_EXTERNAL_SERVICES, process.env.NODE_ENV !== 'production'),
  sessionSecret: process.env.APP_SESSION_SECRET || 'development-only-session-secret',
  cloudbaseEnvId: process.env.CLOUDBASE_ENV_ID || '',
  cloudbaseApiKey: process.env.CLOUDBASE_API_KEY || '',
  wechatAppId: process.env.WECHAT_APP_ID || 'wx7d9c6a2740751b9d',
  wechatAppSecret: process.env.WECHAT_APP_SECRET || '',
  tencentSecretId: process.env.TENCENT_SECRET_ID || '',
  tencentSecretKey: process.env.TENCENT_SECRET_KEY || '',
  alibabaCloudAccessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
  alibabaCloudAccessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '',
  alibabaCloudSecurityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN || '',
  aliyunOcrEndpoint: process.env.ALIYUN_OCR_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com',
  aliyunOcrRegionId: process.env.ALIYUN_OCR_REGION_ID || 'cn-hangzhou',
  aliyunOcrSingleAction: process.env.ALIYUN_OCR_SINGLE_ACTION || 'RecognizeEduQuestionOcr',
  aliyunOcrPaperCutEnabled: bool(process.env.ALIYUN_OCR_PAPER_CUT_ENABLED, true),
  aliyunOcrPaperCutAction: process.env.ALIYUN_OCR_PAPER_CUT_ACTION || 'RecognizeEduPaperCut',
  aliyunOcrPaperAction: process.env.ALIYUN_OCR_PAPER_ACTION || 'RecognizeEduPaperOcr',
  aliyunOcrImageType: process.env.ALIYUN_OCR_IMAGE_TYPE || 'photo',
  aliyunOcrSubject: process.env.ALIYUN_OCR_SUBJECT || 'default',
  aliyunOcrNeedRotate: bool(process.env.ALIYUN_OCR_NEED_ROTATE, true),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  deepseekMaxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 8192),
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS || 90000),
  recognitionTaskTimeoutMs: Number(process.env.RECOGNITION_TASK_TIMEOUT_MS || 240000),
  vectorProvider: process.env.VECTOR_PROVIDER || 'dashvector',
  dashVectorEndpoint: (process.env.DASHVECTOR_ENDPOINT || '').replace(/\/+$/, ''),
  dashVectorApiKey: process.env.DASHVECTOR_API_KEY || '',
  dashVectorCollection: process.env.DASHVECTOR_COLLECTION || 'questions',
  vectorRequestTimeoutMs: Number(process.env.VECTOR_REQUEST_TIMEOUT_MS || 12000),
  dashScopeBaseUrl: (process.env.DASHSCOPE_BASE_URL || '').replace(/\/+$/, ''),
  dashScopeApiKey: process.env.DASHSCOPE_API_KEY || '',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-v4',
  embeddingDimension: Number(process.env.EMBEDDING_DIMENSION || 1024),
  pdfFontPath: process.env.PDF_FONT_PATH || '',
  pdfFontFamily: process.env.PDF_FONT_FAMILY || '',
  pointsEnabled: bool(process.env.POINTS_ENABLED, process.env.NODE_ENV !== 'production')
});

const missingNames = (entries) => entries
  .filter(([, value]) => !value || value === 'development-only-session-secret')
  .map(([name]) => name);

export function getProductionConfigStatus(config = env) {
  if (config.nodeEnv !== 'production') {
    return Object.freeze({
      authReady: true,
      recognitionReady: true,
      searchReady: true,
      authMissing: [],
      recognitionMissing: [],
      searchMissing: []
    });
  }

  const authMissing = [
    ...(config.mockExternalServices ? ['MOCK_EXTERNAL_SERVICES=false'] : []),
    ...(config.dataDriver !== 'cloudbase' ? ['DATA_DRIVER=cloudbase'] : []),
    ...missingNames([
      ['APP_SESSION_SECRET', config.sessionSecret],
      ['CLOUDBASE_ENV_ID', config.cloudbaseEnvId],
      ['WECHAT_APP_SECRET', config.wechatAppSecret]
    ])
  ];
  const aiReady = Boolean(
    (config.deepseekApiKey && config.deepseekBaseUrl)
    || (config.dashScopeApiKey && config.dashScopeBaseUrl)
  );
  const recognitionMissing = [
    ...missingNames([
      ['ALIBABA_CLOUD_ACCESS_KEY_ID', config.alibabaCloudAccessKeyId],
      ['ALIBABA_CLOUD_ACCESS_KEY_SECRET', config.alibabaCloudAccessKeySecret]
    ]),
    ...(aiReady ? [] : ['DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL 或 DASHSCOPE_BASE_URL/DASHSCOPE_API_KEY'])
  ];
  const searchMissing = missingNames([
    ['DASHVECTOR_ENDPOINT', config.dashVectorEndpoint],
    ['DASHVECTOR_API_KEY', config.dashVectorApiKey],
    ['DASHSCOPE_BASE_URL', config.dashScopeBaseUrl],
    ['DASHSCOPE_API_KEY', config.dashScopeApiKey]
  ]);

  return Object.freeze({
    authReady: authMissing.length === 0,
    recognitionReady: recognitionMissing.length === 0,
    searchReady: searchMissing.length === 0,
    authMissing,
    recognitionMissing,
    searchMissing
  });
}

export function assertProductionConfig(config = env) {
  const status = getProductionConfigStatus(config);
  const missing = [
    ...status.authMissing,
    ...status.recognitionMissing,
    ...status.searchMissing
  ];
  if (missing.length) throw new Error(`生产环境配置缺失: ${missing.join(', ')}`);
}
