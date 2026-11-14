import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/utils/src/objects.ts";
import {
  maximumSetupEnvelope,
  nativeSetup,
  observeSetupReads,
  pendingIdentityProbe,
  pidGone,
  processGone,
  readSetupReads,
  recordingChildWithArguments,
  startSupervisor,
  type ChildEvent,
  type ProcessEventRow,
} from "./workspace-node-supervisor-fixture.ts";

// Real child processes exercise signal delivery and reaping. The fixture substitutes pairing and Codex.
export async function restartsAndReapsIndependently(t: TestContext) {
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
      "shellCaPath: process.env.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS,",
      "hasModelKey: process.env.OPENAI_API_KEY !== undefined,",
      'autoUpdateDisabled: process.env.OPENCLAW_NO_AUTO_UPDATE === "1",',
      'hasTransportToken: process.env.APP_SERVER_TOKEN !== undefined }) + "\\n");',
      'if (kind === "codex") spawn(process.execPath, [__filename, events, "grandchild"], { stdio: "inherit" });',
      "setInterval(() => {}, 1_000);",
    ],
    stubs: [
      ...pendingIdentityProbe,
      // Simulate a broken sink for node-exit diagnostics while preserving real supervision.
      "const savedConsoleError = console.error; console.error = (line) => {",
      '  if (typeof line === "string" && line.includes("runtime.process_exit") && line.includes("workspace-node")) throw new Error("sentinel-private-exit-log-secret");',
      "  savedConsoleError(line); };",
    ],
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
  const node = initial.find((row) => row.kind === "node");
  const codex = initial.find((row) => row.kind === "codex");
  assert.ok(node?.caPath, "node reported its Gateway CA path");
  assert.ok(codex?.caPath, "Codex reported its combined CA path");
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
  // Sandboxed commands cannot read the hook directory; they keep the Pod's own CA.
  assert.equal(codex.shellCaPath, existingCa);
  assert.equal(node.shellCaPath, undefined);

  process.kill(codex.pid, "SIGKILL");
  const afterCodex = await waitFor(
    "Codex restarted",
    (rows) => rows.filter((row) => row.kind === "codex").length === 2,
  );
  assert.equal(afterCodex.filter((row) => row.kind === "node").length, 1);
  const exitEvents = output()
    .split("\n")
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        const row = asRecord(value);
        return row?.event === "runtime.process_exit" ? [row] : [];
      } catch {
        return [];
      }
    });
  assert.deepEqual(
    exitEvents.find((e) => e.component === "codex-wrapper"),
    {
      event: "runtime.process_exit",
      component: "codex-wrapper",
      exitCode: null,
      signal: "SIGKILL",
      stopping: false,
    },
  );
  process.kill(node.pid, 0);
  const descendant = initial.find((row) => row.kind === "grandchild");
  assert.ok(descendant, "Codex recorded its descendant");
  await waitFor("old Codex descendant exited", () => pidGone(descendant.pid));

  const renewedSetup = {
    url: "wss://gateway.example.test/node",
    bootstrapToken: "renewed-provider-bootstrap-token",
    expiresAtMs: Date.now() + 60_000,
  };
  await writeFile(setupEnvelopePath, JSON.stringify(renewedSetup));
  const afterNode = await waitFor(
    "connected node restarted after its provider setup changed",
    (rows) => rows.filter((row) => row.kind === "node").length === 2,
  );
  assert.equal(afterNode.filter((row) => row.kind === "codex").length, 2);
  const restartedNode = afterNode.filter((row) => row.kind === "node").at(-1);
  assert.ok(restartedNode?.args, "restarted node recorded its arguments");
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
    (rows) => rows.filter((row) => row.kind === "node").length === 3,
  );
  const cachedSetupNode = afterProjectionRemoval.filter((row) => row.kind === "node").at(-1);
  assert.ok(cachedSetupNode?.args, "node recorded its arguments after projection removal");
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
      rows.filter((row) => row.kind === "node").length === 4,
  );
  assert.equal(afterEmptyToken.filter((row) => row.kind === "node").length, 3);

  // Stop exits once its children are gone, without waiting for the probe. It reaps
  // its own children before exiting, so they are gone at once.
  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], output());
  const recorded = (await events()).filter((row) => row.pid !== undefined);
  for (const { pid } of recorded.filter(({ kind }) => kind !== "grandchild")) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  // The group kill also ends the Codex grandchild, but its new parent reaps it a
  // moment later, and until then kill(pid, 0) still finds it.
  for (const { pid } of recorded.filter((row) => row.kind === "grandchild")) {
    await processGone(`Codex grandchild ${pid} still running 5 s after stop`, pid);
  }
  for (const secret of [
    "synthetic-model-key",
    "synthetic-transport-token",
    "sentinel-private-exit-log-secret",
  ]) {
    assert.equal(output().includes(secret), false);
  }
}

