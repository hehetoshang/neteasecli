import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bridgeBaseUrl,
  bridgeClientConfig,
  loadBridgeToken,
} from '../dist/player/bridge-security.js';

const saved = { ...process.env };
let temporaryDirectory;
const reset = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  delete process.env.OPENXIAOAI_API_TOKEN;
  delete process.env.OPENXIAOAI_API_TOKEN_FILE;
  delete process.env.OPENXIAOAI_BASE_URL;
  delete process.env.OPENXIAOAI_ALLOW_INSECURE_HTTP;
};

try {
  reset();
  process.env.OPENXIAOAI_API_TOKEN = 'x'.repeat(43);
  assert.equal('http://127.0.0.1:9092', bridgeBaseUrl());
  assert.match(bridgeClientConfig().axios.headers.Authorization, /^Bearer x+$/);

  reset();
  process.env.OPENXIAOAI_BASE_URL = 'http://192.168.1.20:9092';
  assert.throws(() => bridgeBaseUrl(), /refusing plaintext/);
  process.env.OPENXIAOAI_ALLOW_INSECURE_HTTP = '1';
  assert.equal('http://192.168.1.20:9092', bridgeBaseUrl());

  reset();
  process.env.OPENXIAOAI_API_TOKEN = 'short';
  assert.throws(() => loadBridgeToken(), /at least 32/);

  reset();
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'neteasecli-token-'));
  const tokenFile = join(temporaryDirectory, 'token');
  writeFileSync(tokenFile, 'z'.repeat(43) + '\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  process.env.OPENXIAOAI_API_TOKEN_FILE = tokenFile;
  assert.equal('z'.repeat(43), loadBridgeToken());

  console.log('player security tests passed');
} finally {
  reset();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
