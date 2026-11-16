import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  codexLinearPluginState,
  gatewayRuntimeProvenance,
  nodeRequire,
  parseJson,
  plain,
  pluginAppServerToken,
  property,
  record,
  required,
  revision,
  runGeneratedProgram,
  text,
  waitForCondition,
} from "./plugin-compute-fixtures.ts";
import {
  type StatusHandler,
  readReadyStatusFromHandler,
  readStatusFromHandler,
} from "./plugin-compute-status.ts";
import { DELIBERATE_RESTART, startCodexGatewaySupervisor } from "./plugin-compute-supervisor.ts";

export function registerGatewayPeerState(): void {
  // On a first dedicated deploy the Gateway starts alongside its Harness, and the
  // agent Service lists the Harness only once it is ready. The Gateway waits for
  // the Harness plugin status without a deadline: it neither exits nor reports
  // ready until the Harness really reports.
  test("Codex gateway supervisor waits for its Harness plugin status without a deadline", async () => {
    const revisionId = "revision-plugin-compute-1";
    const runtime = pluginRuntimeSpecForRevision(
      revision({
        plugins: codexLinearPluginState({
          toolDefaults: { approval: "provider_default", reviewer: "auto" },
        }),
      }),
    );
    const files = new Map([
      ["/opt/oce/runtime/provenance.json", gatewayRuntimeProvenance],
      [
        "/etc/openclaw/openclaw.json",
        JSON.stringify({
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        }),
      ],
    ]);
    const peerStatus = {
      revisionId,
      container: "agent",
      startupId: "agent-startup-1",
      podUid: "agent-pod-1",
      phase: "ready",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    // Harness not ready yet: no Service endpoint, then an unready status port,
    // then a Harness still installing its plugins.
    const unavailable = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve({ status: 503, json: async () => ({}) }),
      () =>
        Promise.resolve({ status: 200, json: async () => ({ ...peerStatus, phase: "starting" }) }),
    ];
    let peerReady = false;
    let fetches = 0;
    const waits: (() => void)[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    let now = 0;
    let statusHandler: StatusHandler | undefined;
    let child: { kill(): void; on(): void } | undefined;
    class FixtureDate extends Date {
      static override now() {
        return now;
      }
    }
    const sandbox = {
      AbortSignal,
      Buffer,
      structuredClone,
      JSON,
      URL,
      Date: FixtureDate,
      console: { error: (message: string) => errors.push(message) },
      fetch(url: URL) {
        assert.equal(
          String(url),
          "http://agent-fixture.harness.svc:18791/openclaw/plugin-runtime/status",
        );
        fetches++;
        if (peerReady) {
          return Promise.resolve({ status: 200, json: async () => peerStatus });
        }
        return required(unavailable[(fetches - 1) % unavailable.length])();
      },
      process: {
        env: {
          APP_SERVER_TOKEN: "base-app-server-token",
          APP_SERVER_URL: "ws://agent-fixture.harness.svc:4500",
          HOME: "/home/node",
          OPENCLAW_AGENT_REVISION_ID: revisionId,
          OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
          OPENCLAW_GATEWAY_PORT: "8080",
          OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: runtime }),
          OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
          OPENCLAW_PLUGIN_STATUS_PORT: "18791",
          OPENCLAW_POD_UID: "gateway-pod-1",
        },
        on() {},
        exit(code: number) {
          exits.push(code);
        },
      },
      setInterval() {
        return { unref() {} };
      },
      setTimeout(callback: () => void, delay: number) {
        if (delay === 250) {
          waits.push(callback);
        }
        return { unref() {} };
      },
      clearTimeout() {},
      require(specifier: string) {
        if (specifier === "node:http") {
          return {
            createServer(handler: StatusHandler) {
              statusHandler = handler;
              return { listen() {} };
            },
          };
        }
        if (specifier === "node:fs") {
          return {
            existsSync(path: string) {
              return files.has(path);
            },
            lstatSync(path: string) {
              if (!files.has(path)) {
                throw Object.assign(new Error("File not found"), { code: "ENOENT" });
              }
              return { isFile: () => true, mode: 0o600 };
            },
            mkdirSync() {},
            readFileSync(path: string) {
              if (!files.has(path)) {
                throw new Error(`Missing mocked file: ${path}`);
              }
              return files.get(path);
            },
            writeFileSync(path: string, data: unknown) {
              files.set(path, String(data));
            },
          };
        }
        if (specifier === "node:child_process") {
          return {
            spawn() {
              child = { kill() {}, on() {} };
              return child;
            },
            spawnSync(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
              // Native image tests separately exercise the real config validator.
              assert.equal(command, "node");
              assert.deepEqual(plain(args), ["/app/openclaw.mjs", "config", "validate", "--json"]);
              assert.equal(options.env.OPENCLAW_CONFIG_READONLY, "1");
              return { status: 0, stdout: JSON.stringify({ valid: true }) };
            },
          };
        }
        return nodeRequire(specifier);
      },
    };

    runGeneratedProgram(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
    // Twelve failed reads, each ten minutes apart: far beyond the former 60 s deadline
    // and the controller's own 900 s convergence deadline.
    for (let attempt = 0; attempt < 12; attempt++) {
      await waitForCondition("the next peer status retry", () => waits.length > 0);
      assert.equal(child, undefined, "the Gateway must not start before its Harness reports");
      assert.equal(readStatusFromHandler(statusHandler).phase, "starting");
      now += 10 * 60_000;
      required(waits.shift())();
    }
    await waitForCondition("the next peer status retry", () => waits.length > 0);
    assert.equal(fetches, 13);
    assert.deepEqual(exits, [], "a slow Harness must not exit the Gateway supervisor");
    assert.equal(child, undefined);
    assert.equal(readStatusFromHandler(statusHandler).phase, "starting");
    // The wait reports why it is still waiting, never a token or the peer address.
    assert.ok(errors.length > 0);
    for (const message of errors) {
      assert.match(message, /^Waiting for Harness plugin runtime status: /);
      assert.doesNotMatch(message, /base-app-server-token|agent-fixture/);
    }

    peerReady = true;
    required(waits.shift())();
    await waitForCondition("gateway supervisor start", () => child);
    assert.equal(fetches, 14);
    assert.deepEqual(exits, []);
    const status = readStatusFromHandler(statusHandler);
    assert.equal(status.phase, "ready");
    assert.deepEqual(status.successfulPluginIds, peerStatus.successfulPluginIds);
    assert.equal(
      sandbox.process.env.APP_SERVER_TOKEN,
      pluginAppServerToken("base-app-server-token", revisionId, peerStatus.startupId),
    );
  });

  test("Codex gateway supervisor recovers a changed peer after restarting with its writable copy", async (t) => {
    const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const path = "/home/node/.openclaw/openclaw.json";
    const edited = record(parseJson(previous.files.get(path)));
    edited.messages = { responsePrefix: "Native admin edit" };
    previous.files.set(path, JSON.stringify(edited));
    const gateway = await startCodexGatewaySupervisor(t, {
      writableConfig: true,
      savedFiles: previous.files,
      initialPeerStatus: {
        ...previous.peerStatus,
        startupId: "agent-startup-2",
        podUid: "agent-pod-2",
        successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
        failures: [],
      },
    });
    assert.equal(
      property(required(gateway.children[0]).config, "messages", "responsePrefix"),
      "Native admin edit",
    );
    assert.equal(
      property(
        required(gateway.children[0]).config,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      true,
    );
    assert.equal(required(gateway.children[0]).token, gateway.token("agent-startup-2"));
    assert.equal(property(gateway.status(), "phase"), "ready");
    assert.deepEqual(gateway.exits, []);
  });

  for (const after of [false, true]) {
    test(`Codex gateway supervisor replays provenance after an interrupted bridge write (after=${after})`, async (t) => {
      const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
      const first = required(previous.children[0]);
      previous.peerStatus = {
        ...previous.peerStatus,
        startupId: "agent-startup-2",
        podUid: "agent-pod-2",
        successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
        failures: [],
      };
      previous.failConfigWrite = { remaining: 2, after };
      const respawn = previous.pollPeer();
      await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
      first.exit(null, "SIGTERM");
      await respawn;
      assert.deepEqual(previous.exits, [DELIBERATE_RESTART]);
      const gateway = await startCodexGatewaySupervisor(t, {
        writableConfig: true,
        savedFiles: previous.files,
        initialPeerStatus: previous.peerStatus,
      });
      assert.equal(
        property(
          required(gateway.children[0]).config,
          "plugins",
          "entries",
          "codex",
          "config",
          "codexPlugins",
          "plugins",
          "linear",
          "enabled",
        ),
        true,
      );
      assert.equal(property(gateway.status(), "phase"), "ready");
      assert.deepEqual(gateway.exits, []);
    });
  }

  test("Codex gateway supervisor keeps its peer bridge record usable after an interrupted record write", async (t) => {
    const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const first = required(previous.children[0]);
    const record = "/home/node/.openclaw/openclaw.json.oce-peer-bridge.json";
    const kept = previous.files.get(record);
    previous.peerStatus = {
      ...previous.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    // The record is replaced through a pending file, so a crash mid-write leaves the old one.
    previous.tearWrite = (path) => path.startsWith(record);
    const respawn = previous.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await respawn;
    assert.deepEqual(previous.exits, [DELIBERATE_RESTART]);
    assert.equal(previous.tearWrite, undefined, "the record write should have been interrupted");
    assert.equal(previous.files.get(record), kept);
    assert.equal(previous.files.has(`${record}.pending`), false);
    const gateway = await startCodexGatewaySupervisor(t, {
      writableConfig: true,
      savedFiles: previous.files,
      initialPeerStatus: previous.peerStatus,
    });
    assert.equal(
      property(
        required(gateway.children[0]).config,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      true,
    );
    assert.equal(property(gateway.status(), "phase"), "ready");
    assert.deepEqual(gateway.exits, []);
  });

  // The Pod-local bridge record survives container restarts, so an unusable one
  // would fail every restart the same way until the Pod is replaced. The wrapper
  // holds unready instead, names the file and the remedy, reports the failure on
  // the runtime status port and keeps the record (removing it could overwrite
  // native edits with a rebuilt bridge).
  for (const [name, changeRecord, problem, snapshot = (text: string) => text] of [
    ["empty", () => "", "is unreadable"],
    ["truncated", (saved: string) => saved.slice(0, -5), "is unreadable"],
    ["null", () => "null", "does not match the admitted revision"],
    ["an array", () => "[]", "does not match the admitted revision"],
    [
      "another revision",
      (saved: string) =>
        JSON.stringify({ ...record(parseJson(saved)), revisionId: "another-revision" }),
      "does not match the admitted revision",
    ],
    [
      "another managed snapshot",
      (saved: string) =>
        JSON.stringify({ ...record(parseJson(saved)), sourceHash: "0".repeat(64) }),
      "does not match the admitted revision",
    ],
    [
      "another record version",
      (saved: string) => JSON.stringify({ ...record(parseJson(saved)), version: 2 }),
      "does not match the admitted revision",
    ],
    [
      "missing its bridges",
      (saved: string) => JSON.stringify({ ...record(parseJson(saved)), bridges: undefined }),
      "does not match the admitted revision",
    ],
    [
      "holding three bridges",
      (saved: string) => JSON.stringify({ ...record(parseJson(saved)), bridges: [{}, {}, {}] }),
      "does not match the admitted revision",
    ],
    [
      "holding a bridge that is not an object",
      (saved: string) => JSON.stringify({ ...record(parseJson(saved)), bridges: ["bridge"] }),
      "does not match the admitted revision",
    ],
    [
      // The record is intact, but the managed snapshot it was written for changed.
      "written for an earlier managed snapshot",
      (saved: string) => saved,
      "does not match the admitted revision",
      (snapshot: string) =>
        JSON.stringify({ ...record(parseJson(snapshot)), tools: { alsoAllow: [] } }),
    ],
  ] as const) {
    test(`Codex gateway supervisor holds with a named remedy for a peer bridge record that is ${name}`, async (t) => {
      const previous = await startCodexGatewaySupervisor(t, { writableConfig: true });
      const path = "/home/node/.openclaw/openclaw.json.oce-peer-bridge.json";
      let savedFiles = new Map(previous.files);
      savedFiles.set(path, changeRecord(required(savedFiles.get(path))));
      const managed = "/etc/openclaw-managed/openclaw.json";
      savedFiles.set(managed, snapshot(required(savedFiles.get(managed))));
      const saved = savedFiles.get(path);
      // A container restart in the same Pod starts again from the files the last one left.
      for (let restart = 0; restart < 2; restart++) {
        const gateway = await startCodexGatewaySupervisor(t, {
          writableConfig: true,
          savedFiles,
          runtimeStatus: true,
          expectStart: false,
        });
        savedFiles = gateway.files;
        // Longer than a loopback peer round trip: a wrapper that went on past the hold
        // would have asked its Harness peer by now.
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(gateway.peerRequests, 0, "the held wrapper never asks its Harness peer");
        assert.deepEqual(gateway.children, [], "OpenClaw must not start from an unusable record");
        assert.deepEqual(gateway.exits, [], "the wrapper holds rather than crash-looping");
        assert.equal(gateway.files.get(path), saved, "the record is kept for Pod replacement");
        assert.ok(
          gateway.logs.includes(
            `Gateway peer configuration record ${path} ${problem}. OpenClaw was not started. ` +
              "Delete the Pod to restore the managed configuration snapshot; native configuration " +
              "edits in this Pod are lost.",
          ),
          JSON.stringify(gateway.logs),
        );
        const phases = gateway.logs
          .filter((line) => typeof line === "string" && line.startsWith("{"))
          .map((line) => record(parseJson(text(line))))
          .filter(({ event }) => event === "runtime.startup_phase")
          .map(({ phase, outcome, code }) => ({ phase, outcome, code }));
        assert.deepEqual(phases, [
          { phase: "peer-bridge-record", outcome: "failed", code: "PEER_BRIDGE_RECORD_UNUSABLE" },
        ]);
        const runtimeFailure = record(property(gateway.runtimeStatus(), "runtimeFailure"));
        assert.equal(runtimeFailure.check, "peer-bridge-record");
        assert.equal(runtimeFailure.code, "UNAVAILABLE");
        assert.equal(property(gateway.status(), "phase"), "starting");
        assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
        // The remedy deletes the Pod: termination ends the held wrapper at once.
        required(gateway.signalHandlers.SIGTERM)();
        assert.deepEqual(gateway.exits, [0]);
      }
    });
  }
}
