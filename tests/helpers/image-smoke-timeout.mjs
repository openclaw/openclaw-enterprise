import assert from "node:assert/strict";

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
