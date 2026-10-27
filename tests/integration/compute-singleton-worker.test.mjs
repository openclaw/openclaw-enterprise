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

test("Sandbox Driver maintenance intervals must be positive safe integers", async () => {
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
            computeDriver: createDevelopmentComputeDriver(),
            sandboxDriver: {
              id: "sandbox-fixture",
              capability: "sandbox",
              implementation: "fixture",
              facets: ["process"],
              cleanup: async () => {},
              maintenanceIntervalMs,
            },
          }),
        /Sandbox maintenance interval must be a positive safe integer/u,
      );
    }
  } finally {
    await pool.end();
  }
});
