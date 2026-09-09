// Opt-in real SSH, systemd and OpenClaw gateway proof on a disposable Linux host.
// Exercises readiness and revision/state lifecycle only; no model turn is required or proved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { SystemSshCommandExecutor } from "../../apps/controller/src/drivers/compute/ssh/executor.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { sha256Hex } from "../../packages/utils/src/index.ts";

const requiredNames = [
  "OCC_TEST_SSH_ADDRESS",
  "OCC_TEST_SSH_PORT",
  "OCC_TEST_SSH_USER",
  "OCC_TEST_SSH_IDENTITY_FILE",
  "OCC_TEST_SSH_KNOWN_HOSTS_FILE",
  "OCC_TEST_SSH_NODE_PATH",
  "OCC_TEST_SSH_OPENCLAW_PATH",
  "OCC_TEST_SSH_RUNTIME_USER",
];
const selected = process.env.OCC_TEST_SSH_REAL === "1";
const skip = selected
  ? false
  : `Set OCC_TEST_SSH_REAL=1 plus ${requiredNames.join(", ")} to run real SSH host proof; OCC_TEST_SSH_ROOT and OCC_TEST_SSH_UNIT_DIRECTORY are optional.`;

const INSPECT = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const input = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}
(async () => {
  if (input.operation === "deleted") {
    const active = spawnSync("systemctl", ["is-active", "--quiet", input.unit]);
    return { directoryExists: fs.existsSync(input.namespaceDir), unitExists: fs.existsSync(input.unitPath), active: active.status === 0 };
  }
  if (input.operation === "marker") {
    const agent = readJson(input.agentDir + "/agent.json");
    const written = output("runuser", [
      "-u",
      agent.runtimeUser,
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 })",
      input.agentDir + "/state/proof-marker",
      input.marker,
    ]);
    return { written: written.status === 0 };
  }
  if (input.operation === "isolation") {
    const first = readJson(input.agentDir + "/agent.json");
    const sibling = readJson(input.siblingAgentDir + "/agent.json");
    const firstUid = output("id", ["-u", first.runtimeUser]);
    const firstGid = output("id", ["-g", first.runtimeUser]);
    const siblingUid = output("id", ["-u", sibling.runtimeUser]);
    const siblingGid = output("id", ["-g", sibling.runtimeUser]);
    const ownState = output("runuser", ["-u", first.runtimeUser, "--", "cat", input.agentDir + "/state/proof-marker"]);
    const ownConfig = output("runuser", ["-u", sibling.runtimeUser, "--", "cat", input.siblingAgentDir + "/current/openclaw.json"]);
    const foreignState = output("runuser", ["-u", sibling.runtimeUser, "--", "cat", input.agentDir + "/state/proof-marker"]);
    const foreignConfig = output("runuser", ["-u", sibling.runtimeUser, "--", "cat", input.agentDir + "/current/openclaw.json"]);
    return {
      firstUser: first.runtimeUser, siblingUser: sibling.runtimeUser,
      firstUid: firstUid.stdout, firstGid: firstGid.stdout,
      siblingUid: siblingUid.stdout, siblingGid: siblingGid.stdout,
      ownStateReadable: ownState.status === 0,
      ownConfigReadable: ownConfig.status === 0,
      foreignStateReadable: foreignState.status === 0,
      foreignConfigReadable: foreignConfig.status === 0,
    };
  }
  const agent = readJson(input.agentDir + "/agent.json");
  const active = spawnSync("systemctl", ["is-active", "--quiet", input.unit]);
  const response = await fetch("http://127.0.0.1:" + agent.port + "/readyz", { signal: AbortSignal.timeout(5000), redirect: "error" });
  await response.body?.cancel();
  return {
    current: fs.readlinkSync(input.agentDir + "/current"), active: active.status === 0,
    readyStatus: response.status,
    marker: fs.existsSync(input.agentDir + "/state/proof-marker") ? fs.readFileSync(input.agentDir + "/state/proof-marker", "utf8") : null,
    oldRevisionExists: fs.existsSync(input.oldRevisionDir),
  };
})().then((result) => process.stdout.write(JSON.stringify(result) + "\n")).catch(() => {
  process.stderr.write("SSH host verification failed.\n"); process.exitCode = 1;
});
`;

test(
  "real SSH host prepares, cuts over, preserves state, retires and deletes an embedded OpenClaw Agent",
  { skip, timeout: 600_000 },
  async () => {
    for (const name of requiredNames)
      assert.ok(process.env[name]?.trim(), `${name} is required when OCC_TEST_SSH_REAL=1.`);
    const host = {
      address: process.env.OCC_TEST_SSH_ADDRESS,
      port: Number(process.env.OCC_TEST_SSH_PORT),
      user: process.env.OCC_TEST_SSH_USER,
    };
    const ssh = {
      identityFile: process.env.OCC_TEST_SSH_IDENTITY_FILE,
      knownHostsFile: process.env.OCC_TEST_SSH_KNOWN_HOSTS_FILE,
      connectTimeoutSeconds: 10,
    };
    const runtime = {
      nodePath: process.env.OCC_TEST_SSH_NODE_PATH,
      openclawPath: process.env.OCC_TEST_SSH_OPENCLAW_PATH,
      user: process.env.OCC_TEST_SSH_RUNTIME_USER,
      root: process.env.OCC_TEST_SSH_ROOT ?? "/var/lib/openclaw-enterprise",
      systemdUnitDirectory: process.env.OCC_TEST_SSH_UNIT_DIRECTORY ?? "/etc/systemd/system",
    };
    const driver = new SshComputeDriver({
      ssh,
      hosts: { "ssh-proof": host },
      runtime,
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    });
    const namespace = {
      id: `ns-${randomUUID()}`,
      name: "ssh-proof",
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const agentId = `agent-${randomUUID()}`;
    const siblingAgentId = `agent-${randomUUID()}`;
    const configuration = admitLoggingConfiguration(
      {
        gateway: {
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        agents: {
          defaults: {
            skipBootstrap: true,
            model: "openai/gpt-5.6-sol",
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      "info",
    );
    const first = {
      id: `revision-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId,
      revision: 1,
      providerId: null,
      configurationId: `cfg-${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration,
      harness: { id: "openclaw", version: "2026.7.1", mode: "embedded" },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: `sp-${randomUUID()}`,
      createdAt: namespace.createdAt,
    };
    const second = {
      ...first,
      id: `revision-${randomUUID()}`,
      revision: 2,
      configurationGeneration: 2,
      configuration: admitLoggingConfiguration(
        {
          ...configuration,
          agents: { defaults: { ...configuration.agents.defaults, timeoutSeconds: 90 } },
        },
        "info",
      ),
    };
    const sibling = {
      ...first,
      id: `revision-${randomUUID()}`,
      agentId: siblingAgentId,
      configurationId: `cfg-${randomUUID()}`,
      servicePrincipalId: `sp-${randomUUID()}`,
    };
    const namespaceDir = `${runtime.root}/namespaces/${sha256Hex(namespace.id, 12)}`;
    const agentDir = `${namespaceDir}/agents/${sha256Hex(agentId, 12)}`;
    const siblingAgentDir = `${namespaceDir}/agents/${sha256Hex(siblingAgentId, 12)}`;
    const unit = `openclaw-enterprise-gateway-${sha256Hex(agentId, 12)}.service`;
    const siblingUnit = `openclaw-enterprise-gateway-${sha256Hex(siblingAgentId, 12)}.service`;
    const executor = new SystemSshCommandExecutor();
    const inspect = async (operation, extra = {}) => {
      const result = await executor.execute({
        ...host,
        ...ssh,
        nodePath: runtime.nodePath,
        helper: INSPECT,
        operation: Buffer.from(
          JSON.stringify({
            operation,
            agentDir,
            siblingAgentDir,
            namespaceDir,
            unit,
            unitPath: `${runtime.systemdUnitDirectory}/${unit}`,
            oldRevisionDir: `${agentDir}/revisions/${sha256Hex(first.id, 12)}`,
            ...extra,
          }),
        ).toString("base64"),
        timeoutMs: 30_000,
      });
      assert.equal(result.code, 0, "Real SSH host inspection must succeed.");
      return JSON.parse(result.stdout);
    };
    await driver.preflight();
    try {
      assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
      // The worker binds server-owned Agent identity after Namespace readiness on every operation.
      namespace.status = "ready";
      const binding = {
        namespace,
        agent: {
          id: agentId,
          namespaceId: namespace.id,
          name: "SSH proof",
          configurationId: first.configurationId,
          providerId: null,
          executionMode: "embedded",
          servicePrincipalId: first.servicePrincipalId,
          createdAt: namespace.createdAt,
        },
      };
      driver.bindAgent(binding);
      assert.equal((await driver.prepareRevision(first, { secretEnvironment: [] })).ready, true);
      await driver.activateRevision(first);
      const observedFirst = await inspect("inspect");
      assert.equal(observedFirst.current, `revisions/${sha256Hex(first.id, 12)}`);
      assert.equal(observedFirst.active, true);
      assert.equal(observedFirst.readyStatus, 200);
      const marker = randomUUID();
      assert.deepEqual(await inspect("marker", { marker }), { written: true });
      driver.bindAgent({
        namespace,
        agent: {
          id: siblingAgentId,
          namespaceId: namespace.id,
          name: "SSH sibling proof",
          configurationId: sibling.configurationId,
          providerId: null,
          executionMode: "embedded",
          servicePrincipalId: sibling.servicePrincipalId,
          createdAt: namespace.createdAt,
        },
      });
      assert.equal((await driver.prepareRevision(sibling, { secretEnvironment: [] })).ready, true);
      await driver.activateRevision(sibling);
      const isolation = await inspect("isolation", { siblingUnit });
      assert.notEqual(isolation.firstUser, isolation.siblingUser);
      assert.notEqual(isolation.firstUid, isolation.siblingUid);
      assert.notEqual(isolation.firstGid, isolation.siblingGid);
      assert.equal(isolation.ownStateReadable, true);
      assert.equal(isolation.ownConfigReadable, true);
      assert.equal(isolation.foreignStateReadable, false);
      assert.equal(isolation.foreignConfigReadable, false);
      driver.bindAgent(binding);
      assert.equal((await driver.prepareRevision(second, { secretEnvironment: [] })).ready, true);
      await driver.activateRevision(second);
      // A changed admitted snapshot restarts this Agent while its writable state remains intact.
      const cutover = await inspect("inspect");
      assert.equal(cutover.current, `revisions/${sha256Hex(second.id, 12)}`);
      assert.equal(cutover.active, true);
      assert.equal(cutover.readyStatus, 200);
      assert.equal(cutover.marker, marker);
      assert.equal(cutover.oldRevisionExists, true);
      driver.bindAgent(binding);
      await driver.retireRevision(first);
      const retired = await inspect("inspect");
      assert.equal(retired.oldRevisionExists, false);
      assert.equal(retired.active, true);
      assert.equal(retired.marker, marker);
    } finally {
      assert.equal((await driver.deleteNamespace(namespace)).namespaceDeleted, true);
    }
    assert.deepEqual(await inspect("deleted"), {
      directoryExists: false,
      unitExists: false,
      active: false,
    });
  },
);
