import assert from "node:assert/strict";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
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

    assert.ifError(result.error);
    assert.ok(result.status !== null && result.status !== 0, "expected a normal nonzero exit");
    assert.equal(result.signal, null);
    assert.ok(elapsedMs >= 299_000, `expected full helper timeout, observed ${elapsedMs}ms`);
    assert.match(
      result.stderr,
      /readiness failed: worker readiness probe did not pass within 300s/,
    );
    assert.match(
      result.stderr,
      /^diagnostic: docker compose .* --project-name oce-dev-up-test (?:.* )?logs worker$/m,
    );
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));

    // The fixture returns the same failure for every exec. Check each retry's command
    // so a wrong service, script, or readiness argument cannot satisfy the deadline case.
    const composeCommands = (await readJsonLines(fixture.dockerLog))
      .map((row) => {
        const args = asRecord(row)?.args;
        assert.ok(
          Array.isArray(args) && args.every((argument: unknown) => typeof argument === "string"),
          "expected string arguments in the Docker command log",
        );
        return args;
      })
      .filter((args) => args[0] === "compose");
    const probes = composeCommands.filter((args) => args.includes("exec"));
    assert.ok(probes.length > 1, "expected repeated worker readiness probes");
    for (const args of probes) {
      assert.deepEqual(
        args.slice(args.indexOf("exec")),
        ["exec", "-T", "worker", "node", "scripts/production-healthcheck.ts", "worker", "ready"],
        "expected each Compose exec to run the worker readiness command",
      );
    }

    // Readiness must fail before dev-up copies the bootstrap key or authenticates to OCC.
    assert.ok(!composeCommands.some((args) => args.includes("cp")), "copied the bootstrap key");
    await assert.rejects(lstat(keyOutput), { code: "ENOENT" });
    assert.deepEqual(await readJsonLines(fixture.occLog), [], "expected no Installation request");
    const scratch = (await readdir(fixture.directory)).filter((name) =>
      name.startsWith("openclaw-dev-up."),
    );
    assert.deepEqual(scratch, [], "dev-up left its scratch directory behind");
  },
);
