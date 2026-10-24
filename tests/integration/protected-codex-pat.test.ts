import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";

import { PROTECTED_CODEX_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { pluginRuntimeConfigMapData } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";

const nodeRequire = createRequire(import.meta.url);
const transport = "fixture-transport";
const marker = "oce-protected-egress";
const execution = {
  installationId: "installation",
  namespaceId: "namespace",
  agentId: "agent",
  servicePrincipalId: "principal",
  revisionId: "revision",
  executionId: "execution",
};
const enrollment = {
  routeCount: 4,
  inference: true,
  plan: { id: "plan", generation: 1 },
  execution,
};

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function startup(t: TestContext, token: string, loginAccepted = true) {
  const root = mkdtempSync(join(tmpdir(), "protected-codex-pat-"));
  const readyMarker = join(root, "ready");
  writeFileSync(readyMarker, "stale");
  const timers = new Set<NodeJS.Timeout>();
  t.after(() => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync("ed25519");
  const artifacts = pluginRuntimeConfigMapData({
    kind: "codex",
    selections: {},
    nativePat: true,
    providerTools: "none",
    egressEnrollment: enrollment,
  });
  const environment = {
    OPENCLAW_PLUGIN_READY_MARKER: readyMarker,
    CODEX_HOME: join(root, "codex"),
    OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
    TMPDIR: root,
    OPENCLAW_HARNESS_MODEL: "codex/selected-model",
    CODEX_LOGIN_MODE: "codex_pat",
    CODEX_ACCESS_TOKEN: token,
    OCE_CODEX_CREDENTIAL_SOURCE: "1",
    APP_TOKEN_SHA: createHash("sha256").update(transport).digest("hex"),
    APP_SERVER_PORT: "4444",
    OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: execution.revisionId,
    OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY: keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({
      manifest: JSON.parse(artifacts["runtime.json"]!),
      codexConfigurationToml: artifacts["config.toml"],
    }),
  };
  const calls: Array<{
    args: string[];
    env: Record<string, string>;
    auth: unknown;
    mode: number;
    config: string;
  }> = [];
  const record = (args: string[], options: { env: Record<string, string> }) => {
    const auth = join(environment.CODEX_HOME, "auth.json");
    calls.push({
      args: Array.from(args),
      env: options.env,
      auth: JSON.parse(readFileSync(auth, "utf8")),
      mode: statSync(auth).mode & 0o777,
      config: readFileSync(join(environment.CODEX_HOME, "config.toml"), "utf8"),
    });
  };
  let handler: Handler | undefined;
  const sandbox = {
    URL,
    Buffer,
    performance,
    console: { error() {} },
    clearTimeout,
    setInterval() {},
    setTimeout(callback: () => void, ms: number) {
      const timer = setTimeout(callback, ms);
      timers.add(timer);
      return timer;
    },
    process: {
      env: environment,
      geteuid: process.geteuid,
      on() {},
      exit() {
        throw new Error("unexpected process exit");
      },
    },
    require(specifier: string) {
      if (specifier === "node:http") {
        return {
          createServer(next: Handler) {
            return {
              listen() {
                handler ??= next;
              },
              on() {},
              close(done: () => void) {
                done();
              },
              closeAllConnections() {},
            };
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawnSync(_command: string, args: string[], options: { env: Record<string, string> }) {
            record(args, options);
            if (args.includes("login")) {
              return loginAccepted
                ? { status: 0 }
                : { status: 1, stderr: "status 503 Service Unavailable" };
            }
            return {
              status: 0,
              stdout: [
                { type: "turn.started" },
                { type: "item.completed", item: { type: "agent_message", text: "READY" } },
                { type: "turn.completed" },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n"),
            };
          },
          spawn(_command: string, args: string[], options: { env: Record<string, string> }) {
            record(args, options);
            return { on() {}, kill() {}, stderr: null };
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  return {
    environment,
    calls,
    keys,
    run() {
      runInNewContext(PROTECTED_CODEX_RUNTIME_ENTRYPOINT, sandbox);
      return handler;
    },
  };
}

test("protected native Codex rejects a non-marker before filesystem writes or login", (t) => {
  const fixture = startup(t, "invented-unapproved-value");
  assert.throws(() => fixture.run(), /protected native PAT/i);
  assert.equal(existsSync(fixture.environment.CODEX_HOME), false);
  assert.equal(existsSync(fixture.environment.OPENCLAW_PLUGIN_READY_MARKER), false);
  assert.deepEqual(fixture.calls, []);
});

test("protected native Codex refuses a replaced home without writing credentials into it", (t) => {
  const fixture = startup(t, marker);
  const { CODEX_HOME: home, TMPDIR: root } = fixture.environment;
  const replacement = mkdtempSync(join(root, "replacement-"));
  const chmod = fs.fchmodSync;
  let replaced = false;
  // Substitute the path exactly when startup has checked and tightened its directory.
  t.mock.method(fs, "fchmodSync", (fd: number, mode: fs.Mode) => {
    chmod(fd, mode);
    if (fs.readlinkSync("/proc/self/fd/" + fd) === home) {
      fs.renameSync(home, join(root, "original"));
      fs.symlinkSync(replacement, home);
      replaced = true;
    }
  });
  let failure: unknown;
  try {
    fixture.run();
  } catch (error) {
    failure = error;
  }
  assert.ok(replaced);
  assert.equal(
    existsSync(join(replacement, "auth.json")),
    false,
    "credential reached the replacement",
  );
  assert.match(String(failure), /credential home changed/i);
  assert.deepEqual(fixture.calls, []);
});

async function release(fixture: ReturnType<typeof startup>, handler = fixture.run()) {
  assert.ok(handler);
  assert.deepEqual(fixture.calls, [], "native login waits for signed enrollment");
  assert.equal(existsSync(fixture.environment.OPENCLAW_PLUGIN_READY_MARKER), false);
  const exchange = async (method: string, body?: unknown) => {
    let result: { startupId: string } | undefined;
    let finished: (() => void) | undefined;
    await handler(
      {
        method,
        url: "/openclaw/runtime/egress-enrollment",
        headers: { authorization: "Bearer " + transport, "content-type": "application/json" },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(body));
        },
      } as unknown as IncomingMessage,
      {
        writeHead(status: number) {
          assert.equal(status, 200);
        },
        on(_name: string, callback: () => void) {
          finished = callback;
        },
        end(raw: string) {
          result = JSON.parse(raw);
          finished?.();
        },
      } as unknown as ServerResponse,
    );
    return result!;
  };
  const challenge = await exchange("GET");
  const installation = {
    sandboxId: "sandbox",
    instanceId: "instance",
    configurationId: "configuration",
    peerKeyId: "peer",
  };
  const expiresAt = Date.now() + 30_000;
  const signature = sign(
    null,
    Buffer.from(JSON.stringify([challenge, installation, expiresAt])),
    fixture.keys.privateKey,
  ).toString("base64url");
  await exchange("POST", { challenge, installation, expiresAt, signature });
  await new Promise((resolve) => setImmediate(resolve));
}

for (const mutation of ["recreated home", "wider home mode", "replaced credential"] as const) {
  test(`protected native Codex refuses a ${mutation} at signed release`, async (t) => {
    const fixture = startup(t, marker);
    const handler = fixture.run();
    assert.ok(handler);
    const { CODEX_HOME: home, TMPDIR: root } = fixture.environment;
    if (mutation === "recreated home") {
      const entries = fs.readdirSync(home);
      for (const entry of entries) fs.renameSync(join(home, entry), join(root, entry));
      fs.rmdirSync(home);
      fs.mkdirSync(home, { mode: 0o700 });
      for (const entry of entries) fs.renameSync(join(root, entry), join(home, entry));
    } else if (mutation === "wider home mode") {
      fs.chmodSync(home, 0o755);
    } else {
      fs.renameSync(join(home, "auth.json"), join(root, "original-auth"));
      writeFileSync(join(home, "auth.json"), "{}", { mode: 0o600 });
    }
    await release(fixture, handler);
    assert.deepEqual(fixture.calls, []);
    assert.equal(existsSync(fixture.environment.OPENCLAW_PLUGIN_READY_MARKER), false);
  });
}

test("protected native Codex passes its fixed workspace profile to startup and the app server", async (t) => {
  // Enrollment and the generated wrapper are real; the native executable is the controlled boundary.
  const fixture = startup(t, marker);
  await release(fixture);
  assert.equal(fixture.calls.length, 3);
  const [login, probe, appServer] = fixture.calls;
  assert.deepEqual(login!.args, ["-c", "cli_auth_credentials_store=file", "login", "status"]);
  assert.deepEqual(login!.auth, { personal_access_token: marker });
  assert.equal(login!.mode, 0o600);
  assert.equal(Object.hasOwn(login!.env, "CODEX_ACCESS_TOKEN"), false);
  assert.ok(probe!.args.includes("exec"));
  assert.ok(probe!.args.includes("enable_request_compression"));
  assert.ok(
    probe!.args.includes(
      'model_providers.oce-codex-workspace.base_url="https://chatgpt.com/backend-api/codex"',
    ),
  );
  assert.ok(probe!.args.includes("model_providers.oce-codex-workspace.supports_websockets=false"));
  assert.ok(probe!.args.includes("model_providers.oce-codex-workspace.request_max_retries=0"));
  assert.ok(probe!.args.includes("model_providers.oce-codex-workspace.stream_max_retries=0"));
  assert.ok(appServer!.args.includes("app-server"));
  assert.equal(Object.hasOwn(appServer!.env, "CODEX_ACCESS_TOKEN"), false);
  assert.equal(appServer!.config, login!.config);
  const config = appServer!.config;
  assert.match(config, /name = "OpenAI"/);
  assert.match(config, /base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/);
  assert.match(config, /supports_websockets = false/);
  assert.match(config, /enable_request_compression = false/);
  assert.match(config, /request_max_retries = 0/);
  assert.match(config, /stream_max_retries = 0/);
});

test("protected native Codex does not retry a failed authenticated bootstrap", async (t) => {
  const fixture = startup(t, marker, false);
  await release(fixture);
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.calls[0]!.args.includes("login"));
});
