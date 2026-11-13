import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { reviewedCodexSeccompSecurityOptions } from "../helpers/runtime-image-startup.mjs";

export async function verifyRuntimeSeccompRecord(
  t: TestContext,
  {
    stagingCodexVersion,
    historicalCodex,
  }: { stagingCodexVersion: string; historicalCodex: boolean },
): Promise<void> {
  const directory = await temporaryDirectory(t, "oce-runtime-seccomp-profile-");
  const contents = Buffer.from(`${JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO" })}\n`);
  const digest = createHash("sha256").update(contents).digest("hex");
  const profile = join(directory, `codex-${stagingCodexVersion}-${digest}.json`);
  const statePath = join(directory, "state.json");
  await writeFile(profile, contents);
  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: profile, sha256: digest },
        },
      ],
    }),
  );

  const options = { profile, ciStatePath: statePath, codexVersion: stagingCodexVersion };
  assert.deepEqual(await reviewedCodexSeccompSecurityOptions(options), [
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${profile}`,
  ]);
  await assert.rejects(
    reviewedCodexSeccompSecurityOptions({
      ...options,
      codexVersion: historicalCodex ? "0.164.0" : "0.163.0-alpha.2",
    }),
    /must point to codex-/,
  );

  await assert.rejects(
    reviewedCodexSeccompSecurityOptions({ ...options, ciStatePath: "" }),
    /must be prepared by image CI state/,
  );

  // Without a profile, only a local run (no CI, no CI state) may fall back to
  // Docker's default seccomp; CI fails instead of running the case unconfined.
  assert.deepEqual(
    await reviewedCodexSeccompSecurityOptions({ profile: "", ciStatePath: "", ci: "" }),
    ["--security-opt", "no-new-privileges"],
  );
  for (const environment of [
    { ciStatePath: "", ci: "true" },
    { ciStatePath: "", ci: "1" },
    { ciStatePath: statePath, ci: "" },
  ]) {
    await assert.rejects(
      reviewedCodexSeccompSecurityOptions({ profile: "", ...environment }),
      /OCC_TEST_CODEX_SECCOMP_PROFILE is required in CI/,
    );
  }

  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: join(directory, "other.json"), sha256: digest },
        },
      ],
    }),
  );
  await assert.rejects(
    reviewedCodexSeccompSecurityOptions(options),
    /must match the CI-prepared Codex seccomp profile path/,
  );

  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        {
          kind: "k3d-cluster",
          codexDockerSeccompProfile: { path: profile, sha256: "0".repeat(64) },
        },
      ],
    }),
  );
  await assert.rejects(
    reviewedCodexSeccompSecurityOptions(options),
    /must match the CI-prepared Codex seccomp profile digest/,
  );
}
