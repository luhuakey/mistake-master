import cloudbase from '@cloudbase/js-sdk';
import { env } from '../config/env.js';

export class StorageAdapter {
  constructor(config = env) {
    this.config = config;
    this.memory = new Map();
    this.app = config.dataDriver === 'cloudbase' ? cloudbase.init({
      env: config.cloudbaseEnvId,
      ...(config.cloudbaseApiKey ? { accessKey: config.cloudbaseApiKey } : {}),
      ...(!config.cloudbaseApiKey && config.tencentSecretId ? { auth: { secretId: config.tencentSecretId, secretKey: config.tencentSecretKey } } : {})
    }) : null;
  }

  async upload(path, content) {
    if (!this.app) {
      this.memory.set(path, Buffer.from(content));
      return `memory://${path}`;
    }
    const result = await this.app.uploadFile({ cloudPath: path, fileContent: Buffer.from(content) });
    return result.fileID;
  }

  async download(fileId) {
    if (!this.app) {
      const path = String(fileId || '').replace(/^memory:\/\//, '');
      const content = this.memory.get(path);
      return content ? Buffer.from(content) : null;
    }
    const result = await this.app.downloadFile({ fileID: fileId });
    const content = result?.fileContent;
    if (!content) return null;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (typeof content.on === 'function') {
      const chunks = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }
    return Buffer.from(content);
  }

  async delete(fileId) {
    if (!fileId) return;
    if (!this.app) {
      this.memory.delete(String(fileId).replace(/^memory:\/\//, ''));
      return;
    }
    await this.app.deleteFile({ fileList: [fileId] });
  }

  async downloadUrl(fileId) {
    if (!this.app || String(fileId).startsWith('memory://')) return fileId;
    const result = await this.app.getTempFileURL({ fileList: [fileId] });
    return result.fileList?.[0]?.tempFileURL || fileId;
  }
}
