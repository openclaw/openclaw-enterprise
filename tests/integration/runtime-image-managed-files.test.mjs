// Runtime image cases split from runtime-image-startup.test.mjs so CI can run
// them beside it: the Harness entrypoint initializes its workspace without
// replacing owner edits, and the Gateway treats a read-only Kubernetes
// configuration as externally managed and starts with OCE's Node options.
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import {
  OPTIONAL_BOOTSTRAP_FILES,
  RETIRED_OPENCLAW_SETTINGS,
} from "../../packages/occ/src/configuration-settings.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  GATEWAY_DID_NOT_START,
  gatewayConfigurationHoldLine,
  gatewayExitedBeforeServing,
} from "../helpers/openclaw-config-validation.mjs";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  gatewayRuntimeEntrypoint,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  createAdmittedRuntimeImageConfiguration,
  image,
  imageTestOptions,
  runDocker,
  waitForContainerReady,
  waitForDockerLog,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

// The native Gateway process's environment, as OpenClaw itself sees it.
async function gatewayProcessEnvironment(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    'const fs = require("node:fs"); for (const pid of fs.readdirSync("/proc")) { try { if (fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").startsWith("openclaw-gateway")) { process.stdout.write(fs.readFileSync("/proc/" + pid + "/environ", "utf8")); break; } } catch {} }',
  ]);
  assert.notEqual(stdout, "", "the native Gateway process must be running");
  return stdout.split("\0");
}