export async function preservesSavedIdentityOnProviderReadFailure(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-provider-setup-cache-"));
  const setupPath = join(directory, "node-setup.json");
  const readsPath = join(directory, "setup-reads.jsonl");
  const identityPath = join(directory, "identity.json");
  const initialSetup = nativeSetup("initial-bootstrap");
  await writeFile(setupPath, JSON.stringify(initialSetup));
  await writeFile(identityPath, JSON.stringify({ deviceId: "a".repeat(64) }));
  const { events, waitFor, waitForValue } = await startSupervisor(t, directory, {
    child: recordingChildWithArguments,
    stubs: [
      "cp.execFile = (file, args, options, callback) => {",
      `  callback(null, require("node:fs").readFileSync(${JSON.stringify(identityPath)}, "utf8"));`,
      "};",
      ...observeSetupReads(setupPath, readsPath),
    ],
    env: { OPENCLAW_NODE_SETUP_ENVELOPE: setupPath },
  });
  const nodes = (rows: ProcessEventRow[]) => rows.filter((row) => row.kind === "node");
  const evaluated = async (content: string | null) => {
    const offset = (await readSetupReads(readsPath)).length;
    await waitForValue(
      "provider projection read and evaluated",
      (rows) => rows.slice(offset).filter((row) => row.content === content).length >= 2,
      () => readSetupReads(readsPath),
    );
  };
  const [initial] = nodes(await waitFor("initial setup node", (rows) => nodes(rows).length === 1));
  assert.ok(initial?.args, "initial node recorded its arguments");
  assert.equal(initial.args[4], Buffer.from(JSON.stringify(initialSetup)).toString("base64url"));
  // An incomplete envelope falls back to the already saved native identity
  // after an ordinary child failure, without treating the cache as fresh input.
  await writeFile(setupPath, "{}");
  await evaluated("{}");
  process.kill(initial.pid, "SIGKILL");
  const resumed = nodes(
    await waitFor("saved identity node", (rows) => nodes(rows).length === 2),
  )[1];
  assert.ok(resumed, "saved-identity node started");
  assert.deepEqual(resumed.args, [
    "/app/openclaw.mjs",
    "node",
    "run",
    "--commands",
    "file.fetch,file.stat,file.write,file.create,dir.list,workspace.memory,workspace.skills",
  ]);

  // Missing and unparsable projections must not replay the earlier setup into
  // this connected child. Observe real file reads before checking its lifetime.
  await rm(setupPath);
  await evaluated(null);
  assert.equal(nodes(await events()).length, 2);
  process.kill(resumed.pid, 0);
  await writeFile(setupPath, "{");
  await evaluated("{");
  assert.equal(nodes(await events()).length, 2);
  process.kill(resumed.pid, 0);

  const renewed = nativeSetup("renewed-bootstrap");
  await writeFile(setupPath, JSON.stringify(renewed));
  const replacement = nodes(
    await waitFor("fresh setup replaces node", (rows) => nodes(rows).length === 3),
  )[2];
  assert.ok(replacement?.args, "replacement node recorded its arguments");
  assert.equal(replacement.args[4], Buffer.from(JSON.stringify(renewed)).toString("base64url"));
  await processGone("saved identity node survived renewal", resumed.pid);
  assert.equal((await events()).filter((row) => row.kind === "codex").length, 1);
}

