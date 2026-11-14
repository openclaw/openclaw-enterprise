import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { Linter } from "eslint";
import globals from "globals";

import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
  REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";
import * as runtimeEntrypoints from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { WORKSPACE_SETUP_RUNTIME } from "../../apps/controller/src/drivers/compute/workspace-setup-runtime.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { readJsonLinesSync } from "../helpers/json-lines.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const { COMPUTE_AGENT_RUNTIME_ENTRYPOINT: AGENT_RUNTIME_ENTRYPOINT } = runtimeEntrypoints;
// Only the external Codex CLI is substituted: it records each call and answers the probe READY.
const codexCallRecorder = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("login") ? fs.readFileSync(0, "utf8") : undefined;
fs.appendFileSync(process.env.CODEX_HOME + "/../calls", JSON.stringify({ args, input }) + "\\n");
if (args.includes("exec")) {
  const events = [
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "READY" } },
    { type: "turn.completed" },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
}
`;

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const elements: readonly unknown[] = value;
  return elements.every((element) => typeof element === "string");
}

function recordedArguments(value: unknown): string[] {
  const args = asRecord(value)?.args;
  assert.ok(isStringArray(args), "Codex CLI recorder must report a list of arguments");
  return args;
}

export function registerCodexLauncher(): void {
  // Run the actual generated bootstrap in a fresh process. Malformed credential
  // combinations must fail before launching Codex.
  test("Codex startup rejects missing, blank, conflicting, and unsupported authentication inputs", () => {
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { CODEX_LOGIN_MODE: "unknown" },
      // Retired with the managed ChatGPT login (finding 1295).
      { CODEX_LOGIN_MODE: "chatgpt_service_account", CODEX_ACCESS_TOKEN: "fixture-token" },
      { CODEX_LOGIN_MODE: "codex_pat" },
      { CODEX_LOGIN_MODE: "codex_pat", CODEX_ACCESS_TOKEN: " " },
      {
        CODEX_LOGIN_MODE: "codex_pat",
        CODEX_ACCESS_TOKEN: "at-fixture",
        OPENAI_API_KEY: "other-key",
      },
      { CODEX_LOGIN_MODE: "api_key" },
      { CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: " " },
      {
        CODEX_LOGIN_MODE: "api_key",
        OPENAI_API_KEY: "fixture-key",
        CODEX_ACCESS_TOKEN: "fixture-token",
      },
    ];
    for (const env of cases) {
      const child = spawnSync(
        process.execPath,
        ["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)],
        {
          env,
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(child.status, 1);
      assert.match(
        child.stderr,
        /Codex (?:API-key authentication configuration|service account token authentication configuration|authentication mode) is (?:invalid|missing or unsupported)/,
      );
      assert.equal(child.stdout, "");
      assert.doesNotMatch(child.stderr, /fixture-key|fixture-token/);
    }
  });

  // The generated modules run with `node -e`, so an undeclared name fails only when its branch
  // runs: the probe's dead chatgpt_service_account branch named an undefined workspaceId (finding 1295).
  test("generated runtime modules reference only declared names", () => {
    const linter = new Linter();
    const programs: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(runtimeEntrypoints).filter(([name]) => name.endsWith("_ENTRYPOINT")),
      ),
      REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
      REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
      WORKSPACE_SETUP_RUNTIME,
      DOCKER_GATEWAY_RUNTIME_ENTRYPOINT,
    };
    for (const [name, source] of Object.entries(programs)) {
      // nodeProgramArguments runs each as a script (vm.runInThisContext), not a CommonJS module.
      assert.ok(typeof source === "string", name);
      const messages = linter.verify(source, {
        languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: globals.node },
        rules: { "no-undef": "error" },
      });
      assert.deepEqual(
        messages.map(({ line, message }) => `${line}: ${message}`),
        [],
        name,
      );
    }
  });

  test("Codex startup logs in, probes and starts the app server in each login mode", (t) => {
    const login: readonly (readonly [
      "api_key" | "codex_pat" | "chatgptAuthTokens",
      { env: NodeJS.ProcessEnv; flag?: string; input?: string },
    ])[] = [
      [
        "api_key",
        {
          env: { OPENAI_API_KEY: "fixture-key" },
          flag: "--with-api-key",
          input: "fixture-key",
        },
      ],
      [
        "codex_pat",
        {
          env: { CODEX_ACCESS_TOKEN: "at-fixture" },
          flag: "--with-access-token",
          input: "at-fixture",
        },
      ],
      [
        "chatgptAuthTokens",
        {
          env: {
            CODEX_ACCESS_TOKEN: "fixture-external-access-placeholder",
            OCE_CODEX_CHATGPT_ACCOUNT: JSON.stringify({
              accountId: "fixture-account",
              planType: "team",
            }),
          },
        },
      ],
    ];
    for (const [mode, { env, flag, input }] of login) {
      const directory = temporaryDirectorySync(t, "oce-codex-login-mode-");
      const codexHome = join(directory, "codex");
      mkdirSync(join(directory, "bin"));
      mkdirSync(codexHome);
      writeFileSync(join(directory, "bin", "codex"), codexCallRecorder, { mode: 0o755 });
      const child = spawnSync(
        process.execPath,
        ["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)],
        {
          env: {
            ...env,
            PATH: `${join(directory, "bin")}:${dirname(process.execPath)}`,
            HOME: directory,
            TMPDIR: directory,
            CODEX_HOME: codexHome,
            CODEX_LOGIN_MODE: mode,
            OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
            OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
            APP_SERVER_TOKEN: "fixture-transport-token",
            APP_SERVER_PORT: "4500",
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      assert.equal(child.status, 0, `${mode}: ${child.stderr}`);
      assert.match(child.stderr, /"event":"codex\.model_probe".*"code":"READY"/, mode);
      const calls: readonly unknown[] = readJsonLinesSync(join(directory, "calls"));
      const argv = calls.map(recordedArguments);
      assert.deepEqual(
        argv.map((args) =>
          ["login", "exec", "app-server"].find((command) => args.includes(command)),
        ),
        [...(flag === undefined ? [] : ["login"]), "exec", "app-server"],
        mode,
      );
      if (flag !== undefined) {
        assert.deepEqual(calls[0], {
          args: [
            "-c",
            'otel.exporter="none"',
            "-c",
            'otel.metrics_exporter="none"',
            "-c",
            "otel.log_user_prompt=false",
            "-c",
            "cli_auth_credentials_store=file",
            "login",
            flag,
          ],
          input,
        });
      }
      if (mode === "chatgptAuthTokens") {
        // OpenShell owns the real grant; the launcher writes only its injection
        // placeholder and account metadata, without a native refresh credential.
        const auth: unknown = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
        const metadata = asRecord(auth);
        assert.ok(metadata, "Codex auth file must contain an object");
        const tokens = asRecord(metadata.tokens);
        assert.ok(tokens, "Codex auth file must contain token metadata");
        assert.equal(metadata.auth_mode, "chatgptAuthTokens");
        assert.equal(metadata.OPENAI_API_KEY, null);
        assert.equal(tokens.access_token, env.CODEX_ACCESS_TOKEN);
        assert.equal(tokens.refresh_token, "");
        assert.equal(tokens.account_id, "fixture-account");
        assert.doesNotMatch(JSON.stringify(auth), /fixture-transport-token/);
      }
      const probe = argv.find((args) => args.includes("exec"));
      assert.ok(probe, "Codex CLI must run the model probe");
      assert.equal(probe[probe.indexOf("--model") + 1], "gpt-5");
      assert.deepEqual(
        probe.slice(probe.indexOf("--model") + 2),
        [
          "-c",
          "cli_auth_credentials_store=file",
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          "check_for_update_on_startup=false",
          "Reply only READY. Do not use tools.",
        ],
        mode,
      );
    }
  });
}
