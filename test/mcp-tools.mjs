import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(directory, '..', 'dist', 'index.js');
const configHome = mkdtempSync(resolve(tmpdir(), 'neteasecli-mcp-test-'));
const child = spawn(process.execPath, [cli, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: configHome },
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'neteasecli-test', version: '1' },
    },
  })}\n`,
);
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
);
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
);
child.stdin.end(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_account_playlists', arguments: {} },
  })}\n`,
);

const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
rmSync(configHome, { recursive: true, force: true });
assert.equal(exitCode, 0, stderr);

const messages = stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const tools = messages.find((message) => message.id === 2)?.result?.tools;
assert.ok(Array.isArray(tools));

const byName = new Map(tools.map((tool) => [tool.name, tool]));
const search = byName.get('search_track');
assert.equal(search.inputSchema.properties.offset.default, 0);
assert.ok(search.outputSchema.properties.tracks);
assert.ok(search.outputSchema.properties.total);

const queue = byName.get('queue_status');
assert.ok(queue.outputSchema.properties.current);
assert.ok(queue.outputSchema.properties.history);
assert.ok(queue.outputSchema.properties.tracks);

const accountPlaylists = byName.get('list_account_playlists');
assert.ok(accountPlaylists.outputSchema.properties.playlists);
assert.ok(accountPlaylists.outputSchema.properties.total);
assert.ok(accountPlaylists.outputSchema.properties.playlists.items.properties.kind);
assert.ok(accountPlaylists.outputSchema.properties.playlists.items.properties.aliases);

for (const name of ['play_track', 'play_liked', 'play_playlist', 'play_account_playlist']) {
  assert.ok(byName.get(name).outputSchema.properties['x-open-xiaoai-bridge']);
}

const unauthenticated = messages.find((message) => message.id === 3)?.result;
assert.equal(unauthenticated.isError, true);
assert.match(unauthenticated.content[0].text, /^\[AUTH_REQUIRED\]/);

console.log('MCP tool schema tests passed');
