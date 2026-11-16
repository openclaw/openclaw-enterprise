import assert from "node:assert/strict";

// Native hosts keep the Strands test deadlines. A host under software CPU
// emulation (an ARM64 guest on another architecture) may opt into bounded extra
// time without changing any expected outcome.
export const strandsTimeoutMultiplier = Number(
  process.env.OCC_TEST_STRANDS_TIMEOUT_MULTIPLIER ?? 1,
);
assert.ok(
  Number.isSafeInteger(strandsTimeoutMultiplier) &&
    strandsTimeoutMultiplier >= 1 &&
    strandsTimeoutMultiplier <= 10,
  "OCC_TEST_STRANDS_TIMEOUT_MULTIPLIER must be an integer between 1 and 10.",
);

export function strandsTimeoutMs(nativeMs: number): number {
  return nativeMs * strandsTimeoutMultiplier;
}
