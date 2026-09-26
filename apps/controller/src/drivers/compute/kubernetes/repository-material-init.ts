/** Runs in the runtime image before the read-only credential mount is exposed. */
export const REPOSITORY_MATERIAL_INIT_ENTRYPOINT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const clientKeys = ["gatewayOrigin", "gitRemote", "gitUsername", "canonicalApiHost", "apiHost", "repository"];
const limits = { bearer: 256, "client.json": 16384, gitconfig: 16384, "gh/hosts.yml": 16384, "gh/config.yml": 16384, "ca.pem": 65536 };
const systemCaBundleCandidates = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/pki/tls/certs/ca-bundle.crt"];
const runtimeRoot = "/run/oce/repository-credentials/sessions/";
const uid = process.getuid();
let normalizePushRefAllowlist;

function requireValid(condition) {
  if (!condition) throw new Error("invalid-repository-material");
}

function exactKeys(value, keys) {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value).sort();
  requireValid(actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function metadata(name) {
  return fs.lstatSync(name, { bigint: true });
}

function optionalMetadata(name) {
  try { return metadata(name); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateClient(client) {
  const hasPolicy = client !== null && typeof client === "object" && Object.hasOwn(client, "pushRefAllowlist");
  exactKeys(client, [...clientKeys, ...(hasPolicy ? ["pushRefAllowlist"] : [])]);
  if (hasPolicy) normalizePushRefAllowlist(client.pushRefAllowlist);
  requireValid(clientKeys.every((key) => typeof client[key] === "string" &&
    Buffer.byteLength(client[key], "utf8") <= 4096 && !/[\x00-\x1f\x7f]/.test(client[key])));
  const origin = new URL(client.gatewayOrigin);
  const remote = new URL(client.gitRemote);
  requireValid(origin.protocol === "https:" && origin.origin === client.gatewayOrigin &&
    !origin.username && !origin.password && !origin.search && !origin.hash &&
    remote.origin === origin.origin && !remote.username && !remote.password && !remote.search && !remote.hash &&
    /^\/[A-Za-z0-9._/-]+\.git$/.test(remote.pathname) && !remote.pathname.includes("..") &&
    /^[A-Za-z0-9._-]{1,128}$/.test(client.gitUsername) &&
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.apiHost) &&
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.canonicalApiHost) &&
    client.apiHost === origin.hostname && /^[A-Za-z0-9._/-]{1,512}$/.test(client.repository));
}

function validateDescriptor(descriptor) {
  exactKeys(descriptor, ["sourceRoot", "targetRoot", "manifest"]);
  for (const root of [descriptor.sourceRoot, descriptor.targetRoot]) {
    requireValid(typeof root === "string" && root !== "/" && path.isAbsolute(root) &&
      path.resolve(root) === root && !/[\x00-\x1f\x7f]/.test(root));
  }
  requireValid(descriptor.sourceRoot !== descriptor.targetRoot &&
    !inside(descriptor.sourceRoot, descriptor.targetRoot) && !inside(descriptor.targetRoot, descriptor.sourceRoot));
  const manifest = descriptor.manifest;
  exactKeys(manifest, ["version", "generation", "bindings"]);
  requireValid(manifest.version === 1 && typeof manifest.generation === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.generation) && Array.isArray(manifest.bindings) &&
    manifest.bindings.length > 0 && manifest.bindings.length <= 16);
  const refs = new Set();
  const sessions = new Set();
  for (const binding of manifest.bindings) {
    exactKeys(binding, ["repositoryRef", "sessionId", "deadlineWallMs", "directory", "client"]);
    requireValid(typeof binding.repositoryRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.repositoryRef) &&
      typeof binding.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(binding.sessionId) &&
      Number.isSafeInteger(binding.deadlineWallMs) && binding.deadlineWallMs > Date.now() &&
      !refs.has(binding.repositoryRef) && !sessions.has(binding.sessionId));
    refs.add(binding.repositoryRef);
    sessions.add(binding.sessionId);
    requireValid(binding.directory === runtimeRoot + hash([binding.repositoryRef, binding.sessionId]));
    validateClient(binding.client);
  }
  const pairs = manifest.bindings.map((binding) => [binding.repositoryRef, binding.sessionId]);
  const sorted = [...pairs].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  requireValid(hash(sorted) === manifest.generation);
  manifest.bindings.sort((left, right) => left.repositoryRef < right.repositoryRef ? -1 : left.repositoryRef > right.repositoryRef ? 1 : 0);
}

