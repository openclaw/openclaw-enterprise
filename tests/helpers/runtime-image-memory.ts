import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { productionGatewayMemoryLimitGi } from "./kubernetes-real.ts";
import { runDocker } from "./runtime-image-docker.ts";

// The production Gateway memory limit (productionGatewayMemoryLimitGi), with
// swap capped at the same value. Docker's `--memory` alone allows as much again
// in swap, so a Gateway that outgrew its limit passed on CI runners, which swap,
// and was OOM-killed on a host without swap, as on a typical Kubernetes node
// (finding 2700).
const gatewayMemoryLimitBytes = productionGatewayMemoryLimitGi * 1024 ** 3;
export const gatewayMemoryArguments = [
  "--memory",
  String(gatewayMemoryLimitBytes),
  "--memory-swap",
  String(gatewayMemoryLimitBytes),
];
// The most an embedded Gateway's cgroup may have held (memory.peak) through its
// first chat turn: the limit above less about 20% headroom. At the OpenClaw pin
// of #2982 the stand-in provider's first turn peaked at 2.53 to 2.78 GiB
// (finding 2700). A failure means the Gateway grew toward its production limit:
// re-measure the first turn and update the documented Gateway sizing (the
// production example, the profile renderer, installation-profiles.md and this
// limit) before raising the budget.
export const gatewayFirstTurnMemoryBudgetBytes = Math.round(3.2 * 1024 ** 3);

const gibibytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

type GatewayMemoryPeak =
  { peakBytes: number; unavailable?: never } | { unavailable: string; peakBytes?: never };

// Reads a running Gateway container's cgroup v2 memory.peak (Linux 5.19 and
// later): the most the container held since it started, including the page
// cache and tmpfs it is charged for. Returns `{ unavailable }` with the reason
// when the host cannot report it.
export async function gatewayMemoryPeak(containerName: string): Promise<GatewayMemoryPeak> {
  let stdout: string;
  try {
    ({ stdout } = await runDocker([
      "exec",
      containerName,
      "cat",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory.peak",
    ]));
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return {
      unavailable: `the container's cgroup v2 memory.max and memory.peak are unreadable: ${error.message.slice(0, 300)}`,
    };
  }
  const [max, peak] = stdout.trim().split("\n");
  // In the host's cgroup namespace /sys/fs/cgroup is another cgroup; only the
  // container's own cgroup carries the limit this file sets.
  if (Number(max) !== gatewayMemoryLimitBytes) {
    return {
      unavailable: `/sys/fs/cgroup is not the Gateway container's cgroup: memory.max is ${max}, not ${gatewayMemoryLimitBytes}`,
    };
  }
  return { peakBytes: Number(peak) };
}

// Checks a peak from gatewayMemoryPeak against the first-turn budget in its own
// subtest, which reports a host without memory.peak as skipped, not passed.
export async function assertGatewayFirstTurnMemory(
  t: TestContext,
  measurement: GatewayMemoryPeak,
): Promise<void> {
  await t.test("the Gateway's first turn stays within its memory budget", (subtest) => {
    if (measurement.unavailable !== undefined) {
      subtest.skip(
        `memory.peak is unavailable, so the budget is unchecked: ${measurement.unavailable}`,
      );
      return;
    }
    const { peakBytes } = measurement;
    assert.ok(
      peakBytes <= gatewayFirstTurnMemoryBudgetBytes,
      `the Gateway's memory.peak through its first turn is ${gibibytes(peakBytes)}, above its ` +
        `${gibibytes(gatewayFirstTurnMemoryBudgetBytes)} budget under a ${gibibytes(gatewayMemoryLimitBytes)} limit. ` +
        "If the OpenClaw pin moved, re-measure the first turn without swap (finding 2700) and update the " +
        "documented Gateway sizing (deploy/examples/production/installation.yaml, " +
        "scripts/render-installation-profile.ts, docs/guides/deploy/installation-profiles.md) and this " +
        "test's limit before raising gatewayFirstTurnMemoryBudgetBytes.",
    );
    subtest.diagnostic(`Gateway memory.peak through the first turn: ${gibibytes(peakBytes)}`);
  });
}
