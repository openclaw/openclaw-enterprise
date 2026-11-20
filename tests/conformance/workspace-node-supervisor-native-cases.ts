import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NATIVE_WORKER_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { reservePort } from "../helpers/available-port.ts";
import {
  maximumSetupEnvelope,
  nativeSetup,
  observeSetupReads,
  processGone,
  readSetupReads,
  startSupervisor,
  type ChildEvent,
  type ProcessEventRow,
} from "./workspace-node-supervisor-fixture.ts";

export async function refusesInvalidPrivatePort(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-worker-readiness-"));
  const { exited, output } = await startSupervisor(t, directory, {
    entrypoint: NATIVE_WORKER_ENTRYPOINT,
    child: ['throw new Error("unexpected native worker launch");'],
    env: {
      TMPDIR: directory,
      OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify({}),
      OPENCLAW_NATIVE_WORKER_CAPACITY: "2",
      OPENCLAW_NODE_SETUP_CODE: "fixture-native-node-setup",
      OPENCLAW_RUNTIME_STATUS_PORT: "",
    },
  });
  assert.deepEqual(await exited, [1, null], output());
  assert.match(output(), /Runtime status port is invalid\./);
}

// The model probe uses the inherited proxy CA before the native child adds the
// provider Gateway CA. Both must survive in the real child's environment.
export async function preservesNativeCas(
  t: TestContext,
  topology: "Compute-owned" | "provider-owned",
) {
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
  // The supervisor binds its status port on every interface; hold it there.
  const statusReservation =
    topology === "Compute-owned" ? await reservePort({ host: "0.0.0.0" }) : undefined;
  t.after(() => statusReservation?.release());
  const statusPort = statusReservation?.port;
  const { supervisor, exited, waitFor, waitForValue, output } = await startSupervisor(
    t,
    directory,
    {
      entrypoint: NATIVE_WORKER_ENTRYPOINT,
      statusReservation,
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
        ...(statusPort === undefined ? {} : { OPENCLAW_RUNTIME_STATUS_PORT: String(statusPort) }),
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
    },
  );
  const node = (
    await waitFor("native worker started after the probe", (rows) =>
      rows.some(({ kind }) => kind === "node"),
    )
  ).find((row) => row.kind === "node");
  assert.ok(
    node?.kind === "node" && node.caPath && node.args,
    "native worker recorded its CA and arguments",
  );
  assert.equal(
    await readFile(node.caPath, "utf8"),
    "model-proxy-public-ca\nprovider-gateway-public-ca",
  );
  assert.equal((await stat(node.caPath)).mode & 0o777, 0o600);
  assert.equal(node.args[1], "connect");
  const targetIndex = node.args.indexOf("--target-file");
  assert.ok(targetIndex >= 0, "native worker received a target-file flag");
  const targetPath = node.args[targetIndex + 1];
  assert.ok(targetPath, "native worker received a target file");
  assert.equal(
    await readFile(targetPath, "utf8"),
    Buffer.from(setupEnvelope).toString("base64url"),
  );
  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  if (statusReservation !== undefined) {
    // A connection that reaches the reservation is reset; retry until the supervisor answers.
    const ready = await waitForValue(
      "status port answered",
      (status) => status !== undefined,
      () =>
        fetch(`http://127.0.0.1:${statusReservation.port}/readyz`).then(
          (response) => response.status,
          () => undefined,
        ),
    );
    await statusReservation.release();
    assert.equal(ready, 503);
  }
  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], output());
}

// The production wrapper supervises real processes here. Only the external model
// probe and native child implementation are substituted; this is not pairing proof.
async function startNativeProviderWorker(t: TestContext, directory: string, child: string[]) {
  return startSupervisor(t, directory, {
    entrypoint: NATIVE_WORKER_ENTRYPOINT,
    child,
    stubs: [
      'cp.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ auth: { probes: { results: [{ provider: "openai", model: "openai/native-refresh", source: "env", status: "ok" }] } } }) });',
      ...observeSetupReads(
        join(directory, "node-setup.json"),
        join(directory, "setup-reads.jsonl"),
      ),
    ],
    env: {
      OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
      OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
      OPENCLAW_NODE_SETUP_ENVELOPE: join(directory, "node-setup.json"),
      OPENCLAW_HARNESS_MODEL: "openai/native-refresh",
      OPENCLAW_HARNESS_PROVIDER: "openai",
      OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
      OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
        agents: { defaults: { model: "openai/native-refresh" } },
      }),
      OPENAI_API_KEY: "synthetic-model-key",
      TMPDIR: join(directory, "tmp"),
    },
  });
}

