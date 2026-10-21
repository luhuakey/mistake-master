import { clearAuthSession } from '../utils/auth';

const app = () => getApp();
const apiPath = (path) => `/v1${path}`;
const AVATAR_INLINE_BASE64_LIMIT = 72 * 1024;

const apiUrl = (path) => {
  const baseUrl = app().globalData.apiBaseUrl || '';
  if (!baseUrl) throw { code: 'API_NOT_CONFIGURED', message: '当前版本尚未配置后端服务地址' };
  return `${baseUrl}${path}`;
};

const networkError = (fallback, detail) => {
  // 运行配置异常时也按云端链路处理，避免将审核或真机故障误报为本地服务故障。
  const transport = app().globalData.apiTransport || 'cloud';
  const baseUrl = app().globalData.apiBaseUrl || '';
  const platformCode = detail?.errCode || detail?.code || '';
  const platformMessage = String(detail?.errMsg || detail?.message || '');
  const platformReason = platformMessage
    .replace(/^.*?(?:wx\.)?cloud\.callContainer:fail\s*/i, '')
    .replace(/^.*?callContainer:fail\s*/i, '')
    .trim();
  const requestId = detail?.requestID || detail?.requestId || detail?.request_id || '';
  const diagnostic = [platformCode, requestId].filter(Boolean).join(' / ');
  const suffix = diagnostic ? `（${diagnostic}）` : '';
  if (/timeout/i.test(detail?.errMsg || '')) {
    return { code: 'NETWORK_TIMEOUT', message: '请求处理超时，请稍后重试' };
  }
  if (transport === 'cloud') {
    const classificationText = `${platformCode} ${platformReason}`;
    console.error('[cloud-call-container]', {
      env: app().globalData.cloudEnvId,
      service: app().globalData.cloudServiceName,
      platformCode,
      platformReason,
      requestId,
      detail
    });
    if (String(platformCode) === '-606001' || /请求包.*(?:100\s*KB|过大)|request.*(?:too large|100\s*KB)/i.test(classificationText)) {
      return { code: 'CLOUD_REQUEST_TOO_LARGE', message: '上传内容过大，请重新选择图片后再试' };
    }
    if (String(platformCode) === '102002') {
      return { code: 'CLOUD_REQUEST_INTERRUPTED', message: `云托管请求未能完成，请稍后重试；若持续出现，请确认最新服务版本已生效${suffix}` };
    }
    if (/env|environment|环境/i.test(classificationText)) {
      return { code: 'CLOUD_ENV_INVALID', message: `云开发环境不可用，请确认小程序已关联正确的云开发环境${suffix}` };
    }
    if (/permission|forbidden|unauthori[sz]ed|scope|appid|access.?denied|权限|无权|未授权/i.test(classificationText)) {
      return { code: 'CLOUD_ACCESS_DENIED', message: `当前小程序无权访问该云环境，请检查环境关联或环境共享${suffix}` };
    }
    if (/service.?not.?found|service.?not.?exist|resource.?not.?found|服务不存在|找不到服务/i.test(classificationText)) {
      return { code: 'CLOUD_SERVICE_UNAVAILABLE', message: `云托管服务暂时不可用，请确认服务名、环境关联和版本流量${suffix}` };
    }
    return { code: 'CLOUD_NETWORK_ERROR', message: `无法连接云托管服务，请检查云环境关联和服务发布状态${suffix}` };
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?/i.test(baseUrl)) {
    return { code: 'LOCAL_API_UNAVAILABLE', message: '无法连接本地服务，请确认已运行 npm run dev 且地址可访问' };
  }
  return { code: 'NETWORK_ERROR', message: fallback };
};

const headers = (extra = {}) => ({
  'content-type': 'application/json',
  // Authorization 是 callContainer 的云平台保留鉴权头，业务 JWT 必须使用独立名称。
  ...(app().globalData.token ? { 'X-App-Authorization': `Bearer ${app().globalData.token}` } : {}),
  ...extra
});

const handle = (resolve, reject) => (response) => {
  const body = response.data || {};
  if (response.statusCode >= 200 && response.statusCode < 300 && body.success) return resolve(body.data);
  const error = body.error || { code: 'NETWORK_ERROR', message: '请求失败，请重试' };
  if (error.code === 'AUTH_REQUIRED') {
    clearAuthSession();
  }
  reject(error);
};