export async function retiresNodeGroupWithLatestProjection(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-renewal-"));
  const setupPath = join(directory, "setup-code");
  const setupReadsPath = join(directory, "setup-reads.jsonl");
  const initialCode = Buffer.from(JSON.stringify(nativeSetup("initial-bootstrap"))).toString(
    "base64url",
  );
  await writeFile(setupPath, initialCode);
  const { events, waitFor, waitForValue, output } = await startSupervisor(t, directory, {
    child: [
      'const { appendFileSync } = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const [events, kind, args] = process.argv.slice(2);",
      'const row = (event) => appendFileSync(events, JSON.stringify({ kind, event, pid: process.pid, args: JSON.parse(args ?? "[]") }) + "\\n");',
      'row("started");',
      // Both the node and its descendant resist graceful termination. The
      // supervisor must retire the entire group before starting another node.
      'if (kind !== "codex") process.on("SIGTERM", () => row("terminating"));',
      'if (kind === "node") spawn(process.execPath, [__filename, events, "descendant"], { stdio: "inherit" });',
      "setInterval(() => {}, 1_000);",
    ],
    stubs: [...pendingIdentityProbe, ...observeSetupReads(setupPath, setupReadsPath)],
    env: { OPENCLAW_NODE_SETUP_PATH: setupPath },
  });
  const starts = (rows: ProcessEventRow[], kind: "node" | "codex" | "descendant") =>
    rows.filter((row): row is ChildEvent => row.kind === kind && row.event === "started");
  const initial = await waitFor(
    "node, descendant and Codex started",
    (rows) => starts(rows, "descendant").length === 1 && starts(rows, "codex").length === 1,
  );
  const node = starts(initial, "node")[0];
  const descendant = starts(initial, "descendant")[0];
  const codex = starts(initial, "codex")[0];
  assert.ok(node && descendant && codex, "node, descendant and Codex recorded their starts");
  await writeFile(
    setupPath,
    Buffer.from(JSON.stringify(nativeSetup("superseded-bootstrap"))).toString("base64url"),
  );
  await waitFor("renewal requested graceful retirement", (rows) =>
    rows.some((row) => row.pid === node.pid && row.event === "terminating"),
  );
  const readOffset = (await readSetupReads(setupReadsPath)).length;
  await writeFile(setupPath, initialCode);
  await waitForValue(
    "the retiring node observed the rollback to its initial setup",
    (reads) => reads.slice(readOffset).some((read) => read.content === initialCode),
    () => readSetupReads(setupReadsPath),
  );
  // Withdraw after the actual rollback read. The old child still ignores TERM;
  // its replacement must use A, not the B that first triggered retirement.
  await rm(setupPath);
  assert.equal(starts(await events(), "node").length, 1);
  process.kill(node.pid, 0);
  // The production grace period is five seconds. After it expires the normal
  // one-second restart delay must produce one replacement with the newest code.
  await delay(5_000);
  const replaced = await waitFor(
    "stuck node group replaced",
    (rows) => starts(rows, "node").length === 2,
  );
  const replacement = starts(replaced, "node")[1];
  assert.ok(replacement?.args, "replacement node recorded its arguments");
  assert.equal(replacement.args[4], initialCode);
  assert.equal(
    replaced.filter((row) => row.pid === node.pid && row.event === "terminating").length,
    1,
  );
  await processGone("old node remained after replacement", node.pid);
  await processGone("old node descendant remained after replacement", descendant.pid);
  assert.equal(starts(replaced, "codex").length, 1);
  process.kill(codex.pid, 0);
  for (const secret of ["initial-bootstrap", "superseded-bootstrap"]) {
    assert.equal(output().includes(secret), false);
  }
}

