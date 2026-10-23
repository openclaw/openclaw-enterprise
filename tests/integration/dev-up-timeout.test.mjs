import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  composeOptions,
  createFixture,
  readJsonLines,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";

test(
  "dev-up waits the full helper deadline before failing a running but unready worker",
  {
    skip:
      process.env.OCC_TEST_DEV_UP_REAL_TIMEOUT === "1"
        ? false
        : "Set OCC_TEST_DEV_UP_REAL_TIMEOUT=1 to spend 300s proving the helper timeout boundary.",
    timeout: 330_000,
  },
  async (t) => {
    const fixture = await createFixture(t, { scenario: "worker-timeout" });
    const keyOutput = join(fixture.directory, "timeout-key.json");
    const startedAt = Date.now();

    const result = await runDevUp(
      ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
      fixture.env,
    );
    const elapsedMs = Date.now() - startedAt;

    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null);
    assert.ok(elapsedMs >= 299_000, `expected full helper timeout, observed ${elapsedMs}ms`);
    assert.match(
      result.stderr,
      /readiness failed: worker readiness probe did not pass within 300s/,
    );
    assert.match(result.stderr, /diagnostic: docker compose .* logs worker/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
    const dockerLogs = await readJsonLines(fixture.dockerLog);
    assert.ok(
      dockerLogs.filter((entry) => entry.args[0] === "compose" && entry.args.includes("exec"))
        .length > 1,
    );
    assert.equal(
      dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("cp")),
      false,
    );
  },
);
