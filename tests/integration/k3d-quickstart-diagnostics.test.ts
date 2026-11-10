import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(
  new URL("../../scripts/ci/k3d-quickstart/private-step.sh", import.meta.url),
);

test(
  "quickstart failure reports bounded startup timings without publishing private output",
  {
    skip: process.platform !== "linux",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-quickstart-diagnostics-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const scripts = join(directory, "scripts/ci/k3d-quickstart");
    const credentials = join(directory, "oce-credentials");
    const run = join(directory, "run");
    await Promise.all([scripts, credentials, run].map((path) => mkdir(path, { recursive: true })));
    const privateOutput = `private-output-${randomUUID()}`;
    const timing = "[occ-dev-timing] stage=controller-build elapsed_ms=123 failed=false";
    // The stage is a subprocess fixture. The real wrapper owns exit propagation and
    // log projection; malformed or suffixed records must stay in its private log.
    await writeFile(
      join(scripts, "setup.sh"),
      [
        "#!/usr/bin/env bash",
        "cat <<'PRIVATE_OUTPUT'",
        privateOutput,
        timing,
        `[occ-dev-timing] stage=controller-build elapsed_ms=123 failed=false ${privateOutput}`,
        `[occ-dev-timing] stage=${privateOutput} elapsed_ms=1 failed=true`,
        `[occ-dev-timing] stage=runtime-build elapsed_ms=12345678901234567 failed=true`,
        "PRIVATE_OUTPUT",
        "exit 23",
        "",
      ].join("\n"),
    );
    const result = spawnSync("bash", [wrapper, "setup"], {
      cwd: directory,
      env: { ...process.env, RUNNER_TEMP: directory, RUN_DIR: run },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23);
    const published = result.stdout + result.stderr;
    assert.ok(published.includes("setup failed (exit 23)"));
    assert.equal(
      published
        .split("\n")
        .filter((line) => line.startsWith("[occ-dev-timing]"))
        .join("\n"),
      timing,
    );
    assert.ok(!published.includes(privateOutput));
    assert.ok((await readFile(join(credentials, "setup.log"), "utf8")).includes(privateOutput));
  },
);