// Kubernetes projects directories through ..data symlinks. Resolve those links,
// then open the checked regular file without following a final symlink.
function readProjectedFile(sourceRoot, directory, name) {
  const filename = path.join(directory, name);
  const resolved = fs.realpathSync(filename);
  requireValid(inside(sourceRoot, resolved) && inside(fs.realpathSync(directory), resolved));
  const before = metadata(resolved);
  requireValid(before.isFile() && before.nlink === 1n && before.size <= BigInt(limits[name]));
  const file = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(file, { bigint: true });
    requireValid(sameFile(before, opened));
    const bytes = Buffer.alloc(limits[name] + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(file, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    requireValid(length <= limits[name] && BigInt(length) === before.size &&
      sameFile(before, fs.fstatSync(file, { bigint: true })) &&
      sameFile(before, metadata(resolved)) && fs.realpathSync(filename) === resolved);
    const contents = bytes.subarray(0, length);
    const text = decoder.decode(contents);
    requireValid(!text.includes("\0"));
    return { contents, text };
  } finally {
    fs.closeSync(file);
  }
}

function validateProjection(sourceRoot, binding) {
  const directory = path.join(sourceRoot, path.basename(binding.directory));
  const resolved = fs.realpathSync(directory);
  requireValid(inside(sourceRoot, resolved));
  const before = metadata(resolved);
  requireValid(before.isDirectory());
  const names = fs.readdirSync(directory).sort();
  const hasPublicCa = names.includes("ca.pem");
  requireValid(JSON.stringify(names) === JSON.stringify(["bearer", "client.json", "gitconfig", "gh", ...(hasPublicCa ? ["ca.pem"] : [])].sort()));
  const gh = fs.realpathSync(path.join(directory, "gh"));
  requireValid(inside(resolved, gh) && metadata(gh).isDirectory());
  const ghBefore = metadata(gh);
  requireValid(JSON.stringify(fs.readdirSync(gh).sort()) === JSON.stringify(["config.yml", "hosts.yml"]));
  const files = {};
  for (const name of Object.keys(limits)) {
    if (name !== "ca.pem" || hasPublicCa) files[name] = readProjectedFile(sourceRoot, directory, name);
  }
  requireValid(/^[A-Za-z0-9_-]{32,256}$/.test(files.bearer.text));
  const client = JSON.parse(files["client.json"].text);
  exactKeys(client, ["sessionId", "deadlineWallMs", "client", "hasPublicCa"]);
  validateClient(client.client);
  requireValid(client.sessionId === binding.sessionId && client.deadlineWallMs === binding.deadlineWallMs &&
    client.hasPublicCa === hasPublicCa && clientKeys.every((key) => client.client[key] === binding.client[key]) &&
    JSON.stringify(client.client.pushRefAllowlist) === JSON.stringify(binding.client.pushRefAllowlist));
  requireValid(files.gitconfig.text === "[credential]\n\thelper =\n\tuseHttpPath = true\n[http]\n\tfollowRedirects = false\n\tsslVerify = true\n");
  requireValid(files["gh/config.yml"].text === "version: 1\nprompt: disabled\ngit_protocol: https\n");
  requireValid(files["gh/hosts.yml"].text === JSON.stringify(binding.client.canonicalApiHost) + ":\n  api_host: " +
    JSON.stringify(binding.client.apiHost) + "\n  git_protocol: https\n  oauth_token: " + JSON.stringify(files.bearer.text) + "\n");
  requireValid(!hasPublicCa || files["ca.pem"].contents.length > 0);
  requireValid(fs.realpathSync(directory) === resolved && sameFile(before, metadata(resolved)) &&
    fs.realpathSync(path.join(directory, "gh")) === gh && sameFile(ghBefore, metadata(gh)));
  return { binding, files };
}

function readSystemCaBundle() {
  for (const candidate of systemCaBundleCandidates) {
    try {
      const contents = fs.readFileSync(candidate);
      requireValid(contents.length > 0 && contents.length <= 1024 * 1024 && !contents.includes(0));
      return contents;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("system-ca-bundle-missing");
}

function repositoryCaBundle(files) {
  if (!Object.hasOwn(files, "ca.pem")) return undefined;
  const system = readSystemCaBundle();
  return Buffer.concat([
    system,
    system[system.length - 1] === 10 ? Buffer.alloc(0) : Buffer.from("\n"),
    files["ca.pem"].contents,
  ]);
}

function requireDirectoriesWithoutSymlinks(directory) {
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    requireValid(metadata(cursor).isDirectory());
    if (path.dirname(cursor) === cursor) return;
  }
}

// An init retry may find its own partial output. Never traverse or remove links,
// special files, another owner's tree, or a directory exposed to other users.
function validateOwnedOutput(directory) {
  const stat = metadata(directory);
  requireValid(stat.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o7777n) === 0o700n);
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    const child = metadata(filename);
    if (child.isDirectory()) validateOwnedOutput(filename);
    else requireValid(child.isFile() && child.uid === BigInt(uid) && child.nlink === 1n && (child.mode & 0o7777n) === 0o600n);
  }
  requireValid(sameFile(stat, metadata(directory)));
  return stat;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  // fsGroup may set the inherited setgid bit on the emptyDir mount.
  fs.chmodSync(directory, 0o700);
}

