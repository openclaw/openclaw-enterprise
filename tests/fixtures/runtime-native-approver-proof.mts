import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";

// These two markers are replaced with the shared process probes before execution.
const require = createRequire("/app/package.json");
const gatewaySpawned = readinessRequest("GATEWAY_SPAWNED_PROBE");
const openClawRunning = readinessRequest("OPENCLAW_RUNNING_PROBE");

function readinessRequest(source: string): () => Promise<number> {
  const request: unknown = Function("require", "return (" + source + ");")(require);
  assert.ok(typeof request === "function", "Invalid Gateway readiness probe");
  return async () => {
    const status: unknown = await request();
    assert.ok(typeof status === "number", "Expected a numeric process status");
    return status;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function duration(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

function programArgs(value: unknown): string[] {
  assert.ok(Array.isArray(value) && value.length > 0);
  assert.ok(value.every((entry: unknown): entry is string => typeof entry === "string"));
  return value;
}

const input = record(JSON.parse(readFileSync(0, "utf8")));
assert.ok(input, "Expected the native approver input");
const entrypoints = record(input.entrypoints);
const docker = programArgs(entrypoints?.docker);
const kubernetes = programArgs(entrypoints?.kubernetes);
const schemaMs = duration(input.schemaMs);
const startupMs = duration(input.startupMs);

const manifest = { kind: "openclaw", selections: {}, pluginApprovers: [] };
const base = {
  gateway: {
    mode: "local",
    bind: "loopback",
    controlUi: { enabled: false },
    auth: { mode: "token", token: "synthetic-approver-startup-token" },
  },
  logging: { consoleLevel: "error" },
};
const schemaResult = spawnSync("node", ["/app/openclaw.mjs", "config", "schema", "--json"], {
  encoding: "utf8",
  timeout: schemaMs,
  maxBuffer: 8 * 1024 * 1024,
});
assert.equal(schemaResult.status, 0, schemaResult.stderr);
const schema = record(JSON.parse(schemaResult.stdout));
assert.ok(schema, "Expected a Gateway configuration schema");
const approvals = record(record(schema.properties)?.approvals);
const plugin = record(record(approvals?.properties)?.plugin);
const supportsSlackApprovers = record(plugin?.properties)?.slack !== undefined;
async function scenario(
  entrypoint: string[],
  channel: { enabled: boolean } | undefined,
  label: string,
) {
  const directory = mkdtempSync("/tmp/oce-approver-startup-");
  const config = { ...base, ...(channel === undefined ? {} : { channels: { slack: channel } }) };
  const configPath = directory + "/base.json";
  writeFileSync(configPath, JSON.stringify(config));
  const environment = {
    ...process.env,
    HOME: "/home/node",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_JSON: JSON.stringify(config),
    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest }),
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_RUNTIME_STATUS_PORT: "18888",
    OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    OPENCLAW_AGENT_REVISION_ID: "rev_approver-startup",
    OPENCLAW_POD_UID: "pod_approver-startup",
  };
  const child = spawn("node", ["-e", ...entrypoint], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value: Buffer) => {
    output += value;
  });
  child.stderr.on("data", (value: Buffer) => {
    output += value;
  });
  const exited = once(child, "exit").then(() => {});
  // Handle a spawn failure immediately and surface it from the awaited cleanup.
  void exited.catch(() => {});
  const deadline = Date.now() + startupMs;
  const incompatible =
    channel?.enabled !== false && channel !== undefined && !supportsSlackApprovers;
  // Only a configured Slack channel gets the approver overlay, so only that case
  // needs OpenClaw's full start to prove it accepts the policy. Without the overlay
  // the effective config is the base config: those cases end once the launcher has
  // passed its checks and spawned OpenClaw (four fewer full starts per run).
  const fullStart = channel?.enabled === true;
  try {
    let observed = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(label + " exited before readiness: " + output);
      }
      if (incompatible) {
        observed = output.includes("cannot validate approvals.plugin.slack");
      } else if (!fullStart) {
        observed = (await gatewaySpawned()) === 200;
      } else {
        try {
          observed = (
            await fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) })
          ).ok;
        } catch {
          // The process may not yet be accepting connections.
        }
      }
      if (observed) {
        break;
      }
      await setTimeout(100);
    }
    assert.ok(observed, label + " did not report its expected startup outcome: " + output);
    if (incompatible) {
      assert.equal(
        existsSync(directory + "/openclaw.json"),
        false,
        "Rejected policy must not replace the native config",
      );
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), config);
      await assert.rejects(
        fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) }),
        { name: "TypeError", message: "fetch failed" },
      );
      if (label.startsWith("kubernetes")) {
        const status: unknown = await (
          await fetch("http://127.0.0.1:18888/openclaw/runtime/status")
        ).json();
        const failure = record(record(status)?.runtimeFailure);
        assert.equal(failure?.check, "plugin-approvers");
        assert.equal(failure?.code, "INCOMPATIBLE_RESPONSE");
      }
    } else {
      const effective = record(JSON.parse(readFileSync(directory + "/openclaw.json", "utf8")));
      assert.ok(effective, "Expected an effective Gateway configuration");
      assert.deepEqual(
        record(record(effective.approvals)?.plugin)?.slack,
        channel === undefined || channel.enabled === false ? undefined : { approvers: [] },
      );
    }
    assert.deepEqual(manifest.pluginApprovers, []);
    assert.equal(
      readdirSync("/tmp").some((name) => name.startsWith("oce-plugin-approvers-")),
      false,
      "Capability probe must clean up its private config",
    );
  } finally {
    child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // The launcher forwards SIGTERM to OpenClaw and exits with it, but a respawned
  // OpenClaw stopped early in its start can outlive it briefly. The next scenario
  // reuses the port, so wait until no OpenClaw process runs.
  const stopDeadline = Date.now() + 30_000;
  while ((await openClawRunning()) === 200 && Date.now() < stopDeadline) {
    await setTimeout(100);
  }
  assert.equal(await openClawRunning(), 503, label + " left an OpenClaw process running");
}
for (const [label, entrypoint] of [
  ["docker", docker],
  ["kubernetes", kubernetes],
] as const) {
  await scenario(entrypoint, undefined, label + " absent");
  await scenario(entrypoint, { enabled: false }, label + " disabled");
  await scenario(entrypoint, { enabled: true }, label + " configured");
}
console.log("PLUGIN_APPROVER_STARTUP_PASSED");
