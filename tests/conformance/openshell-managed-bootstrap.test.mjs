import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
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

function launch(root, revision) {
  const input = {
    root,
    revision,
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
  const first = "1111111111111111";
  const second = "2222222222222222";
  assert.equal(launch(root, first).status, 0);
  const home = join(root, ".openclaw-runtime/home");
  await writeFile(join(home, "workspace/USER.md"), "retained workspace");
  await writeFile(join(home, ".codex/sessions/thread.jsonl"), "retained session");
  await writeFile(join(home, "revision-only.json"), "first revision config");
  const state = join(root, "oce/node-state/state");
  await writeFile(join(state, "device.json.new"), "paired identity");
  await rename(join(state, "device.json.new"), join(state, "device.json"));
  assert.equal(launch(root, second).status, 0);
  assert.equal(
    await readlink(join(root, ".openclaw-runtime")),
    join(root, "oce/revisions", second),
  );
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
  assert.equal(launch(root, second).status, 0);
  assert.equal(await readFile(join(home, "workspace/USER.md"), "utf8"), "retained workspace");
});

test("managed bootstrap refuses retained symlink ancestors and conflicting runtime selectors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oce-managed-bootstrap-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(outside, { mode: 0o750 });
  await symlink(outside, join(root, "oce"));
  const result = launch(root, "1111111111111111");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires directory ancestors/);
  assert.equal((await stat(outside)).mode & 0o777, 0o750);
  await rm(join(root, "oce"));
  await mkdir(join(root, ".openclaw-runtime"));
  await writeFile(join(root, ".openclaw-runtime/keep"), "do not replace");
  const conflict = launch(root, "1111111111111111");
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /selector conflicts/);
  assert.equal(await readFile(join(root, ".openclaw-runtime/keep"), "utf8"), "do not replace");
});
