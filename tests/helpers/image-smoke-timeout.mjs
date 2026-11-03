import assert from "node:assert/strict";
import { availableParallelism } from "node:os";

// Native image checks retain their deadlines. Emulated release preparation may
// opt into bounded extra time without changing any expected startup outcome.
export const imageSmokeTimeoutMultiplier = Number(
  process.env.OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER ?? 1,
);
assert.ok(
  Number.isSafeInteger(imageSmokeTimeoutMultiplier) &&
    imageSmokeTimeoutMultiplier >= 1 &&
    imageSmokeTimeoutMultiplier <= 10,
  "OCC_TEST_IMAGE_TIMEOUT_MULTIPLIER must be an integer between 1 and 10.",
);

// A startup wait sized on an 8-CPU runner, for the CPUs this runner has. CI runs
// image files side by side, so a runtime start on 4 CPUs honestly takes about twice
// as long, and longer while every file starts at once (finding 2448: a 45 s wait
// failed on a 16vcpu runner). The wait grows at most fourfold (2 CPUs), so a hang
// still fails within minutes.
export function cpuScaledImageTimeoutMs(eightCpuMs) {
  const cpuFactor = Math.min(4, Math.max(1, 8 / availableParallelism()));
  return Math.ceil(eightCpuMs * imageSmokeTimeoutMultiplier * cpuFactor);
}
