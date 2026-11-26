import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { pluginRuntimeSpecForRevision } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { startCodexGatewaySupervisor as startGatewaySupervisor } from "../helpers/codex-gateway-supervisor.ts";
import {
  codexLinearPluginState,
  gatewayRuntimeProvenance,
  nodeRequire,
  parseJson,
  pluginAppServerToken,
  record,
  required,
  revision,
  text,
  waitForCondition,
} from "./plugin-compute-fixtures.ts";

// EX_TEMPFAIL: the status a Kubernetes Gateway wrapper exits with when it restarts its own
// container on purpose (finding 3041).
export const DELIBERATE_RESTART = 75;

// The wrapper names a deliberate restart once: in a startup phase line, which the runtime
// logs API keeps, and in the container's termination message.
export function assertDeliberateRestart(
  gateway: Awaited<ReturnType<typeof startGatewaySupervisor>>,
  code: string,
) {
  const restarts = gateway.logs.flatMap((line) => {
    try {
      const entry = record(parseJson(text(line)));
      return entry.event === "runtime.startup_phase" && entry.phase === "container-restart"
        ? [entry]
        : [];
    } catch {
      return [];
    }
  });
  assert.equal(restarts.length, 1, JSON.stringify(gateway.logs));
  assert.equal(required(restarts[0]).container, "gateway");
  assert.equal(required(restarts[0]).code, code);
  assert.equal(
    gateway.files.get("/dev/termination-log"),
    `deliberate restart: ${code.toLowerCase().replaceAll("_", "-")}`,
  );
  assert.equal(
    gateway.files.has(UNEXPLAINED_EXITS),
    false,
    "a deliberate restart clears the count",
  );
}

// Where the Kubernetes Gateway wrapper keeps its container's consecutive unexplained exits:
// /tmp is the Pod's emptyDir, which outlives a container restart.
export const UNEXPLAINED_EXITS = "/tmp/.oce-unexplained-exits";
export const unexplainedExits = (count: number) => `consecutive unexplained exits: ${count}`;

export function startCodexGatewaySupervisor(
  t: TestContext,
  options?: Parameters<typeof startGatewaySupervisor>[2],
) {
  return startGatewaySupervisor(
    t,
    {
      provenance: gatewayRuntimeProvenance,
      buildManifest: () =>
        pluginRuntimeSpecForRevision(
          revision({
            plugins: codexLinearPluginState({
              toolDefaults: { approval: "provider_default", reviewer: "auto" },
            }),
          }),
        ),
      pluginAppServerToken,
      waitForCondition,
      nodeRequire,
    },
    options,
  );
}
