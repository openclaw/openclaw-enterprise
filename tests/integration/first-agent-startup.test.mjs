import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  firstAgentPriorPatPolicy,
  firstAgentPriorPatPolicyWarning,
  firstAgentRevisionValuesMatch,
} from "../../scripts/first-agent-model.mjs";
import { listen } from "../helpers/listen.mjs";
import { commandPath, writeCommand } from "../helpers/fake-commands.mjs";

const repository = await realpath(resolve(import.meta.dirname, "../.."));
const firstAgent = join(repository, "scripts", "first-agent.mjs");

async function fixture(t, sandboxDriver) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oce-first-agent-startup-"));
  const tools = join(directory, "tools");
  const engineLog = join(directory, "engine.log");
  const keyPath = join(directory, "initial-admin-service-key.json");
  await mkdir(tools, { mode: 0o700 });
  await Promise.all([
    writeCommand(
      tools,
      "docker",
      'printf "%s\\n" "$*" "DOCKER_HOST=$DOCKER_HOST" "DOCKER_TLS=${DOCKER_TLS-unset}" "DOCKER_TLS_VERIFY=${DOCKER_TLS_VERIFY-unset}" "DOCKER_CERT_PATH=${DOCKER_CERT_PATH-unset}" > "$FIRST_AGENT_TEST_ENGINE_LOG"\nprintf "controller container is unavailable\\033[31m\\n" >&2\nprintf "%9000s" "" >&2\nexit 23\n',
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
    PATH: commandPath(tools),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.OCC_SERVICE_KEY_FILE;
  delete env.OCC_URL;
  return { directory, engineLog, env };
}

function runFirstAgent(env, ...args) {
  const result = spawnSync(process.execPath, [firstAgent, "state-contract-test", ...args], {
    cwd: repository,
    encoding: "utf8",
    env,
    timeout: 10_000,
    maxBuffer: 16_384,
  });
  assert.equal(result.status, 1, result.error?.message);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(
    output,
    "",
    `first-Agent exited without diagnostics (signal ${result.signal ?? "none"})`,
  );
  return output;
}

test("first-Agent starts without installed workspace dependencies", async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oce-first-agent-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Run real sources outside the checkout so installed workspace packages cannot
  // hide import failures in the host-run command used by First Agent Smoke.
  for (const path of [
    "package.json",
    "scripts/first-agent.mjs",
    "scripts/first-agent-database.mjs",
    "scripts/first-agent-model.mjs",
    "apps/controller/src",
  ]) {
    await cp(join(repository, path), join(directory, path), { recursive: true });
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts/first-agent.mjs"), "--help"],
    {
      cwd: directory,
      encoding: "utf8",
      env,
      timeout: 10_000,
    },
  );

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/first-agent\.mjs/);
  assert.match(result.stdout, /--control-ui/);
});

test("first-Agent accepts current Compose-backed Kubernetes development state", async (t) => {
  const { engineLog, env } = await fixture(t, "none");
  env.DOCKER_HOST = "unix:///tmp/other-first-agent.sock";
  env.DOCKER_TLS = "1";
  env.DOCKER_TLS_VERIFY = "1";
  env.DOCKER_CERT_PATH = "/tmp/other-first-agent-certificates";

  // Reaching the engine proves state admission succeeded without replacing the
  // external Compose behavior that this focused test does not exercise.
  const output = runFirstAgent(env);
  assert.match(
    output,
    /docker did not complete successfully.*controller container is unavailable/s,
  );
  assert.match(output, /\[stderr truncated\]/);
  assert.ok(output.length < 9_000, "first-Agent should not echo unbounded subprocess stderr");
  assert.equal(
    output.includes(String.fromCharCode(27)),
    false,
    "stderr must not inject terminal controls",
  );
  const invocation = await readFile(engineLog, "utf8");
  assert.match(invocation, /compose .* port controller 3000/);
  assert.match(invocation, /^DOCKER_HOST=unix:\/\/\/tmp\/first-agent-startup-test.sock$/m);
  assert.match(invocation, /^DOCKER_TLS=unset$/m);
  assert.match(invocation, /^DOCKER_TLS_VERIFY=unset$/m);
  assert.match(invocation, /^DOCKER_CERT_PATH=unset$/m);
});

test("first-Agent requires dedicated Codex for OpenShell before external calls", async (t) => {
  const { engineLog, env } = await fixture(t, "openshell");

  assert.match(runFirstAgent(env), /OpenShell first-Agent workflow requires --harness codex/);
  await assert.rejects(readFile(engineLog), { code: "ENOENT" });
});

test("first-Agent recognizes the prior OpenShell PAT policy only on an identified revision", () => {
  const values = (sandbox, approvalsReviewer = "user") => ({
    plugins: { entries: { codex: { config: { appServer: { sandbox, approvalsReviewer } } } } },
  });
  const configured = values("read-only");
  const record = { harness: "codex", sandboxDriver: "openshell", authMethod: "codex_pat" };
  const matches = (snapshot, priorRevisionId) =>
    firstAgentRevisionValuesMatch(snapshot, configured, record, "rev_saved", priorRevisionId);

  const prior = values("workspace-write");
  assert.equal(matches(prior, "rev_saved"), true, "read the saved or active prior revision");
  assert.equal(matches(prior, "rev_other"), false, "do not adopt another obsolete revision");
  assert.equal(matches(prior), false, "a new deployment cannot freeze the obsolete policy");
  assert.equal(matches(values("danger-full-access")), true, "a new deployment uses current policy");
  assert.equal(
    matches(values("workspace-write", "auto_review"), "rev_saved"),
    false,
    "reviewer drift",
  );
  assert.equal(
    firstAgentRevisionValuesMatch(
      prior,
      configured,
      { ...record, authMethod: "api_key" },
      "rev_saved",
      "rev_saved",
    ),
    false,
    "the historical exception is exclusive to PAT revisions",
  );
  assert.equal(
    matches({ ...prior, tools: { allow: ["*"] } }, "rev_saved"),
    false,
    "the historical exception must retain unrelated configuration drift checks",
  );
  assert.deepEqual(prior, values("workspace-write"), "reading never rewrites a frozen revision");
  assert.deepEqual(configured, values("read-only"), "reading never rewrites configured settings");
});