export const request = (path, options = {}) => new Promise((resolve, reject) => {
  const globalData = app().globalData;
  const common = {
    method: options.method || 'GET',
    data: options.data,
    timeout: options.timeout || globalData.requestTimeout || 30000,
    success: handle(resolve, reject),
    fail: (error) => reject(networkError('服务暂时不可用，请稍后重试', error))
  };

  if (globalData.apiTransport === 'cloud') {
    if (!wx.cloud?.callContainer || !globalData.cloudEnvId || !globalData.cloudServiceName) {
      reject({ code: 'CLOUD_API_NOT_CONFIGURED', message: '云托管服务尚未配置完成' });
      return;
    }
    wx.cloud.callContainer({
      ...common,
      config: { env: globalData.cloudEnvId },
      path: apiPath(path),
      header: {
        'X-WX-SERVICE': globalData.cloudServiceName,
        ...headers(options.header)
      }
    });
    return;
  }

  let url;
  try { url = apiUrl(path); } catch (error) { reject(error); return; }
  wx.request({
    ...common,
    url,
    header: headers(options.header)
  });
});

export const requestArrayBuffer = (path) => new Promise((resolve, reject) => {
  let url;
  try { url = apiUrl(path); } catch (error) { reject(error); return; }
  wx.request({
    url,
    method: 'GET',
    header: headers(),
    responseType: 'arraybuffer',
    timeout: app().globalData.requestTimeout || 30000,
    success: (response) => {
      if (response.statusCode >= 200 && response.statusCode < 300 && response.data) {
        resolve(response.data);
        return;
      }
      reject({ code: 'QUESTION_IMAGE_DOWNLOAD_FAILED', message: '题目配图加载失败' });
    },
    fail: (error) => reject(networkError('题目配图加载失败', error))
  });
});

const fileInfo = (filePath, name) => {
  const matched = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const extension = (matched?.[1] || 'jpg').toLowerCase();
  const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return { fileName: `${name}.${extension}`, mimeType: mimeTypes[extension] || 'image/jpeg' };
};

const readBase64 = (filePath) => new Promise((resolve, reject) => {
  wx.getFileSystemManager().readFile({
    filePath,
    encoding: 'base64',
    success: ({ data }) => resolve(data),
    fail: (error) => reject({ code: 'FILE_READ_FAILED', message: '读取图片失败，请重新选择', detail: error?.errMsg })
  });
});

const compressImage = (filePath, { quality, width, height }) => new Promise((resolve, reject) => {
  if (!wx.compressImage) {
    reject({ code: 'IMAGE_COMPRESS_UNAVAILABLE', message: '当前微信版本不支持头像压缩' });
    return;
  }
  wx.compressImage({
    src: filePath,
    quality,
    compressedWidth: width,
    compressedHeight: height,
    success: ({ tempFilePath }) => tempFilePath
      ? resolve(tempFilePath)
      : reject({ code: 'IMAGE_COMPRESS_FAILED', message: '头像压缩失败' }),
    fail: (error) => reject({ code: 'IMAGE_COMPRESS_FAILED', message: '头像压缩失败', detail: error?.errMsg })
  });
});

const inlineAvatarInfo = (fileBase64, name) => {
  const signatures = [
    { matched: fileBase64.startsWith('/9j/'), extension: 'jpg', mimeType: 'image/jpeg' },
    { matched: fileBase64.startsWith('iVBOR'), extension: 'png', mimeType: 'image/png' },
    { matched: fileBase64.startsWith('UklGR'), extension: 'webp', mimeType: 'image/webp' }
  ];
  const detected = signatures.find((item) => item.matched) || signatures[0];
  return { fileBase64, fileName: `${name}.${detected.extension}`, mimeType: detected.mimeType };
};

const prepareInlineAvatar = async (filePath, name) => {
  const candidates = [filePath];
  const compressionSteps = [
    { quality: 64, width: 320, height: 320 },
    { quality: 48, width: 240, height: 240 },
    { quality: 34, width: 160, height: 160 }
  ];
  let lastError = null;
  for (let index = 0; index <= compressionSteps.length; index += 1) {
    if (index > 0) {
      try { candidates.push(await compressImage(filePath, compressionSteps[index - 1])); }
      catch (error) {
        lastError = error;
        if (error?.code === 'IMAGE_COMPRESS_UNAVAILABLE') break;
        continue;
      }
    }
    try {
      const fileBase64 = await readBase64(candidates[candidates.length - 1]);
      if (fileBase64.length <= AVATAR_INLINE_BASE64_LIMIT) return inlineAvatarInfo(fileBase64, name);
      lastError = { code: 'AVATAR_INLINE_TOO_LARGE', message: '头像压缩后仍然过大' };
    } catch (error) { lastError = error; }
  }
  throw lastError || { code: 'AVATAR_INLINE_FAILED', message: '头像处理失败，请重新选择' };
};

