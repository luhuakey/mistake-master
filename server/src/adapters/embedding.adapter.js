import { env } from '../config/env.js';
import { AppError, assert } from '../shared/errors.js';

const embeddingEndpoint = (value) => {
  const base = String(value || '').replace(/\/+$/, '');
  if (/\/embeddings$/i.test(base)) return base;
  if (/\/(?:compatible-mode\/)?v1$/i.test(base)) return `${base}/embeddings`;
  return `${base}/compatible-mode/v1/embeddings`;
};
const retryDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class EmbeddingAdapter {
  constructor(config = env) {
    this.config = config;
    this.fetch = config.fetch || globalThis.fetch;
  }

  isConfigured() {
    return Boolean(this.config.dashScopeBaseUrl && this.config.dashScopeApiKey);
  }

  async embed(text) {
    return (await this.embedMany([text]))[0];
  }

  async embedMany(texts) {
    assert(Array.isArray(texts) && texts.length && texts.length <= 10, 'EMBEDDING_INPUT_INVALID', '向量化文本数量必须为 1～10 条');
    assert(texts.every((text) => typeof text === 'string' && text.trim()), 'EMBEDDING_INPUT_INVALID', '向量化文本不能为空');
    if (!this.isConfigured()) {
      throw new AppError('EMBEDDING_NOT_CONFIGURED', '阿里云百炼文本向量服务尚未配置', 503);
    }

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(this.config.vectorRequestTimeoutMs) || 12000));
      try {
        const response = await this.fetch(embeddingEndpoint(this.config.dashScopeBaseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.dashScopeApiKey}`
          },
          body: JSON.stringify({
            model: this.config.embeddingModel,
            input: texts,
            dimensions: this.config.embeddingDimension,
            encoding_format: 'float'
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(result.error?.message || result.message || `DashScope HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const vectors = (result.data || [])
          .slice()
          .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
          .map((item) => item.embedding);
        if (vectors.length !== texts.length) throw new Error('百炼返回的向量数量不一致');
        if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.config.embeddingDimension)) {
          throw new Error(`百炼返回的向量维度不是 ${this.config.embeddingDimension}`);
        }
        return vectors;
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === 1) break;
        await retryDelay(350 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    if (lastError instanceof AppError) throw lastError;
    const timeoutError = /abort|timeout|超时/i.test(`${lastError?.name || ''} ${lastError?.message || ''}`);
    throw new AppError(
      timeoutError ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_FAILED',
      timeoutError ? '文本向量服务响应超时，已切换备用检索' : '文本向量化失败，请稍后重试',
      timeoutError ? 504 : 502,
      lastError?.message
    );
  }
}
