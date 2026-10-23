// Runtime image cases split from runtime-image-startup.test.mjs so CI can run
// them beside it: the Harness entrypoint initializes its workspace without
// replacing owner edits, and the Gateway treats a read-only Kubernetes
// configuration as externally managed.
import assert from "node:assert/strict";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  image,
  imageTestOptions,
  runDocker,
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
for (let attempt = 0; attempt < 4; attempt++) {
  const bootstrap = attempt === 0 ? { skipBootstrap: true } : attempt === 3 ? { skipBootstrap: "invalid" } : {};
  const substitute = [
    'const cp = require("node:child_process");',
    'cp.spawn = () => {',
    'if (!JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP).skipBootstrap) require("node:assert/strict").ok(require("node:fs").readFileSync("/home/node/workspace/AGENTS.md", "utf8").length > 0);',
    'console.log("WORKSPACE_CHILD_STARTED");',
    'return new (require("node:events").EventEmitter)();',
    '};',
    entrypoint,
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", substitute], {
    env: { PATH: process.env.PATH, HOME: "/home/node", OPENCLAW_NODE_STATE_DIR: "/tmp/node-state", OPENCLAW_NODE_SETUP_CODE: "synthetic-setup", OPENCLAW_WORKSPACE_DIR: "/home/node/workspace", OPENCLAW_WORKSPACE_BOOTSTRAP: JSON.stringify(bootstrap) },
    encoding: "utf8",
  });
  if (attempt === 3) {
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /WORKSPACE_CHILD_STARTED/);
    assert.match(result.stderr, /Workspace initialization failed/);
    continue;
  }
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
console.log("WORKSPACE_INITIALIZATION_PASSED");
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
  },
);

test(
  "runtime image tells OpenClaw that a read-only Kubernetes configuration is externally managed",
  imageTestOptions,
  async (t) => {
    // An embedded OpenClaw Gateway starts from the Configuration OCC mounts read-only.
    const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
    const { containerName } = await runGatewaySmoke(t, "openclaw", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
      withAppServer: false,
    });
    assert.ok(
      (await gatewayProcessEnvironment(containerName)).includes("OPENCLAW_CONFIG_READONLY=1"),
    );
    // OpenClaw promotes its last-known-good backup just after it reports ready,
    // and only then releases its post-ready work. That work includes the remote
    // model catalog refresh, which fails at once without a network. Its log line
    // therefore comes after any promotion failure would have been logged. This
    // ordering is OpenClaw's (checked at the pinned source): re-check it when the
    // pin moves, since a promotion moved after post-ready work would pass here.
    const logs = await waitForDockerLog(containerName, /remote model catalog refresh failed/);
    assert.doesNotMatch(logs, /last-known-good|EROFS/);
  },
);
