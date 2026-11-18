import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { prepareRuntimeImageSmoke } from "../../scripts/ci/prepare.mjs";
import { digest, fixtureImageCommands, nodeBaseImage } from "../helpers/ci-prepare-fixture.ts";

export function registerNativeTimingCases() {
  test("native container preparation summaries", async (t) => {
    const hostEnv = process.env;
    for (const mode of ["normal", "opt-out", "unset", "directory"]) {
      // Create each fresh fixture with the host PATH so it can resolve its shims.
      const commands = await fixtureImageCommands(t, "success", "images-packaging");
      const root = dirname(commands.statePath);
      const bin = join(root, "bin");
      const summary = join(root, "summary.md");
      const image = `sha256:${digest}`;
      try {
        process.env = {
          HOME: root,
          PATH: bin,
          TMPDIR: root,
          RUNNER_TEMP: root,
          CI_FIXTURE_SCENARIO: "success",
          CI_FIXTURE_LANE: "images-packaging",
          OCC_DOCKER_BIN: join(bin, "docker.mjs"),
          OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
          OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
          OCC_TEST_KUBERNETES_GATEWAY_IMAGE: image,
          // nodeBaseImage stands in for Envoy; the synthetic non-reviewed version
          // deliberately fails late, inside the third timed preparation phase.
          OCC_TEST_WORKSPACE_ENVOY_IMAGE: nodeBaseImage,
          OCC_TEST_KUBERNETES_CODEX_VERSION: "not-reviewed",
          OPENCLAW_CI_NATIVE_PREPARATION_SUMMARY: mode === "opt-out" ? "0" : "1",
        };
        if (mode !== "unset") {
          process.env.GITHUB_STEP_SUMMARY = mode === "directory" ? root : summary;
        }
        await writeFile(summary, "Existing summary\n");
        await assert.rejects(prepareRuntimeImageSmoke({ image, statePath: commands.statePath }), {
          code: "ERR_ASSERTION",
          message:
            "Codex seccomp profile verification is limited to reviewed Codex versions: " +
            "0.152.1, 0.154.0, 0.156.0, 0.158.0, 0.160.0, 0.163.0-alpha.1, 0.163.0-alpha.2, 0.164.0.",
        });
        await assert.rejects(stat(commands.statePath), { code: "ENOENT" });
        const text = await readFile(summary, "utf8");
        if (mode === "normal") {
          const rows = text.split("\n");
          assert.equal(rows.length, 5);
          const [previousSummary, create, runtimeImport, seccomp, end] = rows;
          assert.equal(previousSummary, "Existing summary");
          assert.ok(create && runtimeImport && seccomp, "expected all three timed phases");
          assert.match(create, /^- k3d-create: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/);
          assert.match(
            runtimeImport,
            /^- runtime-image-import: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/,
          );
          assert.match(
            seccomp,
            /^- codex-seccomp-profile: (0|[1-9]\d*) ms \(elapsed; see step outcome\)$/,
          );
          assert.equal(end, "");
        } else {
          assert.equal(text, "Existing summary\n");
        }
      } finally {
        process.env = hostEnv;
      }
    }
  });
}
