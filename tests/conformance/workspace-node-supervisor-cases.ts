import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { reservePort } from "../helpers/available-port.ts";

type ChildKind =
  "node" | "codex" | "grandchild" | "descendant" | "setup" | "setup-signal" | "setup-done";

type ChildEvent = {
  [Kind in ChildKind]: {
    kind: Kind;
    pid: number;
    parent?: number;
    args?: string[];
    event?: "started" | "terminating";
    target?: string;
    caPath?: string;
    shellCaPath?: string;
    hasSetup?: boolean;
    hasSetupPath?: boolean;
    hasDisplayName?: boolean;
    hasModelKey?: boolean;
    hasTransportToken?: boolean;
    autoUpdateDisabled?: boolean;
    hasCaPath?: boolean;
  };
}[ChildKind];

type ProcessEventRow = ChildEvent | { kind: "probe"; attempt?: number; pid?: never; event?: never };

type SetupReadRow = { content: string | null };
type SupervisorExit = [code: number | null, signal: NodeJS.Signals | null];
type PollPredicate<Value> = (value: Value) => boolean | Promise<boolean>;

type WaitFor = {
  (description: string, predicate: PollPredicate<ProcessEventRow[]>): Promise<ProcessEventRow[]>;
  <Value>(
    description: string,
    predicate: PollPredicate<Value>,
    read: () => Value | Promise<Value>,
  ): Promise<Value>;
};

type SupervisorOptions = {
  child: string[];
  setup?: string[];
  stubs?: string[];
  env: NodeJS.ProcessEnv;
  entrypoint?: string;
  statusReservation?: Awaited<ReturnType<typeof reservePort>> | undefined;
};

type SupervisorFixture = {
  supervisor: ChildProcessByStdio<null, null, Readable>;
  exited: Promise<SupervisorExit>;
  events: () => Promise<ProcessEventRow[]>;
  waitFor: WaitFor;
  output: () => string;
};

type SetupEnvelope = { url: string; bootstrapToken: string; expiresAtMs: number };

type WorkspaceNodeSupervisorDependencies = {
  startSupervisor: (
    t: TestContext,
    directory: string,
    options: SupervisorOptions,
  ) => Promise<SupervisorFixture>;
  nativeWorkerEntrypoint: string;
  nativeSetup: (bootstrapToken: string) => SetupEnvelope;
  maximumSetupEnvelope: () => SetupEnvelope;
  observeSetupReads: (setupPath: string, setupReadsPath: string) => string[];
  jsonLines: (path: string) => Promise<SetupReadRow[]>;
  pidGone: (pid: number) => boolean;
  processGone: (description: string, pid: number) => Promise<void>;
  pendingIdentityProbe: string[];
};

