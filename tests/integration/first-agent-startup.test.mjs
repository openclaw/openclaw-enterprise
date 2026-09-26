import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = await realpath(resolve(import.meta.dirname, "../.."));
const firstAgent = join(repository, "scripts", "first-agent.mjs");

async function fixture(t, sandboxDriver) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oce-first-agent-startup-"));
  const tools = join(directory, "tools");
  const engineLog = join(directory, "engine.log");
  const keyPath = join(directory, "initial-admin-service-key.json");
  await mkdir(tools, { mode: 0o700 });
  await Promise.all([
    writeFile(
      join(tools, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$FIRST_AGENT_TEST_ENGINE_LOG"\nexit 23\n',
      { mode: 0o700 },
    ),
    writeFile(join(directory, ".openclaw-development"), "openclaw-enterprise-development-v3\n", {
      mode: 0o600,
    }),
    writeFile(
      join(directory, "state.json"),
      `${JSON.stringify({
        version: 3,
        repository,
        computeDriver: "kubernetes",
        sandboxDriver,
        containerEngine: "docker",
        composeProject: "first-agent-startup-test",
        cluster: "occ-dev-first-agent-test",
        dockerHost: "unix:///tmp/first-agent-startup-test.sock",
        keyPath,
        keyOwned: true,
      })}\n`,
      { mode: 0o600 },
    ),
    writeFile(join(directory, "compose.yaml"), "services: {}\n", { mode: 0o600 }),
    writeFile(join(directory, "kubeconfig"), "{}\n", { mode: 0o600 }),
    writeFile(
      keyPath,
      `${JSON.stringify({
        data: { key: "test-service-key", servicePrincipalId: "sp_test" },
        meta: { installationId: "ins_test" },
      })}\n`,
      { mode: 0o600 },
    ),
  ]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    FIRST_AGENT_TEST_ENGINE_LOG: engineLog,
    OCC_DEVELOPMENT_STATE_DIRECTORY: directory,
    PATH: `${tools}:${process.env.PATH}`,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.OCC_SERVICE_KEY_FILE;
  delete env.OCC_URL;
  return { engineLog, env };
}

function runFirstAgent(env) {
  const result = spawnSync(process.execPath, [firstAgent, "state-contract-test"], {
    cwd: repository,
    encoding: "utf8",
    env,
    timeout: 10_000,
    maxBuffer: 16_384,
  });
  assert.equal(result.status, 1, result.error?.message);
  return `${result.stdout}${result.stderr}`;
}

test("first-Agent accepts current Compose-backed Kubernetes development state", async (t) => {
  const { engineLog, env } = await fixture(t, "none");

  // Reaching the engine proves state admission succeeded without replacing the
  // external Compose behavior that this focused test does not exercise.
  assert.match(runFirstAgent(env), /docker did not complete successfully/);
  assert.match(await readFile(engineLog, "utf8"), /compose .* port controller 3000/);
});

test("first-Agent rejects OpenShell development state before external calls", async (t) => {
  const { engineLog, env } = await fixture(t, "openshell");

  assert.match(
    runFirstAgent(env),
    /does not support the OpenShell Sandbox Driver.*OCC_DEVELOPMENT_SANDBOX_DRIVER=none/,
  );
  await assert.rejects(readFile(engineLog), { code: "ENOENT" });
});