const cloudUploadPath = (filePath, name) => {
  const { fileName } = fileInfo(filePath, name);
  const extension = fileName.split('.').pop() || 'jpg';
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const userId = String(app().globalData.user?.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (name === 'avatar' && userId) return `users/${userId}/profile-staging/${nonce}.${extension}`;
  return `client-uploads/${name}/${nonce}.${extension}`;
};

const cloudStorageError = (detail) => {
  const platformCode = detail?.errCode || detail?.code || '';
  const platformMessage = String(detail?.errMsg || detail?.message || '');
  const suffix = platformCode ? `（${platformCode}）` : '';
  if (/permission|forbidden|unauthori[sz]ed|access.?denied|权限|无权|未授权/i.test(`${platformCode} ${platformMessage}`)) {
    return { code: 'CLOUD_STORAGE_ACCESS_DENIED', message: `云存储拒绝上传，请检查云存储安全规则${suffix}`, cause: detail };
  }
  if (/quota|capacity|storage.*full|空间不足|配额/i.test(`${platformCode} ${platformMessage}`)) {
    return { code: 'CLOUD_STORAGE_QUOTA_EXCEEDED', message: `云存储空间或上传配额不足${suffix}`, cause: detail };
  }
  return { code: 'CLOUD_STORAGE_UPLOAD_FAILED', message: `云存储上传失败，请稍后重试${suffix}`, cause: detail };
};

const uploadToCloud = (filePath, name) => new Promise((resolve, reject) => {
  wx.cloud.uploadFile({
    cloudPath: cloudUploadPath(filePath, name),
    filePath,
    success: ({ fileID }) => fileID
      ? resolve(fileID)
      : reject({ code: 'CLOUD_UPLOAD_FAILED', message: '图片上传失败，请重试' }),
    fail: (error) => reject(cloudStorageError(error))
  });
});

const deleteCloudFile = (fileID) => new Promise((resolve) => {
  if (!fileID || !wx.cloud?.deleteFile) return resolve();
  wx.cloud.deleteFile({
    fileList: [fileID],
    complete: resolve
  });
});

export const uploadFile = async (path, filePath, name = 'image') => {
  const { fileName, mimeType } = fileInfo(filePath, name);
  if (app().globalData.apiTransport === 'cloud') {
    let cloudFileId = '';
    try { cloudFileId = await uploadToCloud(filePath, name); }
    catch (cloudUploadError) {
      if (name !== 'avatar') throw cloudUploadError;
      console.warn('[avatar-cloud-storage-fallback]', {
        code: cloudUploadError?.code,
        platformCode: cloudUploadError?.cause?.errCode || cloudUploadError?.cause?.code || '',
        platformMessage: cloudUploadError?.cause?.errMsg || cloudUploadError?.cause?.message || ''
      });
      let inlineAvatar;
      try { inlineAvatar = await prepareInlineAvatar(filePath, name); }
      catch (inlineError) {
        const errorCode = inlineError?.code || cloudUploadError?.code || 'AVATAR_UPLOAD_FAILED';
        throw {
          code: errorCode,
          message: `头像上传失败：${inlineError?.message || '头像预处理未完成'}（${errorCode}）`
        };
      }
      return request(path, {
        method: 'POST',
        timeout: app().globalData.recognitionUploadTimeout || 180000,
        data: {
          file_base64: inlineAvatar.fileBase64,
          file_name: inlineAvatar.fileName,
          mime_type: inlineAvatar.mimeType
        }
      });
    }
    try {
      return await request(path, {
        method: 'POST',
        timeout: app().globalData.recognitionUploadTimeout || 180000,
        data: { cloud_file_id: cloudFileId, file_name: fileName, mime_type: mimeType }
      });
    } catch (error) {
      await deleteCloudFile(cloudFileId);
      throw error;
    }
  }
  const fileBase64 = await readBase64(filePath);
  return request(path, {
    method: 'POST',
    timeout: app().globalData.recognitionUploadTimeout || 180000,
    data: { file_base64: fileBase64, file_name: fileName, mime_type: mimeType }
  });
};

export const uploadImage = (path, filePath) => uploadFile(path, filePath, 'image');

export const showError = (error) => wx.showToast({ title: error?.message || '操作失败', icon: 'none', duration: 2500 });
