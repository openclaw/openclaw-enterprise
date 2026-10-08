import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";

// Reads a JSON-lines file; a file that does not exist yet has no rows. Children append
// rows while the test polls, and a read can see a large append half-written (a Codex
// row carries its whole program), so a last line without its newline is not a row yet.
async function jsonLines(path) {
  const contents = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return contents
    .slice(0, contents.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// True once `pid` no longer exists. A dying or zombie process still answers kill(pid, 0).
function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

// Polls pidGone for at most five seconds.
async function processGone(description, pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pidGone(pid)) {
      return;
    }
    await delay(25);
  }
  assert.fail(description);
}

// Stub lines for a saved-identity probe that appends a "probe" row to the events
// file in the supervisor's HOME (the test directory) and never answers, keeping
// the event loop busy as a slow probe does.
const pendingIdentityProbe = [
  "cp.execFile = () => {",
  '  const events = require("node:path").join(process.env.HOME, "events.jsonl");',
  '  require("node:fs").appendFileSync(events, JSON.stringify({ kind: "probe" }) + "\\n");',
  "  setInterval(() => {}, 60_000);",
  "};",
];

// Runs the supervisor program the container receives; supervision, signals and
// environments run unchanged.
// - Stubbed: native initialization (the runtime-image test covers it), and every child
//   the supervisor spawns, which runs `child` (the lines of child.cjs) with the events
//   path, "node" or "codex", and its JSON arguments. `stubs` are extra program lines
//   that replace other external bodies.
// - Events: children append JSON rows to `directory`/events.jsonl.
// - Cleanup kills the supervisor and every recorded pid, then removes `directory`.
async function startSupervisor(
  t,
  directory,
  { child, stubs = [], env, entrypoint = AGENT_WITH_NODE_ENTRYPOINT },
) {
  const eventsPath = join(directory, "events.jsonl");
  const childPath = join(directory, "child.cjs");
  await writeFile(childPath, child.join("\n"));
  const launch = [
    'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
    "cp.spawnSync = () => ({ status: 0 });",
    "cp.spawn = (command, args, options) => realSpawn(command, [" +
      JSON.stringify(childPath) +
      ", " +
      JSON.stringify(eventsPath) +
      ', args[0] === "/app/openclaw.mjs" ? "node" : "codex", JSON.stringify(args)], options);',
    ...stubs,
    entrypoint
      .replace("\ninitializeRuntimeAssets();\n", "\n")
      .replace("\npublishAgentPluginSkillPath();\n", "\n"),
  ].join("\n");
  // Launch through the same bounded program pieces the container receives.
  const supervisor = spawn(process.execPath, ["-e", ...nodeProgramArguments(launch)], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
      OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let output = "";
  supervisor.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(supervisor, "exit");
  const events = () => jsonLines(eventsPath);
  t.after(async () => {
    supervisor.kill("SIGTERM");
    await exited;
    for (const { pid } of await events()) {
      if (pid === undefined) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  // Polls `read` (the events by default) until `predicate` accepts the rows, failing at
  // once if the supervisor exits.
  const waitFor = async (description, predicate, read = events) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observed = await read();
      if (await predicate(observed)) {
        return observed;
      }
      assert.equal(supervisor.exitCode, null, output);
      await delay(25);
    }
    assert.fail(description + ": " + output);
  };
  return { supervisor, exited, events, waitFor, output: () => output };
}

// This proves process supervision with real child processes. It does not prove
// native pairing, Codex startup or container integration.
test(
  "workspace node and Codex restart independently and retire their process groups",
  {
    timeout: 15_000,
    // These are Linux container entrypoints. Darwin can report EPERM when a
    // process group contains only zombies, unlike the production kernel.
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-"));
    const existingCa = join(directory, "existing-ca.pem");
    await writeFile(existingCa, "existing-public-ca");
    const setupEnvelopePath = join(directory, "node-setup.json");
    await writeFile(
      setupEnvelopePath,
      JSON.stringify({
        url: "wss://gateway.example.test/node",
        bootstrapToken: "provider-bootstrap-token",
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    const { supervisor, exited, events, waitFor, output } = await startSupervisor(t, directory, {
      child: [
        'const { appendFileSync } = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, parent: process.ppid,",
        'args: JSON.parse(args ?? "[]"),',
        "hasSetup: process.env.OPENCLAW_NODE_SETUP_CODE !== undefined ||",
        "  process.env.OPENCLAW_NODE_SETUP_ENVELOPE !== undefined,",
        "caPath: process.env.NODE_EXTRA_CA_CERTS,",
        "hasModelKey: process.env.OPENAI_API_KEY !== undefined,",
        'autoUpdateDisabled: process.env.OPENCLAW_NO_AUTO_UPDATE === "1",',
        'hasTransportToken: process.env.APP_SERVER_TOKEN !== undefined }) + "\\n");',
        'if (kind === "codex") spawn(process.execPath, [__filename, events, "grandchild"], { stdio: "inherit" });',
        "setInterval(() => {}, 1_000);",
      ],
      stubs: pendingIdentityProbe,
      env: {
        OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath,
        OPENCLAW_NODE_CA_PEM: "gateway-public-ca",
        NODE_EXTRA_CA_CERTS: existingCa,
        OPENAI_API_KEY: "synthetic-model-key",
        APP_SERVER_TOKEN: "synthetic-transport-token",
      },
    });
    const initial = await waitFor(
      "children started",
      (rows) =>
        rows.some(({ kind }) => kind === "node") && rows.some(({ kind }) => kind === "grandchild"),
    );
    const node = initial.find(({ kind }) => kind === "node");
    const codex = initial.find(({ kind }) => kind === "codex");
    assert.equal(node.hasSetup, false);
    assert.equal(node.hasModelKey, false);
    assert.equal(node.hasTransportToken, false);
    assert.equal(node.autoUpdateDisabled, true);
    assert.equal(codex.hasSetup, false);
    assert.equal(codex.hasModelKey, true);
    assert.equal(codex.hasTransportToken, true);
    assert.equal((await stat(join(directory, ".oce-native-hooks"))).mode & 0o777, 0o700);
    assert.equal(await readFile(codex.caPath, "utf8"), "existing-public-ca\ngateway-public-ca");
    assert.equal(await readFile(node.caPath, "utf8"), "gateway-public-ca");

    process.kill(codex.pid, "SIGKILL");
    const afterCodex = await waitFor(
      "Codex restarted",
      (rows) => rows.filter(({ kind }) => kind === "codex").length === 2,
    );
    assert.equal(afterCodex.filter(({ kind }) => kind === "node").length, 1);
    process.kill(node.pid, 0);
    const descendant = initial.find(({ kind }) => kind === "grandchild");
    await waitFor("old Codex descendant exited", () => pidGone(descendant.pid));

    const renewedSetup = {
      url: "wss://gateway.example.test/node",
      bootstrapToken: "renewed-provider-bootstrap-token",
      expiresAtMs: Date.now() + 60_000,
    };
    await writeFile(setupEnvelopePath, JSON.stringify(renewedSetup));
    process.kill(node.pid, "SIGKILL");
    const afterNode = await waitFor(
      "node restarted with renewed provider setup",
      (rows) => rows.filter(({ kind }) => kind === "node").length === 2,
    );
    assert.equal(afterNode.filter(({ kind }) => kind === "codex").length, 2);
    const restartedNode = afterNode.filter(({ kind }) => kind === "node").at(-1);
    assert.equal(
      restartedNode.args[4],
      Buffer.from(JSON.stringify(renewedSetup)).toString("base64url"),
    );

    // Retain the most recently read setup if the provider projection is briefly
    // unavailable during another pre-pairing retry.
    await rm(setupEnvelopePath);
    process.kill(restartedNode.pid, "SIGKILL");
    const afterProjectionRemoval = await waitFor(
      "node restarted after its renewed setup projection disappeared",
      (rows) => rows.filter(({ kind }) => kind === "node").length === 3,
    );
    const cachedSetupNode = afterProjectionRemoval.filter(({ kind }) => kind === "node").at(-1);
    assert.equal(
      cachedSetupNode.args[4],
      Buffer.from(JSON.stringify(renewedSetup)).toString("base64url"),
    );

    // An envelope without a bootstrap token is not a setup: the node is not
    // started and the supervisor falls back to the saved-identity probe.
    await writeFile(setupEnvelopePath, JSON.stringify({ ...renewedSetup, bootstrapToken: "" }));
    process.kill(cachedSetupNode.pid, "SIGKILL");
    const afterEmptyToken = await waitFor(
      "identity probe or node start after an empty bootstrap token",
      (rows) =>
        rows.some(({ kind }) => kind === "probe") ||
        rows.filter(({ kind }) => kind === "node").length === 4,
    );
    assert.equal(afterEmptyToken.filter(({ kind }) => kind === "node").length, 3);

    // Stop exits once its children are gone, without waiting for the probe. It reaps
    // its own children before exiting, so they are gone at once.
    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output());
    const recorded = (await events()).filter(({ pid }) => pid !== undefined);
    for (const { pid } of recorded.filter(({ kind }) => kind !== "grandchild")) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    // The group kill also ends the Codex grandchild, but its new parent reaps it a
    // moment later, and until then kill(pid, 0) still finds it.
    for (const { pid } of recorded.filter(({ kind }) => kind === "grandchild")) {
      await processGone(`Codex grandchild ${pid} still running 5 s after stop`, pid);
    }
  },
);

// The model probe uses the inherited proxy CA before the native child adds the
// provider Gateway CA. Both must survive in the real child's environment.
test(
  "native worker preserves inherited model-proxy and provider Gateway CAs",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-worker-ca-"));
    const inheritedCaPath = join(directory, "model-proxy-ca.pem");
    const providerCaPath = join(directory, "provider-gateway-ca.pem");
    await writeFile(inheritedCaPath, "model-proxy-public-ca");
    await writeFile(providerCaPath, "provider-gateway-public-ca");
    const setupEnvelopePath = join(directory, "node-setup.json");
    const setupEnvelope = JSON.stringify({
      url: "wss://gateway.example.test/node",
      bootstrapToken: "synthetic-provider-bootstrap-token",
      expiresAtMs: Date.now() + 60_000,
    });
    await writeFile(setupEnvelopePath, setupEnvelope);
    const inference = {
      agents: { defaults: { model: "openai/native-ca" } },
      models: {
        providers: {
          openai: {
            apiKey: "OPENAI_API_KEY",
            api: "openai-responses",
            baseUrl: "https://model-proxy.example.test/v1",
            models: [
              {
                id: "native-ca",
                name: "Native CA fixture",
                api: "openai-responses",
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };
    const { supervisor, exited, waitFor, output } = await startSupervisor(t, directory, {
      entrypoint: NATIVE_WORKER_ENTRYPOINT,
      child: [
        'const { appendFileSync } = require("node:fs");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args),",
        "caPath: process.env.NODE_EXTRA_CA_CERTS }) + '\\n');",
        "setInterval(() => {}, 1_000);",
      ],
      // The model service is external to this process proof. The production
      // probe preparation and success branch still run before the real child.
      stubs: [
        "cp.spawnSync = (command, args, options) => {",
        '  require("node:assert/strict").ok(args.includes("--probe"));',
        `  require("node:assert/strict").equal(options.env.NODE_EXTRA_CA_CERTS, ${JSON.stringify(inheritedCaPath)});`,
        '  return { status: 0, stdout: JSON.stringify({ auth: { probes: { results: [{ provider: "openai", model: "openai/native-ca", source: "env", status: "ok" }] } } }) };',
        "};",
      ],
      env: {
        OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify(inference),
        OPENCLAW_NATIVE_WORKER_CAPACITY: "8",
        OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath,
        OPENCLAW_NODE_CA_PATH: providerCaPath,
        NODE_EXTRA_CA_CERTS: inheritedCaPath,
        OPENCLAW_HARNESS_MODEL: "openai/native-ca",
        OPENCLAW_HARNESS_PROVIDER: "openai",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify(inference),
        OPENAI_API_KEY: "synthetic-model-key",
        TMPDIR: join(directory, "tmp"),
      },
    });
    const [node] = await waitFor("native worker started after the probe", (rows) =>
      rows.some(({ kind }) => kind === "node"),
    );
    assert.equal(
      await readFile(node.caPath, "utf8"),
      "model-proxy-public-ca\nprovider-gateway-public-ca",
    );
    assert.equal((await stat(node.caPath)).mode & 0o777, 0o600);
    assert.equal(node.args[1], "connect");
    const targetPath = node.args[node.args.indexOf("--target-file") + 1];
    assert.equal(
      await readFile(targetPath, "utf8"),
      Buffer.from(setupEnvelope).toString("base64url"),
    );
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output());
  },
);

// A Deployment-backed Codex Harness starts before its node setup Secret exists
// and receives the code through an optional volume. Real child processes prove
// the start order; native pairing and the kubelet volume refresh are not run here.
test(
  "Codex starts before the node setup file and the node reconnects after the code is removed",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-setup-file-"));
    const setupDirectory = join(directory, "setup");
    const setupPath = join(setupDirectory, "setup-code");
    const setupReadsPath = join(directory, "setup-reads.jsonl");
    const identityPath = join(directory, "identity.json");
    // Substitute the saved-identity lookup as well; the supervisor's setup polling and
    // restarts run unchanged.
    const { supervisor, exited, events, waitFor, output } = await startSupervisor(t, directory, {
      child: [
        'const { appendFileSync } = require("node:fs");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args),",
        "hasSetupPath: process.env.OPENCLAW_NODE_SETUP_PATH !== undefined,",
        "hasDisplayName: process.env.OPENCLAW_NODE_DISPLAY_NAME !== undefined }) + '\\n');",
        "setInterval(() => {}, 1_000);",
      ],
      stubs: [
        "cp.execFile = (file, args, options, callback) => {",
        `  try { callback(null, require("node:fs").readFileSync(${JSON.stringify(identityPath)}, "utf8")); }`,
        '  catch (error) { callback(error, ""); }',
        "};",
        // Record each setup poll and what it read, so the test waits for polls.
        'const fs = require("node:fs"); const realRead = fs.readFileSync;',
        "fs.readFileSync = (path, ...rest) => {",
        `  if (path !== ${JSON.stringify(setupPath)}) return realRead(path, ...rest);`,
        "  let content = null;",
        "  try { content = realRead(path, ...rest); return content; }",
        `  finally { fs.appendFileSync(${JSON.stringify(setupReadsPath)}, JSON.stringify({ content }) + "\\n"); }`,
        "};",
      ],
      env: {
        OPENCLAW_NODE_SETUP_PATH: setupPath,
        OPENCLAW_NODE_DISPLAY_NAME: "agent-0123456789ab-workspace",
      },
    });
    const nodes = (rows) => rows.filter(({ kind }) => kind === "node");
    // The supervisor polls the setup file until it starts a node. A poll that read
    // `content` followed by another poll proves that content started no node.
    const evaluated = (content) =>
      waitFor(
        `a setup poll after reading ${JSON.stringify(content)}`,
        (reads) => {
          const index = reads.findIndex((read) => read.content === content);
          return index !== -1 && index < reads.length - 1;
        },
        () => jsonLines(setupReadsPath),
      );

    const [codex] = await waitFor("Codex started without the setup", (rows) =>
      rows.some(({ kind }) => kind === "codex"),
    );
    assert.equal(codex.hasSetupPath, false, "Codex does not learn where the setup code lives");
    assert.equal(codex.hasDisplayName, false);
    await evaluated(null);
    assert.deepEqual(nodes(await events()), [], "no node without a setup or a saved identity");

    // The kubelet swaps Secret files atomically; an empty, truncated or
    // line-wrapped code (which native pairing rejects, though Buffer decodes it)
    // is still treated as absent rather than handed to native pairing.
    const code = Buffer.from(
      JSON.stringify({ url: "wss://gateway.example.test", bootstrapToken: "bootstrap" }),
    ).toString("base64url");
    await mkdir(setupDirectory);
    for (const incomplete of [
      "",
      "\n",
      code.slice(0, 17),
      `${code.slice(0, 40)}\n${code.slice(40)}`,
    ]) {
      await writeFile(setupPath, incomplete);
      await evaluated(incomplete);
      assert.deepEqual(nodes(await events()), [], JSON.stringify(incomplete));
    }

    await writeFile(setupPath, `${code}\n`);
    const [paired] = nodes(
      await waitFor("node started with the setup", (rows) => nodes(rows).length === 1),
    );
    assert.deepEqual(paired.args.slice(0, 5), [
      "/app/openclaw.mjs",
      "node",
      "run",
      "--pair-if-needed",
      code,
    ]);
    // Every start names the node after the Agent, not the first Pod's host name.
    const displayName = (args) => args[args.indexOf("--display-name") + 1];
    assert.equal(displayName(paired.args), "agent-0123456789ab-workspace");

    // After pairing the controller removes the code and the kubelet removes the
    // file. A node restart then reconnects with its saved device identity.
    await rm(setupPath);
    await writeFile(identityPath, JSON.stringify({ deviceId: "a".repeat(64) }));
    process.kill(paired.pid, "SIGKILL");
    const restarted = nodes(
      await waitFor("node reconnected without a code", (rows) => nodes(rows).length === 2),
    )[1];
    assert.deepEqual(restarted.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
    assert.equal(restarted.args.includes("--pair-if-needed"), false);
    assert.equal(restarted.args.includes(code), false);
    assert.equal(displayName(restarted.args), "agent-0123456789ab-workspace");
    assert.equal((await events()).filter(({ kind }) => kind === "codex").length, 1);

    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output());
  },
);

// After pairing the controller removes the setup code, so every later Harness
// start depends on the saved-identity probe. A probe that fails once (a timeout
// under Codex startup contention) must not park the node until a restart.
test(
  "a failed saved-identity probe is retried and the node starts without a code",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-identity-retry-"));
    // The saved identity exists throughout; only the first probe fails.
    const { supervisor, exited, events, output } = await startSupervisor(t, directory, {
      child: [
        'const { appendFileSync } = require("node:fs");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args) }) + '\\n');",
        "setInterval(() => {}, 1_000);",
      ],
      stubs: [
        'const { appendFileSync } = require("node:fs");',
        "let probes = 0;",
        "cp.execFile = (file, args, options, callback) => {",
        "  probes += 1;",
        `  appendFileSync(${JSON.stringify(join(directory, "events.jsonl"))}, JSON.stringify({ kind: "probe", attempt: probes }) + "\\n");`,
        '  if (probes === 1) { setImmediate(() => callback(Object.assign(new Error("timed out"), { killed: true }), "")); return; }',
        `  setImmediate(() => callback(null, JSON.stringify({ deviceId: ${JSON.stringify("b".repeat(64))} })));`,
        "};",
      ],
      env: { OPENCLAW_NODE_SETUP_PATH: join(directory, "setup", "setup-code") },
    });
    const deadline = Date.now() + 8_000;
    let rows = [];
    while (!rows.some(({ kind }) => kind === "node")) {
      assert.ok(Date.now() < deadline, "node never started after a failed probe: " + output());
      assert.equal(supervisor.exitCode, null, output());
      await delay(50);
      rows = await events();
    }
    const probes = rows.filter(({ kind }) => kind === "probe");
    assert.equal(probes.length, 2, "one failed probe, one retry");
    const node = rows.find(({ kind }) => kind === "node");
    assert.deepEqual(node.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
    assert.equal(node.args.includes("--pair-if-needed"), false);
    assert.equal(rows.filter(({ kind }) => kind === "codex").length, 1);

    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output());
  },
);

// A Pod deleted while Codex is between restarts and the node still waits for its
// setup has no child left to stop. A pending identity probe must not hold the exit.
test(
  "a stop with no running child exits at once",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-stop-idle-"));
    const { supervisor, exited, waitFor, output } = await startSupervisor(t, directory, {
      child: [],
      stubs: [
        // Every child fails to start, so Codex is only ever between restarts.
        'cp.spawn = (command, args, options) => realSpawn(process.env.HOME + "/missing", [], options);',
        ...pendingIdentityProbe,
      ],
      env: { OPENCLAW_NODE_SETUP_PATH: join(directory, "setup", "setup-code") },
    });
    await waitFor("identity probe", (rows) => rows.some(({ kind }) => kind === "probe"));
    await waitFor("Codex start failure", (text) => text.includes("Codex failed to start."), output);
    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output());
  },
);
