import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import { loadRunnerManifest, selectLane } from "../../scripts/ci/runner-inputs.ts";
import { loadPrepare } from "../../scripts/ci/runner-preparation.ts";

const [, , statePath] = process.argv;
assert.ok(statePath, "expected a CI preparation journal path");

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../scripts/ci/test-suites.json", import.meta.url));
const manifest = loadRunnerManifest(manifestPath, process.env.OCC_CI_SUITE_VIEW);
const { lane, issues } = selectLane(
  manifest,
  "postgres-application",
  "tests/integration/postgres-worker-agent-revision-refused-stop.test.ts",
);
assert.deepEqual(issues, []);
const file = lane?.files[0];
assert.ok(lane && file, "expected a registered PostgreSQL application lane and file");
const prepareFile = await loadPrepare(root);
assert.ok(prepareFile, "expected the CI file preparer");

await assert.rejects(
  async () =>
    prepareFile({
      lane,
      file,
      statePath,
      modelSelectors: {
        OCC_TEST_OPENSHELL_HARNESS: undefined,
        OCC_TEST_OPENSHELL_MODEL_BASE_URL: undefined,
      },
    }),
  (error: unknown) => {
    assert.ok(error instanceof Error);
    // Report only classification fields. Messages and command output may contain secrets.
    const details = asRecord(error);
    assert.ok(details);
    const { code, stage, failure, exitCode, signal, timedOut } = details;
    process.stdout.write(JSON.stringify({ code, stage, failure, exitCode, signal, timedOut }));
    return true;
  },
);
