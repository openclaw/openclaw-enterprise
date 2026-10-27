// On Kubernetes a Pod UID identifies one sandbox, but OpenClaw persists Linux
// process identities. The init container pins a verification key for this Pod.
// Its first Gateway consumes the signing key before starting configurable code.
export const INITIALIZE_EMBEDDED_GATEWAY_OWNER = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const verifier = "/run/oce-gateway-owner-key/public.pem";
if (!fs.existsSync(verifier)) {
  const keys = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(verifier, keys.publicKey, { flag: "wx", mode: 0o444 });
  fs.writeFileSync("/run/oce-gateway-owner-start/private.pem", keys.privateKey, { flag: "wx", mode: 0o400 });
}
`;

// Linux can reuse a PID namespace inode after its last process exits. The init
// start time distinguishes those lifetimes. /proc/1/stat's comm can contain ')'.
export const GATEWAY_NAMESPACE_PROBE = String.raw`(() => {
  const fs = require("node:fs");
  const init = fs.readFileSync("/proc/1/stat", "utf8");
  const fields = init.slice(init.lastIndexOf(")") + 2).trim().split(/\s+/);
  const pidNsInitStartTicks = Number(fields[19]);
  if (!Number.isSafeInteger(pidNsInitStartTicks) || pidNsInitStartTicks < 0) {
    throw new Error("Gateway PID 1 start time is unavailable");
  }
  return {
    platform: process.platform,
    host: require("node:os").hostname(),
    identity: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNsInode: /^pid:\[(\d+)\]$/.exec(fs.readlinkSync("/proc/self/ns/pid"))[1],
    pidNsInitStartTicks,
  };
})()`;

export interface GatewayPidNamespace {
  platform: "linux";
  identity: string;
  host: string;
  pidNsInode: string;
  pidNsInitStartTicks: number;
}

function recover(namespaceExpression: string) {
  return `const recovered = require("node:child_process").spawnSync(process.execPath,
    ["/app/openclaw.mjs", "gateway", "recover-lock", "--terminated-namespace", JSON.stringify(${namespaceExpression}), "--json"],
    {stdio:"inherit",timeout:60000});
  if (recovered.status !== 0) console.error("Embedded Gateway recovery could not verify all owners. Native startup will check ownership; use openclaw gateway recover-lock if it requires operator confirmation.");`;
}

export function embeddedGatewayRecoveryPreamble(namespace?: GatewayPidNamespace) {
  return namespace ? "{\n" + recover(JSON.stringify(namespace)) + "\n}\n" : "";
}

// Run this in a short-lived process. By the time the Gateway can load a plugin
// or accept a model turn, the private key is unlinked and its process has exited.
const observeOrVerify = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto");
const key = "/run/oce-gateway-owner-start/private.pem", owner = "/run/oce-gateway-owner-start/owner.json";
const verifier = fs.readFileSync("/run/oce-gateway-owner-key/public.pem");
const pod = process.env.OPENCLAW_POD_UID;
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) throw Error("invalid owner record");
    const bytes = Buffer.alloc(2049);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 2048) throw Error("invalid owner record");
    return bytes.subarray(0,count);
  } finally { fs.closeSync(fd); }
}
function observe() {
  if (!pod) return;
  let privateKey;
  try { privateKey = read(key); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (privateKey) {
    fs.unlinkSync(key);
    const statement = JSON.stringify({pod, userNamespace:fs.readlinkSync("/proc/self/ns/user"), namespace:${GATEWAY_NAMESPACE_PROBE}});
    const signature = crypto.sign(null, Buffer.from(statement), privateKey);
    privateKey.fill(0);
    if (crypto.verify(null, Buffer.from(statement), verifier, signature)) {
      fs.writeFileSync(owner, JSON.stringify({statement, signature:signature.toString("base64")}), {flag:"wx",mode:0o400});
    }
    return;
  }
  const {statement,signature} = JSON.parse(read(owner));
  if (typeof statement !== "string" || typeof signature !== "string" ||
      !crypto.verify(null, Buffer.from(statement), verifier, Buffer.from(signature,"base64"))) return;
  const prior = JSON.parse(statement);
  const current = ${GATEWAY_NAMESPACE_PROBE};
  if (prior.pod === pod && prior.namespace.identity === current.identity &&
      prior.userNamespace === fs.readlinkSync("/proc/self/ns/user")) return prior.namespace;
}
try { const prior = observe(); if (prior) process.stdout.write(JSON.stringify(prior)); }
catch { process.stderr.write("Embedded Gateway has no verifiable prior owner for this Pod.\n"); }
`;

export const EMBEDDED_GATEWAY_OWNER_STARTUP = `
if (process.env.OPENCLAW_EMBEDDED_GATEWAY_OWNER === "1") {
  const ownerFs = require("node:fs");
  let privatePidNamespace = false;
  try {
    const init = ownerFs.statSync("/proc/1/exe"), tini = ownerFs.statSync("/usr/bin/tini");
    privatePidNamespace = process.ppid === 1 && init.dev === tini.dev && init.ino === tini.ino;
  } catch {}
  const sample = privatePidNamespace && require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(observeOrVerify)}], {
    env:{OPENCLAW_POD_UID:process.env.OPENCLAW_POD_UID}, cwd:"/", stdio:["ignore","pipe","inherit"], encoding:"utf8", maxBuffer:2048, timeout:5000
  });
  // An interrupted signer can leave its private key on the startup volume.
  // No configurable process may start while it can still read that key.
  try { require("node:fs").unlinkSync("/run/oce-gateway-owner-start/private.pem"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (sample && sample.status === 0 && sample.stdout) {
    const prior = JSON.parse(sample.stdout);
    ${recover("prior")}
  }
}
`;
