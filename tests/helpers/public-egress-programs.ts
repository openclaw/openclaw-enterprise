import assert from "node:assert/strict";

import type { PublicTcp } from "./public-egress-inputs.ts";

const npmRegistry = "https://registry.npmjs.org";

export function publicProbeUrls(publicTcp: PublicTcp) {
  return [npmRegistry + "/pnpm/latest", "https://nodejs.org/dist/index.json", publicTcp.url];
}

// These programs run through the Agent's ordinary shell tool. Their receipt files
// are read only after the native thread confirms the exact command completed.
export function publicBootstrapProgram({
  packageManager,
  receipt,
  nonce,
}: {
  packageManager: string;
  receipt: string;
  nonce: string;
}) {
  return `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const directory = fs.mkdtempSync('/tmp/oce-package-bootstrap-');
const cache = path.join(directory, 'cache');
fs.mkdirSync(cache);
const env = { ...process.env, COREPACK_HOME: cache,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_DEFAULT_TO_LATEST: '0',
  COREPACK_ENABLE_NETWORK: '1', COREPACK_ENABLE_PROJECT_SPEC: '1',
  COREPACK_ENABLE_STRICT: '1', COREPACK_NPM_REGISTRY: ${JSON.stringify(npmRegistry)} };
delete env.COREPACK_INTEGRITY_KEYS;
delete env.COREPACK_NPM_TOKEN;
delete env.COREPACK_NPM_USERNAME;
delete env.COREPACK_NPM_PASSWORD;
fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ packageManager: ${JSON.stringify(packageManager)} }));
const initiallyEmpty = fs.readdirSync(cache).length === 0;
const result = cp.spawnSync('corepack', ['pnpm', '--version'], {
  cwd: directory, env, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
});
const report = { nonce: ${JSON.stringify(nonce)}, initiallyEmpty,
  executable: process.execPath, exitCode: result.status, signal: result.signal,
  version: result.stdout?.trim(), connectDenied: /connect EACCES/.test(result.stderr ?? ''),
  integrityFailure: /integrity|signature|hash mismatch/i.test(result.stderr ?? '') };
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(report), { flag: 'wx', mode: 384 });
fs.rmSync(directory, { recursive: true });
console.log(${JSON.stringify(nonce)});
`;
}

// The API workload resolves its own installed route and key. Neither credential
// is copied to the runner, sent to the model, or included in the returned receipt.
export const publicGatewayTurnProgram = String.raw`
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const controllerRequire = createRequire('/app/apps/controller/package.json');
(async () => {
  let wire = '';
  for await (const chunk of process.stdin) wire += chunk;
  const input = JSON.parse(wire);
  const { loadYaml } = controllerRequire('@kubernetes/client-node');
  const config = loadYaml(fs.readFileSync(process.env.OCC_CONFIG_PATH, 'utf8'));
  const route = config.drivers.compute.configuration.gatewayRouting;
  const port = route.endpointPort ?? 443;
  const url = 'wss://' + route.hostname + (port === 443 ? '' : ':' + port) +
    '/namespaces/' + input.namespaceId + '/agents/' + input.agentId;
  const { GatewayClient } = await import(controllerRequire.resolve('@openclaw/gateway-client'));
  const connected = Promise.withResolvers();
  const client = new GatewayClient({ url,
    edgeAuthHeaders: { 'x-api-key': fs.readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, 'utf8').trim() },
    clientName: 'gateway-client', mode: 'backend', role: 'operator', scopes: [], deviceIdentity: null,
    minProtocol: 4, maxProtocol: 4,
    onHelloOk: connected.resolve, onConnectError: connected.reject,
  });
  const timer = setTimeout(() => connected.reject(new Error('hello deadline')), 20000);
  try {
    client.start();
    const hello = await connected.promise;
    clearTimeout(timer);
    if (hello.auth?.role !== 'operator' || !hello.auth.scopes.includes('operator.admin')) throw new Error('auth');
    const signal = AbortSignal.timeout(480000);
    const call = (method, params) => client.request(method, params, { signal, timeoutMs: 30000 });
    const sessionKey = 'agent:main:public-egress-' + input.nonce;
    const sent = await call('chat.send', { sessionKey, idempotencyKey: randomUUID(), message: input.prompt });
    let outcome;
    do {
      outcome = await call('agent.wait', { runId: sent.runId, timeoutMs: 3000 });
    } while (outcome.status === 'pending' || outcome.status === 'timeout');
    if (outcome.status !== 'ok') throw new Error('run failed');
    const history = await call('chat.history', { sessionKey, limit: 100 });
    const final = history.messages?.filter(message => message.role === 'assistant').at(-1);
    const content = typeof final?.content === 'string' ? final.content :
      (final?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (!content.includes(input.nonce) || final.stopReason === 'error') throw new Error('reply absent');
    console.log(JSON.stringify({ runId: sent.runId, sessionKey, status: outcome.status, replyMatched: true }));
  } finally {
    clearTimeout(timer);
    await client.stopAndWait({ timeoutMs: 1000 });
  }
})().catch(() => { console.error('Public egress Gateway turn failed; no replay.'); process.exitCode = 1; });
`;

