import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const prepare = join(root, "scripts/ci/prepare.mjs");
const cleanup = join(root, "scripts/ci/cleanup.mjs");
const exporter = join(root, "scripts/ci/export-image-reconciliation.mjs");

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", ...env },
  });
}

test("image lanes use separate cache scopes without exposing credentials or competing writers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const commandsPath = join(directory, "commands.json");
  // Stop at the real preparer's external build boundary. Hosted CI separately
  // proves BuildKit cache transport; this verifies invocation and failure ownership.
  // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
  await writeFile(
    docker,
    `#!${process.execPath}\n` +
      'const fs = process.getBuiltinModule("node:fs");\n' +
      "const args = process.argv.slice(2);\n" +
      'if (args[0] === "version") { console.log("29.4.0"); process.exit(0); }\n' +
      "fs.appendFileSync(process.env.COMMANDS_PATH, `${JSON.stringify(args)}\\n`);\n" +
      "process.exit(42);\n",
    { mode: 0o700 },
  );
  for (const [lane, roles] of [
    // Images and Packaging builds its two images at once.
    ["images-packaging", ["controller", "runtime"]],
    ["images-model-probes", ["runtime"]],
    ["images-runtime-startup", ["runtime"]],
    ["images-runtime-startup-2", ["runtime"]],
  ]) {
    const statePath = join(directory, `${lane}.json`);
    await rm(commandsPath, { force: true });
    const result = run(prepare, ["--lane", lane, "--state", statePath], {
      GITHUB_ACTIONS: "true",
      // A main push: lanes only restore there too; main's warm job alone writes
      // (ci-prepare.test.mjs covers each event).
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      OCC_CI_IMAGE_CACHE: "1",
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-credential",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      OCC_HELM_BIN: "/usr/bin/true",
      OCC_YQ_BIN: "/usr/bin/true",
      OCC_DOCKER_BIN: docker,
      COMMANDS_PATH: commandsPath,
      // Image Runtime Startup creates its k3d cluster while the image builds;
      // a missing k3d stops that before any cluster is recorded or created.
      OPENCLAW_CI_K3D_BIN: join(directory, "no-k3d"),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /42/, result.stderr);
    const calls = (await readFile(commandsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Each lane first probes for an image the engine already holds; the
    // failed probe falls back to the loading build.
    const builds = calls.filter((args) => args.includes("--load"));
    assert.equal(calls.length, 2 * builds.length);
    assert.deepEqual(
      builds.map((args) => (args.includes("--target") ? "controller" : "runtime")).sort(),
      roles,
    );
    for (const args of builds) {
      const role = args.includes("--target") ? "controller" : "runtime";
      assert.deepEqual(args.slice(0, 3), ["buildx", "build", "--load"]);
      assert.equal(
        args[args.indexOf("--cache-from") + 1],
        `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
      );
      assert.equal(args.includes("--cache-to"), false);
    }
    const state = await readFile(statePath, "utf8");
    assert.equal(JSON.parse(state).resources.length, roles.length);
    assert.ok(JSON.parse(state).resources.every(({ status }) => status === "planned"));
    assert.doesNotMatch(
      JSON.stringify(builds) + state + result.stdout + result.stderr,
      /synthetic-cache-credential/,
    );
  }
});

test("failed image preparation and cleanup retain a sanitized attempt-bound tag", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-reconciliation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const docker = join(directory, "docker");
  await writeFile(docker, '#!/bin/sh\nif [ "$1" = "version" ]; then echo 1; exit 0; fi\nexit 42\n');
  await chmod(docker, 0o700);
  const env = {
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "images",
    OCC_HELM_BIN: "/usr/bin/true",
    OCC_YQ_BIN: "/usr/bin/true",
    OCC_DOCKER_BIN: docker,
  };
  // The real preparer records ownership before the deliberately failed build.
  const preparation = run(prepare, ["--lane", "images-packaging", "--state", statePath], env);
  assert.notEqual(preparation.status, 0);
  assert.equal(preparation.error, undefined);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.ciRun, { id: "12345", attempt: "2" });
  // Both tags are recorded before the builds start together, so each stays planned.
  assert.equal(state.resources.length, 2, preparation.stderr);
  const label = createHash("sha256")
    .update(JSON.stringify(["12345", "2", state.prefix]))
    .digest("hex")
    .slice(0, 17);
  const [image, runtimeImage] = state.resources;
  assert.match(
    image.name,
    new RegExp(`^localhost/openclaw-ci-image-${label}-[a-f0-9]{12}/controller:local$`),
  );
  assert.equal(runtimeImage.name, image.name.replace("/controller:", "/runtime:"));
  assert.equal(image.status, "planned");
  assert.equal(runtimeImage.status, "planned");
  state.env = { SECRET: "do-not-export" };
  await writeFile(statePath, JSON.stringify(state));
  const cleaned = run(cleanup, ["--state", statePath], env);
  assert.notEqual(cleaned.status, 0);
  assert.equal(cleaned.error, undefined);
  const exported = run(exporter, [statePath, directory], env);
  assert.equal(exported.status, 0, exported.stderr);
  const record = JSON.parse(await readFile(join(directory, "images-12345-2.json"), "utf8"));
  assert.deepEqual(
    record.images,
    [image, runtimeImage].map(({ id, name }) => ({ id, name, status: "planned" })),
  );
  assert.doesNotMatch(JSON.stringify(record), /do-not-export/);
});

test("image reconciliation refuses foreign, transplanted and duplicate identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const prefix = "openclaw-ci-12345-2-images-abcdef123456";
  const label = createHash("sha256")
    .update(JSON.stringify(["12345", "2", prefix]))
    .digest("hex")
    .slice(0, 17);
  const image = {
    id: `image-tag-${"a".repeat(12)}`,
    kind: "image-tag",
    owner: prefix,
    name: `localhost/openclaw-ci-image-${label}-${"b".repeat(12)}/controller:local`,
    status: "ready",
  };
  const env = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" };
  for (const resources of [
    [{ ...image, name: "private.example/secret:local" }],
    [{ ...image, owner: "openclaw-ci-foreign" }],
    [{ ...image, name: image.name.replace(label, "0".repeat(17)) }],
    [image, { ...image }],
    [image, { ...image, id: `image-tag-${"c".repeat(12)}` }],
  ]) {
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        lane: "images-packaging",
        prefix,
        ciRun: { id: "12345", attempt: "2" },
        resources,
      }),
    );
    const result = run(exporter, [statePath, directory], env);
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
  }
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith("images-")),
    false,
  );

  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      lane: "images-packaging",
      prefix,
      ciRun: { id: "12345", attempt: "1" },
      resources: [image],
    }),
  );
  const mismatch = run(exporter, [statePath, directory], env);
  assert.notEqual(mismatch.status, 0);
  assert.equal(mismatch.error, undefined);
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith("images-")),
    false,
  );
});

test("missing state remains unavailable and each attempt is retained separately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-attempt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "missing.json");
  for (const attempt of ["1", "2"]) {
    const env = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: attempt };
    const result = run(exporter, [statePath, directory], env);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(
      await readFile(join(directory, `images-12345-${attempt}.json`), "utf8"),
    );
    assert.equal(record.state, "unavailable");
    assert.deepEqual(record.images, []);
    assert.notEqual(run(exporter, [statePath, directory], env).status, 0);
  }
});

test("present malformed state is rejected rather than reported as unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-invalid-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const env = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" };
  for (const value of [null, false, 0, "", [], { resources: [] }]) {
    await writeFile(statePath, JSON.stringify(value));
    const result = run(exporter, [statePath, directory], env);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(value)}`);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith("images-")),
      false,
    );
  }
});

test("prepared image records require string IDs, unique roles and one tag base", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const prefix = "openclaw-ci-12345-2-images-abcdef123456";
  const label = createHash("sha256")
    .update(JSON.stringify(["12345", "2", prefix]))
    .digest("hex")
    .slice(0, 17);
  const controller = {
    id: `image-tag-${"a".repeat(12)}`,
    kind: "image-tag",
    owner: prefix,
    name: `localhost/openclaw-ci-image-${label}-${"b".repeat(12)}/controller:local`,
    status: "ready",
  };
  const runtime = {
    ...controller,
    id: `image-tag-${"c".repeat(12)}`,
    name: controller.name.replace("/controller:", "/runtime:"),
  };
  const state = {
    version: 1,
    lane: "images-packaging",
    prefix,
    ciRun: { id: "12345", attempt: "2" },
  };
  const env = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" };
  for (const resources of [
    [{ ...controller, id: [controller.id] }],
    [
      controller,
      {
        ...controller,
        id: runtime.id,
        name: controller.name.replace("b".repeat(12), "d".repeat(12)),
      },
    ],
    [controller, { ...runtime, name: runtime.name.replace("b".repeat(12), "d".repeat(12)) }],
    [null],
    [{}],
    [{ kind: 42 }],
    [{ kind: "unknown-resource" }],
  ]) {
    await writeFile(statePath, JSON.stringify({ ...state, resources }));
    const result = run(exporter, [statePath, directory], env);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(resources)}`);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith("images-")),
      false,
    );
  }
  const database = {
    id: "postgres-database-123456789abc",
    kind: "postgres-database",
    owner: prefix,
    name: "openclaw_ci_12345_2_abcdef123456",
    composeProject: "openclaw_ci_pg_12345_2_abcdef123456",
    port: 55433,
    status: "ready",
  };
  await writeFile(
    statePath,
    JSON.stringify({ ...state, resources: [controller, database, runtime] }),
  );
  const result = run(exporter, [statePath, directory], env);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(await readFile(join(directory, "images-12345-2.json"), "utf8"));
  assert.deepEqual(
    record.images,
    [controller, runtime].map(({ id, name, status }) => ({ id, name, status })),
  );
});

test("the upload is conditioned on this export succeeding even after a cleanup failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ci-image-stale-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const output = join(directory, "images-12345-2.json");
  await writeFile(statePath, "null");
  await writeFile(output, "stale sentinel");
  const exported = run(exporter, [statePath, directory], {
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
  });
  assert.notEqual(exported.status, 0);
  assert.equal(await readFile(output, "utf8"), "stale sentinel");

  // Check the actual composite action guard; this is not a GitHub Actions execution.
  const action = await readFile(join(root, ".github/actions/run-ci-lane/action.yml"), "utf8");
  assert.match(
    action,
    /name: Export image cleanup reconciliation\n\s+id: image_reconciliation\n\s+if: always\(\)/,
  );
  assert.match(
    action,
    /name: Retain image cleanup reconciliation[\s\S]*?if: always\(\) && inputs\.lane == 'images-packaging' && steps\.image_reconciliation\.outcome == 'success'/,
  );
});
