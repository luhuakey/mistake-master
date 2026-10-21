import { env } from '../src/config/env.js';
import { EmbeddingAdapter } from '../src/adapters/embedding.adapter.js';
import { VectorAdapter } from '../src/adapters/vector.adapter.js';

const embedding = new EmbeddingAdapter(env);
const vector = new VectorAdapter(env, embedding);

try {
  const result = await vector.createCollection();
  console.log(JSON.stringify({
    success: true,
    collection: env.dashVectorCollection,
    dimension: env.embeddingDimension,
    metric: 'cosine',
    status: result.already_exists ? 'already_exists' : 'created'
  }));
} catch (error) {
  console.error(JSON.stringify({ success: false, code: error.code || 'INIT_FAILED', message: error.message, details: error.details }));
  process.exitCode = 1;
}
