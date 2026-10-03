#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { github, githubPages, repository, validateCi } from "./container-release.mjs";

export const exportWorkflow = ".github/workflows/repository-service-export.yml";
export const exportLane = "repository-credentials-container";
export const exportRoles = ["service", "client", "qualification"];
export const exporterVersion = "skopeo version 1.13.3";
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;
const ociJsonLimit = 4 * 1024 * 1024;
const ociLayerLimit = 512 * 1024 * 1024;
const ociExpandedLayerLimit = 1024 * 1024 * 1024;
const ociArchiveLimit = 2 * 1024 * 1024 * 1024;
const ociTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value) {
  return sha256(`${JSON.stringify(canonicalize(value))}\n`);
}

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) {
    throw new Error(`${commandName} could not be executed.`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${commandName} failed.`);
  }
  return result;
}

async function readJson(path) {
  return checkedJson(await readFile(path, "utf8"), "JSON document");
}

async function writeJsonAtomic(path, value, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function validateExportRequest(lane, requested) {
  assert.ok(requested === "true" || requested === "false", "Service export must be true or false.");
  if (requested === "true") {
    assert.ok(
      lane === exportLane,
      "Service export is restricted to repository-credentials-container.",
    );
  }
  return requested === "true";
}

export function validateHostedContext(env, repo) {
  assert.ok(env.GITHUB_REPOSITORY === repository, "Hosted repository identity changed.");
  assert.ok(repo.full_name === repository, "Repository API identity changed.");
  assert.ok(repo.default_branch === "main", "Repository default branch changed.");
  assert.ok(typeof repo.private === "boolean", "Repository visibility is unavailable.");
  assert.ok(env.GITHUB_EVENT_NAME === "workflow_dispatch", "Hosted event is unsupported.");
  assert.ok(env.GITHUB_REF === "refs/heads/main", "Hosted branch is unsupported.");
  assert.ok(
    env.GITHUB_WORKFLOW_REF === `${repository}/${exportWorkflow}@refs/heads/main`,
    "Hosted workflow identity changed.",
  );
  for (const name of ["GITHUB_WORKFLOW_SHA", "GITHUB_SHA", "SOURCE_SHA"]) {
    assert.match(env[name] ?? "", shaPattern, `${name} must be a full commit SHA.`);
  }
  assert.ok(env.GITHUB_SHA === env.GITHUB_WORKFLOW_SHA, "Hosted checkout identity changed.");
  assert.ok(env.SOURCE_SHA === env.GITHUB_WORKFLOW_SHA, "Requested source identity changed.");
  assert.match(env.CI_RUN_ID ?? "", integerPattern, "CI run ID is invalid.");
  assert.match(env.CI_ATTEMPT ?? "", integerPattern, "CI run attempt is invalid.");
}

export function validateLaneIdentity(state, receipt, env) {
  assert.ok(state.version === 1, "Lane state version is unsupported.");
  assert.ok(state.repositoryRoot === repositoryRoot, "Lane state repository root changed.");
  assert.ok(state.lane === exportLane, "Lane state name changed.");
  assert.match(state.prefix ?? "", /^openclaw-ci-[a-z0-9-]+$/, "Lane owner is invalid.");
  assert.ok(Array.isArray(state.resources), "Lane resources are missing.");
  assert.ok(receipt.version === 1, "Lane receipt version is unsupported.");
  assert.ok(receipt.lane === exportLane, "Lane receipt name changed.");
  assert.ok(receipt.sourceCommit === env.SOURCE_SHA, "Lane receipt source commit changed.");
  assert.ok(receipt.sourceTree === env.SOURCE_TREE, "Lane receipt source tree changed.");
  assert.ok(receipt.ghVersion === "2.100.0", "Lane receipt GitHub CLI version changed.");
  assert.ok(
    canonicalHash(Object.keys(receipt.images ?? {}).sort()) ===
      canonicalHash([...exportRoles].sort()),
    "Lane receipt image roles changed.",
  );
  assert.ok(state.resources.length === exportRoles.length, "Lane resource count changed.");
  const resources = new Map();
  for (const resource of state.resources) {
    assert.ok(resource.kind === "image-tag", "Lane resource kind is unsupported.");
    assert.ok(resource.owner === state.prefix, "Lane resource ownership changed.");
    assert.ok(resource.status === "ready", "Lane resource is not ready.");
    assert.match(resource.id ?? "", /^image-tag-[a-f0-9]{12}$/, "Lane resource ID is invalid.");
    assert.match(resource.imageId ?? "", digestPattern, "Lane image identity is invalid.");
    assert.match(
      resource.name ?? "",
      /^localhost\/openclaw-ci-image-[a-z0-9-]+\/(service|client|qualification):local$/,
      "Lane image tag is invalid.",
    );
    const role = /\/(service|client|qualification):local$/.exec(resource.name)?.[1];
    assert.ok(role && !resources.has(role), "Each owned image role must be unique.");
    resources.set(role, resource);
  }
  for (const role of exportRoles) {
    const image = receipt.images[role];
    const resource = resources.get(role);
    assert.ok(resource, `Missing ${role} cleanup resource.`);
    assert.ok(
      canonicalHash(image) === canonicalHash({ tag: resource.name, id: resource.imageId }),
      "Lane receipt image does not match its owned cleanup resource.",
    );
  }
  return resources;
}

export function validateServiceRecipe(source, baseReference) {
  assert.ok(
    !/^[ \t]*#[ \t]*(?:syntax|escape|check)[ \t]*=/imu.test(source),
    "Service Dockerfile parser directives are not allowed.",
  );
  const instructions = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(
    canonicalHash(instructions) ===
      canonicalHash([
        `FROM ${baseReference}`,
        "WORKDIR /app",
        "COPY package.json ./package.json",
        "COPY dist ./dist",
        "RUN chmod -R a=rX /app",
        "USER node",
        'ENTRYPOINT ["node", "/app/dist/repository-credentials.js"]',
      ]),
    "Service Dockerfile instructions changed.",
  );
}

export function validateStagedServiceContext(records, dockerignoreSha256, servicePackage) {
  assert.ok(
    records.some(({ path }) => path === "dist/"),
    "Staged service output is missing.",
  );
  assert.ok(
    records.some(({ path, type }) => path.startsWith("dist/") && type === "file"),
    "Staged service output contains no files.",
  );
  assert.ok(
    records.some(({ path }) => path === "package.json"),
    "Staged service package metadata is missing.",
  );
  const ignore = records.find(({ path }) => path === ".dockerignore");
  assert.ok(ignore?.sha256 === dockerignoreSha256, "Staged service ignore policy changed.");
  for (const record of records) {
    assert.ok(
      record.path === ".dockerignore" ||
        record.path === "package.json" ||
        record.path === "dist/" ||
        record.path.startsWith("dist/"),
      "Staged service context contains an unapproved path.",
    );
  }
  if (servicePackage !== undefined) {
    assert.ok(
      canonicalHash(servicePackage) ===
        canonicalHash({ name: "repository-credentials-service", type: "module" }),
      "Staged service package metadata changed.",
    );
  }
}

async function inventory(root, { normalizeModes = false, omit = new Set() } = {}) {
  const records = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (omit.has(relativePath)) {
        continue;
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      assert.ok(!metadata.isSymbolicLink(), "Artifact closure contains a symlink.");
      if (metadata.isDirectory()) {
        records.push({
          path: `${relativePath}/`,
          type: "directory",
          mode: normalizeModes ? "0555" : (metadata.mode & 0o7777).toString(8).padStart(4, "0"),
        });
        await visit(path, relativePath);
      } else {
        assert.ok(metadata.isFile(), "Artifact closure contains a special file.");
        const bytes = await readFile(path);
        const executable = (metadata.mode & 0o111) !== 0;
        records.push({
          path: relativePath,
          type: "file",
          mode: normalizeModes
            ? executable
              ? "0555"
              : "0444"
            : (metadata.mode & 0o7777).toString(8).padStart(4, "0"),
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  await visit(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeHistory(history, label) {
  assert.ok(Array.isArray(history) && history.length > 0, `${label} history is missing.`);
  return history.map((entry) => {
    if (typeof entry === "string") {
      return { createdBy: entry, comment: "" };
    }
    assert.ok(
      entry &&
        typeof entry === "object" &&
        typeof entry.createdBy === "string" &&
        typeof (entry.comment ?? "") === "string",
      `${label} history entry is invalid.`,
    );
    return { createdBy: entry.createdBy, comment: entry.comment ?? "" };
  });
}

export function validateServiceConfiguration(service, base, serviceHistory, baseHistory) {
  assert.ok(
    service.Config && typeof service.Config === "object",
    "The service image configuration is missing.",
  );
  assert.ok(
    base.Config && typeof base.Config === "object",
    "The pinned base image configuration is missing.",
  );
  assert.ok(service.Config?.User === "node", "The service image must use the node user.");
  assert.ok(service.Config?.WorkingDir === "/app", "The service image working directory changed.");
  assert.ok(
    canonicalHash(service.Config?.Entrypoint) ===
      canonicalHash(["node", "/app/dist/repository-credentials.js"]),
    "The service image entrypoint changed.",
  );
  const approvedConfig = {
    ...base.Config,
    User: "node",
    WorkingDir: "/app",
    Entrypoint: ["node", "/app/dist/repository-credentials.js"],
  };
  const intendedOverrides = new Set(["User", "WorkingDir", "Entrypoint"]);
  for (const key of Object.keys(base.Config)) {
    if (!intendedOverrides.has(key)) {
      assert.ok(
        canonicalHash(service.Config[key] ?? null) === canonicalHash(approvedConfig[key] ?? null),
        "The service image changed inherited base configuration.",
      );
    }
  }
  for (const key of [
    "Labels",
    "Healthcheck",
    "Volumes",
    "StopSignal",
    "Shell",
    "ExposedPorts",
    "OnBuild",
  ]) {
    assert.ok(
      canonicalHash(service.Config[key] ?? null) === canonicalHash(approvedConfig[key] ?? null),
      "The service image contains unapproved runtime metadata.",
    );
  }
  const baseLayers = base.RootFS?.Layers;
  const serviceLayers = service.RootFS?.Layers;
  assert.ok(Array.isArray(baseLayers) && baseLayers.length > 0);
  assert.ok(Array.isArray(serviceLayers) && serviceLayers.length > baseLayers.length);
  assert.ok(
    canonicalHash(serviceLayers.slice(0, baseLayers.length)) === canonicalHash(baseLayers),
    "The service image must retain the ordered base layers.",
  );
  const normalizedBaseHistory = normalizeHistory(baseHistory, "Pinned base image");
  const normalizedServiceHistory = normalizeHistory(serviceHistory, "Service image");
  assert.ok(
    normalizedServiceHistory.length > normalizedBaseHistory.length,
    "Service-owned image history is missing.",
  );
  assert.ok(
    canonicalHash(normalizedServiceHistory.slice(-normalizedBaseHistory.length)) ===
      canonicalHash(normalizedBaseHistory),
    "The service image history must retain the pinned base suffix.",
  );
  const serviceOwnedHistory = normalizedServiceHistory.slice(0, -normalizedBaseHistory.length);
  assert.ok(
    !/(?:authorization|bearer|password|private[ _-]?key|secret|token)[=:][^ ,]+/i.test(
      JSON.stringify(serviceOwnedHistory),
    ),
    "Service-owned image history must not carry credential values.",
  );
  assert.ok(
    serviceOwnedHistory.every(
      ({ comment }) => comment === "" || comment === "buildkit.dockerfile.v0",
    ),
    "Service-owned image history contains an unapproved comment.",
  );
  return { approvedConfig, baseLayers, serviceLayers, serviceOwnedHistory };
}

function checkedJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function selectedServiceConfig(service) {
  return Object.fromEntries(
    [
      ["User", service.Config?.User],
      ["WorkingDir", service.Config?.WorkingDir],
      ["Entrypoint", service.Config?.Entrypoint],
      ["Cmd", service.Config?.Cmd],
      ["Env", service.Config?.Env],
      ["Labels", service.Config?.Labels],
      ["Healthcheck", service.Config?.Healthcheck],
      ["Volumes", service.Config?.Volumes],
      ["StopSignal", service.Config?.StopSignal],
      ["Shell", service.Config?.Shell],
      ["ExposedPorts", service.Config?.ExposedPorts],
      ["OnBuild", service.Config?.OnBuild],
    ].filter(([, value]) => value !== undefined),
  );
}

function expectedOci(service, approval = {}) {
  return {
    configId: service.Id,
    diffIds: service.RootFS?.Layers,
    user: service.Config?.User,
    workingDir: service.Config?.WorkingDir,
    entrypoint: service.Config?.Entrypoint,
    command: service.Config?.Cmd ?? null,
    environmentSha256: canonicalHash(service.Config?.Env),
    approvedConfig: approval.approvedConfig ?? selectedServiceConfig(service),
    baseConfig: approval.baseConfig,
    serviceOwnedHistory: approval.serviceOwnedHistory,
  };
}

function validateLayerPayload(bytes, mediaType, expectedDiffId) {
  let expanded;
  if (mediaType === "application/vnd.oci.image.layer.v1.tar") {
    assert.ok(bytes.length <= ociExpandedLayerLimit, "OCI layer exceeds the expanded size limit.");
    expanded = bytes;
  } else if (mediaType === "application/vnd.oci.image.layer.v1.tar+gzip") {
    try {
      expanded = gunzipSync(bytes, { maxOutputLength: ociExpandedLayerLimit });
    } catch {
      throw new Error("OCI gzip layer is invalid or exceeds the expanded size limit.");
    }
  } else {
    throw new Error("OCI layer compression is unsupported by this verifier.");
  }
  assert.ok(
    `sha256:${sha256(expanded)}` === expectedDiffId,
    "OCI layer payload does not match the ordered tested filesystem layer.",
  );
}

async function validateOci(readRoot, readBlob, listBlobNames, expected) {
  assert.ok(
    Array.isArray(expected.diffIds) &&
      expected.diffIds.length > 0 &&
      expected.diffIds.every((digest) => digestPattern.test(digest)),
    "Tested filesystem layer identities are invalid.",
  );
  const indexBytes = await readRoot("index.json", ociJsonLimit);
  const index = checkedJson(indexBytes, "OCI index");
  assert.ok(
    canonicalHash(Object.keys(index).sort()) === canonicalHash(["manifests", "schemaVersion"]),
    "OCI index contains unapproved metadata.",
  );
  assert.ok(index.schemaVersion === 2, "OCI index schema is unsupported.");
  assert.ok(index.manifests?.length === 1, "OCI index must name exactly one manifest.");
  const descriptor = index.manifests[0];
  assert.ok(
    canonicalHash(Object.keys(descriptor ?? {}).sort()) ===
      canonicalHash(["annotations", "digest", "mediaType", "size"]),
    "OCI index descriptor contains unapproved metadata.",
  );
  assert.ok(
    descriptor.mediaType === "application/vnd.oci.image.manifest.v1+json",
    "OCI manifest media type is unsupported.",
  );
  assert.ok(
    canonicalHash(descriptor.annotations) ===
      canonicalHash({ "org.opencontainers.image.ref.name": "service" }),
    "OCI service reference metadata changed.",
  );
  const manifestBytes = await readBlob(descriptor.digest, ociJsonLimit);
  assert.ok(descriptor.size === manifestBytes.length, "OCI manifest descriptor size changed.");
  const manifest = checkedJson(manifestBytes, "OCI manifest");
  assert.ok(
    canonicalHash(Object.keys(manifest).sort()) ===
      canonicalHash(["config", "layers", "mediaType", "schemaVersion"]),
    "OCI manifest contains unapproved metadata.",
  );
  assert.ok(manifest.schemaVersion === 2, "OCI manifest schema is unsupported.");
  assert.ok(
    manifest.mediaType === "application/vnd.oci.image.manifest.v1+json",
    "OCI manifest media type changed.",
  );
  assert.ok(
    manifest.config?.mediaType === "application/vnd.oci.image.config.v1+json",
    "OCI config media type is unsupported.",
  );
  assert.ok(
    canonicalHash(Object.keys(manifest.config ?? {}).sort()) ===
      canonicalHash(["digest", "mediaType", "size"]),
    "OCI config descriptor contains unapproved metadata.",
  );
  assert.ok(manifest.config?.digest === expected.configId, "OCI config identity changed.");
  const configBytes = await readBlob(manifest.config.digest, ociJsonLimit);
  assert.ok(manifest.config.size === configBytes.length, "OCI config descriptor size changed.");
  const config = checkedJson(configBytes, "OCI config");
  if (expected.approvedConfig !== undefined) {
    assert.ok(
      canonicalHash(config.config) === canonicalHash(expected.approvedConfig),
      "OCI runtime configuration contains unapproved metadata.",
    );
  }
  assert.ok(
    canonicalHash(Object.keys(config.rootfs ?? {}).sort()) === canonicalHash(["diff_ids", "type"]),
    "OCI root filesystem metadata is invalid.",
  );
  assert.ok(config.rootfs?.type === "layers", "OCI root filesystem type is unsupported.");
  assert.ok(
    Array.isArray(config.rootfs?.diff_ids) &&
      config.rootfs.diff_ids.length > 0 &&
      config.rootfs.diff_ids.every((digest) => digestPattern.test(digest)),
    "OCI config filesystem layer identities are invalid.",
  );
  assert.ok(
    canonicalHash(config.rootfs?.diff_ids) === canonicalHash(expected.diffIds),
    "OCI config filesystem layers do not match the tested image.",
  );
  assert.ok(config.config?.User === expected.user, "OCI config user changed.");
  assert.ok(config.config?.WorkingDir === expected.workingDir, "OCI working directory changed.");
  assert.ok(
    canonicalHash(config.config?.Entrypoint) === canonicalHash(expected.entrypoint),
    "OCI entrypoint changed.",
  );
  assert.ok(
    canonicalHash(config.config?.Cmd ?? null) === canonicalHash(expected.command),
    "OCI command changed.",
  );
  assert.ok(
    canonicalHash(config.config?.Env) === expected.environmentSha256,
    "OCI environment changed.",
  );
  if (expected.baseConfig) {
    const mutableTopLevel = new Set(["config", "created", "history", "rootfs"]);
    const allowedTopLevel = new Set([...Object.keys(expected.baseConfig), ...mutableTopLevel]);
    assert.ok(
      Object.keys(config).every((key) => allowedTopLevel.has(key)),
      "OCI config contains an unapproved top-level field.",
    );
    for (const key of Object.keys(expected.baseConfig)) {
      if (!mutableTopLevel.has(key)) {
        assert.ok(
          canonicalHash(config[key]) === canonicalHash(expected.baseConfig[key]),
          "OCI config changed inherited base metadata.",
        );
      }
    }
    if (config.created !== undefined) {
      assert.ok(
        typeof config.created === "string" &&
          ociTimestampPattern.test(config.created) &&
          !Number.isNaN(Date.parse(config.created)),
        "OCI config creation time is invalid.",
      );
    }
    const baseOciHistory = expected.baseConfig.history ?? [];
    assert.ok(
      Array.isArray(config.history) &&
        config.history.length === baseOciHistory.length + expected.serviceOwnedHistory.length,
      "OCI config history length changed.",
    );
    assert.ok(
      canonicalHash(config.history.slice(0, baseOciHistory.length)) ===
        canonicalHash(baseOciHistory),
      "OCI config changed inherited base history.",
    );
    const serviceOciHistory = config.history.slice(baseOciHistory.length);
    const approvedHistory = [...expected.serviceOwnedHistory].reverse();
    for (const [index, entry] of serviceOciHistory.entries()) {
      assert.ok(
        entry && typeof entry === "object" && !Array.isArray(entry),
        "OCI service history entry is invalid.",
      );
      assert.ok(
        Object.keys(entry).every((key) =>
          ["comment", "created", "created_by", "empty_layer"].includes(key),
        ),
        "OCI service history contains unapproved metadata.",
      );
      if (entry.created !== undefined) {
        assert.ok(
          typeof entry.created === "string" &&
            ociTimestampPattern.test(entry.created) &&
            !Number.isNaN(Date.parse(entry.created)),
          "OCI service history creation time is invalid.",
        );
      }
      if (entry.empty_layer !== undefined) {
        assert.ok(
          typeof entry.empty_layer === "boolean",
          "OCI service history layer flag is invalid.",
        );
      }
      assert.ok(
        entry.created_by === approvedHistory[index].createdBy,
        "OCI service history instruction changed.",
      );
      assert.ok(
        (entry.comment ?? "") === approvedHistory[index].comment,
        "OCI service history comment changed.",
      );
    }
  }
  assert.ok(
    Array.isArray(manifest.layers) && manifest.layers.length > 0,
    "OCI layers are missing.",
  );
  assert.ok(
    manifest.layers.length === config.rootfs.diff_ids.length,
    "OCI manifest and config layer counts differ.",
  );
  for (const [index, layer] of manifest.layers.entries()) {
    assert.ok(
      canonicalHash(Object.keys(layer ?? {}).sort()) ===
        canonicalHash(["digest", "mediaType", "size"]),
      "OCI layer descriptor contains unapproved metadata.",
    );
    assert.ok(
      layer.mediaType === "application/vnd.oci.image.layer.v1.tar+gzip" ||
        layer.mediaType === "application/vnd.oci.image.layer.v1.tar",
      "OCI layer compression is unsupported by this verifier.",
    );
    const bytes = await readBlob(layer.digest, ociLayerLimit);
    assert.ok(layer.size === bytes.length, "OCI layer descriptor size changed.");
    validateLayerPayload(bytes, layer.mediaType, config.rootfs.diff_ids[index]);
  }
  const expectedBlobs = [
    ...new Set(
      [
        descriptor.digest,
        manifest.config.digest,
        ...manifest.layers.map(({ digest }) => digest),
      ].map((digest) => digest.slice("sha256:".length)),
    ),
  ].sort();
  assert.ok(
    canonicalHash((await listBlobNames()).sort()) === canonicalHash(expectedBlobs),
    "OCI blob topology differs from the descriptor chain.",
  );
  return {
    indexSha256: sha256(indexBytes),
    manifestDigest: descriptor.digest,
    configDigest: manifest.config.digest,
    diffIds: [...config.rootfs.diff_ids],
    layerDigests: manifest.layers.map(({ digest }) => digest),
  };
}

async function verifyLayoutFile(path, limit, label) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && metadata.nlink === 1, `${label} must be one regular file.`);
  assert.ok(metadata.size <= limit, `${label} exceeds its size limit.`);
  return readFile(path);
}

async function verifyBlob(layout, digest, limit) {
  assert.ok(digestPattern.test(digest ?? ""), "OCI blob digest is invalid.");
  const path = join(layout, "blobs", "sha256", digest.slice("sha256:".length));
  const bytes = await verifyLayoutFile(path, limit, "OCI blob");
  assert.ok(`sha256:${sha256(bytes)}` === digest, "OCI blob digest changed.");
  return bytes;
}

export async function validateOciLayout(layout, service, approval) {
  assert.ok(
    canonicalHash((await readdir(layout)).sort()) ===
      canonicalHash(["blobs", "index.json", "oci-layout"]),
    "OCI layout topology is invalid.",
  );
  for (const directory of [join(layout, "blobs"), join(layout, "blobs", "sha256")]) {
    const metadata = await lstat(directory);
    assert.ok(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      "OCI blob path must be a directory.",
    );
  }
  assert.ok(
    canonicalHash(await readdir(join(layout, "blobs"))) === canonicalHash(["sha256"]),
    "OCI blob namespace is invalid.",
  );
  assert.ok(
    canonicalHash(
      checkedJson(
        await verifyLayoutFile(join(layout, "oci-layout"), ociJsonLimit, "OCI layout"),
        "OCI layout",
      ),
    ) === canonicalHash({ imageLayoutVersion: "1.0.0" }),
    "OCI layout version is unsupported.",
  );
  return validateOci(
    (name, limit) => verifyLayoutFile(join(layout, name), limit, `OCI ${name}`),
    (digest, limit) => verifyBlob(layout, digest, limit),
    () => readdir(join(layout, "blobs", "sha256")),
    expectedOci(service, approval),
  );
}

export async function validateOciArchive(archive, serviceOrExpected, approval) {
  const archiveMetadata = await lstat(archive);
  assert.ok(
    archiveMetadata.isFile() && archiveMetadata.nlink === 1,
    "OCI archive must be one regular file.",
  );
  assert.ok(archiveMetadata.size <= ociArchiveLimit, "OCI archive exceeds its size limit.");
  const names = command("tar", ["-tf", archive], { maxBuffer: ociJsonLimit })
    .stdout.split("\n")
    .filter(Boolean);
  const verbose = command("tar", ["--numeric-owner", "-tvf", archive], {
    maxBuffer: ociJsonLimit,
  })
    .stdout.split("\n")
    .filter(Boolean);
  assert.ok(names.length === verbose.length, "OCI archive member table is inconsistent.");
  assert.ok(new Set(names).size === names.length, "OCI archive contains duplicate members.");
  for (const [index, name] of names.entries()) {
    const directory = name === "blobs/" || name === "blobs/sha256/";
    const regular =
      name === "index.json" || name === "oci-layout" || /^blobs\/sha256\/[a-f0-9]{64}$/.test(name);
    assert.ok(directory || regular, "OCI archive contains an unexpected member.");
    assert.ok(
      verbose[index][0] === (directory ? "d" : "-"),
      "OCI archive contains a link or special member.",
    );
  }
  const readMember = async (name, limit) => {
    assert.ok(names.includes(name), "OCI archive member is missing.");
    return command("tar", ["-xOf", archive, name], { encoding: null, maxBuffer: limit }).stdout;
  };
  assert.ok(
    canonicalHash(checkedJson(await readMember("oci-layout", ociJsonLimit), "OCI layout")) ===
      canonicalHash({ imageLayoutVersion: "1.0.0" }),
    "OCI layout version is unsupported.",
  );
  const expected = serviceOrExpected.Id
    ? expectedOci(serviceOrExpected, approval)
    : serviceOrExpected;
  const readArchiveBlob = async (digest, limit) => {
    assert.ok(digestPattern.test(digest ?? ""), "OCI blob digest is invalid.");
    const bytes = await readMember(`blobs/sha256/${digest.slice("sha256:".length)}`, limit);
    assert.ok(`sha256:${sha256(bytes)}` === digest, "OCI blob digest changed.");
    return bytes;
  };
  return validateOci(
    readMember,
    readArchiveBlob,
    async () =>
      names
        .filter((name) => /^blobs\/sha256\/[a-f0-9]{64}$/.test(name))
        .map((name) => basename(name)),
    expected,
  );
}

async function inspectImage(reference) {
  const result = command(process.env.OCC_DOCKER_BIN ?? "docker", ["image", "inspect", reference]);
  const parsed = checkedJson(result.stdout, "Image inspection");
  assert.ok(parsed.length === 1, "Image inspection returned an unexpected result count.");
  return parsed[0];
}

function imageHistory(reference) {
  return command(process.env.OCC_DOCKER_BIN ?? "docker", [
    "history",
    "--no-trunc",
    "--format",
    '{"createdBy":{{json .CreatedBy}},"comment":{{json .Comment}}}',
    reference,
  ])
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => checkedJson(line, "Image history entry"));
}

async function requireCheckout(env) {
  const head = command("git", ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const tree = command("git", ["rev-parse", "--verify", "HEAD^{tree}"]).stdout.trim();
  assert.ok(head === env.SOURCE_SHA, "Checkout commit changed.");
  assert.ok(tree === env.SOURCE_TREE, "Checkout tree changed.");
  assert.ok(env.GITHUB_WORKFLOW_SHA === env.SOURCE_SHA, "Workflow source changed.");
  return { head, tree };
}

async function exportImage(statePath, receiptPath, outputArgument, env = process.env) {
  validateExportRequest(exportLane, env.OPENCLAW_EXPORT_SERVICE_IMAGE ?? "");
  for (const name of ["SOURCE_SHA", "SOURCE_TREE", "GITHUB_WORKFLOW_SHA"]) {
    assert.match(env[name] ?? "", shaPattern, `${name} must be a full commit SHA.`);
  }
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CI_RUN_ID", "CI_ATTEMPT"]) {
    assert.match(env[name] ?? "", integerPattern, `${name} must be a positive integer.`);
  }
  const output = resolve(outputArgument);
  const runnerTemp = resolve(env.RUNNER_TEMP ?? "");
  assert.ok(runnerTemp !== repositoryRoot && contained(runnerTemp, output));
  await mkdir(output, { recursive: false, mode: 0o700 });
  const stateBytes = await readFile(resolve(statePath));
  const receiptBytes = await readFile(resolve(receiptPath));
  const state = checkedJson(stateBytes, "Lane state");
  const receipt = checkedJson(receiptBytes, "Lane receipt");
  validateLaneIdentity(state, receipt, env);
  const checkout = await requireCheckout(env);
  const dockerfilePath = join(repositoryRoot, "deploy/runtime/repository-credentials/Dockerfile");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const baseReference = /^FROM ([^\s]+@sha256:[a-f0-9]{64})$/m.exec(dockerfile)?.[1];
  assert.ok(baseReference, "The service Dockerfile must pin its base by digest.");
  validateServiceRecipe(dockerfile, baseReference);
  const stagedRoot = join(repositoryRoot, ".build/repository-credentials/service");
  const stagedContext = await inventory(stagedRoot);
  const dockerignore = await readFile(
    join(repositoryRoot, "deploy/runtime/repository-credentials/.dockerignore"),
  );
  validateStagedServiceContext(
    stagedContext,
    sha256(dockerignore),
    await readJson(join(stagedRoot, "package.json")),
  );
  const expectedClosure = await inventory(stagedRoot, {
    normalizeModes: true,
    omit: new Set([".dockerignore"]),
  });
  const inspected = {};
  for (const role of exportRoles) {
    inspected[role] = await inspectImage(receipt.images[role].tag);
    assert.ok(inspected[role].Id === receipt.images[role].id, "Tested image identity changed.");
  }
  const work = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "repository-service-export-"));
  const container = `openclaw-service-export-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  try {
    const observedExporter = command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "--version",
    ]).stdout.trim();
    assert.ok(observedExporter === exporterVersion, "OCI exporter version changed.");
    const baseConfigOutput = command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "inspect",
      "--config",
      `docker://${baseReference}`,
    ]).stdout;
    const baseConfig = checkedJson(baseConfigOutput, "Base image configuration");
    assert.ok(baseConfig.os === inspected.service.Os, "Pinned base operating system changed.");
    assert.ok(
      baseConfig.architecture === inspected.service.Architecture,
      "Pinned base architecture changed.",
    );
    const base = {
      Config: baseConfig.config,
      RootFS: { Layers: baseConfig.rootfs?.diff_ids },
    };
    const serviceHistory = imageHistory(receipt.images.service.tag);
    const baseHistory = (baseConfig.history ?? [])
      .map((entry) => ({ createdBy: entry.created_by ?? "", comment: entry.comment ?? "" }))
      .reverse();
    const configuration = validateServiceConfiguration(
      inspected.service,
      base,
      serviceHistory,
      baseHistory,
    );
    command(process.env.OCC_DOCKER_BIN ?? "docker", [
      "create",
      "--name",
      container,
      inspected.service.Id,
    ]);
    const app = join(work, "app");
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["cp", `${container}:/app`, app]);
    const actualClosure = await inventory(app);
    assert.ok(
      canonicalHash(actualClosure) === canonicalHash(expectedClosure),
      "Final /app bytes and normalized modes must match the staged service closure.",
    );
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["rm", "-f", container]);
    const removed = command(
      process.env.OCC_DOCKER_BIN ?? "docker",
      ["container", "inspect", container],
      { allowFailure: true },
    );
    assert.ok(removed.status !== 0, "The export inspection container must be absent.");
    assert.ok(
      /No such container|No such object/i.test(`${removed.stderr}\n${removed.stdout}`),
      "Inspection container absence could not be verified.",
    );
    const oci = join(work, "oci");
    command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "copy",
      "--format",
      "oci",
      `docker-daemon:${receipt.images.service.tag}`,
      `oci:${oci}:service`,
    ]);
    const ociApproval = {
      approvedConfig: configuration.approvedConfig,
      baseConfig,
      serviceOwnedHistory: configuration.serviceOwnedHistory,
    };
    await validateOciLayout(oci, inspected.service, ociApproval);
    const archive = join(output, "repository-credentials-service.oci.tar");
    command("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      archive,
      "-C",
      oci,
      "blobs",
      "index.json",
      "oci-layout",
    ]);
    const ociIdentity = await validateOciArchive(archive, inspected.service, ociApproval);
    const archiveBytes = await readFile(archive);
    const metadata = {
      version: 1,
      kind: "repository-credentials-service-oci-preparation",
      audience: {
        access: "repository-readers",
        retentionDays: 1,
        warning:
          "Preparation artifact only; it is not an installed-lane or registry image reference.",
      },
      source: {
        commit: checkout.head,
        tree: checkout.tree,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
        workflowRun: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
        ciRun: { id: env.CI_RUN_ID, attempt: env.CI_ATTEMPT },
      },
      lane: {
        name: exportLane,
        receiptSha256: sha256(receiptBytes),
        stateSha256: sha256(stateBytes),
      },
      recipe: { path: relative(repositoryRoot, dockerfilePath), sha256: sha256(dockerfile) },
      closure: {
        contextSha256: canonicalHash(stagedContext),
        imageAppSha256: canonicalHash(expectedClosure),
        files: expectedClosure,
      },
      base: {
        pinnedReference: baseReference,
        observedConfigSha256: sha256(baseConfigOutput),
        platform: `${baseConfig.os}/${baseConfig.architecture}`,
      },
      tested: {
        configId: inspected.service.Id,
        tag: receipt.images.service.tag,
        platform: `${inspected.service.Os}/${inspected.service.Architecture}`,
      },
      configuration: {
        user: inspected.service.Config.User,
        workingDir: inspected.service.Config.WorkingDir,
        entrypoint: inspected.service.Config.Entrypoint,
        command: inspected.service.Config.Cmd,
        environmentSha256: canonicalHash(inspected.service.Config.Env),
        serviceOwnedHistorySha256: canonicalHash(configuration.serviceOwnedHistory),
      },
      oci: ociIdentity,
      archive: {
        path: basename(archive),
        sha256: sha256(archiveBytes),
        bytes: archiveBytes.length,
      },
      exporter: {
        name: "skopeo",
        version: observedExporter,
        conversion: "docker-daemon to OCI layout",
      },
      cleanup: {
        status: "pending",
        ownedTags: exportRoles.map((role) => receipt.images[role].tag),
        container,
      },
    };
    await writeJsonAtomic(join(output, "export.json"), metadata, { exclusive: true });
  } finally {
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["rm", "-f", container], {
      allowFailure: true,
    });
    await rm(work, { recursive: true, force: true });
  }
}