test(
  "runtime image initializes the Harness workspace without replacing owner edits",
  imageTestOptions,
  async () => {
    // Run the real Harness entrypoint and native setup. Replace only the long-lived
    // node/Codex bodies: this proves initialization order, not pairing or a model turn.
    const launch = String.raw`
const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const entrypoint = process.argv[1];
const sentinel = "Owner edit that must survive a Harness restart.\n";
const substitute = [
  'const cp = require("node:child_process");',
  'cp.spawn = () => {',
  'if (!JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP).skipBootstrap) require("node:assert/strict").ok(require("node:fs").readFileSync("/home/node/workspace/AGENTS.md", "utf8").length > 0);',
  'console.log("WORKSPACE_CHILD_STARTED");',
  'return new (require("node:events").EventEmitter)();',
  '};',
  entrypoint,
].join("\n");
const harnessEnv = (bootstrap) => ({ PATH: process.env.PATH, HOME: "/home/node", OPENCLAW_NODE_STATE_DIR: "/tmp/node-state", OPENCLAW_NODE_SETUP_CODE: "synthetic-setup", OPENCLAW_WORKSPACE_DIR: "/home/node/workspace", OPENCLAW_WORKSPACE_BOOTSTRAP: JSON.stringify(bootstrap) });
for (let attempt = 0; attempt < 3; attempt++) {
  const bootstrap = attempt === 0 ? { skipBootstrap: true } : {};
  const result = spawnSync(process.execPath, ["-e", substitute], {
    env: harnessEnv(bootstrap),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(require("node:fs").readdirSync("/home/node/openclaw-runtime-assets/bundled-skills").length > 0);
  assert.ok(require("node:fs").statSync("/home/node/openclaw-runtime-assets/plugin-skills").isDirectory());
  assert.ok(require("node:fs").lstatSync("/home/node/.openclaw/plugin-skills").isSymbolicLink());
  assert.equal(
    require("node:fs").realpathSync("/home/node/.openclaw/plugin-skills"),
    require("node:fs").realpathSync("/home/node/openclaw-runtime-assets/plugin-skills"),
  );
  assert.match(
    require("node:fs").readFileSync("/home/node/.openclaw/plugin-skills/slack/SKILL.md", "utf8"),
    /name:\s*slack/,
  );
  assert.match(
    require("node:fs").readFileSync(
      "/home/node/.openclaw/plugin-skills/block-kit/references/official-block-kit.md",
      "utf8",
    ),
    /# Block Kit/,
  );
  assert.equal(result.stdout.split("WORKSPACE_CHILD_STARTED").length - 1, 2);
  if (attempt === 0) {
    assert.equal(existsSync("/home/node/workspace/AGENTS.md"), false);
    continue;
  }
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"]) {
    assert.ok(readFileSync("/home/node/workspace/" + name, "utf8").length > 0);
  }
  if (attempt === 2) assert.equal(readFileSync("/home/node/workspace/AGENTS.md", "utf8"), sentinel);
  writeFileSync("/home/node/workspace/AGENTS.md", sentinel);
}
// An invalid bootstrap setting fails native setup. The Harness holds instead of
// exiting and serves the held check on its Compute status port (finding 2686).
(async () => {
  const http = require("node:http");
  const child = require("node:child_process").spawn(process.execPath, ["-e", substitute], {
    env: { ...harnessEnv({ skipBootstrap: "invalid" }), OPENCLAW_RUNTIME_STATUS_PORT: "18791", OPENCLAW_AGENT_REVISION_ID: "rev_fixture", OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent", OPENCLAW_POD_UID: "pod-fixture" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const read = (path) => new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: 18791, path, timeout: 1000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(undefined));
  });
  let status;
  for (let poll = 0; poll < 900 && child.exitCode === null && status?.status !== 200; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await read("/openclaw/runtime/status");
  }
  const ready = await read("/readyz");
  const held = child.exitCode === null;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  console.log("SETUP_FAILURE " + JSON.stringify({ stdout, stderr, status, ready: ready?.status, held }));
  console.log("WORKSPACE_INITIALIZATION_PASSED");
})();
`;
    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--tmpfs",
        "/home/node:size=64m,uid=1000,gid=1000",
        "--tmpfs",
        "/home/node/workspace:size=16m,uid=1000,gid=1000",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
        AGENT_WITH_NODE_ENTRYPOINT,
      ],
      { timeout: 120_000 * imageSmokeTimeoutMultiplier },
    );
    assert.match(stdout, /WORKSPACE_INITIALIZATION_PASSED/);
    // Native setup reports the invalid configuration as a multi-line JSON document,
    // which runtime logs withhold line by line (finding 2686). The Harness logs its
    // message on one line that `occ agent logs` shows, and keeps the document out.
    const failure = JSON.parse(/^SETUP_FAILURE (.*)$/m.exec(stdout)[1]);
    assert.equal(failure.held, true, failure.stderr);
    assert.doesNotMatch(failure.stdout, /cli_error|WORKSPACE_CHILD_STARTED/);
    const summary =
      /^Workspace initialization failed: openclaw setup --baseline \(exit-1\) reported: OpenClaw config is invalid: \S+ \(invalid settings: agents\.defaults\.skipBootstrap\)\. Codex was not started\. Fix the cause, then deploy the Agent again\.$/m;
    assert.match(failure.stderr, summary, failure.stderr);
    // OpenClaw's own diagnostics still reach the log, without its recovery hints:
    // no Agent user can run doctor or config validate in the container (finding 2699).
    assert.match(failure.stderr, /^Config invalid at \S+\.$/m, failure.stderr);
    assert.doesNotMatch(failure.stderr, /openclaw\b.*\b(?:doctor|config validate)\b/i);
    // Compute reads the held check, never the setup's text, on the status port.
    assert.equal(failure.status?.status, 200, failure.stderr);
    const { checkedAt, ...held } = JSON.parse(failure.status.body).runtimeFailure;
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
    assert.deepEqual(held, {
      component: "agent",
      check: "workspace-baseline",
      code: "UNAVAILABLE",
    });
    assert.equal(failure.ready, 503);
    const { records } = sanitizeRuntimeLogChunk({
      stream: { source: "agent", pod: "agent-0", container: "agent" },
      truncated: false,
      lines: failure.stderr.split("\n").map((raw) => ({ time: null, raw })),
    });
    assert.ok(
      records.some((record) => record.type === "line" && summary.test(record.message)),
      JSON.stringify(records),
    );
  },
);

