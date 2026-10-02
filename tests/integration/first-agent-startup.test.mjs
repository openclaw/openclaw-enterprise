import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
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
  return { directory, engineLog, env };
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

test("first-Agent runs psql through the k3d PostgreSQL StatefulSet", async (t) => {
  const { directory, engineLog, env } = await fixture(t, "none");
  const server = createServer((request, response) => {
    const data = {
      "/installation": { id: "ins_test" },
      "/namespaces": [{ id: "ns_test", name: "default" }],
      "/namespaces/ns_test": { id: "ns_test", status: "ready" },
      "/namespaces/ns_test/agents": [],
    }[request.url];
    response.writeHead(data === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(data === undefined ? { error: { code: "NOT_FOUND" } } : { data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify({
      ...state,
      deploymentMode: "k3d",
      composeProject: "",
      platformNamespace: "occ-system",
      apiPort: server.address().port,
    })}\n`,
    { mode: 0o600 },
  );
  const context = "k3d-occ-dev-first-agent-test";
  await writeFile(
    join(directory, "tools", "kubectl"),
    `#!/bin/sh
case "$*" in
  *" config view "*) printf '%s' '${JSON.stringify({
    "current-context": context,
    clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }],
  })}' ;;
  *" exec "*) printf "%s\\n" "$*" > "$FIRST_AGENT_TEST_ENGINE_LOG"; exit 23 ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o700 },
  );

  // spawnSync would block this process's fake controller, so wait asynchronously.
  const child = spawn(process.execPath, [firstAgent, "state-contract-test"], {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [status] = await once(child, "close");

  assert.equal(status, 1, output);
  assert.match(output, /kubectl did not complete successfully \(exit 23\)/);
  assert.match(
    await readFile(engineLog, "utf8"),
    new RegExp(
      `^--kubeconfig \\S+ --context ${context} -n occ-system exec -i statefulset/postgres -c postgres -- psql `,
    ),
  );
});
