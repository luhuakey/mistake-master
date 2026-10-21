import { env } from '../src/config/env.js';
import { createDataStore } from '../src/data/store.js';
import { EmbeddingAdapter } from '../src/adapters/embedding.adapter.js';
import { VectorAdapter } from '../src/adapters/vector.adapter.js';
import { nowIso } from '../src/shared/utils.js';

if (env.dataDriver !== 'cloudbase') {
  console.error(JSON.stringify({ success: false, code: 'CLOUDBASE_REQUIRED', message: '历史索引重建要求 DATA_DRIVER=cloudbase' }));
  process.exit(1);
}
if (env.mockExternalServices) {
  console.error(JSON.stringify({ success: false, code: 'REAL_SERVICES_REQUIRED', message: '历史索引重建要求 MOCK_EXTERNAL_SERVICES=false' }));
  process.exit(1);
}

const store = createDataStore(env);
const vector = new VectorAdapter(env, new EmbeddingAdapter(env));
const pageSize = 100;
const embeddingBatchSize = 10;
let offset = 0;
let indexed = 0;
let failed = 0;

try {
  if (!vector.isConfigured()) throw new Error('请先配置 DashVector 与百炼 Embedding 环境变量');
  while (true) {
    const questions = await store.find('questions', { orderBy: '_id', direction: 'asc', limit: pageSize, offset });
    if (!questions.length) break;
    for (let start = 0; start < questions.length; start += embeddingBatchSize) {
      const batch = questions.slice(start, start + embeddingBatchSize);
      try {
        await vector.upsertMany(batch);
        for (const question of batch) {
          await store.update('questions', question._id, { index_status: 'ready', updated_at: nowIso() });
          indexed += 1;
        }
      } catch (error) {
        for (const question of batch) {
          await store.update('questions', question._id, { index_status: 'failed', updated_at: nowIso() });
          failed += 1;
        }
        console.error(JSON.stringify({ batch_start: offset + start, count: batch.length, code: error.code || 'INDEX_FAILED', message: error.message }));
      }
    }
    offset += questions.length;
    if (questions.length < pageSize) break;
  }
  console.log(JSON.stringify({ success: failed === 0, indexed, failed, collection: env.dashVectorCollection }));
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, code: error.code || 'REINDEX_FAILED', message: error.message }));
  process.exitCode = 1;
}