test(
  "runtime image accepts exactly the optional bootstrap files Configuration save accepts and none of the retired settings",
  imageTestOptions,
  async () => {
    // Configuration save refuses skipOptionalBootstrapFiles names outside OCE's list, which
    // copies the pinned OpenClaw schema (finding 2699), and the settings that pin retired
    // (finding 2709). Read the image's own schema, so a pin that changes either fails here
    // instead of at save or in native setup.
    const { stdout } = await runDocker(
      [
        "run",
        "--rm",
        "--user",
        "1000:1000",
        "--read-only",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--tmpfs",
        "/home/node:size=64m,uid=1000,gid=1000",
        "--entrypoint",
        "node",
        image,
        "/app/openclaw.mjs",
        "config",
        "schema",
        "--json",
      ],
      { timeout: 120_000 * imageSmokeTimeoutMultiplier, maxBuffer: 16 * 1024 * 1024 },
    );
    const schema = JSON.parse(stdout);
    const files =
      schema.properties?.agents?.properties?.defaults?.properties?.skipOptionalBootstrapFiles?.items
        ?.enum;
    assert.ok(Array.isArray(files), "the image schema lists the optional bootstrap files");
    assert.deepEqual([...files].sort(), [...OPTIONAL_BOOTSTRAP_FILES].sort());
    // Plugin settings have their own schemas, separate from the core config schema.
    for (const [setting] of RETIRED_OPENCLAW_SETTINGS.filter(
      ([path]) => !path.startsWith("plugins.entries."),
    )) {
      const keys = setting.split(".");
      const parent = keys.slice(0, -1).reduce((node, key) => node?.properties?.[key], schema);
      assert.ok(parent?.properties, `the image schema has ${keys.slice(0, -1).join(".")}`);
      assert.equal(parent.properties[keys.at(-1)], undefined, `the image schema has no ${setting}`);
    }
  },
);

test(
  "runtime image starts the Kubernetes Gateway with its externally managed marker and Node options",
  imageTestOptions,
  async (t) => {
    // An embedded OpenClaw Gateway starts from the Configuration OCC mounts read-only.
    const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
    const startGateway = (managedMode) =>
      runGatewaySmoke(t, "openclaw", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: gatewayRuntimeEntrypoint(managedMode),
        volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
        withAppServer: false,
        extraEnvironment: [
          "NODE_OPTIONS=--max-old-space-size=3072",
          "OPENCLAW_CONFIG_READONLY_NOTICE=Inherited from the image",
        ],
      });
    const { containerName } = await startGateway(false);
    const environment = await gatewayProcessEnvironment(containerName);
    assert.ok(environment.includes("OPENCLAW_CONFIG_READONLY=1"));
    // With managed mode off, the independently read-only mount keeps the operator's guidance.
    assert.ok(environment.includes("OPENCLAW_CONFIG_READONLY_NOTICE=Inherited from the image"));
    // The wrapper caps V8's semi-space for the Gateway (finding 2700) and keeps the
    // operator's options after it, so an operator's own flag still wins.
    assert.ok(
      environment.includes("NODE_OPTIONS=--max-semi-space-size=8 --max-old-space-size=3072"),
      environment.find((entry) => entry.startsWith("NODE_OPTIONS=")),
    );
    // OpenClaw promotes its last-known-good backup just after it reports ready,
    // and only then releases its post-ready work. That work includes the remote
    // model catalog refresh, which fails at once without a network. Its log line
    // therefore comes after any promotion failure would have been logged. This
    // ordering is OpenClaw's (checked at the pinned source): re-check it when the
    // pin moves, since a promotion moved after post-ready work would pass here.
    const logs = await waitForDockerLog(containerName, /remote model catalog refresh failed/);
    assert.doesNotMatch(logs, /last-known-good|EROFS/);

    const managed = await startGateway(true);
    assert.ok(
      (await gatewayProcessEnvironment(managed.containerName)).includes(
        "OPENCLAW_CONFIG_READONLY_NOTICE=OpenClaw Enterprise manages this Gateway’s configuration. In the OCE Console, edit and save the Agent’s draft Configuration, then select Deploy new version. https://docs-enterprise.openclaw.org/reference/agents/gateway-managed-mode/",
      ),
    );
  },
);

