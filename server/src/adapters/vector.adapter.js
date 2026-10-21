import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { escapeSqlString } from '../shared/utils.js';
import { EmbeddingAdapter } from './embedding.adapter.js';

const tokens = (text) => [...new Set(String(text).toLowerCase().replace(/\s+/g, '').split(''))];
const endpoint = (value) => {
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  // 控制台复制的地址有时会带 /v1 或完整 API 路径；适配器统一从服务根地址拼接。
  return normalized.replace(/\/+$/, '').replace(/\/v1(?:\/.*)?$/i, '');
};
const retryDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const questionEmbeddingText = (question) => [
  question.subject,
  question.stem,
  ...Object.values(question.options || {}),
  question.analysis,
  question.error_prone_point,
  ...(question.knowledge_points || [])
].filter(Boolean).join('\n');

export class VectorAdapter {
  constructor(config = env, embedding = new EmbeddingAdapter(config)) {
    this.config = config;
    this.embedding = embedding;
    this.fetch = config.fetch || globalThis.fetch;
    this.memory = new Map();
  }

  isDashVectorConfigured() {
    return this.config.vectorProvider === 'dashvector'
      && Boolean(this.config.dashVectorEndpoint && this.config.dashVectorApiKey);
  }

  isConfigured() {
    return this.isDashVectorConfigured() && this.embedding.isConfigured();
  }

