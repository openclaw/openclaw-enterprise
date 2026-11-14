import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, runLauncher } from "./k3d-launcher-fixture.ts";

export function registerLauncherDispatchCases() {
  for (const engine of ["podman", "docker"] as const) {
    test(`${engine} k3d launcher selects the dedicated Codex routing integration`, async (context) => {
      await runLauncher(context, engine, ["test"]);
    });
  }

  test("k3d test selects the dedicated native OpenClaw integration", async (context) => {
    await runLauncher(context, "podman", ["test", "--harness", "openclaw"]);
  });

  test("k3d pulls every pinned Node build base before offline image preparation", async (context) => {
    const runtimeRecipe = await readFile(join(repositoryRoot, "deploy/runtime/Dockerfile"), "utf8");
    const expected = Array.from(
      runtimeRecipe.matchAll(/^ARG NODE(?:_RUNTIME)?_BASE_IMAGE=(.+)$/gmu),
      ([, image]) => image,
    );
    const pulled = await runLauncher(context, "docker", ["test"], { missingBaseImages: true });
    assert.deepEqual(pulled, expected);
  });

  test("k3d rejects an unsupported Harness option", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", ["demo", "--harness", "other"]),
      /--harness must be codex or openclaw/,
    );
  });

  test("Linux Podman uses its native API socket", async (context) => {
    await runLauncher(context, "podman", ["test"], { platform: "Linux" });
  });
}
