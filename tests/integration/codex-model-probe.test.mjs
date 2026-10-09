import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const execute = promisify(execFile);
const image = process.env.OCC_TEST_CODEX_PROBE_IMAGE;
const canary = "probe-output-must-remain-private";

// Only the external Codex CLI is substituted. The emitted launcher, native
// process timeout, retry timer, signals, readiness file and HTTP status are real.
const codexFixture = String.raw`#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
const scenario = fs.readFileSync("/fixture/scenario", "utf8");
fs.appendFileSync("/home/node/calls", JSON.stringify(args) + "\n");
assert.equal(process.env.CODEX_CHATGPT_WORKSPACE_ID, undefined);
assert.equal(args.some((argument) => argument.includes("forced_chatgpt_workspace_id")), false);
if (scenario === "external") {
  // Inspect the actual launcher's output at both native process boundaries.
  assert.equal(args.includes("login"), false);
  assert.equal(process.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(process.env.OCE_CODEX_CHATGPT_ACCOUNT, undefined);
  assert.ok(args.includes("cli_auth_credentials_store=file"));
  const path = process.env.CODEX_HOME + "/auth.json";
  const auth = JSON.parse(fs.readFileSync(path, "utf8"));
  assert.equal(auth.auth_mode, "chatgptAuthTokens");
  assert.equal(auth.tokens.access_token, "opaque-gateway-placeholder");
  assert.equal(auth.tokens.refresh_token, "");
  assert.equal(auth.tokens.account_id, "account-workspace");
  assert.ok(Number.isFinite(Date.parse(auth.last_refresh)));
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url"));
  assert.equal(claims.email, "fixture@example.invalid");
  assert.deepEqual(claims["https://api.openai.com/auth"], {
    chatgpt_account_id: "account-workspace",
    chatgpt_plan_type: "business",
    chatgpt_user_id: "fixture-user",
    chatgpt_account_is_fedramp: false,
  });
}
if (args.includes("login")) {
  assert.equal(Object.hasOwn(process.env, "APP_SERVER_TOKEN"), false);
  const pat = scenario === "pat";
  assert.deepEqual(args, ["-c", "cli_auth_credentials_store=file", "login", pat ? "--with-access-token" : "--with-api-key"]);
  assert.equal(fs.readFileSync(0, "utf8"), pat ? "at-service-account-fixture" : "credential-canary");
} else if (args.includes("exec")) {
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("-a") + 1], "never");
  assert.ok(args.includes("--ignore-user-config") && args.includes("--ignore-rules"));
  assert.ok(args.includes("--ephemeral"));
  const prior = fs.readFileSync("/home/node/calls", "utf8").trim().split("\n")
    .map(JSON.parse).filter((call) => call.includes("exec")).length;
  process.stderr.write("probe-output-must-remain-private\n");
  if (scenario === "timeout" || (scenario === "recover" && prior === 1)) {
    setInterval(() => {}, 1000);
  } else if (scenario === "killed") {
    process.kill(process.pid, "SIGKILL");
  } else if (scenario === "rejected") {
    process.stdout.write(JSON.stringify({ type: "error", message: "probe-output-must-remain-private" }) + "\n");
    process.exitCode = 1;
  } else if (scenario === "malformed") {
    process.stdout.write("probe-output-must-remain-private\n");
  } else {
    const events = [ { type: "turn.started" } ];
    if (scenario === "tool") events.push({ type: "item.completed", item: { type: "command_execution" } });
    events.push({ type: "item.completed", item: { type: "agent_message", text: "READY" } }, { type: "turn.completed" });
    process.stdout.write(events.map(JSON.stringify).join("\n") + "\n");
  }
} else if (args.includes("app-server")) {
  assert.equal(Object.hasOwn(process.env, "APP_SERVER_TOKEN"), false);
  assert.equal(
    args[args.indexOf("--ws-token-sha256") + 1],
    require("node:crypto").createHash("sha256").update("transport-canary").digest("hex"),
  );
  console.log("APP_SERVER_STARTED");
  setInterval(() => {}, 1000);
} else {
  throw new Error("Unexpected fixture invocation");
}
`;

