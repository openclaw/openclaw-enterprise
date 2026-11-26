import assert from "node:assert/strict";
import { once, type EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import {
  generatedPreparation,
  scopedPreparationCaller,
} from "../helpers/codex-preparation-caller.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { WebSocketServer } = createRequire(controllerRequire.resolve("@kubernetes/client-node"))(
  "ws",
);
const selections = {
  "codex-plugin:alpha@openai-curated-remote": { enabled: true },
  "codex-plugin:beta@openai-curated-remote": { enabled: false },
};
const disabled = {
  features: { apps: false, plugins: false, remote_plugin: false },
  apps: { _default: { enabled: false } },
  plugins: { _default: { enabled: false } },
};

type FixtureSocket = {
  on(event: "message", callback: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
};
type FixtureServer = EventEmitter & {
  clients: Set<FixtureSocket>;
  address(): AddressInfo;
  close(callback: (error?: Error) => void): void;
};
type RpcRequest = { id: number | undefined; method: string; params: unknown };
type Edit = { keyPath: string; value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRpcRequest(data: Buffer): RpcRequest {
  const value: unknown = JSON.parse(data.toString());
  assert.ok(isRecord(value));
  assert.ok(typeof value.method === "string");
  assert.ok(value.id === undefined || typeof value.id === "number");
  return { id: value.id, method: value.method, params: value.params };
}

function parseEdits(params: unknown): Edit[] {
  assert.ok(isRecord(params));
  assert.equal(params.reloadUserConfig, true);
  assert.ok(Array.isArray(params.edits));
  return params.edits.map((edit: unknown) => {
    assert.ok(isRecord(edit));
    assert.ok(typeof edit.keyPath === "string");
    return { keyPath: edit.keyPath, value: edit.value };
  });
}

async function startPreparationServer(t: TestContext, credential: string) {
  const server: FixtureServer = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (
      { req }: { req: { headers: { authorization?: string } } },
      done: (valid: boolean, code: number) => void,
    ) => done(req.headers.authorization === "Bearer " + credential, 401),
  });
  t.after(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const methods: string[] = [];
  let written = false;
  server.on("connection", (socket: FixtureSocket) => {
    socket.on("message", (data) => {
      const request = parseRpcRequest(data);
      if (request.method === "initialized") {
        return;
      }
      assert.equal(typeof request.id, "number");
      methods.push(request.method);
      let result: unknown = {};
      switch (request.method) {
        case "initialize":
          break;
        case "config/read":
          result = {
            config: written
              ? disabled
              : { ...disabled, apps: { ...disabled.apps, inherited: { enabled: true } } },
          };
          break;
        case "config/batchWrite": {
          const edits = parseEdits(request.params);
          for (const key of ["apps", "plugins"]) {
            assert.deepEqual(edits.find((edit) => edit.keyPath === key)?.value, {
              _default: { enabled: false },
            });
          }
          assert.ok(
            edits.some((edit) => edit.keyPath === "apps.inherited.enabled" && edit.value === false),
          );
          written = true;
          break;
        }
        default:
          assert.fail("Unexpected preparation RPC method: " + request.method);
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await once(server, "listening");
  return { port: server.address().port, methods };
}

test(
  "Codex no-account preparation uses its supplied caller for disable and readback",
  { timeout: 10_000 },
  async (t) => {
    const credential = "connection-owned-fixture";
    const { port, methods } = await startPreparationServer(t, credential);
    const generated = generatedPreparation({
      CODEX_LOGIN_MODE: "api_key",
      APP_SERVER_TOKEN: "hostile-ambient-fixture",
      OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25",
    });
    const caller = scopedPreparationCaller(port, credential, generated.CodexAppServerRequestError);
    t.after(caller.close);
    const runtime = { manifest: { kind: "codex", selections } };

    // No caller is needed for empty selection, but a selected disable must not
    // silently switch to ambient transport.
    await generated.installCodexPlugins({ manifest: { kind: "codex", selections: {} } }, []);
    await assert.rejects(
      generated.installCodexPlugins(runtime, []),
      /requires a native request caller/,
    );
    assert.deepEqual(methods, []);
    const result = await generated.installCodexPlugins(runtime, [], caller.request);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      successfulPluginIds: [],
      failures: [
        { pluginId: "codex-plugin:alpha@openai-curated-remote", code: "PLUGIN_AUTH_REQUIRED" },
      ],
    });
    assert.deepEqual(methods, ["initialize", "config/read", "config/batchWrite", "config/read"]);
  },
);
