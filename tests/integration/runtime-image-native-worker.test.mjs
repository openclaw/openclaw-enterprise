// Runtime image workspace node and native worker smoke tests, split from
// runtime-image-startup-probe.test.mjs and runtime-image-startup.test.mjs so CI
// can run them beside runtime-image-startup.test.mjs: workspace node enrollment
// and reconnect, descendant reaping across workspace node and Codex restarts,
// and the inactive Slack approver startup check on both production launchers.
// Ephemeral native worker reconnect is in runtime-image-startup-probe.test.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { assertAllPassed } from "../helpers/node-test-summary.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  commandOutput,
  image,
  imageTestOptions,
  runDocker,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

test(
  "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
  imageTestOptions,
  async (t) => {
    // The Kubernetes entrypoint admits the workspace command grant before pairing.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 240_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterRestart, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.commands.length, 7);
  },
);

test(
  "runtime image reaps descendants during workspace node and Codex restarts",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-supervisor-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
    // Run the same process proof inside the image, using the production init
    // command. Copy source over argv so this also works with a remote Docker engine.
    const paths = [
      "tests/conformance/workspace-node-supervisor.test.mjs",
      "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
      "apps/controller/src/drivers/compute/node-program.ts",
      "apps/controller/src/drivers/compute/runtime-startup.ts",
      "apps/controller/src/drivers/plugin/runtime-translator.ts",
    ];
    const files = await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ]),
    );
    const launch = String.raw`
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
for (const [relative, content] of JSON.parse(readFileSync(0, "utf8"))) {
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(process.execPath, ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.mjs"], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
    const { stdout } = await runDocker(
      [
        "run",
        "-i",
        "--rm",
        "--name",
        containerName,
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
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
      ],
      {},
      JSON.stringify(files),
    ).catch((error) => {
      // CI truncates the error message and drops the command output, so name the
      // in-image proof that failed first (main run 37424312731 lost it).
      const report = commandOutput(error);
      const failing = report.indexOf("failing tests:");
      const summary =
        failing !== -1
          ? report.slice(failing, failing + 2_000)
          : report.trim() !== ""
            ? report.slice(-2_000)
            : error.message;
      const stopped = error.killed ? ` (killed by ${error.signal ?? "a signal"})` : "";
      throw new Error(`The in-image supervisor proof failed${stopped}: ${summary}`, {
        cause: error,
      });
    });
    // Every supervisor proof in the file must pass in the image. The check reads
    // the run's own totals, so adding a proof needs no change here. The floor is
    // the 7 proofs the file had when the count stopped being hard-coded
    // (finding 1032); lower it only when a proof is removed on purpose.
    assertAllPassed(stdout, { minimum: 7 });
  },
);

test(
  "runtime image omits inactive Slack approvers and checks native compatibility before gateway launch",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-approvers-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
    // Exercise both production launchers against the selected native image. No
    // model or Slack credentials are provided, and the container has no network.
    const launch = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const entrypoints = JSON.parse(fs.readFileSync(0, "utf8"));
const manifest = { kind: "openclaw", selections: {}, pluginApprovers: [] };
const base = {
  gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false },
    auth: { mode: "token", token: "synthetic-approver-startup-token" } },
  logging: { consoleLevel: "error" },
};
const schemaResult = cp.spawnSync("node", ["/app/openclaw.mjs", "config", "schema", "--json"], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(schemaResult.status, 0, schemaResult.stderr);
const supportsSlackApprovers = JSON.parse(schemaResult.stdout).properties?.approvals?.properties?.plugin?.properties?.slack !== undefined;
async function scenario(entrypoint, channel, label) {
  const directory = fs.mkdtempSync("/tmp/oce-approver-startup-");
  const config = { ...base, ...(channel === undefined ? {} : { channels: { slack: channel } }) };
  const configPath = directory + "/base.json";
  fs.writeFileSync(configPath, JSON.stringify(config));
  const environment = { ...process.env, HOME: "/home/node", OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_JSON: JSON.stringify(config),
    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest }), OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_RUNTIME_STATUS_PORT: "18888", OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    OPENCLAW_AGENT_REVISION_ID: "rev_approver-startup", OPENCLAW_POD_UID: "pod_approver-startup" };
  const child = cp.spawn("node", ["-e", ...entrypoint], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { output += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const deadline = Date.now() + 45000;
  const incompatible = channel?.enabled !== false && channel !== undefined && !supportsSlackApprovers;
  try {
    let observed = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(label + " exited before readiness: " + output);
      if (incompatible) {
        observed = output.includes("cannot validate approvals.plugin.slack");
      } else {
        try { observed = (await fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      }
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(observed, label + " did not report its expected startup outcome: " + output);
    if (incompatible) {
      assert.equal(fs.existsSync(directory + "/openclaw.json"), false, "Rejected policy must not replace the native config");
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
      await assert.rejects(fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) }));
      if (label.startsWith("kubernetes")) {
        const status = await (await fetch("http://127.0.0.1:18888/openclaw/runtime/status")).json();
        assert.equal(status.runtimeFailure.check, "plugin-approvers");
        assert.equal(status.runtimeFailure.code, "INCOMPATIBLE_RESPONSE");
      }
    } else {
      const effective = JSON.parse(fs.readFileSync(directory + "/openclaw.json", "utf8"));
      assert.deepEqual(effective.approvals?.plugin?.slack, channel === undefined || channel.enabled === false ? undefined : { approvers: [] });
    }
    assert.deepEqual(manifest.pluginApprovers, []);
    assert.equal(fs.readdirSync("/tmp").some(name => name.startsWith("oce-plugin-approvers-")), false, "Capability probe must clean up its private config");
  } finally {
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
(async () => {
  for (const [label, entrypoint] of Object.entries(entrypoints)) {
    await scenario(entrypoint, undefined, label + " absent");
    await scenario(entrypoint, { enabled: false }, label + " disabled");
    await scenario(entrypoint, { enabled: true }, label + " configured");
  }
  console.log("PLUGIN_APPROVER_STARTUP_PASSED");
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
    const { stdout } = await runDocker(
      [
        "run",
        "-i",
        "--rm",
        "--name",
        containerName,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "node",
        image,
        "-e",
        launch,
      ],
      { timeout: 180_000 * imageSmokeTimeoutMultiplier },
      JSON.stringify({
        docker: nodeProgramArguments(DOCKER_GATEWAY_RUNTIME_ENTRYPOINT),
        kubernetes: nodeProgramArguments(KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT),
      }),
    );
    assert.match(stdout, /PLUGIN_APPROVER_STARTUP_PASSED/);
  },
);
