import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRuntimeRepositoryManifest } from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import { writeClientConfiguration } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";

const bearer = "compatibility_bearer_0123456789abcdef01234567";

function sessionRoot(t) {
  return mkdtemp(join(tmpdir(), "repository-material-compatibility-")).then(async (created) => {
    t.after(() => rm(created, { recursive: true, force: true }));
    // Resolve the platform symlink in the temporary path; material readers reject symlinked ancestors.
    const root = await realpath(created);
    await mkdir(join(root, "sessions"), { mode: 0o700 });
    return root;
  });
}

async function installBinding(root, { repositoryRef, deadlineWallMs, client }) {
  const sessionId = "session-compatibility";
  const directoryName = createHash("sha256")
    .update(JSON.stringify([repositoryRef, sessionId]))
    .digest("hex");
  const directory = join(root, "sessions", directoryName);
  await writeClientConfiguration(
    {
      bearer,
      session: { sessionId, deadlineWallMs },
      client,
    },
    directory,
    undefined,
  );
  return { repositoryRef, sessionId, deadlineWallMs, directory, client };
}

async function writeManifest(root, bindings) {
  const generation = createHash("sha256")
    .update(
      JSON.stringify(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
    )
    .digest("hex");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ version: 1, generation, bindings }),
    { mode: 0o600 },
  );
}

const gatewayOrigin = "https://credentials.example.test";
const deadlineWallMs = Date.now() + 600_000;

test("stored GitHub client material without projectId still loads", async (t) => {
  const root = await sessionRoot(t);
  const client = {
    gatewayOrigin,
    gitRemote: `${gatewayOrigin}/acme/repository.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository: "acme/repository",
  };
  const binding = await installBinding(root, {
    repositoryRef: "fixture-repository",
    deadlineWallMs,
    client,
  });
  await writeManifest(root, [binding]);

  const manifest = await readRuntimeRepositoryManifest(root);
  assert.equal(manifest.bindings.length, 1);
  assert.equal(manifest.bindings[0].client.projectId, undefined);
  assert.equal(manifest.bindings[0].configuration.client.projectId, undefined);
  assert.equal(
    await readFile(join(manifest.bindings[0].materialDirectory, "gh", "hosts.yml"), "utf8"),
    `"github.com":\n  api_host: "credentials.example.test"\n  git_protocol: https\n  oauth_token: ${JSON.stringify(bearer)}\n`,
  );
});

test("GitLab client material with projectId loads and stays provider-scoped", async (t) => {
  const root = await sessionRoot(t);
  const client = {
    gatewayOrigin,
    gitRemote: `${gatewayOrigin}/group/project.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "gitlab.com",
    apiHost: "credentials.example.test",
    repository: "group/project",
    projectId: "88516404",
  };
  const binding = await installBinding(root, {
    repositoryRef: "88516404",
    deadlineWallMs,
    client,
  });
  await writeManifest(root, [binding]);

  const manifest = await readRuntimeRepositoryManifest(root);
  assert.equal(manifest.bindings[0].client.projectId, "88516404");
  assert.equal(manifest.bindings[0].repositoryRef, "88516404");
  // GitLab sessions use private-token authentication, so no gh oauth material is emitted.
  assert.equal(
    await readFile(join(manifest.bindings[0].materialDirectory, "gh", "hosts.yml"), "utf8"),
    "version: 1\n",
  );
});
