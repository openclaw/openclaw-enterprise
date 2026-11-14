import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import type { TestContext } from "node:test";
import vm from "node:vm";
import { gatewayRuntimeEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  readRuntimeStatusFromHandler,
  readStatusFromHandler,
} from "../fixtures/codex-native-startup.mjs";
import { listen as listenServer } from "./listen.ts";

type PeerFailure = { pluginId: string; code: string };
type PeerStatus = {
  revisionId: string;
  container: string;
  startupId: string;
  podUid: string;
  phase: string;
  successfulPluginIds: string[];
  failures: PeerFailure[];
};
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type Child = {
  token: string;
  env: NodeJS.ProcessEnv;
  config: unknown;
  killed: (NodeJS.Signals | undefined)[];
  exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  listeners: ExitListener[];
  kill(signal?: NodeJS.Signals): void;
  on(event: string, listener: ExitListener): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
};
type StatusHandler = (
  request: { method: string; url: string },
  response: {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(chunk?: string | Buffer): void;
  },
) => void | Promise<void>;
type SpawnOptions = { env: NodeJS.ProcessEnv };
type SupervisorState = {
  revisionId: string;
  initialFailure: PeerFailure;
  peerStatus: PeerStatus;
  peerAvailable: boolean;
  peerRequests: number;
  peerGate?: Promise<unknown>;
  peerRequestPending?: boolean;
  serving: boolean;
  readinessProbes: { child: number; status: number }[];
  validation: { status: number | null; stdout: string; error?: Error };
  validations: number;
  children: Child[];
  exits: number[];
  intervals: { callback: () => unknown; delay: number }[];
  logs: unknown[];
  signalHandlers: Record<string, () => unknown>;
  statusHandler: StatusHandler | undefined;
  files: Map<string, string | undefined>;
  tearWrite?: ((path: string) => boolean) | undefined;
  failConfigWrite?: { remaining: number; after?: boolean } | undefined;
};
type SupervisorOptions = {
  bindingDeviceId?: string;
  writableConfig?: boolean;
  managedMode?: boolean;
  savedFiles?: ReadonlyMap<string, string | undefined>;
  initialPeerStatus?: PeerStatus;
  runtimeStatus?: boolean;
  expectStart?: boolean;
};
type SupervisorDependencies = {
  provenance: string;
  buildManifest(): unknown;
  pluginAppServerToken(baseToken: string, revisionId: string, startupId: string): string;
  waitForCondition(description: string, condition: () => boolean): Promise<unknown>;
  nodeRequire(specifier: string): unknown;
};

function plain(value: readonly string[]): unknown {
  return JSON.parse(JSON.stringify(value));
}

