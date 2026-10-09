import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
const { WebSocketServer } = socketRequire("ws");
const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const selections = Object.fromEntries(
  names.map((name) => [
    `codex-plugin:${name}@openai-curated-remote`,
    {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    },
  ]),
);
const configuration = {
  plugins: {
    _default: { enabled: false },
    ...Object.fromEntries(
      names.map((name) => [`${name}@openai-curated-remote`, { enabled: true }]),
    ),
  },
  features: { apps: true, plugins: true, remote_plugin: true },
  apps: {
    _default: { enabled: false },
    ...Object.fromEntries(
      names.map((name) => [name, { enabled: true, default_tools_approval_mode: "auto" }]),
    ),
  },
};

function summary(name, installed, enabled = false) {
  return {
    id: `${name}@openai-curated-remote`,
    remotePluginId: `plugin_${name}`,
    name,
    source: { type: "remote" },
    installed,
    enabled: installed && enabled,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    version: "1.0.0",
    interface: null,
  };
}

for (const retry of [false, true]) {
  test(`generated Codex startup overlaps metadata reads and preserves policy ordering${retry ? " after a read failure" : ""}`, async (t) => {
    // The external app-server is a protocol fixture; the generated installer,
    // WebSocket client, request timers and child process are the production path.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const events = [];
    const batches = [];
    let pending = [];
    let phaseReads = 0;
    let installed = false;
    let pluginPermitted = false;
    let written = false;
    let attempts = 0;
    let outstanding = 0;
    let firstErrorDrained = !retry;
    const timers = [];
    t.after(() => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    });
    server.on("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "Bearer startup-fixture-token");
      socket.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        if (method === "initialized") {
          return;
        }
        const send = (result) => socket.send(JSON.stringify({ id, result }));
        events.push(method);
        if (method === "initialize") {
          return send({});
        }
        if (method === "plugin/list") {
          assert.equal(outstanding, 0, "a retry must wait for every earlier read to settle");
          assert.equal(firstErrorDrained, attempts === 0 ? !retry : true);
          attempts += 1;
          phaseReads = 0;
          return send({
            marketplaces: [
              {
                name: "openai-curated-remote",
                path: null,
                interface: null,
                plugins: names.map((name) => summary(name, false)),
              },
            ],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          });
        }
        if (method === "plugin/read") {
          const name = params.pluginName.slice("plugin_".length);
          assert.ok(names.includes(name));
          outstanding += 1;
          assert.ok(outstanding <= 4, "metadata concurrency must stay bounded");
          pending.push({ name, socket, id });
          // No timing threshold: a batch can complete only if its reads arrive.
          // Reverse replies prove that selection/detail correspondence survives.
          if (pending.length === Math.min(4, names.length - phaseReads)) {
            const batch = pending;
            pending = [];
            phaseReads = (phaseReads + batch.length) % names.length;
            batches.push(batch.map((item) => item.name));
            for (const [index, item] of batch.toReversed().entries()) {
              timers.push(
                setTimeout(
                  () => {
                    outstanding -= 1;
                    if (retry && attempts === 1 && index === 0) {
                      item.socket.send(
                        JSON.stringify({
                          id: item.id,
                          error: { code: -32000, message: "temporary metadata failure" },
                        }),
                      );
                    } else {
                      if (retry && attempts === 1) {
                        firstErrorDrained = true;
                      }
                      item.socket.send(
                        JSON.stringify({
                          id: item.id,
                          result: {
                            plugin: {
                              marketplaceName: "openai-curated-remote",
                              marketplacePath: null,
                              summary: summary(item.name, installed, pluginPermitted),
                              description: null,
                              skills: [],
                              apps: [{ id: item.name, name: item.name, needsAuth: false }],
                              appTemplates: [],
                              hooks: [],
                              mcpServers: [],
                              scheduledTasks: [],
                            },
                          },
                        }),
                      );
                    }
                  },
                  index === 0 ? 0 : 350,
                ),
              );
            }
          }
          return;
        }
        assert.equal(outstanding, 0, "writes and verification must follow complete read phases");
        if (method === "plugin/install") {
          assert.equal(
            pluginPermitted,
            true,
            "native install authentication needs the plugin grant",
          );
          installed = true;
          assert.equal(written, false);
          return send({ authPolicy: "ON_USE", appsNeedingAuth: [] });
        }
        if (method === "config/batchWrite") {
          assert.equal(params.reloadUserConfig, true);
          if (params.edits.some((edit) => edit.keyPath === "apps")) {
            assert.equal(
              installed,
              true,
              "final app policy follows installation and metadata recheck",
            );
            assert.equal(pluginPermitted, true);
            written = true;
          } else {
            assert.equal(installed, false);
            assert.deepEqual(params.edits, [
              { keyPath: "plugins", mergeStrategy: "replace", value: configuration.plugins },
            ]);
            pluginPermitted = true;
          }
          return send({ status: "ok" });
        }
        if (method === "config/read") {
          if (written) {
            assert.equal(batches.length, retry ? 7 : 6);
          }
          return send({
            config: {
              ...configuration,
              plugins: pluginPermitted ? configuration.plugins : { _default: { enabled: false } },
              apps: written ? configuration.apps : { _default: { enabled: false } },
            },
          });
        }
        assert.fail(`unexpected method ${method}`);
      });
    });
    const script = `${PLUGIN_RUNTIME_HELPERS}\ninstallCodexPlugins(${JSON.stringify({ manifest: { kind: "codex", selections } })})
      .then((value) => console.log(JSON.stringify(value)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        PATH: process.env.PATH,
        NODE_PATH: dirname(dirname(socketRequire.resolve("ws"))),
        APP_SERVER_PORT: String(server.address().port),
        APP_SERVER_TOKEN: "startup-fixture-token",
        OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS: "1500",
        OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), {
      successfulPluginIds: Object.keys(selections),
      failures: [],
    });
    assert.equal(attempts, retry ? 2 : 1);
    assert.equal(events.filter((method) => method === "plugin/install").length, names.length);
    assert.equal(events.at(-1), "config/read");
    assert.deepEqual(
      batches.map((batch) => batch.length),
      retry ? [4, 4, 2, 4, 2, 4, 2] : [4, 2, 4, 2, 4, 2],
    );
  });
}