// All requests originate in the Agent's ordinary shell process. The controlled
// endpoint receives no credential header, ambient cookie, or provider token.
export function publicNetworkProgram({
  nonce,
  receipt,
  publicTcp,
  managedHosts,
}: {
  nonce: string;
  receipt: string;
  publicTcp: PublicTcp;
  managedHosts: string[];
}) {
  return `
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const { createHash } = require('node:crypto');
const read = url => new Promise(resolve => {
  const request = https.get(url, { signal: AbortSignal.timeout(15000) }, response => {
    const hash = createHash('sha256');
    response.on('data', chunk => hash.update(chunk));
    response.on('end', () => resolve({ status: response.statusCode, bodySha256: hash.digest('hex') }));
    response.on('error', error => resolve({ code: error.code }));
  });
  request.on('error', error => resolve({ code: error.code }));
});
const connect = host => new Promise(resolve => {
  const socket = net.connect({ host, port: 8443 });
  socket.setTimeout(15000, () => { socket.destroy(); resolve({ code: 'TIMEOUT' }); });
  socket.on('connect', () => { socket.destroy(); resolve({ connected: true }); });
  socket.on('error', error => resolve({ code: error.code }));
});
(async () => {
  const publicReads = await Promise.all(${JSON.stringify(publicProbeUrls(publicTcp))}.map(read));
  const managedPorts = await Promise.all(${JSON.stringify(managedHosts)}.map(async host => ({ host, ...await connect(host) })));
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ nonce: ${JSON.stringify(nonce)}, publicReads, managedPorts }), { flag: 'wx', mode: 384 });
  console.log(${JSON.stringify(nonce)});
})();
`;
}

export type NetworkReceipt = {
  nonce: string;
  publicReads: { status?: number; bodySha256?: string; code?: string }[];
  managedPorts: { host: string; connected?: boolean; code?: string }[];
};

export function assertPublicNetworkReceipt(
  report: NetworkReceipt,
  {
    nonce,
    allowed,
    hosts,
    publicTcp,
  }: { nonce: string; allowed: boolean; hosts: string[]; publicTcp: PublicTcp },
) {
  assert.equal(report.nonce, nonce);
  assert.equal(report.publicReads.length, 3, "all three public destinations must report");
  for (const result of report.publicReads) {
    if (allowed) {
      assert.equal(result.status, 200);
    } else {
      assert.equal(result.code, "EACCES");
    }
  }
  if (allowed) {
    assert.equal(report.publicReads[2]?.bodySha256, publicTcp.expectedBodySha256);
  }
  assert.deepEqual(
    report.managedPorts.map((result) => result.host),
    hosts,
  );
  for (const result of report.managedPorts) {
    assert.equal(result.code, "EACCES", "managed hosts remain reserved on undeclared ports");
  }
}

export function authenticatedRepositoryProgram({
  repository,
  permissions,
  receipt,
}: {
  repository: string;
  permissions: Readonly<Record<string, boolean>>;
  receipt: string;
}) {
  return `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const result = spawnSync('gh', ['api', ${JSON.stringify("repos/" + repository)}], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
let authenticatedPermissions = false;
try {
  const response = JSON.parse(result.stdout);
  const expected = ${JSON.stringify(permissions)};
  authenticatedPermissions = result.status === 0 && response.full_name === ${JSON.stringify(repository)} &&
    response.permissions !== null && typeof response.permissions === 'object' &&
    Object.entries(expected).every(([key, value]) => response.permissions[key] === value);
} catch {}
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ authenticatedPermissions }), { flag: 'wx', mode: 384 });
console.log('repository-read-complete');
`;
}

// Inspect readable workload state without returning values, hashes of tokens,
// account metadata, or opaque credentials (which are themselves capabilities).
export const publicCustodyProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const opaque = value => typeof value === 'string' && /^openshell:resolve:env:(?:s[0-9a-f]{64}|v[0-9]+)_[A-Z][A-Z0-9_]*$/.test(value);
let providerEnvironmentOpaque = true;
let refreshMaterialAbsent = true;
let privateKeyAbsent = true;
let observed = 0;
for (const pid of fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
  let environment;
  try { environment = fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch { continue; }
  for (const entry of environment.split('\0')) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(key) && value) {
      observed++;
      providerEnvironmentOpaque &&= opaque(value);
    }
    if (/REFRESH_TOKEN|CUSTODY_KEY|APP_PRIVATE_KEY/.test(key) && value) refreshMaterialAbsent = false;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) privateKeyAbsent = false;
  }
}
let auth;
try {
  auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || '/sandbox/.openclaw-runtime/home/.codex', 'auth.json'), 'utf8'));
} catch {}
refreshMaterialAbsent &&= !auth?.tokens?.refresh_token;
process.stdout.write(JSON.stringify({
  nativeAuthPresent: !!auth,
  nativeAuthOpaque: opaque(auth?.personal_access_token),
  providerEnvironmentOpaque: observed > 0 && providerEnvironmentOpaque,
  refreshMaterialAbsent,
  privateKeyAbsent,
}));
`;
