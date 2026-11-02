// Runtime image workspace node and native worker smoke tests, split from
// runtime-image-startup-probe.test.mjs and runtime-image-startup.test.mjs so CI
// can run them beside runtime-image-startup.test.mjs: workspace node enrollment
// and reconnect, descendant reaping across workspace node and Codex restarts,
// and the inactive Slack approver startup check on both production launchers.
// Ephemeral native worker reconnect is in runtime-image-startup-probe.test.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.mjs";
import { assertAllPassed } from "../helpers/node-test-summary.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  commandOutput,
  image,
  imageTestOptions,
  openClawGatewaySpawnedRequest,
  openClawProcessRunningRequest,
  runDocker,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

async function startGoogleGateway(t, enabled, workspaceNodeId) {
  const { id, releaseSha256 } = managedGoogleInstall;
  const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
  const manifest = { kind: "openclaw", selections: { [id]: { enabled } } };
  return runGatewaySmoke(t, "openclaw", {
    configurationPath: "/etc/openclaw/openclaw.json",
    entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
    volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    withAppServer: false,
    extraEnvironment: [
      ...(workspaceNodeId ? ["OPENCLAW_WORKSPACE_NODE_ID=" + workspaceNodeId] : []),
      "OPENCLAW_PLUGIN_RUNTIME_JSON=" + JSON.stringify({ manifest }),
      "OPENCLAW_MANAGED_GOOGLE_PLUGIN_ID=" + id,
      ...(enabled ? ["OPENCLAW_MANAGED_GOOGLE_RELEASE_SHA256=" + releaseSha256] : []),
    ],
  });
}

