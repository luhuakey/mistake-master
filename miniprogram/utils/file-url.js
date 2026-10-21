import { requestArrayBuffer } from '../services/api';

const resolvedFiles = new Map();

const fileHash = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const writeLocalFile = (path, data) => new Promise((resolve, reject) => {
  wx.getFileSystemManager().writeFile({
    filePath: path,
    data,
    success: () => resolve(path),
    fail: (error) => reject({ code: 'QUESTION_IMAGE_WRITE_FAILED', message: '题目配图缓存失败', detail: error?.errMsg })
  });
});

export const displayableFileUrl = (fileId) => {
  const value = String(fileId || '').trim();
  if (!value) return '';
  return /^memory:\/\//i.test(value) ? '' : value;
};

// 根据原图自然尺寸计算题图的展示宽度（rpx），避免把小图拉伸到整行导致过大/模糊。
// 上限按题目卡片比例收敛，且不放大超过原图，保证清晰。
export const questionImageDisplayWidth = (width, height) => {
  const naturalW = Number(width) || 0;
  const naturalH = Number(height) || 0;
  if (naturalW > 0 && naturalH > 0) {
    const maxWidthRpx = 420;
    const maxHeightRpx = 400;
    const naturalWrpx = naturalW * 2;
    const naturalHrpx = naturalH * 2;
    const scale = Math.min(1, maxWidthRpx / naturalWrpx, maxHeightRpx / naturalHrpx);
    return `${Math.max(24, Math.round(naturalWrpx * scale))}rpx`;
  }
  return '420rpx';
};

export const resolveDisplayableFileUrl = async (fileId) => {
  const value = String(fileId || '').trim();
  if (!value) return '';
  if (!/^memory:\/\//i.test(value)) return value;
  if (resolvedFiles.has(value)) return resolvedFiles.get(value);

  const extension = value.match(/\.(jpe?g|png|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
  const localPath = `${wx.env.USER_DATA_PATH}/question-image-${fileHash(value)}.${extension}`;
  const pending = requestArrayBuffer(`/local-assets/question-image?file_id=${encodeURIComponent(value)}`)
    .then((data) => writeLocalFile(localPath, data))
    .catch((error) => {
      resolvedFiles.delete(value);
      console.warn('[question-image-local-cache]', { code: error?.code || '', message: error?.message || '' });
      return '';
    });
  resolvedFiles.set(value, pending);
  return pending;
};
