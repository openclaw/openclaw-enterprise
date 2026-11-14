import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertKeycloakSecondPassFailure,
  registerInstallationKeycloak,
} from "../helpers/dev-up-installation-workflows.mjs";
import {
  createRunnerFixture,
  laneArgs,
  runnerArtifactPaths,
  runRunnerSync,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

registerInstallationKeycloak();

test("Keycloak mismatch reports the expected checkpoint and ignores error accessors", () => {
  const stdout = "Enabling Keycloak sign-in (second Helm pass)...\n";
  const helm = "injected second Helm pass failure";
  const cleanup = "injected owned cluster deletion failure";

  assert.equal(assertKeycloakSecondPassFailure({ stdout, stderr: helm + "\n" + cleanup }), true);
  assert.throws(
    () => assertKeycloakSecondPassFailure({ stdout, stderr: cleanup, code: 1 }),
    /expected injected second Helm pass failure.*last observed stage=Keycloak second Helm pass/,
  );
  assert.throws(
    () => assertKeycloakSecondPassFailure({ stdout, stderr: helm, code: 1, signal: "SIGTERM" }),
    /expected injected owned cluster deletion failure.*exit=1 signal=SIGTERM/,
  );

  assert.throws(
    () => assertKeycloakSecondPassFailure({ code: "invented-code", signal: "invented-signal" }),
    /exit=unknown signal=unknown/,
  );

  let reads = 0;
  const error = Object.defineProperties(new Error("child message"), {
    stdout: { get: () => ++reads },
    stderr: { get: () => ++reads },
    code: { get: () => ++reads },
    signal: { get: () => ++reads },
  });
  assert.throws(
    () => assertKeycloakSecondPassFailure(error),
    /expected Keycloak second Helm pass.*last observed stage=unknown.*exit=unknown signal=unknown/,
  );
  assert.equal(reads, 0);
});

test("Keycloak mismatch keeps launcher content out of CI results and full diagnostics", async (t) => {
  const root = await createRunnerFixture(t);
  const lane = "keycloak-mismatch";
  const file = "tests/integration/keycloak-mismatch.test.ts";
  const { statePath, resultsPath } = runnerArtifactPaths(root, lane);
  const helper = new URL("../helpers/dev-up-installation-workflows.mjs", import.meta.url);
  // The same synthetic value covers adjacent keys and an opener lost to both old tail limits.
  const marker = "invented-keycloak-marker";
  const cases = [63, 64, 65].flatMap((spaces) =>
    [false, true].map((outsideTail) => ({
      name: `early launcher failure ${spaces} ${outsideTail ? "clipped opener" : "retained opener"}`,
      stdout:
        "Creating Kubernetes-only k3d cluster owned-fixture...\n" +
        "[occ-dev-timing] stage=runtime-build elapsed_ms=45 failed=true\n",
      stderr:
        "token:\n" +
        `"credentials"${" ".repeat(spaces)}: {\n` +
        (outsideTail ? '  "padding": "' + "x".repeat(6_100) + '",\n' + "\n".repeat(45) : "") +
        `  "inner": ["${marker}"]\n}\n` +
        "failed to fetch a build dependency\n",
      code: 47,
      signal: null,
    })),
  );
  await writeSingleFileRunnerLane(
    root,
    lane,
    file,
    `import test from "node:test";
import { assertKeycloakSecondPassFailure } from ${JSON.stringify(helper.href)};
for (const { name, ...error } of ${JSON.stringify(cases)}) {
  test(name, () => assertKeycloakSecondPassFailure(error));
}
`,
  );
  const result = runRunnerSync(laneArgs(root, lane, statePath, resultsPath));
  assert.equal(result.status, 1);
  const summary = await readFile(resultsPath, "utf8");
  const detail = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const outputs = {
    results: summary,
    "full diagnostics": detail,
    "job output": result.stdout + result.stderr,
  };
  const disclosures = Object.entries(outputs)
    .filter(([, output]) => output.includes(marker))
    .map(([name]) => name);
  assert.deepEqual(disclosures, [], "invented marker reached reporter outputs");
  for (const [outputName, output] of Object.entries(outputs)) {
    assert.equal(output.includes("owned-fixture"), false, `${outputName} disclosed launcher text`);
    assert.match(output, /expected Keycloak second Helm pass/);
    assert.match(output, /last observed stage=cluster creation/);
    assert.match(output, /failed-build=runtime-build/);
    assert.match(output, /exit=47 signal=none/);
    assert.match(output, /build-error=download/);
  }
  for (const { name, ...error } of cases) {
    assert.throws(
      () => assertKeycloakSecondPassFailure(error),
      (mismatch) => {
        assert.ok(mismatch instanceof Error);
        assert.equal(mismatch.message.includes(marker), false, name);
        assert.equal(mismatch.cause, undefined);
        return true;
      },
    );
  }
  const summaryFile = JSON.parse(summary).files[0];
  assert.equal(summaryFile.counts.failed, cases.length);
  const detailTests = JSON.parse(detail).failures[0].tests;
  assert.equal(detailTests.length, cases.length);
  for (const [index, { name }] of cases.entries()) {
    assert.equal(detailTests[index].name, name);
    assert.match(detailTests[index].message, /failed-build=runtime-build build-error=download/);
  }
});