  async request(path, body, method = 'POST') {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(this.config.vectorRequestTimeoutMs) || 12000));
      try {
        const response = await this.fetch(`${endpoint(this.config.dashVectorEndpoint)}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'dashvector-auth-token': this.config.dashVectorApiKey
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const result = await response.json().catch(() => ({}));
        // DashVector 不同网关可能返回数字 0 或字符串 "0"。
        if (!response.ok || Number(result.code) !== 0) {
          const error = new Error(result.message || `DashVector HTTP ${response.status}`);
          error.providerCode = result.code;
          error.httpStatus = response.status;
          error.retryable = response.status === 429 || response.status >= 500 || [429, 500, 503].includes(Number(result.code));
          throw error;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === 1) break;
        await retryDelay(350 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  document(question, vector) {
    return {
      id: question._id,
      vector,
      fields: {
        user_id: question.user_id,
        subject: question.subject,
        question_type: question.type
      }
    };
  }

  async upsert(question) {
    await this.upsertMany([question]);
  }

  async upsertMany(questions) {
    if (this.config.mockExternalServices) {
      for (const question of questions) {
        this.memory.set(question._id, {
          id: question._id,
          text: questionEmbeddingText(question),
          user_id: question.user_id,
          subject: question.subject,
          question_type: question.type
        });
      }
      return;
    }
    if (!this.isConfigured()) throw new AppError('VECTOR_NOT_CONFIGURED', '阿里云 DashVector 或百炼 Embedding 尚未配置', 503);
    try {
      // 百炼单次最多接受 10 条文本；按服务能力分批，但不限制整次识题保存总量。
      for (let offset = 0; offset < questions.length; offset += 10) {
        const batch = questions.slice(offset, offset + 10);
        const vectors = await this.embedding.embedMany(batch.map(questionEmbeddingText));
        await this.request(`/v1/collections/${encodeURIComponent(this.config.dashVectorCollection)}/docs/upsert`, {
          docs: batch.map((question, index) => this.document(question, vectors[index]))
        });
      }
    } catch (error) {
      throw new AppError('VECTOR_INDEX_FAILED', '题目已保存，但阿里云向量索引写入失败', 502, error.message);
    }
  }

  async search({ userId, keyword, subject, limit = 20 }) {
    if (this.config.mockExternalServices) {
      const queryTokens = tokens(keyword);
      return [...this.memory.values()]
        .filter((item) => item.user_id === userId && (!subject || item.subject === subject))
        .map((item) => {
          const haystack = new Set(tokens(item.text));
          const matched = queryTokens.filter((token) => haystack.has(token)).length;
          return { id: item.id, score: queryTokens.length ? matched / queryTokens.length : 0 };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
    if (!this.isConfigured()) throw new AppError('VECTOR_NOT_CONFIGURED', '阿里云 DashVector 或百炼 Embedding 尚未配置', 503);
    try {
      const vector = await this.embedding.embed(keyword);
      const clauses = [`user_id = '${escapeSqlString(userId)}'`];
      if (subject) clauses.push(`subject = '${escapeSqlString(subject)}'`);
      const result = await this.request(`/v1/collections/${encodeURIComponent(this.config.dashVectorCollection)}/query`, {
        vector,
        topk: limit,
        filter: clauses.join(' and '),
        include_vector: false,
        output_fields: ['user_id', 'subject', 'question_type']
      });
      const output = result.output || result.data?.output || [];
      return output.map((item) => ({
        id: item.id,
        score: Math.max(0, Math.min(1, 1 - Number(item.score || 0)))
      }));
    } catch (error) {
      // 保留百炼向量化的真实错误，避免前端误报为 DashVector 索引故障。
      if (error instanceof AppError && /^EMBEDDING_/.test(error.code)) throw error;
      const timeoutError = /abort|timeout|超时/i.test(`${error?.name || ''} ${error?.message || ''}`);
      const rateLimited = Number(error?.providerCode) === 429 || /rate|thrott|限流/i.test(String(error?.message));
      const accessDenied = [401, 403].includes(Number(error?.httpStatus))
        || [401, 403].includes(Number(error?.providerCode))
        || /white.?list|forbidden|permission|access.?denied|not.?allowed|白名单|无权|拒绝访问/i.test(String(error?.message));
      const collectionMissing = Number(error?.httpStatus) === 404
        || /collection.*(?:not.?found|not.?exist)|集合.*(?:不存在|未找到)/i.test(String(error?.message));
      const code = accessDenied
        ? 'VECTOR_ACCESS_DENIED'
        : (collectionMissing
          ? 'VECTOR_COLLECTION_NOT_FOUND'
          : (timeoutError ? 'VECTOR_TIMEOUT' : (rateLimited ? 'VECTOR_RATE_LIMITED' : 'VECTOR_SEARCH_FAILED')));
      const message = accessDenied
        ? '云端无权访问语义索引，请检查 DashVector API Key 与公网 IP 白名单'
        : (collectionMissing
          ? '云端语义索引集合不存在，请检查 Collection 名称和地域'
          : (timeoutError ? '语义索引响应超时，已切换备用检索' : (rateLimited ? '语义索引请求繁忙，已切换备用检索' : '智能搜索失败，请重试')));
      throw new AppError(
        code,
        message,
        timeoutError ? 504 : 502,
        {
          provider: 'dashvector',
          reason: accessDenied ? 'access_denied' : (collectionMissing ? 'collection_not_found' : (timeoutError ? 'timeout' : (rateLimited ? 'rate_limited' : 'request_failed'))),
          provider_code: error?.providerCode ?? null,
          http_status: error?.httpStatus ?? null
        }
      );
    }
  }

  async createCollection() {
    if (!this.isDashVectorConfigured()) throw new AppError('VECTOR_NOT_CONFIGURED', '阿里云 DashVector 尚未配置', 503);
    try {
      return await this.request('/v1/collections', {
        name: this.config.dashVectorCollection,
        dimension: this.config.embeddingDimension,
        dtype: 'FLOAT',
        metric: 'cosine',
        fields_schema: {
          user_id: 'STRING',
          subject: 'STRING',
          question_type: 'STRING'
        }
      });
    } catch (error) {
      if (/already|exist|已存在/i.test(error.message)) return { already_exists: true };
      throw new AppError('VECTOR_COLLECTION_INIT_FAILED', 'DashVector Collection 初始化失败', 502, error.message);
    }
  }
}
