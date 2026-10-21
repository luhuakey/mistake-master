import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const sourceUrl = new URL('../../miniprogram/config/env.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8')
  .replace('export const getRuntimeConfig =', 'const getRuntimeConfig =')
  .concat('\nglobalThis.__getRuntimeConfig = getRuntimeConfig;');

const runtimeConfig = ({
  envVersion = 'develop',
  platform = 'devtools',
  localOptIn = false,
  accountError = null,
  storageError = null
} = {}) => {
  const wx = {
    getAccountInfoSync() {
      if (accountError) throw accountError;
      return { miniProgram: { envVersion } };
    },
    getDeviceInfo() { return { platform }; },
    getStorageSync(key) {
      if (storageError) throw storageError;
      return key === '__mistake_master_use_local_api__' && localOptIn;
    }
  };
  const context = vm.createContext({ wx });
  new vm.Script(source, { filename: sourceUrl.pathname }).runInContext(context);
  return context.__getRuntimeConfig();
};

test('develop 默认使用云托管，避免审核环境访问 localhost', () => {
  const config = runtimeConfig();
  assert.equal(config.envVersion, 'develop');
  assert.equal(config.localApiEnabled, false);
  assert.equal(config.apiTransport, 'cloud');
  assert.equal(config.apiBaseUrl, '');
});

test('仅开发者工具中的显式开关可启用本地服务', () => {
  const config = runtimeConfig({ localOptIn: true });
  assert.equal(config.localApiEnabled, true);
  assert.equal(config.apiTransport, 'http');
  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:3000/v1');
});

test('真机开发版忽略本地开关并使用云托管', () => {
  const config = runtimeConfig({ platform: 'ios', localOptIn: true });
  assert.equal(config.localApiEnabled, false);
  assert.equal(config.apiTransport, 'cloud');
});

test('trial 和 release 始终使用云托管', () => {
  for (const envVersion of ['trial', 'release']) {
    const config = runtimeConfig({ envVersion, localOptIn: true });
    assert.equal(config.localApiEnabled, false);
    assert.equal(config.apiTransport, 'cloud');
  }
});

test('环境读取异常或未知版本时安全回退到云托管', () => {
  const failed = runtimeConfig({ accountError: new Error('unavailable'), localOptIn: true });
  const unknown = runtimeConfig({ envVersion: 'audit', localOptIn: true });
  assert.equal(failed.envVersion, 'unknown');
  assert.equal(failed.apiTransport, 'cloud');
  assert.equal(unknown.apiTransport, 'cloud');
});

test('本地开关读取失败时不会启用 localhost', () => {
  const config = runtimeConfig({ storageError: new Error('unavailable') });
  assert.equal(config.localApiEnabled, false);
  assert.equal(config.apiTransport, 'cloud');
});