const nativeRefreshChild = [
  'const { appendFileSync, readFileSync } = require("node:fs");',
  'const { spawn } = require("node:child_process");',
  "const [events, kind, args] = process.argv.slice(2);",
  'const argv = JSON.parse(args ?? "[]");',
  'const target = kind === "node" ? readFileSync(argv[argv.indexOf("--target-file") + 1], "utf8") : undefined;',
  'const row = (event) => appendFileSync(events, JSON.stringify({ kind, event, pid: process.pid, target }) + "\\n");',
  'row("started");',
  'if (kind === "node") spawn(process.execPath, [__filename, events, "descendant"], { stdio: "inherit" });',
  'process.on("SIGTERM", () => { row("terminating"); if (!target || JSON.parse(Buffer.from(target, "base64url")).bootstrapToken !== "initial-bootstrap") process.exit(0); });',
  "setInterval(() => {}, 1_000);",
];

const nativeStarts = (rows: ProcessEventRow[]) =>
  rows.filter(
    (row): row is Extract<ChildEvent, { kind: "node" }> =>
      row.kind === "node" && row.event === "started",
  );

export async function retiresNativeWorkerWithLatestEnvelope(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-refresh-"));
  const setupPath = join(directory, "node-setup.json");
  const identityPath = join(directory, "node-state", "retained-device");
  await mkdir(join(directory, "node-state"));
  await writeFile(identityPath, "retained-private-identity");
  const { exited, events, waitFor, waitForValue, output } = await startNativeProviderWorker(
    t,
    directory,
    nativeRefreshChild,
  );
  // A provider may expose the virtual file after wrapper startup. No incomplete
  // or absent projection is passed to the native connection.
  await delay(1_100);
  assert.equal(nativeStarts(await events()).length, 0);
  await writeFile(setupPath, "{");
  await delay(1_100);
  assert.equal(nativeStarts(await events()).length, 0);
  await writeFile(setupPath, JSON.stringify(nativeSetup("initial-bootstrap")));
  const started = await waitFor("native worker and descendant started", (rows) =>
    rows.some((row) => row.kind === "descendant" && row.event === "started"),
  );
  const initial = nativeStarts(started)[0];
  const descendant = started.find((row) => row.kind === "descendant");
  assert.ok(initial && descendant, "native worker and descendant recorded their starts");
  const payload = nativeSetup("initial-bootstrap");
  const unchanged = [
    JSON.stringify(
      {
        expiresAtMs: payload.expiresAtMs,
        bootstrapToken: payload.bootstrapToken,
        url: payload.url,
      },
      null,
      2,
    ),
    "{",
    JSON.stringify({ ...payload, bootstrapToken: "" }),
    JSON.stringify({ ...payload, url: "https://gateway.example.test/node" }),
    // Native rejects a TLS pin over plaintext; do not retire its healthy child first.
    JSON.stringify({
      ...payload,
      url: "ws://gateway.example.test/node",
      tlsFingerprint: "ab".repeat(32),
    }),
    JSON.stringify({
      ...payload,
      url: "wss:gateway.example.test/node",
      bootstrapToken: "malformed-url-bootstrap",
    }),
    JSON.stringify({ ...payload, bootstrapToken: "x".repeat(140_000) }),
    JSON.stringify({ ...payload, bootstrapToken: "x".repeat(50_000) }),
    JSON.stringify({
      ...payload,
      bootstrapToken: "\u2003".repeat(30_000) + "different-bootstrap",
    }),
  ];
  for (const projection of unchanged) {
    await writeFile(setupPath, projection);
    await delay(1_100);
    const observed = await events();
    assert.equal(nativeStarts(observed).length, 1);
    assert.equal(
      observed.some((row) => row.pid === initial.pid && row.event === "terminating"),
      false,
      "an invalid projection retired the healthy native worker",
    );
    process.kill(initial.pid, 0);
  }
  await rm(setupPath);
  await delay(1_100);
  assert.equal(nativeStarts(await events()).length, 1);

  await writeFile(setupPath, JSON.stringify(nativeSetup("superseded-bootstrap")));
  await waitFor("old worker received graceful retirement", (rows) =>
    rows.some((row) => row.pid === initial.pid && row.event === "terminating"),
  );
  const latest = nativeSetup("initial-bootstrap");
  const setupReadsPath = join(directory, "setup-reads.jsonl");
  const readOffset = (await readSetupReads(setupReadsPath)).length;
  await writeFile(setupPath, JSON.stringify(latest));
  await waitForValue(
    "the retiring native worker observed the rollback",
    (reads) => reads.slice(readOffset).some((read) => read.content === JSON.stringify(latest)),
    () => readSetupReads(setupReadsPath),
  );
  // The initial setup is the latest complete value. Its equality with the old
  // child's setup must not preserve the superseded value across this withdrawal.
  await rm(setupPath);
  assert.equal(nativeStarts(await events()).length, 1);
  process.kill(initial.pid, 0);
  await delay(4_100);
  const replaced = await waitFor(
    "native worker restarted with refreshed setup",
    (rows) => nativeStarts(rows).length === 2,
  );
  const replacement = nativeStarts(replaced)[1];
  assert.ok(replacement?.target, "replacement native worker recorded its target");
  const target: unknown = JSON.parse(Buffer.from(replacement.target, "base64url").toString("utf8"));
  assert.deepEqual(target, latest);
  assert.equal(
    replaced.filter((row) => row.pid === initial.pid && row.event === "terminating").length,
    1,
  );
  await processGone("old native worker survived replacement", initial.pid);
  await processGone("old native descendant survived replacement", descendant.pid);
  assert.equal(await readFile(identityPath, "utf8"), "retained-private-identity");
  assert.equal((await stat(join(directory, "node-state", "connect-target"))).mode & 0o777, 0o600);
  // Both incarnations intentionally resist TERM, so finish this race fixture
  // through the normal child-exit path after verifying the replacement.
  process.kill(replacement.pid, "SIGKILL");
  assert.deepEqual(await exited, [1, null], output());
  for (const secret of ["initial-bootstrap", "superseded-bootstrap"]) {
    assert.equal(output().includes(secret), false);
  }
}