export function registerWorkspaceNodeSupervisorCases({
  startSupervisor,
  nativeWorkerEntrypoint,
  nativeSetup,
  maximumSetupEnvelope,
  observeSetupReads,
  jsonLines,
  pidGone,
  processGone,
  pendingIdentityProbe,
}: WorkspaceNodeSupervisorDependencies): void {
  test(
    "native worker refuses an invalid configured private port",
    { timeout: 10_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-native-worker-readiness-"));
      const { exited, output } = await startSupervisor(t, directory, {
        entrypoint: nativeWorkerEntrypoint,
        child: ['throw new Error("unexpected native worker launch");'],
        env: {
          TMPDIR: directory,
          OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify({}),
          OPENCLAW_NATIVE_WORKER_CAPACITY: "2",
          OPENCLAW_NODE_SETUP_CODE: "fixture-native-node-setup",
          OPENCLAW_RUNTIME_STATUS_PORT: "",
        },
      });
      const [code] = await exited;
      assert.notEqual(code, 0);
      assert.match(output(), /Runtime status port is invalid\./);
    },
  );

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
          rows.some(({ kind }) => kind === "node") &&
          rows.some(({ kind }) => kind === "grandchild"),
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
            const value: { event?: string; component?: string } = JSON.parse(line);
            return value.event === "runtime.process_exit" ? [value] : [];
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
      for (const secret of [
        "synthetic-model-key",
        "synthetic-transport-token",
        "sentinel-private-exit-log-secret",
      ]) {
        assert.equal(JSON.stringify(exitEvents).includes(secret), false);
      }
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
    },
  );

  test(
    "provider read failures preserve a running saved-identity node",
    {
      timeout: 20_000,
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-provider-setup-cache-"));
      const setupPath = join(directory, "node-setup.json");
      const readsPath = join(directory, "setup-reads.jsonl");
      const identityPath = join(directory, "identity.json");
      const initialSetup = nativeSetup("initial-bootstrap");
      await writeFile(setupPath, JSON.stringify(initialSetup));
      await writeFile(identityPath, JSON.stringify({ deviceId: "a".repeat(64) }));
      const { events, waitFor } = await startSupervisor(t, directory, {
        child: [
          "const [events, kind, args] = process.argv.slice(2);",
          'require("node:fs").appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args) }) + "\\n");',
          "setInterval(() => {}, 1_000);",
        ],
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
        const offset = (await jsonLines(readsPath)).length;
        await waitFor(
          "provider projection read and evaluated",
          (rows) => rows.slice(offset).filter((row) => row.content === content).length >= 2,
          () => jsonLines(readsPath),
        );
      };
      const [initial] = nodes(
        await waitFor("initial setup node", (rows) => nodes(rows).length === 1),
      );
      assert.ok(initial?.args, "initial node recorded its arguments");
      assert.equal(
        initial.args[4],
        Buffer.from(JSON.stringify(initialSetup)).toString("base64url"),
      );
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
    },
  );

  test(
    "setup renewal preserves a rolled-back file projection while retiring its node group",
    {
      timeout: 20_000,
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-node-renewal-"));
      const setupPath = join(directory, "setup-code");
      const setupReadsPath = join(directory, "setup-reads.jsonl");
      const setup = (bootstrapToken: string) => ({
        url: "wss://gateway.example.test/node",
        bootstrapToken,
        expiresAtMs: 4_000_000_000_000,
      });
      const initialCode = Buffer.from(JSON.stringify(setup("initial-bootstrap"))).toString(
        "base64url",
      );
      await writeFile(setupPath, initialCode);
      const { events, waitFor, output } = await startSupervisor(t, directory, {
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
      const starts = (rows: ProcessEventRow[], kind: ChildKind) =>
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
        Buffer.from(JSON.stringify(setup("superseded-bootstrap"))).toString("base64url"),
      );
      await waitFor("renewal requested graceful retirement", (rows) =>
        rows.some((row) => row.pid === node.pid && row.event === "terminating"),
      );
      const readOffset = (await jsonLines(setupReadsPath)).length;
      await writeFile(setupPath, initialCode);
      await waitFor(
        "the retiring node observed the rollback to its initial setup",
        (reads) => reads.slice(readOffset).some((read) => read.content === initialCode),
        () => jsonLines(setupReadsPath),
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
    },
  );

  // An OpenShell Sandbox delivers the Gateway CA as a provider file (OPENCLAW_NODE_CA_PATH)
  // and runs the Harness with its own HOME. Codex hook commands call the Gateway route, so
  // they need that CA as much as the node does, and their credential directory is HOME's.
  test(
    "Codex hooks trust a file-delivered Gateway CA from the Harness HOME",
    {
      timeout: 15_000,
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-node-ca-file-"));
      const caPath = join(directory, "node-ca.pem");
      await writeFile(caPath, "gateway-public-ca\n");
      const setupEnvelopePath = join(directory, "node-setup.json");
      await writeFile(
        setupEnvelopePath,
        JSON.stringify({
          url: "wss://gateway.example.test/node",
          bootstrapToken: "provider-bootstrap-token",
          expiresAtMs: Date.now() + 60_000,
        }),
      );
      const { waitFor } = await startSupervisor(t, directory, {
        child: [
          'const { appendFileSync } = require("node:fs");',
          "const [events, kind] = process.argv.slice(2);",
          "appendFileSync(events, JSON.stringify({ kind, pid: process.pid,",
          "caPath: process.env.NODE_EXTRA_CA_CERTS,",
          "shellCaPath: process.env.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS,",
          'hasCaPath: process.env.OPENCLAW_NODE_CA_PATH !== undefined }) + "\\n");',
          "setInterval(() => {}, 1_000);",
        ],
        stubs: pendingIdentityProbe,
        env: { OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath, OPENCLAW_NODE_CA_PATH: caPath },
      });
      const rows = await waitFor(
        "children started",
        (observed) =>
          observed.some(({ kind }) => kind === "node") &&
          observed.some(({ kind }) => kind === "codex"),
      );
      const node = rows.find((row) => row.kind === "node");
      const codex = rows.find((row) => row.kind === "codex");
      assert.ok(node && codex, "node and Codex recorded their starts");
      assert.equal(node.caPath, caPath);
      const hooks = join(directory, ".oce-native-hooks");
      assert.equal((await stat(hooks)).mode & 0o777, 0o700);
      assert.equal(codex.caPath, join(hooks, "gateway-ca.pem"));
      assert.equal(await readFile(codex.caPath, "utf8"), "gateway-public-ca");
      // No Pod CA: sandboxed commands get no NODE_EXTRA_CA_CERTS at all.
      assert.equal(codex.shellCaPath, "");
      assert.equal(codex.hasCaPath, false);
    },
  );

  // Code in the Harness runs as the Harness user, so it can replace the hook directory, for
  // example with a symlink into the workspace. On OpenShell HOME survives restarts, so the
  // replacement would steer later relay credentials and the CA copy into the workspace.
  test(
    "each Codex start rebuilds the hook directory without following a planted link",
    {
      timeout: 15_000,
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-node-hook-directory-"));
      const caPath = join(directory, "node-ca.pem");
      await writeFile(caPath, "gateway-public-ca\n");
      const setupEnvelopePath = join(directory, "node-setup.json");
      await writeFile(
        setupEnvelopePath,
        JSON.stringify({
          url: "wss://gateway.example.test/node",
          bootstrapToken: "provider-bootstrap-token",
          expiresAtMs: Date.now() + 60_000,
        }),
      );
      // A previous Harness lifetime left the directory as a link into the workspace.
      const hooks = join(directory, ".oce-native-hooks");
      const leak = join(directory, "workspace", "leak");
      await mkdir(leak, { recursive: true });
      await writeFile(join(leak, "planted.json"), "planted");
      await symlink(leak, hooks);
      const { waitFor } = await startSupervisor(t, directory, {
        child: [
          'const { appendFileSync } = require("node:fs");',
          "const [events, kind] = process.argv.slice(2);",
          "appendFileSync(events, JSON.stringify({ kind, pid: process.pid,",
          'caPath: process.env.NODE_EXTRA_CA_CERTS }) + "\\n");',
          "setInterval(() => {}, 1_000);",
        ],
        stubs: pendingIdentityProbe,
        env: { OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath, OPENCLAW_NODE_CA_PATH: caPath },
      });
      const codexRows = (rows: ProcessEventRow[]) => rows.filter((row) => row.kind === "codex");
      const first = codexRows(
        await waitFor("Codex started", (rows) => codexRows(rows).length === 1),
      );
      const assertPrivateHooks = async () => {
        const entry = await lstat(hooks);
        assert.equal(entry.isDirectory(), true);
        assert.equal(entry.mode & 0o777, 0o700);
        assert.equal((await lstat(join(hooks, "gateway-ca.pem"))).isFile(), true);
        assert.equal(await readFile(join(hooks, "gateway-ca.pem"), "utf8"), "gateway-public-ca");
      };
      await assertPrivateHooks();
      const [firstStart] = first;
      assert.ok(firstStart, "Codex recorded its first start");
      assert.equal(firstStart.caPath, join(hooks, "gateway-ca.pem"));
      assert.deepEqual(await readdir(leak), ["planted.json"]);

      // Mid-run, Harness code links the CA copy into the workspace and then swaps the
      // whole directory for a link. A Codex restart rebuilds the directory without
      // writing through either link, and drops the previous process's credentials.
      await writeFile(join(hooks, "relay.g1.json"), "previous-relay-credential", { mode: 0o600 });
      await rm(join(hooks, "gateway-ca.pem"));
      await symlink(join(leak, "linked-ca.pem"), join(hooks, "gateway-ca.pem"));
      process.kill(firstStart.pid, "SIGKILL");
      const second = codexRows(
        await waitFor("Codex restarted", (rows) => codexRows(rows).length === 2),
      );
      await assertPrivateHooks();
      assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
      assert.deepEqual(await readdir(leak), ["planted.json"]);

      await rm(hooks, { recursive: true });
      await symlink(leak, hooks);
      const secondStart = second.at(-1);
      assert.ok(secondStart, "Codex recorded its second start");
      process.kill(secondStart.pid, "SIGKILL");
      await waitFor("Codex restarted again", (rows) => codexRows(rows).length === 3);
      await assertPrivateHooks();
      assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
      assert.deepEqual(await readdir(leak), ["planted.json"]);
    },
  );

  // An earlier Harness lifetime's credentials belong to retired relays. The first Codex
  // start removes them from an intact directory, fixes its mode and replaces a linked CA copy.
  test(
    "the first Codex start removes credentials left by an earlier Harness lifetime",
    {
      timeout: 15_000,
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-node-hook-stale-"));
      const setupEnvelopePath = join(directory, "node-setup.json");
      await writeFile(
        setupEnvelopePath,
        JSON.stringify({
          url: "wss://gateway.example.test/node",
          bootstrapToken: "provider-bootstrap-token",
          expiresAtMs: Date.now() + 60_000,
        }),
      );
      const hooks = join(directory, ".oce-native-hooks");
      const workspace = join(directory, "workspace");
      await mkdir(hooks, { recursive: true, mode: 0o755 });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(hooks, "relay.g0.json"), "retired-relay-credential");
      await symlink(join(workspace, "linked-ca.pem"), join(hooks, "gateway-ca.pem"));
      const { waitFor } = await startSupervisor(t, directory, {
        child: [
          'const { appendFileSync } = require("node:fs");',
          "const [events, kind] = process.argv.slice(2);",
          'appendFileSync(events, JSON.stringify({ kind, pid: process.pid }) + "\\n");',
          "setInterval(() => {}, 1_000);",
        ],
        stubs: pendingIdentityProbe,
        env: {
          OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath,
          OPENCLAW_NODE_CA_PEM: "gateway-public-ca",
        },
      });
      await waitFor("Codex started", (rows) => rows.some(({ kind }) => kind === "codex"));
      assert.equal((await lstat(hooks)).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
      assert.equal((await lstat(join(hooks, "gateway-ca.pem"))).isFile(), true);
      assert.equal(await readFile(join(hooks, "gateway-ca.pem"), "utf8"), "gateway-public-ca");
      assert.deepEqual(await readdir(workspace), []);
    },
  );

  // The model probe uses the inherited proxy CA before the native child adds the
  // provider Gateway CA. Both must survive in the real child's environment.
  for (const topology of ["Compute-owned", "provider-owned"]) {
    test(
      `native worker preserves model-proxy and Gateway CAs when ${topology}`,
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
        // The supervisor binds its status port on every interface; hold it there.
        const statusReservation =
          topology === "Compute-owned" ? await reservePort({ host: "0.0.0.0" }) : undefined;
        t.after(() => statusReservation?.release());
        const statusPort = statusReservation?.port;
        const { supervisor, exited, waitFor, output } = await startSupervisor(t, directory, {
          entrypoint: nativeWorkerEntrypoint,
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
            ...(statusPort === undefined
              ? {}
              : { OPENCLAW_RUNTIME_STATUS_PORT: String(statusPort) }),
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
        const targetPath = node.args[node.args.indexOf("--target-file") + 1];
        assert.ok(targetPath, "native worker received a target file");
        assert.equal(
          await readFile(targetPath, "utf8"),
          Buffer.from(setupEnvelope).toString("base64url"),
        );
        assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
        if (statusReservation !== undefined) {
          // A connection that reaches the reservation is reset; retry until the supervisor answers.
          const ready = await waitFor(
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
      },
    );
  }

  // The production wrapper supervises real processes here. Only the external model
  // probe and native child implementation are substituted; this is not pairing proof.
  async function startNativeProviderWorker(t: TestContext, directory: string, child: string[]) {
    return startSupervisor(t, directory, {
      entrypoint: nativeWorkerEntrypoint,
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

  test(
    "native provider renewal preserves a rolled-back envelope while retiring its node group",
    { timeout: 25_000, skip: process.platform !== "linux" && "Linux process groups are required." },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-refresh-"));
      const setupPath = join(directory, "node-setup.json");
      const identityPath = join(directory, "node-state", "retained-device");
      await mkdir(join(directory, "node-state"));
      await writeFile(identityPath, "retained-private-identity");
      const { exited, events, waitFor, output } = await startNativeProviderWorker(
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
      const readOffset = (await jsonLines(setupReadsPath)).length;
      await writeFile(setupPath, JSON.stringify(latest));
      await waitFor(
        "the retiring native worker observed the rollback",
        (reads) => reads.slice(readOffset).some((read) => read.content === JSON.stringify(latest)),
        () => jsonLines(setupReadsPath),
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
      assert.deepEqual(
        JSON.parse(Buffer.from(replacement.target, "base64url").toString("utf8")),
        latest,
      );
      assert.equal(
        replaced.filter((row) => row.pid === initial.pid && row.event === "terminating").length,
        1,
      );
      await processGone("old native worker survived replacement", initial.pid);
      await processGone("old native descendant survived replacement", descendant.pid);
      assert.equal(await readFile(identityPath, "utf8"), "retained-private-identity");
      assert.equal(
        (await stat(join(directory, "node-state", "connect-target"))).mode & 0o777,
        0o600,
      );
      // Both incarnations intentionally resist TERM, so finish this race fixture
      // through the normal child-exit path after verifying the replacement.
      process.kill(replacement.pid, "SIGKILL");
      assert.deepEqual(await exited, [1, null], output());
      for (const secret of ["initial-bootstrap", "superseded-bootstrap"]) {
        assert.equal(output().includes(secret), false);
      }
    },
  );

  test(
    "operator stop cancels a pending native provider renewal",
    { timeout: 18_000, skip: process.platform !== "linux" && "Linux process groups are required." },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-stop-"));
      const setupPath = join(directory, "node-setup.json");
      await writeFile(setupPath, JSON.stringify(nativeSetup("initial-bootstrap")));
      const { supervisor, exited, events, waitFor } = await startNativeProviderWorker(
        t,
        directory,
        nativeRefreshChild,
      );
      const initial = nativeStarts(
        await waitFor("native worker started", (rows) =>
          rows.some((row) => row.kind === "descendant"),
        ),
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
    },
  );

  test(
    "native provider wrapper preserves a natural child exit code",
    { timeout: 10_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-native-provider-exit-"));
      await writeFile(join(directory, "node-setup.json"), JSON.stringify(maximumSetupEnvelope()));
      const { exited } = await startNativeProviderWorker(t, directory, [
        "const args = JSON.parse(process.argv[4]);",
        'const target = require("node:fs").readFileSync(args[args.indexOf("--target-file") + 1]);',
        'require("node:assert/strict").equal(target.length, 65_536);',
        "process.exit(7);",
      ]);
      assert.deepEqual(await exited, [7, null]);
    },
  );
}
