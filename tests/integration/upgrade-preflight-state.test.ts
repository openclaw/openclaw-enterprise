import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repository, "scripts/upgrade-preflight-state.py");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function writePrivate(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixture(t: TestContext) {
  const parent = temporaryDirectorySync(t, "upgrade-preflight-state-");
  const root = join(realpathSync(parent), "evidence");
  mkdirSync(root, { mode: 0o700 });
  const kubeconfig = join(parent, "kubeconfig");
  writePrivate(kubeconfig, { context: "fixture" });
  const info = statSync(root);
  const parameters = {
    evidenceDirectory: { path: root, st_dev: info.dev, st_ino: info.ino },
    arguments: [kubeconfig, "fixture", "control", "team", ...Array.from({ length: 11 }, () => "")],
    kubeconfigSha256: sha256(kubeconfig),
    scriptSha256: sha256(join(repository, "scripts/upgrade-production-images")),
    startupPreflightSha256: sha256(join(repository, "scripts/upgrade-startup-preflight.ts")),
    preflightStateSha256: sha256(script),
    preflightCleanupSha256: sha256(join(repository, "scripts/lib/upgrade-preflight-cleanup.sh")),
  };
  writePrivate(join(root, "parameters.json"), parameters);
  const invoke = (
    action: string,
    args: readonly string[] = [],
    options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
  ) =>
    spawnSync("python3", [script, action, root, ...args], {
      ...options,
      encoding: "utf8",
    });
  const success = (action: string, args: readonly string[] = []) => {
    const result = invoke(action, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  success("init");
  const inspect = () => invoke("inspect", parameters.arguments.slice(0, 4));
  return { root, parent, invoke, success, inspect, parameters };
}

function acknowledgedJob(state: ReturnType<typeof fixture>) {
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
  const { resources } = record(JSON.parse(accepted.stdout));
  assert.ok(Array.isArray(resources));
  assert.equal(resources.length, 1);
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
  const lock = (fd: number) =>
    state.invoke("lock", ["3"], { stdio: ["ignore", "pipe", "pipe", fd] });
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
  const inspectAt = (root: string) =>
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

for (const attempt of [
  ".",
  "migration-preflight-resume.ABCD1234",
  "upgrade-preflight-resume.ABCD1234",
]) {
  test(`create evidence outside the attempt index is refused for ${attempt}`, (t) => {
    const state = fixture(t);
    const path = attempt === "." ? state.root : join(state.root, attempt);
    if (attempt !== ".") {
      mkdirSync(path, { mode: 0o700 });
    }
    state.success("register", [attempt, "abcd0123", "false"]);
    const slot = attempt.startsWith("migration-") ? "migration" : "api";
    state.success("started", [attempt, slot]);
    const startedPath = join(path, `preflight-${slot}-started.json`);
    const started: unknown = JSON.parse(readFileSync(startedPath, "utf8"));
    rmSync(startedPath);
    const journalPath = join(state.root, "preflight-journal.json");
    const journal = record(JSON.parse(readFileSync(journalPath, "utf8")));
    const attempts = record(journal.attempts);
    delete attempts[attempt];
    writePrivate(journalPath, journal);

    // A crash after plan publication and before registration has no create boundary.
    const planOnly = state.inspect();
    assert.equal(planOnly.status, 0, planOnly.stderr);
    assert.deepEqual(record(JSON.parse(planOnly.stdout)).resources, []);

    // A lost index entry must not conceal a visible create boundary or acknowledgement.
    const acknowledgement = {
      kind: "job.batch",
      name: `team-upgrade-preflight-${slot}-abcd0123`,
      uid: "created-job-uid",
    };
    const facts: [path: string, value: unknown][] = [
      [startedPath, started],
      [join(path, `preflight-${slot}-identity.json`), acknowledgement],
      [
        join(path, `preflight-${slot}-pod-identity.json`),
        {
          kind: "pod",
          name: "created-child",
          uid: "created-child-uid",
        },
      ],
      // The fixed ACK staging name is also written only after a create response.
      [join(path, `.preflight-${slot}-identity.json.tmp`), acknowledgement],
    ];
    for (const [factPath, value] of facts) {
      writePrivate(factPath, value);
      const refused = state.inspect();
      assert.notEqual(refused.status, 0, factPath);
      assert.equal(refused.stdout, "");
      rmSync(factPath);
    }
  });
}

test("a registered staged ACK requires its create boundary and never grants cleanup authority", (t) => {
  const state = fixture(t);
  state.success("register", [".", "abcd0123", "false"]);
  writePrivate(join(state.root, ".preflight-api-identity.json.tmp"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "created-job",
  });
  const contradictory = state.inspect();
  assert.notEqual(contradictory.status, 0);
  assert.equal(contradictory.stdout, "");

  // Stopping after create and during ACK publication is legitimate, but its UID is not authoritative.
  state.success("started", [".", "api"]);
  const unknown = state.inspect();
  assert.equal(unknown.status, 0, unknown.stderr);
  const result = record(JSON.parse(unknown.stdout));
  assert.deepEqual(result.resources, []);
  assert.deepEqual(result.unknown, [".:api"]);
  assert.equal(result.consumerUnknown, true);
});

for (const attempt of [".", "migration-preflight-resume.ABCD1234"]) {
  test(`staged ACKs for excluded slots are rejected in ${attempt}`, (t) => {
    const state = fixture(t);
    const path = attempt === "." ? state.root : join(state.root, attempt);
    if (attempt !== ".") {
      mkdirSync(path, { mode: 0o700 });
    }
    state.success("register", [attempt, "abcd0123", "false"]);
    const slot = attempt === "." ? "networkpolicy" : "secret";
    writePrivate(join(path, `.preflight-${slot}-identity.json.tmp`), { uid: "unexpected" });
    const result = state.inspect();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
}

test("a staged child ACK requires an acknowledged parent and cannot substitute for a child receipt", (t) => {
  const state = fixture(t);
  state.success("register", [".", "abcd0123", "false"]);
  state.success("started", [".", "api"]);
  writePrivate(join(state.root, ".preflight-api-pod-identity.json.tmp"), {
    kind: "pod",
    name: "created-child",
    uid: "created-child-uid",
  });
  const contradictory = state.inspect();
  assert.notEqual(contradictory.status, 0);
  assert.equal(contradictory.stdout, "");

  // A known Job permits owner-based child discovery, but the staged child itself is not an ACK.
  writePrivate(join(state.root, "preflight-api-identity.json"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "created-job",
  });
  const accepted = state.inspect();
  assert.equal(accepted.status, 0, accepted.stderr);
  const { resources, children } = record(JSON.parse(accepted.stdout));
  assert.ok(Array.isArray(resources));
  assert.equal(resources.length, 1);
  assert.deepEqual(children, []);
});

test("a final ACK rejects a conflicting staging file rather than ignoring it", (t) => {
  const state = fixture(t);
  acknowledgedJob(state);
  writePrivate(join(state.root, ".preflight-api-identity.json.tmp"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "another-job",
  });
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

for (const kind of ["fifo", "symlink-to-fifo"]) {
  test(`cleanup rejects ${kind} evidence before opening it or requiring tools`, (t) => {
    const parent = temporaryDirectorySync(t, "upgrade-preflight-fifo-");
    const fifo = join(parent, "fifo");
    const created = spawnSync(
      "python3",
      ["-c", "import os, sys; os.mkfifo(sys.argv[1], 0o600)", fifo],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );
    assert.equal(created.status, 0, created.stderr);
    const evidence = kind === "fifo" ? fifo : join(parent, "link");
    if (kind === "symlink-to-fifo") {
      symlinkSync(fifo, evidence);
    }
    // No writer opens the FIFO. Opening it before validation would block indefinitely.
    // An empty tool path proves invalid evidence does not require cluster tooling.
    const result = spawnSync(
      "/bin/bash",
      [
        join(repository, "scripts/upgrade-production-images"),
        "--cleanup-preflight",
        "--kubeconfig",
        join(parent, "unused-kubeconfig"),
        "--context",
        "fixture",
        "--namespace",
        "control",
        "--release",
        "team",
        "--evidence-dir",
        evidence,
        "--previous-process-settled",
        "--evidence-unrestored",
      ],
      {
        cwd: repository,
        env: { ...process.env, PATH: parent },
        encoding: "utf8",
        timeout: 2000,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(result.error, undefined, "invalid evidence must be rejected without blocking");
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /evidence.*directory/i);
  });
}