export async function stopsPendingNativeRenewal(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-stop-"));
  const setupPath = join(directory, "node-setup.json");
  await writeFile(setupPath, JSON.stringify(nativeSetup("initial-bootstrap")));
  const { supervisor, exited, events, waitFor } = await startNativeProviderWorker(
    t,
    directory,
    nativeRefreshChild,
  );
  const initial = nativeStarts(
    await waitFor("native worker started", (rows) => rows.some((row) => row.kind === "descendant")),
  )[0];
  assert.ok(initial, "native worker recorded its start");
  await writeFile(setupPath, JSON.stringify(nativeSetup("renewed-bootstrap")));
  await waitFor("native worker began retirement", (rows) =>
    rows.some((row) => row.pid === initial.pid && row.event === "terminating"),
  );
  supervisor.kill("SIGTERM");
  assert.deepEqual(await exited, [1, null]);
  assert.equal(nativeStarts(await events()).length, 1);
  await processGone("stopped native worker remained alive", initial.pid);
}

export async function preservesNaturalNativeExitCode(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-exit-"));
  await writeFile(join(directory, "node-setup.json"), JSON.stringify(maximumSetupEnvelope()));
  const { exited } = await startNativeProviderWorker(t, directory, [
    "const args = JSON.parse(process.argv[4]);",
    'const target = require("node:fs").readFileSync(args[args.indexOf("--target-file") + 1]);',
    'require("node:assert/strict").equal(target.length, 65_536);',
    "process.exit(7);",
  ]);
  assert.deepEqual(await exited, [7, null]);
}
