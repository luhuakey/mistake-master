// 所有可上传版本默认通过微信云开发私有链路访问云托管，无需配置 request 合法域名。
const CLOUD_ENV_ID = 'development-d3g6c1hqv2750bedf';
const CLOUD_SERVICE_NAME = 'mistake-master-server';
const LOCAL_API_BASE_URL = 'http://127.0.0.1:3000/v1';
// 本地 HTTP 只能在开发者工具中显式开启。上传包、真机和审核环境绝不会因 envVersion=develop 访问 localhost。
const LOCAL_API_OPT_IN_KEY = '__mistake_master_use_local_api__';

const CLOUD_RUNTIME_CONFIG = Object.freeze({
  transport: 'cloud',
  cloudEnvId: CLOUD_ENV_ID,
  cloudServiceName: CLOUD_SERVICE_NAME,
  apiBaseUrl: ''
});

const LOCAL_RUNTIME_CONFIG = Object.freeze({
  transport: 'http',
  cloudEnvId: CLOUD_ENV_ID,
  cloudServiceName: CLOUD_SERVICE_NAME,
  apiBaseUrl: LOCAL_API_BASE_URL
});

const currentEnvVersion = () => {
  try {
    return wx.getAccountInfoSync()?.miniProgram?.envVersion || 'unknown';
  } catch {
    return 'unknown';
  }
};

const currentPlatform = () => {
  try {
    if (wx.getDeviceInfo) return wx.getDeviceInfo().platform || '';
    return wx.getSystemInfoSync().platform || '';
  } catch {
    return '';
  }
};

const localApiExplicitlyEnabled = (envVersion) => {
  if (envVersion !== 'develop' || currentPlatform() !== 'devtools') return false;
  try {
    return wx.getStorageSync(LOCAL_API_OPT_IN_KEY) === true;
  } catch {
    return false;
  }
};

export const getRuntimeConfig = () => {
  const envVersion = currentEnvVersion();
  const localApiEnabled = localApiExplicitlyEnabled(envVersion);
  const selected = localApiEnabled ? LOCAL_RUNTIME_CONFIG : CLOUD_RUNTIME_CONFIG;
  return {
    envVersion,
    localApiEnabled,
    apiTransport: selected.transport,
    cloudEnvId: selected.cloudEnvId,
    cloudServiceName: selected.cloudServiceName,
    apiBaseUrl: selected.apiBaseUrl,
    requestTimeout: 30000,
    recognitionUploadTimeout: 240000
  };
};
