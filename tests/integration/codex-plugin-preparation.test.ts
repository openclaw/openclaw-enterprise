import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
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

test(
  "Codex no-account preparation uses its supplied caller for disable and readback",
  { timeout: 10_000 },
  async (t) => {
    const credential = "connection-owned-fixture";
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (
        { req }: { req: { headers: { authorization?: string } } },
        done: (valid: boolean, code: number) => void,
      ) => done(req.headers.authorization === "Bearer " + credential, 401),
    });
    t.after(() => {
      for (const socket of server.clients) {
        socket.terminate();
      }
      server.close();
    });
    await once(server, "listening");
    const methods: string[] = [];
    let written = false;
    server.on(
      "connection",
      (socket: {
        on(event: string, callback: (data: Buffer) => void): void;
        send(data: string): void;
      }) => {
        socket.on("message", (data) => {
          const { id, method, params } = JSON.parse(data.toString());
          if (method === "initialized") {
            return;
          }
          methods.push(method);
          let result = {};
          if (method === "config/read") {
            result = {
              config: written
                ? disabled
                : { ...disabled, apps: { ...disabled.apps, inherited: { enabled: true } } },
            };
          } else if (method === "config/batchWrite") {
            assert.equal(params.reloadUserConfig, true);
            for (const key of ["apps", "plugins"]) {
              assert.deepEqual(
                params.edits.find((edit: { keyPath: string }) => edit.keyPath === key).value,
                { _default: { enabled: false } },
              );
            }
            assert.ok(
              params.edits.some(
                (edit: { keyPath: string; value: boolean }) =>
                  edit.keyPath === "apps.inherited.enabled" && edit.value === false,
              ),
            );
            written = true;
          } else {
            assert.equal(method, "initialize");
          }
          socket.send(JSON.stringify({ id, result }));
        });
      },
    );
    const generated = generatedPreparation({
      CODEX_LOGIN_MODE: "api_key",
      APP_SERVER_TOKEN: "hostile-ambient-fixture",
      OPENCLAW_PLUGIN_STATUS_PORT: "18791",
      OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25",
    });
    const caller = scopedPreparationCaller(
      server.address().port,
      credential,
      generated.CodexAppServerRequestError,
    );
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
