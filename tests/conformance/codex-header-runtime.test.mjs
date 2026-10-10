import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const require = createRequire(import.meta.url);

// Execute the production wrapper with native process boundaries recorded. This
// proves environment/config handoff, not Codex HTTP behavior or OpenShell substitution.
test("Codex source header authentication survives the probe and app-server environment boundary", async (t) => {
  for (const authHeader of [undefined, "x-api-key"]) {
    await t.test(authHeader ?? "default Bearer", () => {
      const directory = mkdtempSync(join(tmpdir(), "codex-header-runtime-"));
      const calls = [];
      const logs = [];
      const stoppedAtNativeSpawn = new Error("native spawn observed");
      const placeholder = "openshell:resolve:env:synthetic-model-placeholder";
      const transport = "synthetic-app-server-token";
      const endpoint = {
        baseUrl: "https://models.example.test/v1",
        modelProvider: "openai-compatible",
        ...(authHeader === undefined ? {} : { authHeader }),
      };
      const configuration = 'model_provider = "openai-compatible"\n';
      const environment = {
        PATH: "/usr/bin",
        HOME: directory,
        TMPDIR: directory,
        CODEX_HOME: join(directory, "codex"),
        CODEX_LOGIN_MODE: "api_key",
        OPENAI_API_KEY: placeholder,
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        OPENCLAW_HARNESS_MODEL: "codex/test-model",
        APP_SERVER_PORT: "4500",
        APP_SERVER_TOKEN: transport,
        SSL_CERT_FILE: "/run/openshell/ca.crt",
        OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({
          manifest: { kind: "codex", selections: {}, modelEndpoint: endpoint },
          codexConfigurationToml: configuration,
        }),
      };
      const sandbox = {
        URL,
        console: { error: (line) => logs.push(line) },
        setInterval() {},
        setTimeout() {
          assert.fail("successful probe must not retry");
        },
        process: {
          env: environment,
          on() {},
          exit() {
            assert.fail("unexpected wrapper exit");
          },
        },
        require(specifier) {
          if (specifier !== "node:child_process") {
            return require(specifier);
          }
          return {
            spawnSync(command, args, options) {
              calls.push({ command, args: Array.from(args), options });
              return args.includes("login")
                ? { status: 0 }
                : {
                    status: 0,
                    stdout: [
                      { type: "turn.started" },
                      { type: "item.completed", item: { type: "agent_message", text: "READY" } },
                      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
                    ]
                      .map((event) => JSON.stringify(event))
                      .join("\n"),
                  };
            },
            spawn(command, args, options) {
              calls.push({ command, args: Array.from(args), options });
              throw stoppedAtNativeSpawn;
            },
          };
        },
      };
      try {
        assert.throws(
          () => vm.runInNewContext(AGENT_RUNTIME_ENTRYPOINT, sandbox),
          (error) => error === stoppedAtNativeSpawn,
        );
        const login = calls.filter(({ args }) => args.includes("login"));
        assert.equal(login.length, authHeader === undefined ? 1 : 0);
        if (login.length !== 0) {
          assert.equal(login[0].options.input, placeholder);
        }
        const probe = calls.find(({ args }) => args.includes("exec"));
        const native = calls.find(({ args }) => args.includes("app-server"));
        assert.ok(probe);
        assert.ok(native);
        assert.ok(probe.args.includes("--ignore-user-config"));
        const provider = "model_providers.openai-compatible.";
        assert.ok(
          probe.args.includes(provider + "requires_openai_auth=" + (authHeader === undefined)),
        );
        const rawHeader = provider + 'env_http_headers={"x-api-key"="OPENAI_API_KEY"}';
        assert.equal(probe.args.includes(rawHeader), authHeader === "x-api-key");
        for (const child of [probe, native]) {
          assert.equal(
            child.options.env.OPENAI_API_KEY,
            authHeader === "x-api-key" ? placeholder : undefined,
          );
          assert.equal(child.options.env.APP_SERVER_TOKEN, undefined);
          assert.equal(child.options.env.APP_TOKEN_SHA, undefined);
          assert.equal(
            child.args.some((argument) => argument.includes(placeholder)),
            false,
          );
        }
        assert.equal(environment.OPENAI_API_KEY, undefined);
        assert.equal(probe.options.env.SSL_CERT_FILE, "/run/openshell/ca.crt");
        assert.equal(
          native.args[native.args.indexOf("--ws-token-sha256") + 1],
          createHash("sha256").update(transport).digest("hex"),
        );
        assert.equal(readFileSync(join(directory, "codex/config.toml"), "utf8"), configuration);
        assert.equal(logs.join("\n").includes(placeholder), false);
        assert.equal(logs.join("\n").includes(transport), false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