// An embedded Gateway's OpenClaw exits at startup on the invalid entry with status 78 and names
// each failing setting (finding 3043; the image's openclaw/openclaw#189392 patch). A dedicated
// Codex Gateway's tool policy step validates the composed configuration before OpenClaw starts,
// and holds the same check, not a tool policy failure (finding 3045).
for (const { topology, harnessId, withAppServer, event } of [
  {
    topology: "an embedded",
    harnessId: "openclaw",
    withAppServer: false,
    event: gatewayExitedBeforeServing("exit-78"),
  },
  {
    topology: "a dedicated Codex",
    harnessId: "codex",
    withAppServer: true,
    event: GATEWAY_DID_NOT_START,
  },
]) {
  test(
    `runtime image holds ${topology} Kubernetes Gateway whose plugin configuration fails its schema`,
    imageTestOptions,
    async (t) => {
      // A beam plugin entry without its required mirror settings.
      const admitted = createAdmittedRuntimeImageConfiguration(harnessId);
      const configuration = {
        ...admitted,
        plugins: {
          ...admitted.plugins,
          entries: {
            ...admitted.plugins?.entries,
            beam: { enabled: true, config: { mirror: { token: "synthetic-beam-token-value" } } },
          },
        },
      };
      const configurationPath = await temporaryGatewayConfiguration(t, harnessId, configuration);
      const startedAt = Date.now();
      const { containerName } = await runGatewaySmoke(t, harnessId, {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: gatewayRuntimeEntrypoint(false),
        volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
        withAppServer,
        waitUntilReady: false,
        extraEnvironment: [
          "OPENCLAW_RUNTIME_STATUS_PORT=18791",
          "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
          "OPENCLAW_AGENT_REVISION_ID=rev_gateway-config",
          "OPENCLAW_POD_UID=pod_gateway-config",
        ],
      });
      // The wrapper keeps running, so the container is not restarted into the same refusal,
      // and serves the held check on the status port Compute reads. Commands run in the
      // container read that port from the container's own environment.
      await waitForContainerReady(containerName, {
        label: "Held Gateway configuration failure",
        request:
          '() => fetch("http://127.0.0.1:" + process.env.OPENCLAW_RUNTIME_STATUS_PORT + "/openclaw/runtime/status", { signal: AbortSignal.timeout(5000) }).then((response) => response.json()).then((status) => (status.runtimeFailure === undefined ? 503 : 200))',
        timeoutMs: 120_000 * imageSmokeTimeoutMultiplier,
      });
      t.diagnostic(`held ${Date.now() - startedAt} ms after the container started`);
      const { stdout } = await runDocker([
        "exec",
        containerName,
        "node",
        "-e",
        'const status = "http://127.0.0.1:" + process.env.OPENCLAW_RUNTIME_STATUS_PORT; Promise.all([fetch(status + "/openclaw/runtime/status").then((response) => response.json()), fetch(status + "/readyz").then((response) => response.status)]).then(([held, ready]) => process.stdout.write(JSON.stringify({ status: held, ready })))',
      ]);
      const { status, ready } = JSON.parse(stdout);
      const { checkedAt, ...held } = status.runtimeFailure;
      assert.ok(!Number.isNaN(Date.parse(checkedAt)));
      assert.deepEqual(held, {
        component: "gateway",
        check: "gateway-config",
        code: "UNAVAILABLE",
      });
      assert.equal(ready, 503);
      // The log names the failing settings with OpenClaw's schema messages, never their
      // values, on one line that runtime logs keep.
      const logs = await runDocker(["logs", containerName]);
      const output = `${logs.stdout}\n${logs.stderr}`;
      if (!withAppServer) {
        // OpenClaw's own refusal, in its JSON console records, names the plugin setting instead
        // of reporting a config change.
        const openClawLines = output.split("\n").flatMap((line) => {
          try {
            const { message } = JSON.parse(line);
            return typeof message === "string" ? message.split("\n") : [];
          } catch {
            return [];
          }
        });
        assert.ok(
          openClawLines.includes(
            "  - plugins.entries.beam.config.mirror.endpoint: invalid config: must have required property 'endpoint'",
          ),
          output,
        );
      }
      const line = gatewayConfigurationHoldLine(event, [
        "plugins.entries.beam.config.mirror.endpoint: must have required property 'endpoint'",
        "plugins.entries.beam.config.mirror.catalogs: must have required property 'catalogs'",
      ]);
      assert.ok(output.split("\n").includes(line), output);
      assert.doesNotMatch(
        output,
        /synthetic-beam-token-value|required tool policy|config validity changed/,
      );
      const { records } = sanitizeRuntimeLogChunk({
        stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
        truncated: false,
        lines: logs.stderr.split("\n").map((raw) => ({ time: null, raw })),
      });
      assert.ok(
        records.some((record) => record.type === "line" && record.message.includes(line)),
        JSON.stringify(records.slice(-5)),
      );
    },
  );
}
