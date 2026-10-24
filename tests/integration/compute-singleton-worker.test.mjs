import assert from "node:assert/strict";
import test from "node:test";

test("before-commit Compute Drivers must expose an activation operation", async () => {
  const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
    await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
    ]);
  const pool = new Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  try {
    assert.throws(
      () =>
        createControllerWorker({
          pool,
          computeDriver: {
            ...createDevelopmentComputeDriver(),
            activationOrder: "beforeCommit",
          },
        }),
      /before-commit Compute Driver must implement activateRevision/,
    );
  } finally {
    await pool.end();
  }
});

test("Compute Driver maintenance intervals must be positive safe integers", async () => {
  const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
    await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.mjs"),
    ]);
  const pool = new Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  try {
    for (const maintenanceIntervalMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () =>
          createControllerWorker({
            pool,
            computeDriver: { ...createDevelopmentComputeDriver(), maintenanceIntervalMs },
          }),
        /Compute maintenance interval must be a positive safe integer/,
      );
    }
  } finally {
    await pool.end();
  }
});

test("worker timer settings must fit a Node.js timer", async () => {
  // Node fires a timer longer than 2^31-1 ms after 1 ms: the claim-lapse timer would abort every
  // claim and the poll loop would spin (finding 2303). Refuse those values at startup.
  const [
    { Pool },
    { createControllerWorker, workerDatabasePoolOptions },
    { MAX_TIMER_DELAY_MS, workerEnvironmentSettings },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("../../apps/controller/src/worker/timer-settings.ts"),
  ]);
  const over = MAX_TIMER_DELAY_MS + 1;
  const timers = [
    "OCC_WORKER_POLL_INTERVAL_MS",
    "OCC_WORKER_LEASE_DURATION_MS",
    "OCC_WORKER_DATABASE_TIMEOUT_MS",
  ];
  for (const name of timers) {
    assert.throws(
      () => workerEnvironmentSettings({ [name]: String(over) }),
      new RegExp(`^Error: ${name} must be at most ${MAX_TIMER_DELAY_MS} milliseconds\\.$`),
    );
    assert.throws(
      () => workerEnvironmentSettings({ [name]: "1.5" }),
      new RegExp(`${name} must be a positive safe integer`),
    );
  }
  assert.deepEqual(
    workerEnvironmentSettings({
      ...Object.fromEntries(timers.map((name) => [name, String(MAX_TIMER_DELAY_MS)])),
      // Only compared with work age, never a timer delay: the safe-integer bound still applies.
      OCC_WORKER_CONVERGENCE_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
    }),
    {
      pollIntervalMs: MAX_TIMER_DELAY_MS,
      leaseDurationMs: MAX_TIMER_DELAY_MS,
      maxAttempts: 5,
      convergenceTimeoutMs: Number.MAX_SAFE_INTEGER,
      databaseTimeoutMs: MAX_TIMER_DELAY_MS,
    },
  );
  assert.deepEqual(workerEnvironmentSettings({}), {
    pollIntervalMs: 250,
    leaseDurationMs: 5_000,
    maxAttempts: 5,
    convergenceTimeoutMs: 900_000,
    databaseTimeoutMs: 60_000,
  });
  assert.throws(() => workerDatabasePoolOptions(over), /Worker database timeout must be at most/);
  const pool = new Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  try {
    for (const [option, label] of [
      ["pollIntervalMs", "Worker poll interval"],
      ["leaseDurationMs", "Worker claim lease"],
    ]) {
      assert.throws(
        () => createControllerWorker({ pool, [option]: over }),
        new RegExp(`${label} must be at most ${MAX_TIMER_DELAY_MS} milliseconds`),
      );
    }
  } finally {
    await pool.end();
  }
});
