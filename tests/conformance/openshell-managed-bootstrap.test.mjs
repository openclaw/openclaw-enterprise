import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const bootstrap = resolve("deploy/runtime/openshell-bootstrap.cjs");

function launch(root, runtimeRoot) {
  const input = {
    root,
    runtimeRoot,
    native: true,
    directories: ["workspace", "codex-sessions", "node-state", "node-state/state"],
    links: [
      { path: "workspace", target: "workspace" },
      { path: ".codex/sessions", target: "codex-sessions" },
    ],
  };
  // Each invocation is a new Harness bootstrap process, with the previous one exited.
  return spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(bootstrap)}).prepareManaged(${JSON.stringify(input)})`],
    { encoding: "utf8" },
  );
}

test("managed bootstrap retains files and atomic node state across isolated revision homes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oce-managed-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = join(root, "sandbox");
  const runtimeRoot = join(root, "runtime");
  await mkdir(retained);
  await chmod(retained, 0o770);
  assert.equal(launch(retained, runtimeRoot).status, 0);
  const home = join(runtimeRoot, "home");
  await writeFile(join(home, "workspace/USER.md"), "retained workspace");
  await writeFile(join(home, ".codex/sessions/thread.jsonl"), "retained session");
  await writeFile(join(home, "revision-only.json"), "first revision config");
  const state = join(retained, "oce/node-state/state");
  await writeFile(join(state, "device.json.new"), "paired identity");
  await rename(join(state, "device.json.new"), join(state, "device.json"));
  // Replace the workload filesystem while keeping the same workspace volume.
  // The secret must be absent from the volume even before the new workload starts.
  await assert.rejects(readFile(join(retained, "oce/revisions")), { code: "ENOENT" });
  await rm(runtimeRoot, { recursive: true });
  assert.equal(launch(retained, runtimeRoot).status, 0);
  assert.equal(await readFile(join(home, "workspace/USER.md"), "utf8"), "retained workspace");
  assert.equal(
    await readFile(join(home, ".codex/sessions/thread.jsonl"), "utf8"),
    "retained session",
  );
  assert.equal(await readFile(join(state, "device.json"), "utf8"), "paired identity");
  await assert.rejects(readFile(join(home, "revision-only.json")), { code: "ENOENT" });
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, "tmp"))).mode & 0o777, 0o700);
  // A lost startup acknowledgement can repeat preparation without replacing data.
  assert.equal(launch(retained, runtimeRoot).status, 0);
  assert.equal(await readFile(join(home, "workspace/USER.md"), "utf8"), "retained workspace");
});

test("managed bootstrap refuses symlink ancestors and retained runtime homes from the old layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oce-managed-bootstrap-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = join(root, "sandbox");
  const runtimeRoot = join(root, "runtime");
  const outside = join(root, "outside");
  await mkdir(retained);
  await mkdir(outside);
  await chmod(outside, 0o750);
  await symlink(outside, join(retained, "oce"));
  const result = launch(retained, runtimeRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires directory ancestors/);
  assert.equal((await stat(outside)).mode & 0o777, 0o750);
  await rm(join(retained, "oce"));
  await mkdir(join(retained, "oce/revisions/previous/home"), { recursive: true });
  const file = join(retained, "oce/revisions/previous/home/keep");
  await writeFile(file, "existing state");
  const conflict = launch(retained, runtimeRoot);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /retained runtime Homes from an older layout/);
  assert.equal(await readFile(file, "utf8"), "existing state");
  await assert.rejects(stat(runtimeRoot), { code: "ENOENT" });
});
