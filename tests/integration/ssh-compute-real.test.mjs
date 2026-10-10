import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
// Opt-in real SSH, systemd and OpenClaw gateway proof on a disposable Linux host.
// OCC_TEST_SSH_MODEL also verifies real provider calls and runtime-owned credential behavior.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { SystemSshCommandExecutor } from "../../apps/controller/src/drivers/compute/ssh/executor.ts";
import {
  admitLoggingConfiguration,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/index.ts";
import { sha256Hex } from "../../packages/utils/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

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
const modelProof = process.env.OCC_TEST_SSH_MODEL === "1";
const selected = process.env.OCC_TEST_SSH_REAL === "1" || modelProof;
const skip = selected
  ? false
  : `Set OCC_TEST_SSH_REAL=1 plus ${requiredNames.join(", ")} to run real SSH host proof; OCC_TEST_SSH_ROOT and OCC_TEST_SSH_UNIT_DIRECTORY are optional.`;

const INSPECT = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const input = JSON.parse(Buffer.from(SSH_OPERATION, "base64").toString("utf8"));
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
  if (input.operation.startsWith("workspace-failure-")) {
    const agent = readJson(input.agentDir + "/agent.json");
    const state = input.agentDir + "/state";
    const workspace = state + "/workspace";
    const userFile = workspace + "/USER.md";
    const stockFile = state + "/proof-user-stock.md";
    const configPath = state + "/proof-setup.json";
    if (input.operation === "workspace-failure-seed") {
      const runtimeOwner = fs.statSync(state);
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { defaults: { workspace }, entries: { main: {} } }, gateway: { mode: "local" },
      }), { mode: 0o600 });
      fs.chownSync(configPath, runtimeOwner.uid, runtimeOwner.gid);
      const native = spawnSync("runuser", ["--user", agent.runtimeUser, "--", process.execPath,
        input.executable, "setup", "--baseline", "--workspace", workspace], {
        env: { ...process.env, HOME: input.agentDir + "/home", OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath },
        cwd: state, encoding: "utf8", timeout: 120000,
      });
      if (native.status !== 0) throw new Error("Native baseline setup failed.");
      const owner = fs.statSync(userFile);
      fs.copyFileSync(userFile, stockFile);
      fs.chownSync(stockFile, owner.uid, owner.gid);
      if (output("mount", ["--bind", stockFile, userFile]).status !== 0) {
        throw new Error("Disposable workspace bind mount failed.");
      }
      return { seeded: true };
    }
    if (input.operation === "workspace-failure-recover") {
      if (output("mountpoint", ["-q", userFile]).status === 0 &&
          output("umount", [userFile]).status !== 0) throw new Error("Workspace unmount failed.");
      if (fs.existsSync(stockFile)) {
        fs.writeFileSync(userFile, input.divergentContent ?? fs.readFileSync(stockFile));
        if (input.divergentContent === undefined) {
          fs.unlinkSync(stockFile);
          fs.rmSync(configPath, { force: true });
        }
      }
      return { recovered: true };
    }
    const uid = fs.statSync(workspace).uid;
    const runtimeProcess = fs.readdirSync("/proc").some((pid) => {
      if (!/^[0-9]+$/.test(pid)) return false;
      try { return fs.statSync("/proc/" + pid).uid === uid; }
      catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
    });
    const listener = await new Promise((resolve) => {
      const socket = require("node:net").connect(agent.port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", (error) => resolve(error.code));
      socket.setTimeout(1000, () => { socket.destroy(); resolve("timeout"); });
    });
    return {
      filesMatch: Object.entries(input.files).every(([name, content]) => fs.readFileSync(workspace + "/" + name, "utf8") === content),
      userIsStock: fs.readFileSync(userFile, "utf8") === fs.readFileSync(stockFile, "utf8"),
      markerExists: fs.existsSync(workspace + "/.oce-workspace-setup.json"),
      metadataExists: fs.existsSync(input.agentDir + "/workspace-setup.json"),
      currentExists: fs.existsSync(input.agentDir + "/current"),
      unitExists: fs.existsSync(input.unitPath), runtimeProcess, listener,
    };
  }
  if (input.operation === "workspace") {
    const workspace = input.agentDir + "/state/workspace";
    const metadata = readJson(input.agentDir + "/workspace-setup.json");
    const active = spawnSync("systemctl", ["is-active", "--quiet", input.unit]).status === 0;
    return {
      matches: Object.entries(input.files).every(([name, content]) => fs.readFileSync(workspace + "/" + name, "utf8") === content),
      git: fs.existsSync(workspace + "/.git"),
      metadataOnly: metadata.completed === true && !Object.hasOwn(metadata, "files") && metadata.defaultsId === input.defaultsId,
      active,
    };
  }
  if (input.operation === "workspace-edit") {
    const agent = readJson(input.agentDir + "/agent.json");
    const result = spawnSync("runuser", ["--user", agent.runtimeUser, "--", process.execPath, "-"], {
      input: "require('node:fs').writeFileSync(" + JSON.stringify(input.agentDir + "/state/workspace/AGENTS.md") + "," + JSON.stringify(input.content) + ")",
      encoding: "utf8",
    });
    return { edited: result.status === 0 };
  }
  if (input.operation === "workspace-guard") {
    const marker = input.agentDir + "/state/workspace/.oce-workspace-setup.json";
    const saved = marker + ".proof-backup";
    output("systemctl", ["stop", input.unit]);
    fs.renameSync(marker, saved);
    try {
      const started = spawnSync("systemctl", ["start", input.unit], { timeout: 15000, encoding: "utf8" });
      const active = spawnSync("systemctl", ["is-active", "--quiet", input.unit]);
      return { refused: started.status !== 0, active: active.status === 0 };
    } finally {
      output("systemctl", ["stop", input.unit]);
      fs.renameSync(saved, marker);
      output("systemctl", ["reset-failed", input.unit]);
    }
  }
  if (input.operation === "env-state") {
    const contents = fs.readFileSync(input.agentDir + "/env");
    const stat = fs.statSync(input.agentDir + "/env");
    return { digest: require("node:crypto").createHash("sha256").update(contents).digest("hex"), mode: stat.mode & 511, ino: stat.ino, mtimeMs: stat.mtimeMs };
  }
  if (input.operation === "meter") return readJson(input.namespaceDir + "/provider-meter.json");
  if (input.operation === "stop-meter") {
    process.kill(readJson(input.namespaceDir + "/provider-meter.json").pid, "SIGTERM");
    return { stopped: true };
  }
  const agent = readJson(input.agentDir + "/agent.json");
  if (input.operation === "model") {
    const password = fs.readFileSync(input.agentDir + "/gateway-password.env", "utf8").trim().split("=")[1];
    const response = await fetch("http://127.0.0.1:" + agent.port + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + password },
      body: JSON.stringify({ model: "openclaw/default", messages: [{ role: "user", content: "Reply with READY. Do not use tools." }], stream: false, max_tokens: 32 }),
      signal: AbortSignal.timeout(180000),
    });
    const body = await response.json();
    return { status: response.status, modelReply: response.ok && typeof body.choices?.[0]?.message?.content === "string" && body.choices[0].message.content.trim().length > 0 };
  }
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
  "real SSH unit directory supports stop, restart and scoped deletion",
  { skip, timeout: 600_000 },
  async () => {
    for (const name of requiredNames) {
      assert.ok(process.env[name]?.trim(), `${name} is required when OCC_TEST_SSH_REAL=1.`);
    }
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
      hosts: { "ssh-unit-proof": host },
      runtime,
      network: { gatewayPortRange: { start: 18910, end: 18919 } },
    });
    const namespace = {
      id: `ns-${randomUUID()}`,
      name: "ssh-unit-proof",
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    const configuration = createHarnessConfiguration("openclaw", defaultAgentModel);
    configuration.gateway.bind = "loopback";
    configuration.models.providers.openai.baseUrl = "http://127.0.0.1:9/v1";
    const executor = new SystemSshCommandExecutor();
    const remote = async (helper) => {
      const result = await executor.execute({
        ...host,
        ...ssh,
        nodePath: runtime.nodePath,
        helper,
        operation: "",
        timeoutMs: 30_000,
      });
      assert.equal(result.code, 0, "Real SSH lifecycle inspection must succeed.");
      return JSON.parse(result.stdout);
    };
    const agents = Array.from({ length: 2 }, () => ({
      id: `agent-${randomUUID()}`,
      namespaceId: namespace.id,
      name: "SSH unit proof",
      configurationId: `cfg-${randomUUID()}`,
      backendId: null,
      executionMode: "embedded",
      servicePrincipalId: `sp-${randomUUID()}`,
      createdAt: namespace.createdAt,
    }));
    const revisions = agents.map((agent) => ({
      id: `revision-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: agent.id,
      revision: 1,
      backendId: null,
      harnessAuth: { method: "runtime" },
      configurationId: agent.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: admitLoggingConfiguration(configuration, "info"),
      harness: { id: "openclaw", version: "2026.9.1", mode: "embedded" },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt: namespace.createdAt,
    }));
    const namespaceDir = `${runtime.root}/namespaces/${sha256Hex(namespace.id, 12)}`;
    const inspect = async (agent) =>
      remote(`
    const fs = require("node:fs"), cp = require("node:child_process");
    const dir = ${JSON.stringify(namespaceDir + "/agents/")} + ${JSON.stringify(sha256Hex(agent.id, 12))};
      const unit = ${JSON.stringify(`openclaw-enterprise-gateway-${sha256Hex(agent.id, 12)}.service`)};
      const active = cp.spawnSync("systemctl", ["is-active", "--quiet", unit]).status === 0;
      const account = cp.spawnSync("getent", ["passwd", ${JSON.stringify(`${runtime.user.slice(0, 19)}-${sha256Hex(`${namespace.id}:${agent.id}`, 12)}`)}]).status === 0;
    (async () => {
      let readyStatus = null;
      if (active) { const data = JSON.parse(fs.readFileSync(dir + "/agent.json")); const response = await fetch("http://127.0.0.1:" + data.port + "/readyz", { signal: AbortSignal.timeout(5000) }); readyStatus = response.status; await response.body?.cancel(); }
      console.log(JSON.stringify({ active, readyStatus, account, directory: fs.existsSync(dir), unit: fs.existsSync(${JSON.stringify(runtime.systemdUnitDirectory + "/")} + unit), namespace: fs.existsSync(${JSON.stringify(namespaceDir)}) }));
    })().catch(() => process.exitCode = 1);
  `);
    await driver.preflight();
    let failed = false;
    try {
      assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
      for (let index = 0; index < agents.length; index++) {
        driver.bindAgent({ namespace, agent: agents[index] });
        assert.equal(
          (await driver.prepareRevision(revisions[index], { secretEnvironment: [] })).ready,
          true,
        );
        await driver.activateRevision(revisions[index], { secretEnvironment: [] });
        assert.equal((await inspect(agents[index])).readyStatus, 200);
      }
      const [first, sibling] = agents;
      driver.bindAgent({ namespace, agent: first });
      await driver.stopRevision(revisions[0]);
      await driver.stopRevision(revisions[0]);
      assert.equal((await inspect(first)).active, false);
      assert.equal((await inspect(sibling)).readyStatus, 200);
      await driver.activateRevision(revisions[0], { secretEnvironment: [] });
      assert.equal((await inspect(first)).readyStatus, 200);
      await driver.deactivateRevision(revisions[0]);
      await driver.retireRevision(revisions[0]);
      await driver.retireRevision(revisions[0]);
      await driver.deleteAgentRuntimeCredentials({ namespace, agent: first });
      await driver.deleteAgentRuntimeCredentials({ namespace, agent: first });
      assert.deepEqual(await inspect(first), {
        active: false,
        readyStatus: null,
        account: false,
        directory: false,
        unit: false,
        namespace: true,
      });
      assert.equal((await inspect(sibling)).readyStatus, 200);
      assert.equal((await driver.deleteNamespace(namespace)).namespaceDeleted, true);
      assert.deepEqual(await inspect(sibling), {
        active: false,
        readyStatus: null,
        account: false,
        directory: false,
        unit: false,
        namespace: false,
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const deleted = await driver.deleteNamespace(namespace);
      if (!failed) {
        assert.equal(deleted.namespaceDeleted, true);
      }
    }
  },
);

test(
  modelProof
    ? "real SSH runtime credentials allow model turns, skip deployment probes, and preserve host env on failed-auth readiness, redeploy and stop"
    : "real SSH host prepares, cuts over, preserves state, retires and deletes an embedded OpenClaw Agent",
  { skip, timeout: 600_000 },
  async () => {
    for (const name of requiredNames) {
      assert.ok(process.env[name]?.trim(), `${name} is required when OCC_TEST_SSH_REAL=1.`);
    }
    const model = process.env.OCC_TEST_OPENAI_MODEL || defaultAgentModel;
    let providerKey;
    if (modelProof) {
      assert.ok(
        process.env.OCC_TEST_OPENAI_API_KEY_FILE,
        "OCC_TEST_OPENAI_API_KEY_FILE is required for model proof.",
      );
      providerKey = (await readFile(process.env.OCC_TEST_OPENAI_API_KEY_FILE, "utf8")).trim();
      assert.ok(/^[^\s\0]+$/.test(providerKey), "Expected one nonempty API key.");
      // Establish credential availability separately from the deployment/no-probe assertion.
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${providerKey}` },
        body: JSON.stringify({ model, input: "Reply READY", max_output_tokens: 16 }),
        signal: AbortSignal.timeout(60000),
      });
      await response.body?.cancel();
      assert.equal(
        response.status,
        200,
        "Provider credential/model must work before SSH deployment proof.",
      );
    }
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
          http: { endpoints: { chatCompletions: { enabled: true } } },
        },
        agents: {
          defaults: {
            skipBootstrap: true,
            model: `openai/${model}`,
            models: { [`openai/${model}`]: { agentRuntime: { id: "openclaw" } } },
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
      backendId: null,
      harnessAuth: { method: "runtime" },
      configurationId: `cfg-${randomUUID()}`,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration,
      harness: { id: "openclaw", version: "2026.9.1", mode: "embedded" },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: `sp-${randomUUID()}`,
      createdAt: namespace.createdAt,
    };
    const setup = {
      id: `setup-${randomUUID()}`,
      namespaceId: namespace.id,
      agentId,
      defaultsId: WORKSPACE_DEFAULTS_ID,
      files: { "AGENTS.md": "# SSH setup proof\r\nPrivate setup instructions.\r\n", "USER.md": "" },
      completed: false,
    };
    const setupContext = {
      harnessAuth: { method: "runtime" },
      secretEnvironment: [],
      workspaceSetup: setup,
    };
    const completedContext = {
      ...setupContext,
      workspaceSetup: { ...setup, files: undefined, completed: true },
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
    const remote = async (helper, operation = "", timeoutMs = 30000) => {
      const result = await executor.execute({
        ...host,
        ...ssh,
        nodePath: runtime.nodePath,
        helper,
        operation,
        timeoutMs,
      });
      assert.equal(result.code, 0, "Remote operator test action must succeed.");
      return result.stdout;
    };
    const provision = async (value) => {
      // The key travels in SSH stdin, never process argv, logs, or revision metadata.
      await remote(
        `require("node:fs").writeFileSync(${JSON.stringify(agentDir + "/env")}, ${JSON.stringify("OPENAI_API_KEY=" + value + "\n")}, {mode: 0o600});`,
      );
    };
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
        timeoutMs:
          operation === "workspace-failure-seed"
            ? 150_000
            : operation === "model"
              ? 190_000
              : 30_000,
      });
      assert.equal(result.code, 0, "Real SSH host inspection must succeed.");
      return JSON.parse(result.stdout);
    };
    await driver.preflight();
    let meterStarted = false;
    let partialWriteSeeded = false;
    try {
      assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
      if (modelProof) {
        // Count real provider traffic without replacing the provider. Both successful
        // and rejected credentials are forwarded to the actual OpenAI endpoint.
        const meterPath = `${namespaceDir}/provider-meter.json`;
        const meterScript = `const fs=require("node:fs"),http=require("node:http");
          const state={pid:process.pid,count:0,port:0};
          const save=()=>fs.writeFileSync(${JSON.stringify(meterPath)},JSON.stringify(state));
          const server=http.createServer(async(req,res)=>{
            state.count++;save();
            try {
              const chunks=[];for await(const chunk of req)chunks.push(chunk);
              const upstream=await fetch("https://api.openai.com"+req.url,{method:req.method,headers:{"content-type":"application/json",authorization:req.headers.authorization},body:Buffer.concat(chunks),signal:AbortSignal.timeout(150000)});
              res.writeHead(upstream.status,{"content-type":upstream.headers.get("content-type")||"application/json"});
              for await(const chunk of upstream.body)res.write(chunk);res.end();
            } catch {res.writeHead(502);res.end();}
          });server.listen(0,"127.0.0.1",()=>{state.port=server.address().port;save();});`;
        await remote(
          `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(meterScript)}],{detached:true,stdio:"ignore"});child.unref();`,
        );
        meterStarted = true;
        let meter;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            meter = await inspect("meter");
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.ok(meter?.port, "Provider traffic meter must be listening.");
        const models = {
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${meter.port}/v1`,
              api: "openai-responses",
              models: [{ id: model, name: model }],
            },
          },
        };
        first.configuration = admitLoggingConfiguration({ ...first.configuration, models }, "info");
        second.configuration = admitLoggingConfiguration(
          { ...second.configuration, models },
          "info",
        );
      }
      // The worker binds server-owned Agent identity after Namespace readiness on every operation.
      namespace.status = "ready";
      const binding = {
        namespace,
        agent: {
          id: agentId,
          namespaceId: namespace.id,
          name: "SSH proof",
          configurationId: first.configurationId,
          backendId: null,
          executionMode: "embedded",
          servicePrincipalId: first.servicePrincipalId,
          createdAt: namespace.createdAt,
        },
      };
      driver.bindAgent(binding);
      // An incompatible preview must not install a runnable service or admit first use.
      await assert.rejects(
        driver.prepareRevision(first, {
          ...setupContext,
          workspaceSetup: { ...setup, defaultsId: "0".repeat(64) },
        }),
      );
      // A real bind mount permits native reads but refuses replacement of the second
      // supplied file. The first atomic write must survive without opening execution.
      partialWriteSeeded = true;
      assert.deepEqual(
        await inspect("workspace-failure-seed", { executable: runtime.openclawPath }),
        { seeded: true },
      );
      await assert.rejects(driver.prepareRevision(first, setupContext));
      const inactiveSetup = {
        filesMatch: true,
        userIsStock: true,
        markerExists: false,
        metadataExists: false,
        currentExists: false,
        unitExists: false,
        runtimeProcess: false,
        listener: "ECONNREFUSED",
      };
      assert.deepEqual(
        await inspect("workspace-failure-inspect", {
          files: { "AGENTS.md": setup.files["AGENTS.md"] },
        }),
        inactiveSetup,
      );
      // A subsequent user edit must fail closed rather than be overwritten on retry.
      const divergentUser = "User-owned content after interrupted initialization.\n";
      assert.deepEqual(
        await inspect("workspace-failure-recover", { divergentContent: divergentUser }),
        { recovered: true },
      );
      await assert.rejects(driver.prepareRevision(first, setupContext));
      assert.deepEqual(
        await inspect("workspace-failure-inspect", {
          files: { "AGENTS.md": setup.files["AGENTS.md"], "USER.md": divergentUser },
        }),
        { ...inactiveSetup, userIsStock: false },
      );
      assert.deepEqual(await inspect("workspace-failure-recover"), { recovered: true });
      partialWriteSeeded = false;
      assert.equal((await driver.prepareRevision(first, setupContext)).ready, true);
      assert.deepEqual(
        await inspect("workspace", { files: setup.files, defaultsId: setup.defaultsId }),
        { matches: true, git: true, metadataOnly: true, active: false },
      );
      let operatorEnv;
      if (modelProof) {
        await provision(providerKey);
        operatorEnv = await inspect("env-state");
        assert.equal(operatorEnv.mode, 0o600);
      }
      await driver.activateRevision(first, setupContext);
      const observedFirst = await inspect("inspect");
      assert.equal(observedFirst.current, `revisions/${sha256Hex(first.id, 12)}`);
      assert.equal(observedFirst.active, true);
      assert.equal(observedFirst.readyStatus, 200);
      if (modelProof) {
        assert.equal(
          (await inspect("meter")).count,
          0,
          "Deployment/readiness must make no model request.",
        );
        const turn = await inspect("model");
        assert.equal(turn.status, 200);
        assert.equal(turn.modelReply, true);
        assert.ok((await inspect("meter")).count > 0);
        assert.deepEqual(await inspect("env-state"), operatorEnv);
      }
      const editedFiles = {
        ...setup.files,
        "AGENTS.md": "Edited by the Agent after initial setup.\n",
      };
      assert.deepEqual(await inspect("workspace-edit", { content: editedFiles["AGENTS.md"] }), {
        edited: true,
      });
      // A lost completion acknowledgement still delivers pending bytes; replay must preserve edits.
      assert.equal((await driver.prepareRevision(first, setupContext)).ready, true);
      assert.deepEqual(
        await inspect("workspace", { files: editedFiles, defaultsId: setup.defaultsId }),
        { matches: true, git: true, metadataOnly: true, active: true },
      );
      assert.deepEqual(await inspect("workspace-guard"), { refused: true, active: false });
      await driver.activateRevision(first, completedContext);
      const marker = randomUUID();
      assert.deepEqual(await inspect("marker", { marker }), { written: true });
      driver.bindAgent({
        namespace,
        agent: {
          id: siblingAgentId,
          namespaceId: namespace.id,
          name: "SSH sibling proof",
          configurationId: sibling.configurationId,
          backendId: null,
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
      assert.equal((await driver.prepareRevision(second, completedContext)).ready, true);
      await driver.activateRevision(second, completedContext);
      // A changed admitted snapshot restarts this Agent while its writable state remains intact.
      const cutover = await inspect("inspect");
      assert.equal(cutover.current, `revisions/${sha256Hex(second.id, 12)}`);
      assert.equal(cutover.active, true);
      assert.equal(cutover.readyStatus, 200);
      assert.equal(cutover.marker, marker);
      assert.equal(cutover.oldRevisionExists, true);
      assert.deepEqual(
        await inspect("workspace", { files: editedFiles, defaultsId: setup.defaultsId }),
        { matches: true, git: true, metadataOnly: true, active: true },
      );
      driver.bindAgent(binding);
      await driver.retireRevision(first);
      const retired = await inspect("inspect");
      assert.equal(retired.oldRevisionExists, false);
      assert.equal(retired.active, true);
      assert.equal(retired.marker, marker);
      if (modelProof) {
        assert.deepEqual(
          await inspect("env-state"),
          operatorEnv,
          "Redeploy and retirement preserve operator bytes and metadata.",
        );
        const before = (await inspect("meter")).count;
        // A different key affects this existing immutable revision after process restart.
        await driver.stopRevision(second);
        assert.deepEqual(
          await inspect("env-state"),
          operatorEnv,
          "Stop preserves operator credentials.",
        );
        await provision("sk-invalid-runtime-proof");
        const invalidEnv = await inspect("env-state");
        await driver.activateRevision(second, completedContext);
        assert.equal((await inspect("inspect")).readyStatus, 200);
        assert.equal(
          (await inspect("meter")).count,
          before,
          "Invalid credentials must not trigger a deployment probe.",
        );
        const rejected = await inspect("model");
        assert.equal(rejected.modelReply, false);
        assert.ok(rejected.status >= 400);
        assert.ok(
          (await inspect("meter")).count > before,
          "The actual model request must reach the provider and be rejected.",
        );
        assert.equal((await inspect("inspect")).readyStatus, 200);
        await driver.stopRevision(second);
        assert.deepEqual(await inspect("env-state"), invalidEnv);
      }
    } finally {
      if (partialWriteSeeded) {
        await inspect("workspace-failure-recover");
      }
      if (meterStarted) {
        await inspect("stop-meter");
      }
      assert.equal((await driver.deleteNamespace(namespace)).namespaceDeleted, true);
    }
    assert.deepEqual(await inspect("deleted"), {
      directoryExists: false,
      unitExists: false,
      active: false,
    });
  },
);
