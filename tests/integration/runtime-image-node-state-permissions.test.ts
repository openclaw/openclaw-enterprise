import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { image, imageTestOptions, runDocker } from "../helpers/runtime-image-startup.mjs";

test(
  "runtime image initializes and restarts private node state below a setgid parent",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-node-state-permissions-${randomUUID()}`;
    t.after(() => runDocker(["rm", "-f", containerName]));
    // Run OCE's whole Harness launcher and the packaged OpenClaw setup against
    // real Linux directories. Only the long-lived children after setup are
    // replaced; this proves startup filesystem behavior, not node enrollment.
    const program = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { entrypoint, startupMs } = JSON.parse(fs.readFileSync(0, "utf8"));
const children = [
  'const cp = require("node:child_process");',
  'const realSpawn = cp.spawn;',
  'cp.spawn = (command, args, options) => args[1] === "doctor"',
  '  ? realSpawn(command, args, options)',
  '  : new (require("node:events").EventEmitter)();',
].join("\n");
const mode = path => fs.statSync(path).mode & 0o7777;
for (const failedAttempt of [false, true]) {
  const parent = "/home/node/" + (failedAttempt ? "retry" : "fresh");
  const state = parent + "/state";
  const workspace = parent + "/workspace";
  fs.mkdirSync(parent);
  // fsGroup-backed volumes propagate setgid even when mkdir requests 0700.
  fs.chmodSync(parent, 0o2755);
  fs.mkdirSync(workspace);
  fs.writeFileSync(workspace + "/retained.txt", "keep workspace content");
  const workspaceMode = mode(workspace);
  if (failedAttempt) {
    // A refused first setup preserves its new control directory. The launcher
    // must recover without discarding existing private state or workspace data.
    fs.mkdirSync(state);
    fs.mkdirSync(state + "/control", { mode: 0o700 });
    assert.equal(mode(state + "/control"), 0o2700);
    fs.writeFileSync(state + "/retained.txt", "keep node state", { mode: 0o600 });
  }
  for (let start = 0; start < 2; start += 1) {
    const result = cp.spawnSync(process.execPath, ["-e", children + "\n" + entrypoint], {
      env: {
        PATH: process.env.PATH,
        HOME: "/home/node",
        OPENCLAW_NODE_STATE_DIR: state,
        OPENCLAW_NODE_SETUP_CODE: "synthetic-setup",
        OPENCLAW_WORKSPACE_DIR: workspace,
        OPENCLAW_WORKSPACE_BOOTSTRAP: JSON.stringify({ workspace }),
      },
      encoding: "utf8",
      timeout: startupMs,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    const phases = output.split("\n").flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    assert.ok(phases.some(event => event.event === "runtime.startup_phase" &&
      event.phase === "workspace-baseline" && event.outcome === "ok"), output);
    assert.equal(mode(state), 0o700);
    assert.equal(mode(state + "/control"), 0o700);
    assert.equal(mode(parent), 0o2755);
    assert.equal(mode(workspace), workspaceMode);
    assert.equal(fs.readFileSync(workspace + "/retained.txt", "utf8"), "keep workspace content");
    if (failedAttempt) {
      assert.equal(fs.readFileSync(state + "/retained.txt", "utf8"), "keep node state");
    }
  }
}
console.log("NODE_STATE_PERMISSIONS_PASSED");
`;
    const startupMs = 60_000 * imageSmokeTimeoutMultiplier;
    const { stdout } = await runDocker(
      [
        "run",
        "--name",
        containerName,
        "-i",
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:size=128m,mode=1777",
        "--tmpfs",
        "/home/node:size=128m,mode=1777",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        program,
      ],
      { timeout: 4 * startupMs + 30_000 },
      JSON.stringify({ entrypoint: AGENT_WITH_NODE_ENTRYPOINT, startupMs }),
    );
    assert.match(stdout, /NODE_STATE_PERMISSIONS_PASSED/);
  },
);
