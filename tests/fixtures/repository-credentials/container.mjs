import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./runtime.mjs";
import { run } from "./process.mjs";

// All controlled peers share this container. It verifies composition and client
// routing; a separate service/Agent runtime is required to prove isolation.
/** @returns {Promise<boolean>} Whether the host handled or skipped the child run. */
export async function runInFixtureContainer(t, testFile, { packaged = false } = {}) {
  if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
    if (packaged || process.env.REPOSITORY_CREDENTIALS_APP_ROOT !== undefined) {
      assert.equal(
        process.env.REPOSITORY_CREDENTIALS_APP_ROOT,
        "/app/dist",
        "packaged qualification must use emitted application modules",
      );
      for (const path of ["apps", "packages", "node_modules"]) {
        await assert.rejects(access(join(repositoryRoot, path)), { code: "ENOENT" });
      }
    }
    return false;
  }
  const image = packaged
    ? process.env.REPOSITORY_CREDENTIALS_TEST_IMAGE
    : (process.env.REPOSITORY_CREDENTIALS_NODE_IMAGE ?? "node:24-bookworm");
  if (!image) {
    t.skip(
      "packaged qualification requires REPOSITORY_CREDENTIALS_TEST_IMAGE built from the delivered service/client artifacts",
    );
    return true;
  }
  const gh = process.env.REPOSITORY_CREDENTIALS_GH_BINARY ?? "/usr/bin/gh";
  if (!packaged) {
    await access(gh);
    const version = await run(gh, ["--version"]);
    assert.match(version.stdout, /^gh version 2\.103\.2\b/, "pinned gh 2.103.2 is required");
  }
  assert.ok(!image.startsWith("-"), "invalid qualification image reference");
  const inspected = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const imageId = inspected.stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/, "selected image must exist locally");
  const name = `repository-credentials-${randomBytes(8).toString("hex")}`;
  try {
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--add-host",
      "credentials.example.test:127.0.0.1",
      "--mount",
      packaged
        ? `type=bind,src=${join(repositoryRoot, "tests")},dst=/workspace/tests,readonly`
        : `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--env",
      "REPOSITORY_CREDENTIALS_CONTAINER_CHILD=1",
      "--env",
      "HOME=/tmp/client-home",
      "--entrypoint",
      "node",
    ];
    if (!packaged) {
      args.push("--mount", `type=bind,src=${gh},dst=/usr/local/bin/gh,readonly`);
    }
    if (packaged) {
      args.push("--env", "REPOSITORY_CREDENTIALS_APP_ROOT=/app/dist");
    }
    args.push(imageId, "--test", "--test-reporter=tap", testFile);
    const result = await run("docker", args, { timeout: 120000, allowFailure: true });
    // Child diagnostics are safe test names/statuses. Never copy command stdout
    // or provider response bodies into test failure messages.
    if (result.code !== 0) {
      t.diagnostic(result.stdout.replace(/(Bearer|token)\s+\S+/g, "$1 [redacted]"));
    }
    assert.equal(result.code, 0, "credential container acceptance failed");
    const counts = Object.fromEntries(
      [...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(
        ([, name, count]) => [name, Number(count)],
      ),
    );
    assert.ok(counts.tests > 0, "the selected container must run acceptance cases");
    for (const name of ["fail", "cancelled", "skipped", "todo"]) {
      assert.equal(counts[name], 0, `container qualification reported ${name}`);
    }
    t.diagnostic(JSON.stringify({ image: imageId, packaged, counts }));
  } finally {
    await run("docker", ["rm", "-f", name], { allowFailure: true });
  }
  return true;
}
