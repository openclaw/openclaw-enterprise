import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repository, "scripts/upgrade-preflight-state.py");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function writePrivate(path, value) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "upgrade-preflight-state-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(realpathSync(parent), "evidence");
  mkdirSync(root, { mode: 0o700 });
  const kubeconfig = join(parent, "kubeconfig");
  writePrivate(kubeconfig, { context: "fixture" });
  const info = statSync(root);
  const parameters = {
    evidenceDirectory: { path: root, st_dev: info.dev, st_ino: info.ino },
    arguments: [kubeconfig, "fixture", "control", "team", ...Array(11).fill("")],
    kubeconfigSha256: sha256(kubeconfig),
    scriptSha256: sha256(join(repository, "scripts/upgrade-production-images")),
    startupPreflightSha256: sha256(join(repository, "scripts/upgrade-startup-preflight.mjs")),
    preflightStateSha256: sha256(script),
    preflightCleanupSha256: sha256(join(repository, "scripts/lib/upgrade-preflight-cleanup.sh")),
  };
  writePrivate(join(root, "parameters.json"), parameters);
  const invoke = (action, args = [], options = {}) =>
    spawnSync("python3", [script, action, root, ...args], {
      encoding: "utf8",
      ...options,
    });
  const success = (action, args = []) => {
    const result = invoke(action, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  success("init");
  const inspect = () => invoke("inspect", parameters.arguments.slice(0, 4));
  return { root, parent, invoke, success, inspect, parameters };
}

function acknowledgedJob(state) {
  state.success("register", [".", "abcd0123", "false"]);
  state.success("started", [".", "api"]);
  const path = join(state.root, "preflight-api-identity.json");
  writePrivate(path, {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "original-job-uid",
  });
  return path;
}

test("a published ACK survives its exact staging link, but rejects extra hardlinks", (t) => {
  const state = fixture(t);
  const receipt = acknowledgedJob(state);
  // A stopped publisher may have linked the final name without unlinking staging.
  linkSync(receipt, join(state.root, ".preflight-api-identity.json.tmp"));
  const accepted = state.inspect();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).resources.length, 1);
  linkSync(receipt, join(state.root, "unrelated-link"));
  const refused = state.inspect();
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, "");
});

test("a missing registered migration plan refuses all cleanup authority", (t) => {
  const state = fixture(t);
  acknowledgedJob(state);
  const attempt = "migration-preflight-resume.ABCD1234";
  mkdirSync(join(state.root, attempt), { mode: 0o700 });
  state.success("register", [attempt, "abcd4567", "false"]);
  rmSync(join(state.root, attempt, "preflight-plan.json"));
  // A valid startup receipt cannot turn a missing later consumer plan into success.
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("directory locking lasts through the caller's inherited descriptor lifetime", (t) => {
  const state = fixture(t);
  const first = openSync(state.root, "r");
  const second = openSync(state.root, "r");
  t.after(() => closeSync(second));
  const lock = (fd) => state.invoke("lock", ["3"], { stdio: ["ignore", "pipe", "pipe", fd] });
  try {
    assert.equal(lock(first).status, 0);
    // The Python helper has exited, but the invoking shell's open description lives.
    assert.notEqual(lock(second).status, 0);
  } finally {
    closeSync(first);
  }
  assert.equal(lock(second).status, 0);
});

test("a parent directory alias preserves physical evidence binding; a leaf alias does not", (t) => {
  const state = fixture(t);
  const alias = join(state.parent, "parent-alias");
  symlinkSync(state.parent, alias, "dir");
  const inspectAt = (root) =>
    spawnSync("python3", [script, "inspect", root, ...state.parameters.arguments.slice(0, 4)], {
      encoding: "utf8",
    });
  const parentAlias = inspectAt(join(alias, "evidence"));
  assert.equal(parentAlias.status, 0, parentAlias.stderr);
  const leaf = join(state.parent, "evidence-alias");
  symlinkSync(state.root, leaf, "dir");
  assert.notEqual(inspectAt(leaf).status, 0);
});

test("unplanned known slots in a migration attempt cannot be silently ignored", (t) => {
  const state = fixture(t);
  const attempt = "migration-preflight-resume.ABCD1234";
  mkdirSync(join(state.root, attempt), { mode: 0o700 });
  state.success("register", [attempt, "abcd4567", "false"]);
  const unexpected = join(state.root, attempt, "preflight-secret-identity.json");
  writePrivate(unexpected, { kind: "secret", name: "unplanned", uid: "unknown" });
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