function writePrivate(filename, contents) {
  const file = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(file, contents);
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
}

async function materialize(descriptor) {
  ({ normalizePushRefAllowlist } = await import(
    "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/native-git.js"
  ));
  validateDescriptor(descriptor);
  const { sourceRoot, targetRoot, manifest } = descriptor;
  requireDirectoriesWithoutSymlinks(sourceRoot);
  requireValid(fs.realpathSync(sourceRoot) === sourceRoot);
  const sourceBefore = metadata(sourceRoot);
  const materials = manifest.bindings.map((binding) => validateProjection(sourceRoot, binding));
  requireValid(sameFile(sourceBefore, metadata(sourceRoot)));
  const parent = path.dirname(targetRoot);
  requireDirectoriesWithoutSymlinks(parent);
  const parentBefore = metadata(parent);
  const existing = optionalMetadata(targetRoot);
  if (existing !== undefined) validateOwnedOutput(targetRoot);
  // No output is created until every binding has been validated above.
  const staging = fs.mkdtempSync(path.join(parent, ".repository-material-"));
  fs.chmodSync(staging, 0o700);
  let published = false;
  try {
    privateDirectory(path.join(staging, "sessions"));
    for (const { binding, files } of materials) {
      const directory = path.join(staging, "sessions", path.basename(binding.directory));
      privateDirectory(directory);
      privateDirectory(path.join(directory, "gh"));
      for (const [name, file] of Object.entries(files)) writePrivate(path.join(directory, name), file.contents);
      const caBundle = repositoryCaBundle(files);
      if (caBundle !== undefined) writePrivate(path.join(directory, "ca-bundle.pem"), caBundle);
    }
    writePrivate(path.join(staging, "manifest.json"), JSON.stringify(manifest) + "\n");
    requireValid(manifest.bindings.every((binding) => binding.deadlineWallMs > Date.now()));
    requireDirectoriesWithoutSymlinks(parent);
    const parentAfter = metadata(parent);
    requireValid(parentBefore.dev === parentAfter.dev && parentBefore.ino === parentAfter.ino);
    if (existing !== undefined) {
      requireValid(sameFile(existing, validateOwnedOutput(targetRoot)));
      fs.rmSync(targetRoot, { recursive: true });
    } else requireValid(optionalMetadata(targetRoot) === undefined);
    fs.renameSync(staging, targetRoot);
    published = true;
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true });
  }
}

Promise.resolve().then(async () => {
  process.umask(0o077);
  await materialize(JSON.parse(process.argv[1]));
}).catch(() => {
  process.stderr.write("Repository credential material initialization failed.\n");
  process.exitCode = 1;
});
`;

/** Runs after the private subPath exists, without the fsGroup-writable volume root. */
export const REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT = String.raw`
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
Promise.resolve().then(async () => {
  process.umask(0o077);
  const root = process.argv[1];
  const { readPrivateFile } = await import(
    "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/private-files.js"
  );
  const { prepareNativeGitConfiguration } = await import(
    "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/native-git.js"
  );
  const config = path.join(root, "gitconfig");
  // An interrupted init may have left a partial file. Only this init can write
  // the private mount; validate custody before removing its previous output.
  try {
    await readPrivateFile(config, 256 * 1024);
    await fs.unlink(config);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await prepareNativeGitConfiguration(root, "/run/oce/repository-credentials");
}).catch(() => {
  process.stderr.write("Repository native Git configuration initialization failed.\n");
  process.exitCode = 1;
});
`;