// A Deployment-backed Codex Harness starts before its node setup Secret exists
// and receives the code through an optional volume. Real child processes prove
// the start order; native pairing and the kubelet volume refresh are not run here.
export async function startsBeforeSetupAndReconnects(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-setup-file-"));
  const setupDirectory = join(directory, "setup");
  const setupPath = join(setupDirectory, "setup-code");
  const setupReadsPath = join(directory, "setup-reads.jsonl");
  const identityPath = join(directory, "identity.json");
  // Substitute the saved-identity lookup as well; the supervisor's setup polling and
  // restarts run unchanged.
  const { supervisor, exited, events, waitFor, waitForValue, output } = await startSupervisor(
    t,
    directory,
    {
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
    },
  );
  const nodes = (rows: ProcessEventRow[]) => rows.filter((row) => row.kind === "node");
  // The supervisor polls the setup file until it starts a node. A poll that read
  // `content` followed by another poll proves that content started no node.
  const evaluated = async (content: string | null) => {
    const offset = (await readSetupReads(setupReadsPath)).length;
    return waitForValue(
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
      () => readSetupReads(setupReadsPath),
    );
  };

  const codex = (
    await waitFor("Codex started without the setup", (rows) =>
      rows.some(({ kind }) => kind === "codex"),
    )
  ).find((row) => row.kind === "codex");
  assert.ok(codex, "Codex recorded its start");
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
  assert.ok(paired?.args, "node recorded its arguments");
  assert.deepEqual(paired.args.slice(0, 5), [
    "/app/openclaw.mjs",
    "node",
    "run",
    "--pair-or-reconnect",
    code,
  ]);
  // Every start names the node after the Agent, not the first Pod's host name.
  const displayName = (args: string[]) => {
    const index = args.indexOf("--display-name");
    assert.ok(index >= 0, "node received its display-name flag");
    return args[index + 1];
  };
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
  assert.ok(refreshed?.args, "node recorded its arguments");
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
  assert.ok(restarted?.args, "node recorded its arguments");
  assert.deepEqual(restarted.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
  assert.equal(restarted.args.includes("--pair-or-reconnect"), false);
  assert.equal(restarted.args.includes(code), false);
  assert.equal(displayName(restarted.args), "agent-0123456789ab-workspace");
  assert.equal((await events()).filter(({ kind }) => kind === "codex").length, 1);

  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], output());
}

// After pairing the controller removes the setup code, so every later Harness
// start depends on the saved-identity probe. A probe that fails once (a timeout
// under Codex startup contention) must not park the node until a restart.
export async function retriesSavedIdentityProbe(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-identity-retry-"));
  // The saved identity exists throughout; only the first probe fails.
  const { supervisor, exited, waitFor, output } = await startSupervisor(t, directory, {
    child: recordingChildWithArguments,
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
  const rows = await waitFor(
    "node never started after a failed probe",
    (events) => events.some(({ kind }) => kind === "node"),
    { timeoutMs: 8_000, intervalMs: 50 },
  );
  const probes = rows.filter((row) => row.kind === "probe");
  assert.deepEqual(
    probes.map(({ attempt }) => attempt),
    [1, 2],
    "one failed probe, one retry",
  );
  const node = rows.find((row) => row.kind === "node");
  assert.ok(node?.args, "node recorded its arguments");
  assert.deepEqual(node.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
  assert.equal(node.args.includes("--pair-or-reconnect"), false);
  assert.equal(rows.filter(({ kind }) => kind === "codex").length, 1);

  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], output());
}

// A Pod deleted while Codex is between restarts and the node still waits for its
// setup has no child left to stop. A pending identity probe must not hold the exit.
export async function stopsBetweenRestarts(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-stop-idle-"));
  const { supervisor, exited, waitFor, waitForValue, output } = await startSupervisor(
    t,
    directory,
    {
      child: [],
      stubs: [
        // Every child fails to start, so Codex is only ever between restarts.
        'cp.spawn = (command, args, options) => args[1] === "setup"',
        '  ? realSpawn(process.execPath, ["-e", ""], options)',
        '  : realSpawn(process.env.HOME + "/missing", [], options);',
        ...pendingIdentityProbe,
      ],
      env: { OPENCLAW_NODE_SETUP_PATH: join(directory, "setup", "setup-code") },
    },
  );
  await waitFor("identity probe", (rows) => rows.some(({ kind }) => kind === "probe"));
  await waitForValue(
    "Codex start failure",
    (text) => text.includes("Codex failed to start."),
    output,
  );
  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], output());
}