async function reconcileCleanup(statePath, receiptPath, outputArgument) {
  const output = resolve(outputArgument);
  const metadataPath = join(output, "export.json");
  const metadata = await readJson(metadataPath);
  assert.ok(metadata.version === 1, "Service export metadata version is unsupported.");
  assert.ok(
    metadata.kind === "repository-credentials-service-oci-preparation",
    "Service export metadata kind changed.",
  );
  assert.ok(metadata.cleanup?.status === "pending", "Service export cleanup is not pending.");
  const receiptBytes = await readFile(resolve(receiptPath));
  assert.ok(
    sha256(receiptBytes) === metadata.lane?.receiptSha256,
    "Lane receipt bytes changed before reconciliation.",
  );
  const receipt = checkedJson(receiptBytes, "Lane receipt");
  assert.ok(
    canonicalHash(metadata.cleanup.ownedTags) ===
      canonicalHash(exportRoles.map((role) => receipt.images[role].tag)),
    "Cleanup metadata does not match the lane receipt.",
  );
  await assert.rejects(stat(resolve(statePath)), { code: "ENOENT" });
  for (const tag of metadata.cleanup.ownedTags) {
    const result = command(process.env.OCC_DOCKER_BIN ?? "docker", ["image", "inspect", tag], {
      allowFailure: true,
    });
    assert.ok(result.status !== 0, "An owned image tag remains after cleanup.");
    assert.ok(
      /No such image|No such object/i.test(`${result.stderr}\n${result.stdout}`),
      "Owned image tag absence could not be verified.",
    );
  }
  const container = command(
    process.env.OCC_DOCKER_BIN ?? "docker",
    ["container", "inspect", metadata.cleanup.container],
    { allowFailure: true },
  );
  assert.ok(container.status !== 0, "The export inspection container remains after cleanup.");
  assert.ok(
    /No such container|No such object/i.test(`${container.stderr}\n${container.stdout}`),
    "Inspection container absence could not be verified.",
  );
  const archive = await readFile(join(output, metadata.archive.path));
  assert.ok(sha256(archive) === metadata.archive.sha256, "OCI archive bytes changed.");
  const archiveIdentity = await validateOciArchive(join(output, metadata.archive.path), {
    configId: metadata.tested.configId,
    diffIds: metadata.oci.diffIds,
    user: metadata.configuration.user,
    workingDir: metadata.configuration.workingDir,
    entrypoint: metadata.configuration.entrypoint,
    command: metadata.configuration.command ?? null,
    environmentSha256: metadata.configuration.environmentSha256,
  });
  assert.ok(
    canonicalHash(archiveIdentity) === canonicalHash(metadata.oci),
    "OCI archive identity changed before upload.",
  );
  assert.ok(
    canonicalHash((await readdir(output)).sort()) ===
      canonicalHash(["export.json", metadata.archive.path].sort()),
    "Service export output contains an unexpected file.",
  );
  metadata.cleanup = {
    status: "verified",
    scope: "owned service, client and qualification tags plus the export inspection container",
    state: "absent",
    ownedTags: metadata.cleanup.ownedTags,
    container: metadata.cleanup.container,
  };
  await writeJsonAtomic(metadataPath, metadata);
}