// Runs the Kubernetes Codex Gateway wrapper against a real HTTP Harness peer
// status endpoint and a real readiness endpoint standing in for OpenClaw.
export async function startCodexGatewaySupervisor(
  t: TestContext,
  {
    provenance,
    buildManifest,
    pluginAppServerToken,
    waitForCondition,
    nodeRequire,
  }: SupervisorDependencies,
  {
    bindingDeviceId,
    writableConfig = false,
    managedMode = false,
    savedFiles,
    initialPeerStatus,
    runtimeStatus = false,
    expectStart = true,
  }: SupervisorOptions = {},
) {
  const peerHttp = await import("node:http");
  const configurationPath = writableConfig
    ? "/home/node/.openclaw/openclaw.json"
    : "/etc/openclaw/openclaw.json";
  const revisionId = "revision-plugin-compute-1";
  const initialFailure = {
    pluginId: "codex-plugin:linear@openai-curated-remote",
    code: "PLUGIN_AUTH_REQUIRED",
  };
  const fixture: SupervisorState = {
    revisionId,
    initialFailure,
    peerStatus: {
      revisionId,
      container: "agent",
      startupId: "agent-startup-1",
      podUid: "agent-pod-1",
      phase: "ready",
      successfulPluginIds: [],
      failures: [initialFailure],
    },
    peerAvailable: true,
    peerRequests: 0,
    serving: true,
    readinessProbes: [],
    // What OpenClaw's config validator reports, and how often the wrapper ran it.
    validation: { status: 0, stdout: JSON.stringify({ valid: true }) },
    validations: 0,
    children: [],
    exits: [],
    intervals: [],
    logs: [],
    signalHandlers: {},
    statusHandler: undefined,
    files: new Map([
      ["/opt/oce/runtime/provenance.json", provenance],
      [
        configurationPath,
        JSON.stringify({
          gateway: { port: 8080 },
          plugins: { installs: { keep: { source: "npm" } }, load: { paths: ["existing"] } },
          tools: { alsoAllow: ["existing-tool"] },
        }),
      ],
    ]),
  };
  if (writableConfig) {
    fixture.files.set("/etc/openclaw-managed/openclaw.json", fixture.files.get(configurationPath));
  }
  if (savedFiles !== undefined) {
    fixture.files = new Map(savedFiles);
  }
  // The kubelet creates an empty termination log for each container instance; /tmp, an
  // emptyDir, keeps what an earlier instance of the Pod saved there.
  fixture.files.set("/dev/termination-log", "");
  if (initialPeerStatus !== undefined) {
    fixture.peerStatus = initialPeerStatus;
  }
  if (bindingDeviceId !== undefined) {
    fixture.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId, deviceId: bindingDeviceId }),
    );
  }
  const listen = (handler: RequestListener): Promise<number> =>
    listenServer(t, peerHttp.createServer(handler));
  const peerPort = await listen(async (request, response) => {
    assert.equal(request.url, "/openclaw/plugin-runtime/status");
    fixture.peerRequests++;
    if (fixture.peerGate !== undefined) {
      fixture.peerRequestPending = true;
      await fixture.peerGate;
    }
    if (!fixture.peerAvailable) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fixture.peerStatus));
  });
  // The native Gateway's own readiness endpoints, answered only while serving.
  const gatewayPort = await listen((request, response) => {
    assert.ok(
      request.url !== undefined && ["/readyz", "/startupz"].includes(request.url),
      request.url!,
    );
    const live = fixture.children.at(-1);
    const status = fixture.serving && live?.exited === undefined ? 200 : 503;
    fixture.readinessProbes.push({ child: fixture.children.length, status });
    response.writeHead(status).end();
  });
  const fixtureWithPort = Object.assign(fixture, { gatewayPort });
  const sandbox = {
    AbortSignal,
    Buffer,
    structuredClone,
    JSON,
    URL,
    console: {
      error(value: unknown) {
        fixture.logs.push(value);
      },
    },
    fetch,
    process: {
      env: {
        APP_SERVER_TOKEN: "base-app-server-token",
        APP_SERVER_URL: `ws://127.0.0.1:${peerPort}`,
        HOME: "/home/node",
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        OPENCLAW_CONFIG_PATH: configurationPath,
        OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: buildManifest() }),
        OPENCLAW_PLUGIN_STATUS_CONTAINER: "gateway",
        OPENCLAW_PLUGIN_STATUS_PORT: String(peerPort),
        OPENCLAW_POD_UID: "gateway-pod-1",
        ...(bindingDeviceId === undefined
          ? {}
          : {
              OPENCLAW_WORKSPACE_NODE_PATH: "/home/node/workspace-node-binding/workspace-node.json",
            }),
        ...(bindingDeviceId === undefined && !runtimeStatus
          ? {}
          : {
              OPENCLAW_RUNTIME_STATUS_PORT: "18792",
              OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
            }),
      },
      on(signal: string, handler: () => unknown) {
        fixture.signalHandlers[signal] = handler;
      },
      exit(code: number) {
        fixture.exits.push(code);
      },
    },
    setInterval(callback: () => unknown, delay: number) {
      fixture.intervals.push({ callback, delay });
      return { unref() {} };
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    require(specifier: string): unknown {
      if (specifier === "node:http") {
        return {
          createServer(handler: StatusHandler) {
            fixture.statusHandler = handler;
            return { listen() {} };
          },
          // Readiness reaches the fixture's native Gateway port.
          get: peerHttp.get,
        };
      }
      if (specifier === "node:fs") {
        return {
          existsSync: (path: string) => fixture.files.has(path),
          lstatSync(path: string) {
            if (!fixture.files.has(path)) {
              throw Object.assign(new Error("File not found"), { code: "ENOENT" });
            }
            return { isFile: () => true, mode: 0o600 };
          },
          mkdirSync() {},
          readFileSync(path: string) {
            if (!fixture.files.has(path)) {
              throw new Error(`Missing mocked file: ${path}`);
            }
            return fixture.files.get(path);
          },
          writeFileSync(path: string, data: unknown) {
            // A write that stops half-way, as a crash would leave the file.
            if (fixture.tearWrite?.(path)) {
              fixture.tearWrite = undefined;
              fixture.files.set(path, String(data).slice(0, -5));
              throw new Error("Interrupted write");
            }
            fixture.files.set(path, String(data));
          },
          renameSync(from: string, to: string) {
            const failure = fixture.failConfigWrite;
            if (to === configurationPath && failure !== undefined && --failure.remaining === 0) {
              fixture.failConfigWrite = undefined;
              if (failure.after) {
                fixture.files.set(to, fixture.files.get(from));
                fixture.files.delete(from);
              }
              throw new Error("Interrupted configuration replacement");
            }
            fixture.files.set(to, fixture.files.get(from));
            fixture.files.delete(from);
          },
          rmSync(path: string) {
            fixture.files.delete(path);
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command: string, args: readonly string[], options: SpawnOptions) {
            assert.equal(command, "node");
            assert.deepEqual(plain(args), [
              "/app/openclaw.mjs",
              "gateway",
              "--port",
              String(gatewayPort),
            ]);
            const child: Child = {
              token: sandbox.process.env.APP_SERVER_TOKEN,
              env: { ...options.env },
              config: JSON.parse(String(fixture.files.get("/home/node/.openclaw/openclaw.json"))),
              killed: [],
              exited: undefined,
              listeners: [],
              kill(signal) {
                this.killed.push(signal);
              },
              on(event, listener) {
                if (event === "exit") {
                  this.listeners.push(listener);
                }
              },
              exit(code, signal) {
                this.exited = { code, signal };
                for (const listener of this.listeners) {
                  listener(code, signal);
                }
              },
            };
            fixture.children.push(child);
            return child;
          },
          spawnSync(command: string, args: readonly string[], options: SpawnOptions) {
            // Native image tests separately exercise the real config validator.
            assert.equal(command, "node");
            assert.deepEqual(plain(args), ["/app/openclaw.mjs", "config", "validate", "--json"]);
            assert.equal(options.env.OPENCLAW_CONFIG_READONLY, "1");
            fixture.validations++;
            return fixture.validation;
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  const mutableSandbox: typeof sandbox & { AbortController?: typeof AbortController } = sandbox;
  const supervisor = Object.assign(fixtureWithPort, {
    sandbox: mutableSandbox,
    status: (): unknown => readStatusFromHandler(fixture.statusHandler),
    runtimeStatus: (): unknown => readRuntimeStatusFromHandler(fixture.statusHandler),
    token: (startupId: string) =>
      pluginAppServerToken("base-app-server-token", revisionId, startupId),
    // The peer status poll runs every two seconds; a Gateway stop adds its own recheck.
    pollPeer: () =>
      fixture.intervals
        .slice()
        .reverse()
        .find(({ delay }) => delay === 2_000)!
        .callback(),
  });
  vm.runInNewContext(gatewayRuntimeEntrypoint(managedMode), sandbox);
  if (expectStart) {
    await waitForCondition("gateway supervisor start", () => fixture.children.length === 1);
  }
  return supervisor;
}