test("first-Agent flags a prior OpenShell PAT revision and points at --replace-key", () => {
  const values = (sandbox) => ({
    plugins: {
      entries: { codex: { config: { appServer: { sandbox, approvalsReviewer: "user" } } } },
    },
  });
  const record = { harness: "codex", sandboxDriver: "openshell", authMethod: "codex_pat" };
  const prior = values("workspace-write");
  assert.equal(firstAgentPriorPatPolicy(prior, record, "rev_saved", "rev_saved"), true);
  for (const sandbox of ["danger-full-access", "read-only"]) {
    assert.equal(
      firstAgentPriorPatPolicy(values(sandbox), record, "rev_saved", "rev_saved"),
      false,
      sandbox,
    );
  }
  assert.equal(firstAgentPriorPatPolicy(prior, record, "rev_saved"), false, "a new deployment");
  assert.equal(firstAgentPriorPatPolicy(prior, record, "rev_saved", "rev_other"), false);
  assert.equal(
    firstAgentPriorPatPolicy(prior, { ...record, authMethod: "api_key" }, "rev_saved", "rev_saved"),
    false,
  );
  for (const other of [{ sandboxDriver: undefined }, { harness: "openclaw" }]) {
    assert.equal(
      firstAgentPriorPatPolicy(prior, { ...record, ...other }, "rev_saved", "rev_saved"),
      false,
      JSON.stringify(other),
    );
  }
  const warning = firstAgentPriorPatPolicyWarning("rev_saved");
  assert.match(warning, /rev_saved/);
  assert.match(warning, /workspace-write/);
  assert.match(warning, /shell tools fail/);
  assert.match(warning, /--replace-key/);
  assert.match(warning, /current sandbox mode \(danger-full-access/);
});

test("first-Agent admits dedicated Codex with OpenShell development state", async (t) => {
  const { engineLog, env } = await fixture(t, "openshell");

  assert.match(runFirstAgent(env, "--harness", "codex"), /docker did not complete successfully/);
  assert.match(await readFile(engineLog, "utf8"), /compose .* port controller 3000/);
});

test("first-Agent control UI requires the launcher-owned native admin endpoint", async (t) => {
  const { directory, engineLog, env } = await fixture(t, "openshell");

  assert.match(
    runFirstAgent(env, "--harness", "codex", "--control-ui"),
    /did not enable its durable native admin endpoint/,
  );
  await assert.rejects(readFile(engineLog), { code: "ENOENT" });

  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify({
      ...state,
      browserOrigin: "https://console.occ-dev-first-agent-test.oce.localhost:8443",
      nativeAdminDomain: "agents.occ-dev-first-agent-test.oce.localhost",
    })}\n`,
    { mode: 0o600 },
  );
  assert.match(
    runFirstAgent(env, "--harness", "codex", "--control-ui"),
    /docker did not complete successfully/,
  );
  assert.match(await readFile(engineLog, "utf8"), /compose .* port controller 3000/);
});

test("first-Agent admits a native admin origin on the default HTTPS port", async (t) => {
  const { directory, engineLog, env } = await fixture(t, "openshell");
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  const host = "console.occ-dev-first-agent-test.oce.localhost";
  // The canonical origin current Local Setup records for port 443, the explicit
  // :443 form older Local Setup recorded, and forms that are still refused.
  for (const [browserOrigin, admitted] of [
    [`https://${host}`, true],
    [`https://${host}:443`, true],
    [`https://${host}:443/`, false],
    [`https://${host}/`, false],
    [`https://${host}:0443`, false],
  ]) {
    await rm(engineLog, { force: true });
    await writeFile(
      join(directory, "state.json"),
      `${JSON.stringify({
        ...state,
        browserOrigin,
        nativeAdminDomain: "agents.occ-dev-first-agent-test.oce.localhost",
      })}\n`,
      { mode: 0o600 },
    );
    const output = runFirstAgent(env, "--harness", "codex", "--control-ui");
    if (admitted) {
      assert.match(output, /docker did not complete successfully/, browserOrigin);
    } else {
      assert.match(output, /native admin endpoint is invalid/, browserOrigin);
      await assert.rejects(readFile(engineLog), { code: "ENOENT" });
    }
  }
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
  await listen(t, server);
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
  await writeCommand(
    join(directory, "tools"),
    "kubectl",
    `case "$*" in
  *" config view "*) printf '%s' '${JSON.stringify({
    "current-context": context,
    clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }],
  })}' ;;
  *" exec "*) printf "%s\\n" "$*" > "$FIRST_AGENT_TEST_ENGINE_LOG"; exit 23 ;;
  *) exit 64 ;;
esac
`,
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
