import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { reservePort, reservedPortArgs } from "../helpers/available-port.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { registerWorkspaceNodeSupervisorCases } from "./workspace-node-supervisor-cases.ts";

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

// Observe the actual projection bytes without changing read results or errors.
// Support both whole-file and bounded descriptor reads for baseline comparisons.
function observeSetupReads(setupPath, setupReadsPath) {
  return [
    'const fs = require("node:fs");',
    "const realRead = fs.readFileSync, realOpen = fs.openSync, realReadSync = fs.readSync, realClose = fs.closeSync;",
    "const observedSetupReads = new Map(); let directSetupRead = false;",
    `const setupRead = (content) => fs.appendFileSync(${JSON.stringify(setupReadsPath)}, JSON.stringify({ content }) + "\\n");`,
    "fs.readFileSync = (path, ...rest) => {",
    `  if (path !== ${JSON.stringify(setupPath)}) return realRead(path, ...rest);`,
    "  let content = null; directSetupRead = true;",
    "  try { content = realRead(path, ...rest); return content; }",
    "  finally { directSetupRead = false; setupRead(content); }",
    "};",
    "fs.openSync = (path, ...rest) => {",
    `  const observe = path === ${JSON.stringify(setupPath)} && !directSetupRead;`,
    "  try { const fd = realOpen(path, ...rest); if (observe) observedSetupReads.set(fd, []); return fd; }",
    "  catch (error) { if (observe) setupRead(null); throw error; }",
    "};",
    "fs.readSync = (fd, buffer, offset, length, position) => {",
    "  const read = realReadSync(fd, buffer, offset, length, position);",
    "  observedSetupReads.get(fd)?.push(Buffer.from(buffer.subarray(offset, offset + read)));",
    "  return read;",
    "};",
    "fs.closeSync = (fd) => {",
    "  try { return realClose(fd); } finally {",
    "    const chunks = observedSetupReads.get(fd); observedSetupReads.delete(fd);",
    '    if (chunks) setupRead(Buffer.concat(chunks).toString("utf8"));',
    "  }",
    "};",
  ];
}

function nativeSetup(bootstrapToken) {
  return { url: "wss://gateway.example.test/node", bootstrapToken, expiresAtMs: 4_000_000_000_000 };
}

