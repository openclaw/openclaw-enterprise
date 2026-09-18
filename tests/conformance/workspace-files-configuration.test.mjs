import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWorkspaceFilesAccess,
  readWorkspaceFilesApiKey,
  validateGatewayApiKeyPath,
  validateWorkspaceFilesApiKeyPath,
} from "../../apps/controller/src/composition/workspace-files.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const agentId = "agt_00000000-0000-4000-8000-000000000001";

async function tempPath(t, basename, contents) {
  const directory = await mkdtemp(join(tmpdir(), "occ-gateway-api-key-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, basename);
  await writeFile(path, contents, "utf8");
  return path;
}

async function projectedSecretKeyPath(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "occ-projected-gateway-api-key-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const revisionDirectory = "..2026_09_01_00_00_00.000000001";
  await mkdir(join(directory, revisionDirectory));
  await writeFile(join(directory, revisionDirectory, "gateway-api-key"), contents, "utf8");
  await symlink(revisionDirectory, join(directory, "..data"));
  await symlink("..data/gateway-api-key", join(directory, "gateway-api-key"));
  return { directory, path: join(directory, "gateway-api-key") };
}

async function rotateProjectedSecretKey(projected, contents) {
  const revisionDirectory = `..2026_09_01_00_00_00.${Math.random().toString(16).slice(2)}`;
  await mkdir(join(projected.directory, revisionDirectory));
  await writeFile(
    join(projected.directory, revisionDirectory, "gateway-api-key"),
    contents,
    "utf8",
  );
  await symlink(revisionDirectory, join(projected.directory, "..data_tmp"));
  await rename(join(projected.directory, "..data_tmp"), join(projected.directory, "..data"));
}

function computeDriver(overrides = {}) {
  return {
    id: "compute-workspace-files",
    capability: "compute",
    implementation: "deterministic-test",
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    ...overrides,
  };
}

function startupDiagnostic(stderr) {
  const diagnostic = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.event === "startup-error");
  assert.ok(diagnostic, stderr);
  return diagnostic;
}

function revision(overrides = {}) {
  return {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId,
    agentId,
    revision: 1,
    providerId: "provider-test",
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    harness: { id: "test-harness", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: "sp-workspace-files",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function readRequest(overrides = {}) {
  return {
    revision: revision(overrides.revision),
    filename: "AGENTS.md",
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 100),
  };
}

test("workspace-files API key parser accepts one mounted key and re-reads rotations", async (t) => {
  const path = await tempPath(t, "gateway-api-key", "key-without-newline");

  await validateWorkspaceFilesApiKeyPath(path);
  assert.equal(await readWorkspaceFilesApiKey(path), "key-without-newline");

  await writeFile(path, "rotated-key", "utf8");
  assert.equal(await readWorkspaceFilesApiKey(path), "rotated-key");
});

test("workspace-files API key parser follows projected Secret symlink rotations", async (t) => {
  const projected = await projectedSecretKeyPath(t, "projected-key");

  await validateWorkspaceFilesApiKeyPath(projected.path);
  assert.equal(await readWorkspaceFilesApiKey(projected.path), "projected-key");

  await rotateProjectedSecretKey(projected, "projected-rotated-key");
  assert.equal(await readWorkspaceFilesApiKey(projected.path), "projected-rotated-key");
});

test("workspace-files API key parser rejects missing, relative, empty, whitespace, and oversized files", async (t) => {
  const missing = join(tmpdir(), "missing-gateway-api-key");
  assert.throws(() => validateGatewayApiKeyPath("gateway-api-key"), /absolute/i);
  await assert.rejects(validateWorkspaceFilesApiKeyPath("gateway-api-key"), /unavailable|invalid/i);
  await assert.rejects(validateWorkspaceFilesApiKeyPath(missing), /unavailable|invalid/i);

  for (const [basename, contents] of [
    ["empty", ""],
    ["spaces", "   "],
    ["leading-space", " key"],
    ["trailing-space", "key "],
    ["embedded-space", "ke y"],
    ["nul", "key\u0000"],
    ["tab", "key\tvalue"],
    ["non-ascii", "keyé"],
    ["one-newline", "key\n"],
    ["two-newlines", "key\n\n"],
    ["carriage-return", "key\r\n"],
    ["oversized", "k".repeat(4 * 1024 + 1)],
  ]) {
    await assert.rejects(
      readWorkspaceFilesApiKey(await tempPath(t, basename, contents)),
      /invalid/i,
      basename,
    );
  }
});

test("workspace-files access resolves native gateway endpoints through the selected Compute Driver", async (t) => {
  const path = await tempPath(t, "gateway-api-key", "native-key");
  const endpoints = [];
  const access = createWorkspaceFilesAccess(
    computeDriver({
      getGatewayEndpoint(candidate) {
        endpoints.push(candidate);
        if (candidate.namespaceId !== namespaceId || candidate.agentId !== agentId) {
          return undefined;
        }
        return "https://gateway.example/openclaw";
      },
    }),
    path,
  );

  assert.deepEqual(await access.read(readRequest()), { status: "unavailable" });
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].namespaceId, namespaceId);
  assert.equal(endpoints[0].agentId, agentId);
});

test("workspace-files access reports unavailable when the Compute Driver has no native endpoint", async (t) => {
  const access = createWorkspaceFilesAccess(
    computeDriver(),
    await tempPath(t, "key", "native-key"),
  );

  assert.deepEqual(await access.read(readRequest()), { status: "unavailable" });
});

test("workspace-files access maps rotated missing API-key files to unavailable after startup", async (t) => {
  const path = await tempPath(t, "gateway-api-key", "native-key");
  const access = createWorkspaceFilesAccess(
    computeDriver({
      getGatewayEndpoint() {
        return "wss://gateway.example/openclaw";
      },
    }),
    path,
  );
  await rm(path);

  assert.deepEqual(await access.read(readRequest()), { status: "unavailable" });
});

test("workspace-files server startup validates API-only key configuration before database access", async (t) => {
  const gatewayApiKeyPath = await tempPath(t, "gateway-api-key", " ");
  const installationPath = await tempPath(t, "installation.yaml", JSON.stringify(installation()));

  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: installationPath,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr).code, "GATEWAY_API_KEY_UNAVAILABLE");
  assert.doesNotMatch(server.stderr, /ECONNREFUSED|PostgreSQL|database/i);
});

test("workspace-files server startup rejects the removed endpoint-map environment", async (t) => {
  const installationPath = await tempPath(t, "installation.yaml", JSON.stringify(installation()));

  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      OCC_CONFIG_PATH: installationPath,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
      OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
      OCC_WORKSPACE_FILES_CONFIG_PATH: "/etc/openclaw/workspace-files/workspace-files.yaml",
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr).code, "WORKSPACE_FILES_CONFIG_REMOVED");
  assert.doesNotMatch(server.stderr, /ECONNREFUSED|PostgreSQL|database/i);
});