// Each case uses a private container and run-owned fixtures. Two run at a time.
describe("runtime image native worker", { concurrency: 2 }, () => {
  test(
    "the dedicated worker launches the pinned gog on PATH only for the selected release",
    imageTestOptions,
    async () => {
      const releaseFile = new URL(
        "../../apps/controller/plugins/oce-google-workspace/ai.openclaw.oce/release.json",
        import.meta.url,
      );
      const { version } = JSON.parse(await readFile(releaseFile, "utf8"));
      const expected = managedGoogleInstall.releaseSha256;
      // Exercise the production worker bootstrap in the real image. Substitute its model probe and
      // enrollment peer; the child resolves and executes the installed binary with the actual launch env.
      const probe = `const r = require("node:child_process").spawnSync("gog", ["--version"], {encoding:"utf8"});
console.log(JSON.stringify({...(r.error ? {code:r.error.code} : {version:r.stdout.trim().split(" ")[0]}), markerVisible:process.env.GOG_ACCESS_TOKEN===undefined?undefined:"present"}));
process.exit(r.error ? 0 : r.status);`;
      const launch = `
const cp = require("node:child_process"), realSpawn = cp.spawn;
cp.spawnSync = () => ({status:0,stdout:JSON.stringify({auth:{probes:{results:[{provider:"openai",model:"openai/test",source:"env",status:"ok"}]}}})});
cp.spawn = (command, args, options) => {
  require("node:assert/strict").deepEqual(args.slice(0, 2), ["/app/openclaw.mjs", "connect"]);
  return realSpawn(command, ["-e", ${JSON.stringify(probe)}], options);
};
Object.assign(process.env, {
  HOME:"/tmp/home", TMPDIR:"/tmp/worker-tmp", OPENCLAW_WORKSPACE_DIR:"/tmp/workspace", OPENCLAW_NODE_STATE_DIR:"/tmp/node",
  OPENCLAW_NODE_SETUP_CODE:"fixture", OPENCLAW_NATIVE_WORKER_CAPACITY:"1", OPENCLAW_NATIVE_INFERENCE_CONFIG:"{}",
  OPENCLAW_HARNESS_MODEL:"openai/test", OPENCLAW_HARNESS_PROVIDER:"openai", OPENCLAW_HARNESS_CREDENTIAL_ENV:"TEST_MODEL_KEY",
  TEST_MODEL_KEY:"fixture", OPENCLAW_HARNESS_PROBE_CONFIG:'{"agents":{"defaults":{"model":"openai/test"}}}'
});
${NATIVE_WORKER_ENTRYPOINT}`;
      const worker = (digest, mounts = [], environment = []) =>
        runDocker(
          [
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--tmpfs",
            "/tmp:mode=1777",
            ...(digest === undefined
              ? []
              : ["-e", "OPENCLAW_MANAGED_GOOGLE_RELEASE_SHA256=" + digest]),
            ...mounts,
            ...environment.flatMap((entry) => ["--env", entry]),
            "--entrypoint",
            "node",
            image,
            // The default OpenShell policy permits image reads under /usr and /app. Exercise
            // the bootstrap with those roots plus its writable fixture home under /tmp.
            "--permission",
            "--allow-fs-read=/usr",
            "--allow-fs-read=/app",
            "--allow-fs-read=/tmp",
            "--allow-fs-write=/tmp",
            "--allow-child-process",
            "-",
          ],
          {},
          launch,
        );
      const marker =
        "GOG_ACCESS_TOKEN=openshell:resolve:env:s" + "a".repeat(64) + "_GOG_ACCESS_TOKEN";
      assert.deepEqual(JSON.parse((await worker(undefined, [], [marker])).stdout.trim()), {
        code: "ENOENT",
        markerVisible: "present",
      });
      assert.deepEqual(JSON.parse((await worker(expected)).stdout.trim()), {
        version: "v" + version,
      });
      const bound = "OPENCLAW_MANAGED_GOOGLE_CREDENTIAL_ENV=GOG_ACCESS_TOKEN";
      assert.deepEqual(JSON.parse((await worker(expected, [], [marker])).stdout), {
        version: "v" + version,
        markerVisible: "present",
      });
      assert.deepEqual(JSON.parse((await worker(expected, [], [bound])).stdout), {
        version: "v" + version,
      });
      assert.deepEqual(JSON.parse((await worker(expected, [], ["GOG_ACCESS_TOKEN=raw"])).stdout), {
        version: "v" + version,
      });
      assert.deepEqual(JSON.parse((await worker(expected, [], [bound, marker])).stdout), {
        version: "v" + version,
        markerVisible: "present",
      });
      await assert.rejects(
        worker(expected, [], [bound, "GOG_ACCESS_TOKEN=not-an-issued-placeholder"]),
        (error) => /requires its scoped OpenShell credential placeholder/.test(error.stderr),
      );
      await assert.rejects(worker("0".repeat(64)), (error) =>
        /image integrity check: \/usr\/local\/lib\/oce\/plugins\/google\/release\.json/.test(
          error.stderr,
        ),
      );
      await assert.rejects(
        worker(expected, [
          "-v",
          fileURLToPath(releaseFile) + ":/usr/local/lib/oce/plugins/google/bin/gog:ro",
        ]),
        (error) =>
          /image integrity check: \/usr\/local\/lib\/oce\/plugins\/google\/bin\/gog/.test(
            error.stderr,
          ),
      );
    },
  );

  test(
    "the native Gateway discovers the selected Google installation instructions",
    imageTestOptions,
    async (t) => {
      const { containerName } = await startGoogleGateway(t, true);
      const { stdout } = await runDocker([
        "exec",
        "-e",
        "OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
        containerName,
        "node",
        "/app/openclaw.mjs",
        "skills",
        "info",
        "oce-google",
        "--json",
      ]);
      assert.equal(
        JSON.parse(stdout).filePath,
        "/usr/local/lib/oce/plugins/google/skills/oce-google/SKILL.md",
      );
    },
  );

  test(
    "the node skill policy admits only the selected Google instructions",
    imageTestOptions,
    async (t) => {
      const probe = await readFile(
        new URL("../fixtures/runtime-google-skill-policy.mts", import.meta.url),
        "utf8",
      );
      for (const enabled of [false, true]) {
        const { containerName } = await startGoogleGateway(t, enabled, "a".repeat(64));
        await runDocker(
          [
            "exec",
            "-i",
            containerName,
            "node",
            "--input-type=module-typescript",
            "-",
            String(enabled),
          ],
          {},
          probe,
        );
      }
    },
  );

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
      // The fixture bounds every CLI call and wait by one deadline 10 s inside this
      // exec timeout, so a hung call fails with its own name.
      const execTimeoutMs = 240_000 * imageSmokeTimeoutMultiplier;
      const { stdout } = await runDocker(
        [
          "exec",
          "-e",
          `WORKSPACE_PROOF_BUDGET_MS=${execTimeoutMs - 10_000}`,
          containerName,
          "node",
          "--input-type=module",
          "-e",
          source,
        ],
        { timeout: execTimeoutMs },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.sameIdentityAfterRestart, true);
      assert.equal(result.singleBootstrapCompletion, true);
      assert.equal(result.commands.length, 7);
      t.diagnostic(`slowest gateway call: ${result.slowestCallMs} ms`);
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
        "tests/helpers/available-port.mjs",
        "tests/helpers/reuse-port-preload.mjs",
        "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
        "apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts",
        "apps/controller/plugins/oce-google-workspace/ai.openclaw.oce/release.json",
        "apps/controller/src/drivers/compute/embedded-gateway-owner.ts",
        "apps/controller/src/drivers/compute/gateway-tool-policy.ts",
        "apps/controller/src/drivers/compute/harness-egress-enrollment.ts",
        "apps/controller/src/drivers/compute/node-program.ts",
        "apps/controller/src/drivers/compute/openclaw-config-issues.ts",
        "apps/controller/src/drivers/compute/runtime-startup.ts",
        "apps/controller/src/drivers/plugin/runtime-translator.ts",
        "packages/contracts/src/runtime-failure.mjs",
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
const { entrypoints, schemaMs, startupMs } = JSON.parse(fs.readFileSync(0, "utf8"));
const gatewaySpawned = ${openClawGatewaySpawnedRequest};
const openClawRunning = ${openClawProcessRunningRequest};
const manifest = { kind: "openclaw", selections: {}, pluginApprovers: [] };
const base = {
  gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false },
    auth: { mode: "token", token: "synthetic-approver-startup-token" } },
  logging: { consoleLevel: "error" },
};
const schemaResult = cp.spawnSync("node", ["/app/openclaw.mjs", "config", "schema", "--json"], { encoding: "utf8", timeout: schemaMs, maxBuffer: 8 * 1024 * 1024 });
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
  const deadline = Date.now() + startupMs;
  const incompatible = channel?.enabled !== false && channel !== undefined && !supportsSlackApprovers;
  // Only a configured Slack channel gets the approver overlay, so only that case
  // needs OpenClaw's full start to prove it accepts the policy. Without the overlay
  // the effective config is the base config: those cases end once the launcher has
  // passed its checks and spawned OpenClaw (four fewer full starts per run).
  const fullStart = channel?.enabled === true;
  try {
    let observed = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(label + " exited before readiness: " + output);
      if (incompatible) {
        observed = output.includes("cannot validate approvals.plugin.slack");
      } else if (!fullStart) {
        observed = (await gatewaySpawned()) === 200;
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
  // The launcher forwards SIGTERM to OpenClaw and exits with it, but a respawned
  // OpenClaw stopped early in its start can outlive it briefly. The next scenario
  // reuses the port, so wait until no OpenClaw process runs.
  const stopDeadline = Date.now() + 30_000;
  while ((await openClawRunning()) === 200 && Date.now() < stopDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await openClawRunning(), 503, label + " left an OpenClaw process running");
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
      // The waits scale with the runner's CPUs: the lane's other files start runtimes
      // at the same time, so a slow start under that load is not a failure. A start
      // that never reports its outcome still fails within startupMs. The container
      // reads the schema once, then starts six runtimes one after another (two
      // launchers, Slack absent, disabled and configured; only configured runs to
      // /healthz): its limit is their sum plus a minute to create and remove the
      // container.
      const schemaMs = cpuScaledImageTimeoutMs(30_000);
      const startupMs = cpuScaledImageTimeoutMs(45_000);
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
        { timeout: schemaMs + 6 * startupMs + 60_000 * imageSmokeTimeoutMultiplier },
        JSON.stringify({
          entrypoints: {
            docker: nodeProgramArguments(DOCKER_GATEWAY_RUNTIME_ENTRYPOINT),
            kubernetes: nodeProgramArguments(KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT),
          },
          schemaMs,
          startupMs,
        }),
      );
      assert.match(stdout, /PLUGIN_APPROVER_STARTUP_PASSED/);
    },
  );
});