// Both delivery paths must fit the native connect target-file limit (64 KiB).
function maximumSetupEnvelope() {
  const payload = nativeSetup("");
  const maximumDecodedBytes = (65_536 / 4) * 3;
  payload.bootstrapToken = "x".repeat(
    maximumDecodedBytes - Buffer.byteLength(JSON.stringify(payload)),
  );
  return payload;
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
//   the supervisor spawns. Native setup runs `setup` (the lines of setup.cjs; by default
//   it succeeds at once) with the events path, with the options (stdio included) the
//   supervisor passes. Every other child runs `child` (the lines of child.cjs) with the
//   events path, "node" or "codex", and its JSON arguments. `stubs` are extra program
//   lines that replace other external bodies; `realSpawnSync` is the unstubbed spawnSync.
// - Events: children append JSON rows to `directory`/events.jsonl.
// - Cleanup kills the supervisor and every recorded pid, then removes `directory`.
async function startSupervisor(
  t,
  directory,
  {
    child,
    setup = [],
    stubs = [],
    env,
    entrypoint = AGENT_WITH_NODE_ENTRYPOINT,
    statusReservation,
  },
) {
  const eventsPath = join(directory, "events.jsonl");
  const childPath = join(directory, "child.cjs");
  const setupPath = join(directory, "setup.cjs");
  await writeFile(childPath, child.join("\n"));
  await writeFile(setupPath, setup.join("\n"));
  const launch = [
    'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
    "const realSpawnSync = cp.spawnSync;",
    "cp.spawnSync = () => ({ status: 0 });",
    'cp.spawn = (command, args, options) => realSpawn(command, args[1] === "setup" ? [' +
      JSON.stringify(setupPath) +
      ", " +
      JSON.stringify(eventsPath) +
      "] : [" +
      JSON.stringify(childPath) +
      ", " +
      JSON.stringify(eventsPath) +
      ', args[0] === "/app/openclaw.mjs" ? "node" : "codex", JSON.stringify(args)], options);',
    ...stubs,
    entrypoint
      .replace("\ninitializeRuntimeAssets();\n", "\n")
      .replace("\npublishAgentPluginSkillPath();\n", "\n"),
  ].join("\n");
  // Launch through the same bounded program pieces the container receives. A reserved
  // status port stays held by the test until the supervisor's own listener answers; the
  // preload lets that listener bind the held port.
  const preload = statusReservation === undefined ? [] : reservedPortArgs(statusReservation);
  const supervisor = spawn(process.execPath, [...preload, "-e", ...nodeProgramArguments(launch)], {
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

registerWorkspaceNodeSupervisorCases({
  startSupervisor,
  nativeWorkerEntrypoint: NATIVE_WORKER_ENTRYPOINT,
  nativeSetup,
  maximumSetupEnvelope,
  observeSetupReads,
  jsonLines,
  pidGone,
  processGone,
  pendingIdentityProbe,
});

// A Deployment-backed Codex Harness starts before its node setup Secret exists
// and receives the code through an optional volume. Real child processes prove
// the start order; native pairing and the kubelet volume refresh are not run here.
test(
  "Codex starts before the node setup file and the node reconnects after the code is removed",
  {
    timeout: 40_000,
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
        ...observeSetupReads(setupPath, setupReadsPath),
      ],
      env: {
        OPENCLAW_NODE_SETUP_PATH: setupPath,
        OPENCLAW_NODE_DISPLAY_NAME: "agent-0123456789ab-workspace",
      },
    });
    const nodes = (rows) => rows.filter(({ kind }) => kind === "node");
    // The supervisor polls the setup file until it starts a node. A poll that read
    // `content` followed by another poll proves that content started no node.
    const evaluated = async (content) => {
      const offset = (await jsonLines(setupReadsPath)).length;
      return waitFor(
        "a setup poll after the selected projection was read",
        (reads) => {
          const expectedRead =
            content === null ? null : Buffer.from(content).subarray(0, 65_537).toString("utf8");
          const index = reads.findIndex(
            (read, row) =>
              row >= offset && (read.content === expectedRead || read.content === content),
          );
          return index !== -1 && index < reads.length - 1;
        },
        () => jsonLines(setupReadsPath),
      );
    };

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
    const payload = maximumSetupEnvelope();
    const code = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.equal(Buffer.byteLength(code), 65_536);
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

    await writeFile(setupPath, code);
    const [paired] = nodes(
      await waitFor("node started with the setup", (rows) => nodes(rows).length === 1),
    );
    assert.deepEqual(paired.args.slice(0, 5), [
      "/app/openclaw.mjs",
      "node",
      "run",
      "--pair-or-reconnect",
      code,
    ]);
    // Every start names the node after the Agent, not the first Pod's host name.
    const displayName = (args) => args[args.indexOf("--display-name") + 1];
    assert.equal(displayName(paired.args), "agent-0123456789ab-workspace");

    // Incomplete replacement projections leave the connected node alone. Renewal
    // must not turn a transient file swap into a node or Codex outage.
    // The outer base64url is valid ASCII, but decoding must not silently repair
    // an invalid token byte into a different setup that replaces a healthy node.
    const invalidUtf8 = Buffer.from(
      JSON.stringify({ ...payload, bootstrapToken: "invalid-utf8-bootstrap" }),
    );
    invalidUtf8[invalidUtf8.indexOf("invalid-utf8-bootstrap")] = 0xff;
    for (const incomplete of [
      "",
      code.slice(0, 17),
      invalidUtf8.toString("base64url"),
      ...[
        {},
        { bootstrapToken: "bootstrap" },
        { ...payload, expiresAtMs: "invalid" },
        { ...payload, expiresAtMs: undefined },
        // A valid pin still requires TLS before the replacement can retire this node.
        {
          ...nativeSetup("plaintext-pinned-bootstrap"),
          url: "ws://gateway.example.test/node",
          tlsFingerprint: "ab".repeat(32),
        },
        {
          ...payload,
          url: "wss:gateway.example.test/node",
          bootstrapToken: "malformed-url-bootstrap",
        },
        { ...payload, bootstrapToken: "x".repeat(140_000) },
      ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")),
      Buffer.from(JSON.stringify({ ...payload, bootstrapToken: "over-limit-delivery" })).toString(
        "base64url",
      ) + " ".repeat(65_536),
    ]) {
      await writeFile(setupPath, incomplete);
      await evaluated(incomplete);
      assert.equal(nodes(await events()).length, 1);
      process.kill(paired.pid, 0);
    }
    // Projection serialization is not setup identity: no restart for reordered
    // JSON, whitespace, or the optional URL prefix around the same payload.
    const equivalent = Buffer.from(
      JSON.stringify({
        expiresAtMs: payload.expiresAtMs,
        bootstrapToken: payload.bootstrapToken,
        url: payload.url,
      }),
    ).toString("base64url");
    await writeFile(setupPath, equivalent);
    await evaluated(equivalent);
    assert.equal(nodes(await events()).length, 1);
    const renewed = Buffer.from(
      JSON.stringify({ ...payload, bootstrapToken: "renewed-bootstrap" }),
    ).toString("base64url");
    await writeFile(setupPath, renewed);
    const refreshed = nodes(
      await waitFor("connected node received renewed setup", (rows) => nodes(rows).length === 2),
    )[1];
    assert.equal(refreshed.args[4], renewed);
    await processGone("previous node survived setup renewal", paired.pid);
    await evaluated(renewed);
    assert.equal(nodes(await events()).length, 2, "unchanged setup must not restart the node");
    const prefixed = "oc-pair://" + renewed + "\n";
    await writeFile(setupPath, prefixed);
    await evaluated(prefixed);
    assert.equal(
      nodes(await events()).length,
      2,
      "a setup presentation change must not restart the node",
    );

    // After pairing the controller removes the code and the kubelet removes the
    // file. Removal leaves the running node alone; a later process failure
    // reconnects with its saved device identity.
    await rm(setupPath);
    await evaluated(null);
    assert.equal(nodes(await events()).length, 2);
    process.kill(refreshed.pid, 0);
    await writeFile(identityPath, JSON.stringify({ deviceId: "a".repeat(64) }));
    process.kill(refreshed.pid, "SIGKILL");
    const restarted = nodes(
      await waitFor("node reconnected without a code", (rows) => nodes(rows).length === 3),
    )[2];
    assert.deepEqual(restarted.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
    assert.equal(restarted.args.includes("--pair-or-reconnect"), false);
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
    assert.equal(node.args.includes("--pair-or-reconnect"), false);
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
        'cp.spawn = (command, args, options) => args[1] === "setup"',
        '  ? realSpawn(process.execPath, ["-e", ""], options)',
        '  : realSpawn(process.env.HOME + "/missing", [], options);',
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

// Native setup that prints the value of the JavaScript expression `stdout` and exits
// with `status`.
function setupStub(stdout, status) {
  return [`process.stdout.write(${stdout}); process.exitCode = ${status};`];
}

const recordingChild = [
  'const { appendFileSync } = require("node:fs");',
  "const [events, kind] = process.argv.slice(2);",
  'appendFileSync(events, JSON.stringify({ kind, pid: process.pid }) + "\\n");',
  "setInterval(() => {}, 1_000);",
];

test(
  "Harness starts its children after a native setup whose result outgrows a pipe buffer",
  { timeout: 15_000 },
  async (t) => {
    // A buffered pipe (spawnSync's 1 MiB default) killed a setup whose result outgrew
    // it, which failed a setup that succeeded (review-3817).
    const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-baseline-"));
    const { waitFor } = await startSupervisor(t, directory, {
      child: recordingChild,
      setup: setupStub('JSON.stringify({ ok: true, padding: "x".repeat(3 * 1024 * 1024) })', 0),
      env: { OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup" },
    });
    await waitFor(
      "children started",
      (rows) =>
        rows.some(({ kind }) => kind === "node") && rows.some(({ kind }) => kind === "codex"),
    );
  },
);

test(
  "Harness holds a failed native setup and serves the held check on the Compute status port",
  { timeout: 15_000 },
  async (t) => {
    // Codex owns this container's status port, and it never starts on an uninitialized
    // workspace: the supervisor serves the hold there itself, so Compute fails the
    // revision with the check instead of waiting for its deadline (finding 2686).
    const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-held-"));
    // The supervisor binds its status port on every interface; hold it there.
    const statusReservation = await reservePort({ host: "0.0.0.0" });
    t.after(() => statusReservation.release());
    const { port } = statusReservation;
    const result = {
      ok: false,
      error: { type: "cli_error", message: `bad\n\u001b]0;title\u0007${"y".repeat(600)}` },
      issues: [{ path: "agents.defaults.skipBootstrap", message: "sk-fixture-value" }],
    };
    const { supervisor, events, waitFor, output } = await startSupervisor(t, directory, {
      child: recordingChild,
      statusReservation,
      setup: setupStub(JSON.stringify(JSON.stringify(result, null, 2)), 1),
      env: {
        OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup",
        OPENCLAW_RUNTIME_STATUS_PORT: String(port),
        OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
        OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
        OPENCLAW_POD_UID: "pod-fixture",
      },
    });
    const read = async (path) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: response.status, body: await response.text() };
      } catch {
        return undefined;
      }
    };
    // A connection that reaches the reservation is reset, which read() reports as no answer.
    const answer = await waitFor(
      "held status served",
      (served) => served?.status === 200,
      () => read("/openclaw/runtime/status"),
    );
    await statusReservation.release();
    const status = JSON.parse(answer.body);
    const { checkedAt, ...failure } = status.runtimeFailure;
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
    assert.deepEqual(
      { ...status, runtimeFailure: failure },
      {
        revisionId: "rev_fixture",
        container: "agent",
        podUid: "pod-fixture",
        runtimeFailure: { component: "agent", check: "workspace-baseline", code: "UNAVAILABLE" },
      },
    );
    assert.equal((await read("/readyz")).status, 503);
    // One bounded line names the setup's message and setting path, never its values.
    const lines = output()
      .split("\n")
      .filter((line) => line.includes("Workspace initialization"));
    assert.equal(lines.length, 1, output());
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    assert.doesNotMatch(lines[0], /[\u0000-\u001f\u007f-\u009f]|sk-fixture-value/u);
    // The message is cut at 400 characters after control characters collapse.
    assert.ok(
      lines[0].includes(
        `reported: bad ]0;title ${"y".repeat(387)} (invalid settings: agents.defaults.skipBootstrap).`,
      ),
      lines[0],
    );
    // Held: alive, and neither child started.
    assert.equal(supervisor.exitCode, null);
    assert.deepEqual(await events(), []);
  },
);

test(
  "a Harness stopped during native setup lets setup finish before it exits",
  {
    timeout: 15_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    // Native setup holds the node state's lock on the Agent's workspace claim. If the
    // supervisor exited on SIGTERM first, the container would end and the kernel would
    // kill setup while it holds the lock, which no later Pod can then take (finding
    // 3104). OpenClaw's launcher kills the CLI about 2 s after a forwarded stop, so the
    // supervisor keeps the stop to itself and waits for setup to end on its own.
    const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-setup-stop-"));
    const release = join(directory, "release-setup");
    const { supervisor, exited, events, waitFor, output } = await startSupervisor(t, directory, {
      child: recordingChild,
      setup: [
        'const { appendFileSync, existsSync } = require("node:fs");',
        "const [events] = process.argv.slice(2);",
        "const row = (kind) => appendFileSync(events, JSON.stringify({ kind, pid: process.pid }) + '\\n');",
        'process.on("SIGTERM", () => row("setup-signal"));',
        'row("setup");',
        // Setup holds its lock until the test lets it finish; releasing takes a moment.
        "const timer = setInterval(() => {",
        `  if (!existsSync(${JSON.stringify(release)})) return;`,
        "  clearInterval(timer);",
        '  setTimeout(() => row("setup-done"), 100);',
        "}, 10);",
      ],
      env: { OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup" },
    });
    const [setup] = await waitFor("native setup started", (rows) =>
      rows.some(({ kind }) => kind === "setup"),
    );
    supervisor.kill("SIGTERM");
    // While setup holds its lock, the stopped supervisor must not exit. The real
    // supervisor cannot exit before setup does, so this wait cannot fail it; one
    // that exits on the stop does so well within the wait.
    const early = await Promise.race([exited, delay(500).then(() => "running")]);
    assert.equal(early, "running", output());
    await writeFile(release, "");
    assert.deepEqual(await exited, [0, null], output());
    // The supervisor exited after setup ended: setup was gone when it exited.
    assert.ok(pidGone(setup.pid), "native setup outlived the supervisor");
    // Setup finished undisturbed, and the stopped Harness started neither child.
    assert.deepEqual(
      (await events()).map(({ kind }) => kind),
      ["setup", "setup-done"],
    );
  },
);
