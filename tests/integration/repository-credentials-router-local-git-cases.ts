import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it as test } from "node:test";
import { readRuntimeRepositoryManifest } from "../../apps/controller/src/drivers/repo/github/access/client/manifest.ts";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import {
  clean,
  environment,
  exec,
  fill,
  gitWith,
  granted,
  manifestOf,
  nativeMaterial,
  opened,
  protocol,
  refused,
  relocated,
  settle,
  writeManifest,
} from "./repository-credentials-router-fixture.ts";

export function registerLocalGitCases() {
  test("literal dot-git names and effective repository endpoints cannot silently switch bindings", async (t) => {
    const a = opened("a");
    const b = opened("b", { repository: "example/project.git" });
    const c = opened("c", { repository: "example/other" });
    const material = await nativeMaterial(t, ["a", a], ["b", b], ["c", c]);
    await settle([
      fill(material).then(refused),
      fill(material, { OCE_REPOSITORY_REF: "a" }).then((result) => granted(result, a.bearer)),
      fill(material, { OCE_REPOSITORY_REF: "b" }).then((result) => granted(result, b.bearer)),
      fill(material, {}, "EXAMPLE/PROJECT.git.git").then((result) => granted(result, b.bearer)),
      fill(material, { OCE_REPOSITORY_REF: "a" }, "example/other.git").then(refused),
      fill(material, {}, "example/other").then((result) => granted(result, c.bearer)),
    ]);
  });

  test("embedded generation fails closed after replacement while local stock Git retains hooks and configuration", async (t) => {
    const replacement = opened("replacement");
    const [material, next] = await settle([
      nativeMaterial(t, ["project", opened("original")]),
      // New material is valid in isolation but cannot be selected by the old emitted helper command.
      nativeMaterial(t, ["project", replacement]),
    ]);
    const work = await temporaryDirectory(t);
    const env = environment(material, {
      OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "project", "stale"]),
      NATIVE_HOOK_MARKER: "normal-environment",
    });
    const local = gitWith({ env, cwd: work });
    const subject = async (...args: string[]) =>
      (await local([...args, "log", "-1", "--format=%s"])).stdout.trim();
    await local(["init"]);
    await local(["config", "user.name", "Native fixture"]);
    await local(["config", "user.email", "fixture@example.test"]);
    const marker = join(work, "hook-result");
    await writeFile(
      join(work, ".git/hooks/pre-commit"),
      `#!/bin/sh\nprintf '%s' "$NATIVE_HOOK_MARKER" > '${marker}'\n`,
      { mode: 0o700 },
    );
    await writeFile(join(work, "file.txt"), "native content\n");
    await local(["add", "file.txt"]);
    await local(["commit", "-m", "Native hook"]);
    assert.equal(await readFile(marker, "utf8"), "normal-environment");
    await local(["mv", "file.txt", "moved.txt"]);
    await local(["commit", "-m", "Native move"]);
    await local(["rm", "moved.txt"]);
    await local(["commit", "-m", "Native removal"]);
    await local(["config", "alias.native-status", "status --short"]);
    assert.equal((await local(["native-status"])).stdout.trim(), "?? hook-result");
    const linked = join(work, "linked");
    await local(["worktree", "add", "--detach", linked]);
    assert.equal(await subject("-C", linked), "Native removal");
    await local(["remote", "add", "origin", "https://github.com/ExAmPlE/PrOjEcT"]);
    await local(["remote", "set-url", "--push", "origin", "https://github.com/example/other.git"]);
    const [fetchUrl, pushUrl, stale] = await settle([
      local(["remote", "get-url", "origin"]),
      local(["remote", "get-url", "--push", "origin"]),
      fill(material, { OCE_REPOSITORY_SELECTION: env.OCE_REPOSITORY_SELECTION }),
    ]);
    assert.equal(fetchUrl.stdout.trim(), "https://credentials.example.test/ExAmPlE/PrOjEcT");
    assert.equal(pushUrl.stdout.trim(), "https://credentials.example.test/example/other.git");
    assert.notEqual(stale.code, 0);
    const oldConfig = await readFile(join(material.root, "gitconfig"), "utf8");
    // Install a fully valid next generation; only the old helper generation pin must reject it.
    await writeManifest(material, manifestOf(await relocated(material, next)));
    assert.equal(await readFile(join(material.root, "gitconfig"), "utf8"), oldConfig);
    const current = await readRuntimeRepositoryManifest(material.root);
    assert.equal(current.generation, next.manifest.generation);
    const [acceptedNew, rejected, last] = await settle([
      exec(
        process.execPath,
        [material.helper, "manifest", material.root, current.generation, "get"],
        {
          env: clean(),
          input: protocol(),
        },
      ),
      fill(material),
      subject(),
    ]);
    granted(acceptedNew, replacement.bearer);
    refused(rejected);
    assert.equal(last, "Native removal");
  });
}