async function startLauncher(
  t,
  scenario,
  stopAfterTimeout = false,
  auth = { CODEX_LOGIN_MODE: "api_key", OPENAI_API_KEY: "credential-canary" },
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-codex-probe-"));
  const name = `oce-codex-probe-${randomUUID()}`;
  let output = "";
  let errors = "";
  let stop;
  t.after(async () => {
    await execute("docker", ["rm", "--force", name], { timeout: 10000 });
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    writeFile(join(directory, "entrypoint.cjs"), AGENT_RUNTIME_ENTRYPOINT),
    writeFile(join(directory, "codex"), codexFixture, { mode: 0o755 }),
    writeFile(join(directory, "scenario"), scenario),
    writeFile(join(directory, "calls"), ""),
  ]);
  const child = spawn(
    "docker",
    [
      "run",
      "--name",
      name,
      "--pull=never",
      "--init",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      // Match the private bind mount owner on Linux without DAC override.
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      `/home/node:uid=${process.getuid()},gid=${process.getgid()},mode=0700`,
      "--mount",
      `type=bind,src=${directory},dst=/fixture,readonly`,
      "--mount",
      `type=bind,src=${join(directory, "calls")},dst=/home/node/calls`,
      "-e",
      "PATH=/fixture:/usr/local/bin:/usr/bin:/bin",
      "-e",
      "CODEX_HOME=/home/node/codex",
      "-e",
      "OPENCLAW_WORKSPACE_DIR=/home/node/workspace",
      ...Object.entries(auth).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-e",
      "OPENCLAW_HARNESS_MODEL=codex/fixture-model",
      "-e",
      "APP_SERVER_TOKEN=transport-canary",
      "-e",
      "APP_SERVER_PORT=4500",
      "-e",
      "OPENCLAW_PLUGIN_READY_MARKER=/home/node/ready",
      "-e",
      "OPENCLAW_RUNTIME_STATUS_PORT=18791",
      "-e",
      "OPENCLAW_RUNTIME_STATUS_CONTAINER=agent",
      "-e",
      "OPENCLAW_AGENT_REVISION_ID=revision-probe",
      "-e",
      "OPENCLAW_POD_UID=pod-probe",
      "--entrypoint",
      "node",
      image,
      "/fixture/entrypoint.cjs",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
    if (stopAfterTimeout && stop === undefined && errors.includes('"code":"MODEL_PROBE_TIMEOUT"')) {
      stop = execute("docker", ["kill", "--signal=TERM", name], { timeout: 5000 });
    }
  });
  return {
    name,
    exited,
    calls: async () =>
      (await readFile(join(directory, "calls"), "utf8")).trim().split("\n").map(JSON.parse),
    output: () => output,
    errors: () => errors,
    stop: () => stop,
    async snapshot() {
      const { stdout } = await execute(
        "docker",
        [
          "exec",
          name,
          "node",
          "-e",
          `
        const fs = require('node:fs');
        fetch('http://127.0.0.1:18791/openclaw/runtime/status').then(async response => {
          console.log(JSON.stringify({ status: await response.json(), ready: fs.existsSync('/home/node/ready'),
            calls: fs.readFileSync('/home/node/calls', 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse),
            probeDirectories: fs.readdirSync('/tmp').filter(name => name.startsWith('codex-auth-probe-')) }));
        });
      `,
        ],
        { timeout: 5000 },
      );
      return JSON.parse(stdout);
    },
  };
}

async function waitFor(check, diagnostics) {
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await delay(50);
  }
  assert.fail(`Launcher did not settle: ${diagnostics()}`);
}

test(
  "generated Codex launcher hands model credentials to native processes",
  {
    skip: image ? false : "Set OCC_TEST_CODEX_PROBE_IMAGE to an immutable Node 24+ image.",
    timeout: 90000,
  },
  async (t) => {
    assert.match(image, /^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/);
    // Both imported and managed PATs reach this receiver; Compute tests verify
    // their distinct source ownership before selecting the same native login.
    await t.test("service-account token", async (t) => {
      const launcher = await startLauncher(t, "pat", false, {
        CODEX_LOGIN_MODE: "codex_pat",
        CODEX_ACCESS_TOKEN: "at-service-account-fixture",
      });
      await waitFor(() => launcher.output().includes("APP_SERVER_STARTED"), launcher.errors);
      const snapshot = await launcher.snapshot();
      assert.equal(snapshot.ready, true);
      assert.equal(snapshot.calls.length, 3);
      assert.ok(snapshot.calls[0].includes("login"));
      assert.ok(snapshot.calls[1].includes("exec"));
      assert.ok(snapshot.calls[2].includes("app-server"));
      assert.equal(snapshot.status.runtimeFailure, undefined);
      assert.deepEqual(snapshot.probeDirectories, []);
      assert.doesNotMatch(
        launcher.output() + launcher.errors(),
        /at-service-account-fixture|transport-canary/,
      );
    });

    const auth = {
      CODEX_LOGIN_MODE: "chatgptAuthTokens",
      CODEX_ACCESS_TOKEN: "opaque-gateway-placeholder",
      OCE_CODEX_CHATGPT_ACCOUNT: JSON.stringify({
        accountId: "account-workspace",
        planType: "business",
        userId: "fixture-user",
        email: "fixture@example.invalid",
      }),
    };
    const launcher = await startLauncher(t, "external", false, auth);
    await waitFor(() => launcher.output().includes("APP_SERVER_STARTED"), launcher.errors);
    const snapshot = await launcher.snapshot();
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.calls.length, 2);
    assert.ok(snapshot.calls[0].includes("exec"));
    assert.ok(snapshot.calls[1].includes("app-server"));
    assert.doesNotMatch(launcher.output() + launcher.errors(), /opaque-gateway-placeholder/);

    // Incomplete metadata must stop before any native process or readiness.
    const invalid = await startLauncher(t, "external", false, {
      ...auth,
      OCE_CODEX_CHATGPT_ACCOUNT: JSON.stringify({ accountId: "account-workspace" }),
    });
    await waitFor(
      () => invalid.errors().includes("Harness model authentication probe failed."),
      invalid.errors,
    );
    const failed = await invalid.snapshot();
    assert.equal(failed.ready, false);
    assert.equal(failed.status.runtimeFailure.code, "LOGIN_FAILED");
    assert.deepEqual(failed.calls, []);
  },
);