async function writeArtifactReceipt(outputArgument, artifactId, artifactDigest, artifactName) {
  assert.match(artifactId ?? "", integerPattern, "Artifact ID is invalid.");
  assert.match(artifactDigest ?? "", /^(?:sha256:)?[a-f0-9]{64}$/, "Artifact digest is invalid.");
  assert.match(
    artifactName ?? "",
    /^repository-service-oci-[1-9][0-9]*-[1-9][0-9]*$/,
    "Artifact name is invalid.",
  );
  const output = resolve(outputArgument);
  await mkdir(output, { recursive: false, mode: 0o700 });
  await writeJsonAtomic(
    join(output, "artifact.json"),
    {
      version: 1,
      artifact: { id: artifactId, digest: artifactDigest, name: artifactName },
      audience: "repository-readers",
      retentionDays: 1,
      qualification: "preparation-only",
    },
    { exclusive: true },
  );
}

async function preflight(env = process.env) {
  const repo = await github(`repos/${repository}`);
  validateHostedContext(env, repo);
  const comparison = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  assert.ok(comparison.status === "identical", "The requested source must equal current main.");
  await requireCheckout(env);
  const workflow = await github(`repos/${repository}/actions/workflows/ci.yml`);
  const run = await github(`repos/${repository}/actions/runs/${env.CI_RUN_ID}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${env.CI_RUN_ID}/attempts/${env.CI_ATTEMPT}/jobs`,
    "jobs",
  );
  validateCi(run, workflow, jobs, env.SOURCE_SHA, env.CI_RUN_ID, env.CI_ATTEMPT);
}

async function main(args) {
  const [operation, ...rest] = args;
  if (operation === "gate" && rest.length === 2) {
    validateExportRequest(rest[0], rest[1]);
  } else if (operation === "preflight" && rest.length === 0) {
    await preflight();
  } else if (operation === "export" && rest.length === 3) {
    await exportImage(...rest);
  } else if (operation === "reconcile" && rest.length === 3) {
    await reconcileCleanup(...rest);
  } else if (operation === "artifact-receipt" && rest.length === 4) {
    await writeArtifactReceipt(...rest);
  } else {
    throw new Error(
      "Usage: service-image-export.mjs gate|preflight|export|reconcile|artifact-receipt ...",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Repository service export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
