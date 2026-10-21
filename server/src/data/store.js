import cloudbase from '@cloudbase/js-sdk';
import { isDeepStrictEqual } from 'node:util';
import { env } from '../config/env.js';
import { AppError, notFound } from '../shared/errors.js';

const clone = (value) => structuredClone(value);
const normalizeCloudBaseRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
    return { _id: row._id, ...row.data };
  }
  return row;
};
const cloudBaseErrorCode = (value) => value?.code || value?.data?.code || value?.response?.data?.code || '';
const isDocumentNotFound = (value) => cloudBaseErrorCode(value) === 'DOCUMENT_NOT_FOUND';
const assertCloudBaseResult = (result, collectionName) => {
  const code = result?.code || result?.data?.code;
  if (!code || code === 'SUCCESS' || code === 0 || code === '0') return;
  const providerMessage = result?.message || result?.data?.message || 'CloudBase 请求失败';
  if (code === 'DATABASE_COLLECTION_NOT_EXIST') {
    throw new AppError(
      'CLOUDBASE_COLLECTION_NOT_FOUND',
      `云数据库集合 ${collectionName} 不存在，请先初始化 CloudBase 数据库`,
      503,
      { provider_code: code, provider_message: providerMessage }
    );
  }
  throw new AppError(
    'CLOUDBASE_REQUEST_FAILED',
    '云数据库请求失败，请检查 CloudBase 配置',
    502,
    { provider_code: code, provider_message: providerMessage }
  );
};
const rethrowCloudBaseError = (error, collectionName) => {
  assertCloudBaseResult(error, collectionName);
  throw error;
};
const cloudBaseRows = (result, collectionName) => {
  assertCloudBaseResult(result, collectionName);
  const data = result?.data;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(result?.list)
        ? result.list
        : [];
  return rows.map(normalizeCloudBaseRow);
};
const matchesPatch = (row, patch) => Boolean(row) && Object.entries(patch)
  .every(([key, value]) => isDeepStrictEqual(row[key], value));

export class MemoryDataStore {
  constructor(seed = {}) {
    this.tables = new Map();
    this.transactionQueue = Promise.resolve();
    for (const [name, rows] of Object.entries(seed)) {
      this.tables.set(name, new Map(rows.map((row) => [row._id, clone(row)])));
    }
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  async put(name, row) {
    this.table(name).set(row._id, clone(row));
    return clone(row);
  }

  async get(name, rowId) {
    const row = this.table(name).get(rowId);
    return row ? clone(row) : null;
  }

  async update(name, rowId, patch) {
    const current = await this.get(name, rowId);
    if (!current) throw notFound();
    const next = { ...current, ...clone(patch) };
    return this.put(name, next);
  }

  async find(name, { where = {}, orderBy, direction = 'desc', limit = 100, offset = 0 } = {}) {
    let rows = [...this.table(name).values()].filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    if (orderBy) {
      const sign = direction === 'asc' ? 1 : -1;
      rows.sort((a, b) => String(a[orderBy] || '').localeCompare(String(b[orderBy] || '')) * sign);
    }
    return clone(rows.slice(offset, offset + limit));
  }

  async runTransaction(callback) {
    const run = async () => {
      const snapshot = new Map([...this.tables.entries()].map(([name, rows]) => [
        name,
        new Map([...rows.entries()].map(([rowId, row]) => [rowId, clone(row)]))
      ]));
      try {
        return await callback(this);
      } catch (error) {
        this.tables = snapshot;
        throw error;
      }
    };
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.catch(() => {});
    return result;
  }
}

export class CloudBaseDataStore {
  constructor(config = env) {
    this.app = cloudbase.init({
      env: config.cloudbaseEnvId,
      ...(config.cloudbaseApiKey ? { accessKey: config.cloudbaseApiKey } : {}),
      ...(!config.cloudbaseApiKey && config.tencentSecretId ? { auth: { secretId: config.tencentSecretId, secretKey: config.tencentSecretKey } } : {})
    });
    this.db = this.app.database();
  }

