import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import type { AxiosRequestConfig } from 'axios';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9092';

function tokenFilePath(): string {
  const configured = process.env.OPENXIAOAI_API_TOKEN_FILE;
  if (configured) return configured;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'open-xiaoai-bridge', 'api-token');
}

export function loadBridgeToken(): string {
  const explicit = process.env.OPENXIAOAI_API_TOKEN?.trim();
  if (explicit) {
    if (explicit.length < 32) {
      throw new Error('OPENXIAOAI_API_TOKEN must contain at least 32 characters');
    }
    return explicit;
  }

  const filename = tokenFilePath();
  let token: string;
  try {
    const stat = fs.statSync(filename);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`bridge token file permissions are too broad; run: chmod 600 ${filename}`);
    }
    token = fs.readFileSync(filename, 'utf8').trim();
  } catch (error) {
    if (error instanceof Error && error.message.includes('permissions are too broad')) {
      throw error;
    }
    throw new Error(
      `bridge API token is unavailable; start open-xiaoai-bridge once or set OPENXIAOAI_API_TOKEN_FILE (${filename})`,
    );
  }
  if (token.length < 32) {
    throw new Error(`bridge API token file is empty or too short: ${filename}`);
  }
  return token;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function bridgeBaseUrl(): string {
  const raw = process.env.OPENXIAOAI_BASE_URL || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('OPENXIAOAI_BASE_URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OPENXIAOAI_BASE_URL only supports http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('OPENXIAOAI_BASE_URL must not embed credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('OPENXIAOAI_BASE_URL must not contain a query or fragment');
  }
  if (
    parsed.protocol === 'http:' &&
    !isLoopback(parsed.hostname) &&
    process.env.OPENXIAOAI_ALLOW_INSECURE_HTTP !== '1'
  ) {
    throw new Error(
      'refusing plaintext bridge connection outside loopback; configure HTTPS or explicitly set OPENXIAOAI_ALLOW_INSECURE_HTTP=1 for migration only',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

function tlsAgent(baseUrl: string): https.Agent | undefined {
  if (!baseUrl.startsWith('https://')) return undefined;
  const caFile = process.env.OPENXIAOAI_TLS_CA;
  const certFile = process.env.OPENXIAOAI_TLS_CLIENT_CERT;
  const keyFile = process.env.OPENXIAOAI_TLS_CLIENT_KEY;
  if (!!certFile !== !!keyFile) {
    throw new Error(
      'OPENXIAOAI_TLS_CLIENT_CERT and OPENXIAOAI_TLS_CLIENT_KEY must be set together',
    );
  }
  return new https.Agent({
    ca: caFile ? fs.readFileSync(caFile) : undefined,
    cert: certFile ? fs.readFileSync(certFile) : undefined,
    key: keyFile ? fs.readFileSync(keyFile) : undefined,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  });
}

export function bridgeClientConfig(): { baseUrl: string; axios: AxiosRequestConfig } {
  const baseUrl = bridgeBaseUrl();
  const token = loadBridgeToken();
  return {
    baseUrl,
    axios: {
      timeout: 30_000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: tlsAgent(baseUrl),
    },
  };
}