test(
  "generated Codex launcher bounds model-probe recovery",
  {
    skip: image
      ? false
      : "Set OCC_TEST_CODEX_PROBE_IMAGE to an existing immutable Node 24+ image; requires Docker.",
    timeout: 130000,
    concurrency: true,
  },
  async (t) => {
    assert.match(image, /^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/);
    // A missing local image is setup failure, not a model-probe timeout.
    await execute("docker", ["image", "inspect", image], { timeout: 10000 });
    const scenarios = [
      { name: "timeout then success", input: "recover", attempts: 2, ready: true },
      { name: "two timeouts", input: "timeout", attempts: 2, code: "MODEL_PROBE_TIMEOUT" },
      { name: "credential rejection", input: "rejected", attempts: 1, code: "MODEL_PROBE_FAILED" },
      { name: "external SIGKILL", input: "killed", attempts: 1, code: "MODEL_PROBE_FAILED" },
      { name: "malformed output", input: "malformed", attempts: 1, code: "MODEL_PROBE_FAILED" },
      { name: "tool event", input: "tool", attempts: 1, code: "MODEL_PROBE_FAILED" },
    ];
    // Every scenario has its own container, so the backoff termination case
    // runs beside them: its first 30 s probe timeout overlaps theirs.
    await Promise.all([
      ...scenarios.map((scenario) =>
        t.test(scenario.name, { concurrency: true }, async (t) => {
          const launcher = await startLauncher(t, scenario.input);
          await waitFor(
            () =>
              launcher.output().includes("APP_SERVER_STARTED") ||
              launcher.errors().includes("Harness model authentication probe failed."),
            launcher.errors,
          );
          const snapshot = await launcher.snapshot();
          assert.equal(snapshot.ready, scenario.ready ?? false);
          assert.equal(snapshot.calls.filter((args) => args.includes("login")).length, 1);
          assert.equal(
            snapshot.calls.filter((args) => args.includes("exec")).length,
            scenario.attempts,
          );
          assert.equal(
            snapshot.calls.filter((args) => args.includes("app-server")).length,
            scenario.ready ? 1 : 0,
          );
          assert.equal(snapshot.status.runtimeFailure?.code, scenario.code);
          assert.deepEqual(snapshot.probeDirectories, []);
          assert.doesNotMatch(
            launcher.output() + launcher.errors() + JSON.stringify(snapshot.status),
            new RegExp(`${canary}|credential-canary|transport-canary`),
          );
          const diagnostics = launcher
            .errors()
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map(JSON.parse)
            .filter(({ event }) => event === "codex.model_probe");
          assert.equal(diagnostics.length, scenario.attempts);
          assert.equal(diagnostics.at(-1).code, scenario.code ?? "READY");
          assert.deepEqual(
            diagnostics.map((entry) => entry.attempt),
            scenario.attempts === 2 ? [1, 2] : [1],
          );
          if (scenario.input === "timeout") {
            assert.ok(
              diagnostics.every((entry) => entry.elapsedMs >= 29000 && entry.elapsedMs < 32000),
            );
          }
          // Status/readiness observation after settlement cannot trigger another call.
          const again = await launcher.snapshot();
          assert.deepEqual(again.calls, snapshot.calls);
        }),
      ),
      t.test("termination during backoff exits without another probe", async (t) => {
        const launcher = await startLauncher(t, "timeout", true);
        await waitFor(() => launcher.stop() !== undefined, launcher.errors);
        await launcher.stop();
        const result = await Promise.race([
          launcher.exited,
          delay(3000).then(() => "still running"),
        ]);
        assert.notEqual(result, "still running");
        assert.equal(launcher.output(), "");
        const calls = await launcher.calls();
        assert.equal(calls.filter((args) => args.includes("exec")).length, 1);
        assert.equal(calls.filter((args) => args.includes("app-server")).length, 0);
        assert.equal(
          launcher
            .errors()
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map(JSON.parse)
            .filter(({ event }) => event === "codex.model_probe").length,
          1,
        );
        assert.doesNotMatch(launcher.errors(), /Harness model authentication probe failed/);
      }),
    ]);
  },
);
