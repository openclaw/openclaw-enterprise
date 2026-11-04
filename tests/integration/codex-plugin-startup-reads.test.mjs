import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  generatedPreparation,
  scopedPreparationCaller,
} from "../helpers/codex-preparation-caller.ts";
import { captureChild } from "../helpers/child-processes.mjs";

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
      toolDefaults: { enabled: false, approval: "all_actions", reviewer: "human" },
      tools: { [name + "/read_" + name]: { enabled: true, approval: "none" } },
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
      names.map((name) => [
        name,
        {
          enabled: true,
          default_tools_enabled: false,
          default_tools_approval_mode: "prompt",
          approvals_reviewer: "user",
          tools: { ["read_" + name]: { enabled: true, approval_mode: "approve" } },
        },
      ]),
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

for (const mode of [
  "ordinary",
  "scoped-no-ambient",
  "scoped-hostile-ambient",
  "missing",
  "invalid",
  "wrong-credential",
]) {
  for (const retry of ["ordinary", "scoped-no-ambient", "scoped-hostile-ambient"].includes(mode)
    ? [false, true]
    : [false]) {
    test(
      ["missing", "invalid", "wrong-credential"].includes(mode)
        ? `generated Codex preparation refuses ${mode} caller before native effects`
        : `generated Codex startup overlaps metadata reads and preserves policy ordering (${mode})${retry ? " after a read failure" : ""}`,
      { timeout: 15_000 },
      async (t) => {
        // The external app-server is a protocol fixture; the generated installer,
        // ordinary WebSocket client and request timers are the production path.
        const credential =
          mode === "ordinary" ? "startup-fixture-token" : "connection-fixture-token";
        let rejectedConnections = 0;
        const server = new WebSocketServer({
          host: "127.0.0.1",
          port: 0,
          verifyClient({ req }, done) {
            const accepted = req.headers.authorization === "Bearer " + credential;
            if (!accepted) {
              rejectedConnections++;
            }
            done(accepted, 401);
          },
        });
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
          assert.equal(request.headers.authorization, "Bearer " + credential);
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
            if (method === "plugin/search") {
              assert.ok(names.includes(params.searchTerm));
              assert.equal(params.scope, "global");
              if (params.searchTerm === names[0]) {
                assert.equal(outstanding, 0, "a retry must wait for every earlier read to settle");
                assert.equal(firstErrorDrained, attempts === 0 ? !retry : true);
                attempts += 1;
                phaseReads = 0;
              }
              return send({
                data: [
                  {
                    marketplaceName: "openai-curated-remote",
                    plugin: summary(params.searchTerm, false),
                  },
                ],
                nextCursor: null,
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
            assert.equal(
              outstanding,
              0,
              "writes and verification must follow complete read phases",
            );
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
            if (method === "mcpServerStatus/list") {
              assert.equal(installed, true);
              assert.equal(written, false, "tool discovery precedes app grants");
              assert.equal(params.detail, "toolsAndAuthOnly");
              return send({
                data: [
                  {
                    name: "codex_apps",
                    toolsError: null,
                    tools: Object.fromEntries(
                      names.map((name) => [
                        "read_" + name,
                        {
                          name: "read_" + name,
                          inputSchema: { type: "object" },
                          _meta: { connector_id: name },
                          annotations: { readOnlyHint: true, destructiveHint: false },
                        },
                      ]),
                    ),
                  },
                ],
                nextCursor: null,
              });
            }
            if (method === "configRequirements/read") {
              assert.equal(written, true);
              return send({ requirements: { allowedApprovalsReviewers: ["user"] } });
            }
            if (method === "config/read") {
              if (written) {
                assert.equal(batches.length, retry ? 7 : 6);
              }
              return send({
                config: {
                  ...configuration,
                  plugins: pluginPermitted
                    ? configuration.plugins
                    : { _default: { enabled: false } },
                  apps: written ? configuration.apps : { _default: { enabled: false } },
                },
              });
            }
            assert.fail(`unexpected method ${method}`);
          });
        });
        const runtime = { manifest: { kind: "codex", selections } };
        const env = {
          PATH: process.env.PATH,
          NODE_PATH: dirname(dirname(socketRequire.resolve("ws"))),
          APP_SERVER_PORT: String(server.address().port),
          ...(mode !== "scoped-no-ambient"
            ? {
                APP_SERVER_TOKEN:
                  mode === "scoped-hostile-ambient" ? "hostile-ambient-token" : credential,
              }
            : {}),
          OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS: "1500",
          OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "5000",
        };
        let result;
        if (mode === "ordinary") {
          const script = `${PLUGIN_RUNTIME_HELPERS}\ninstallCodexPlugins(${JSON.stringify(runtime)}, [], codexAppServerRequest)
        .then((value) => console.log(JSON.stringify(value)))
        .catch((error) => { console.error(error.message); process.exitCode = 1; });`;
          const { status, stdout, stderr } = await captureChild(process.execPath, ["-e", script], {
            env,
            signal: t.signal,
            killSignal: "SIGKILL",
          });
          assert.equal(status, 0, stderr);
          result = JSON.parse(stdout);
        } else {
          const generated = generatedPreparation({
            ...env,
            ...(["missing", "invalid", "wrong-credential"].includes(mode)
              ? { OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS: "25" }
              : {}),
          });
          const caller = scopedPreparationCaller(
            server.address().port,
            mode === "wrong-credential" ? "incorrect-connection-token" : credential,
            generated.CodexAppServerRequestError,
          );
          t.after(caller.close);
          let request = caller.request;
          if (mode === "missing") {
            request = undefined;
          }
          if (mode === "invalid") {
            request = {};
          }
          if (["missing", "invalid", "wrong-credential"].includes(mode)) {
            let failure;
            try {
              await generated.installCodexPlugins(runtime, [], request);
            } catch (error) {
              failure = error;
            }
            assert.deepEqual(
              events,
              [],
              "rejected callers cannot initialize, write configuration or install",
            );
            assert.match(
              String(failure?.message),
              mode === "wrong-credential" ? /401/ : /requires a native request caller/,
            );
            assert.equal(rejectedConnections, mode === "wrong-credential" ? 1 : 0);
            return;
          }
          result = JSON.parse(
            JSON.stringify(await generated.installCodexPlugins(runtime, [], request)),
          );
          assert.equal(events.filter((method) => method === "initialize").length, 1);
          assert.equal(rejectedConnections, 0, "ambient credentials must not be used");
        }
        assert.deepEqual(result, { successfulPluginIds: Object.keys(selections), failures: [] });
        assert.equal(attempts, retry ? 2 : 1);
        assert.equal(events.filter((method) => method === "plugin/install").length, names.length);
        assert.equal(events.at(-1), "configRequirements/read");
        assert.equal(events.filter((method) => method === "mcpServerStatus/list").length, 1);
        assert.equal(events.filter((method) => method === "config/read").length, 2);
        assert.deepEqual(
          batches.map((batch) => batch.length),
          retry ? [4, 4, 2, 4, 2, 4, 2] : [4, 2, 4, 2, 4, 2],
        );
      },
    );
  }
}
