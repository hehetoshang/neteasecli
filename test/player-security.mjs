import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bridgeBaseUrl,
  bridgeClientConfig,
  loadBridgeToken,
} from '../dist/player/bridge-security.js';
import { bridgeRequestError } from '../dist/player/xiaoai.js';

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

  const bridgeError = bridgeRequestError('POST', '/api/stream/play', {
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: { error: '播放 URL 不允许访问本机或私有网络地址' },
    },
  });
  assert.equal(
    'open-xiaoai-bridge POST /api/stream/play failed (HTTP 400): 播放 URL 不允许访问本机或私有网络地址',
    bridgeError.message,
  );

  const redactedError = bridgeRequestError('POST', '/api/stream/play', {
    isAxiosError: true,
    message: 'Request failed',
    response: { status: 500, data: { error: 'Authorization: Bearer abcdefghijklmnop' } },
  });
  assert.doesNotMatch(redactedError.message, /abcdefghijklmnop/);
  assert.match(redactedError.message, /<redacted>/);

  console.log('player security tests passed');
} finally {
  reset();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