  async put(name, row) {
    const data = { ...row };
    delete data._id;
    const result = await this.db.collection(name).doc(row._id).set(data);
    assertCloudBaseResult(result, name);
    return row;
  }

  async get(name, rowId) {
    try {
      const result = await this.db.collection(name).doc(rowId).get();
      return cloudBaseRows(result, name)[0] || null;
    } catch (error) {
      if (isDocumentNotFound(error)) return null;
      return rethrowCloudBaseError(error, name);
    }
  }

  async update(name, rowId, patch) {
    const current = await this.get(name, rowId);
    if (!current) throw notFound();
    const document = this.db.collection(name).doc(rowId);
    const result = await document.update(patch);
    assertCloudBaseResult(result, name);
    const updated = result?.updated ?? result?.data?.updated;
    if (updated === undefined) {
      let confirmed = await this.get(name, rowId);
      if (matchesPatch(confirmed, patch)) return confirmed;

      const replacement = { ...current, ...patch };
      delete replacement._id;
      const fallbackResult = await document.set(replacement);
      assertCloudBaseResult(fallbackResult, name);
      confirmed = await this.get(name, rowId);
      if (!matchesPatch(confirmed, patch)) {
        throw new AppError(
          'CLOUDBASE_UPDATE_UNCONFIRMED',
          `云数据库未确认 ${name} 更新成功`,
          502,
          {
            request_id: result?.requestId || result?.data?.requestId || '',
            fallback_request_id: fallbackResult?.requestId || fallbackResult?.data?.requestId || ''
          }
        );
      }
      console.warn('CloudBase update 缺少计数且首次回读不一致，已通过 set 完成兜底写入', {
        collection: name,
        rowId,
        requestId: result?.requestId || result?.data?.requestId || '',
        fallbackRequestId: fallbackResult?.requestId || fallbackResult?.data?.requestId || ''
      });
      return confirmed;
    }
    return { ...current, ...patch };
  }

  async find(name, { where = {}, orderBy, direction = 'desc', limit = 100, offset = 0 } = {}) {
    let query = this.db.collection(name).where(where);
    if (orderBy) query = query.orderBy(orderBy, direction);
    if (offset) query = query.skip(offset);
    const result = await query.limit(Math.min(limit, 100)).get();
    return cloudBaseRows(result, name);
  }

  async runTransaction(callback) {
    return this.db.runTransaction(async (transaction) => {
      const transactionalStore = {
        get: async (name, rowId) => {
          try {
            const result = await transaction.collection(name).doc(rowId).get();
            return cloudBaseRows(result, name)[0] || null;
          } catch (error) {
            if (isDocumentNotFound(error)) return null;
            return rethrowCloudBaseError(error, name);
          }
        },
        put: async (name, row) => {
          const data = { ...row };
          delete data._id;
          const result = await transaction.collection(name).doc(row._id).set(data);
          assertCloudBaseResult(result, name);
          return row;
        },
        update: async (name, rowId, patch) => {
          const current = await transactionalStore.get(name, rowId);
          if (!current) throw notFound();
          const result = await transaction.collection(name).doc(rowId).update(patch);
          assertCloudBaseResult(result, name);
          return { ...current, ...patch };
        },
        find: async (name, { where = {}, orderBy, direction = 'desc', limit = 100, offset = 0 } = {}) => {
          let query = transaction.collection(name).where(where);
          if (orderBy) query = query.orderBy(orderBy, direction);
          if (offset) query = query.skip(offset);
          const result = await query.limit(Math.min(limit, 100)).get();
          return cloudBaseRows(result, name);
        }
      };
      return callback(transactionalStore);
    });
  }
}

export const createDataStore = (config = env) => config.dataDriver === 'cloudbase'
  ? new CloudBaseDataStore(config)
  : new MemoryDataStore();
