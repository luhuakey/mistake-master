import { createApp } from './app.js';
import { env, getProductionConfigStatus } from './config/env.js';

const configStatus = getProductionConfigStatus(env);
for (const [capability, missing] of [
  ['auth', configStatus.authMissing],
  ['recognition', configStatus.recognitionMissing],
  ['search', configStatus.searchMissing]
]) {
  if (missing.length) console.error(`[startup] ${capability} configuration missing: ${missing.join(', ')}`);
}

const app = createApp();
app.listen(env.port, env.host, () => {
  console.log(`mistake-master API listening on http://${env.host}:${env.port}`);
});
