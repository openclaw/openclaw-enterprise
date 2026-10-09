import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultK3sImage } from "../../scripts/ci/prepare.mjs";

// Shared by ci-prepare.test.mjs and ci-prepare-k3d.test.mjs, which split the
// preparation cases so Checks and Conformance 2 can run them at the same time.
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const digest = "a".repeat(64);
export const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
export const nodeBaseImage = `docker.io/library/node:24-bookworm@sha256:${digest}`;
export const mutableImage = "registry.example/openclaw/runtime:latest";

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-prepare-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

// Lane preparation stderr opens with timing and host metrics, and assert.match's default
// message keeps only its start (finding 818). Show the end, where the cause is.
export function assertStderrMatch(stderr, pattern, label) {
  const prefix = label ? `${label}: ` : "";
  const tail = stderr.slice(-1_500);
  assert.match(
    stderr,
    pattern,
    `${prefix}stderr did not match ${pattern}; it ended with:\n${tail}`,
  );
}

export function fixturePreparationMetrics(stderr) {
  return stderr.split("\n").flatMap((line) => {
    const match = line.match(/^\[prepare:k3d-fixture-configuration\] (\{.*\})$/);
    return match ? [JSON.parse(match[1])] : [];
  });
}

export async function fixtureImageCommands(
  t,
  scenario,
  lane = "k3d-fixture-configuration",
  extraEnv = {},
) {
  const root = await fixture(t);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const commandSource = `#!${process.execPath}\n${String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

const root = process.env.CI_FIXTURE_ROOT;
const scenario = process.env.CI_FIXTURE_SCENARIO;
const command = basename(process.argv[1], ".mjs");
const args = process.argv.slice(2);
const statePath = join(root, "commands-state.json");
const initialState = existsSync(statePath) ? readFileSync(statePath, "utf8") : "{}";
const state = JSON.parse(initialState);
const equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const configId = "sha256:" + "b".repeat(64);
const manifestDigest = "sha256:" + "c".repeat(64);
appendFileSync(join(root, "commands.jsonl"), JSON.stringify({
  command, args, envPublished: existsSync(join(root, "github.env")), at: Date.now(),
}) + "\n");
// Preparation runs independent commands concurrently. Merge this command's
// changes into the latest shared state under a lock so none is lost.
function commitState() {
  const serializedState = JSON.stringify(state);
  // Parallel diagnostic reads must not truncate the shared fixture state.
  if (serializedState === initialState) return;
  const lock = statePath + ".lock";
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const before = JSON.parse(initialState);
    const latest = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    for (const [key, value] of Object.entries(state)) {
      if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
      const nested = (entry) => entry && typeof entry === "object" && !Array.isArray(entry);
      latest[key] = nested(value) && nested(latest[key]) ? { ...latest[key], ...value } : value;
    }
    // Commands read the state unlocked at startup. Replace the file atomically
    // so a concurrent reader sees the old or the new state, never an empty file.
    const temp = statePath + "." + process.pid + ".tmp";
    writeFileSync(temp, JSON.stringify(latest));
    renameSync(temp, statePath);
  } finally {
    rmdirSync(lock);
  }
}
function finish(stdout = "") {
  commitState();
  process.stdout.write(stdout);
  process.exit(0);
}
// An engine or node command that does not answer; preparation must time it out. It exits
// on its own later, so a regression cannot leave it running.
async function hang() {
  setTimeout(() => process.exit(124), 40_000);
  await new Promise(() => {});
}
async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

if (command === "docker" || command === "podman") {
  if (equals(args, ["version", "--format", "{{.Server.Version}}"])) finish("29.4.0\n");
  for (const [list, format] of [
    [["ps", "-a"], "{{.Names}}"],
    [["network", "ls"], "{{.Name}}"],
    [["volume", "ls"], "{{.Name}}"],
  ]) {
    if (equals(args.slice(0, list.length), list)) {
      assert.ok(state.clusterDeleted, "cluster inventory is checked after deletion");
      assert.ok([
        "label=k3d.cluster=" + state.cluster,
        "name=k3d-" + state.cluster,
      ].includes(args[list.length + 1]));
      assert.deepEqual(args.slice(list.length), ["--filter", args[list.length + 1], "--format", format]);
      finish();
    }
  }
  if ((scenario.startsWith("nodes-unready") || scenario === "cluster-create-failed") &&
      ["server-0", "agent-0"].some((suffix) => args.at(-1) === "k3d-" + state.cluster + "-" + suffix)) {
    if (state.containersAvailable === false) {
      process.stderr.write("node container was removed by rollback\n");
      process.exit(1);
    }
    if (equals(args.slice(0, 3), ["inspect", "--format", "{{json .State}}"])) {
      finish(JSON.stringify({ Status: "running", Running: true, OOMKilled: false, ExitCode: 0 }));
    }
    if (equals(args.slice(0, 3), ["logs", "--tail=20000", "--timestamps"])) {
      // The node's own error on stderr, followed by more kubectl retries against
      // localhost:8080 than the old 100-line tail held (finding 15).
      const retries = Array.from({ length: 150 }, (_, second) =>
        new Date(Date.UTC(2026, 8, 23, 0, 1, second)).toISOString() +
        " The connection to the server localhost:8080 was refused - did you specify the right host or port?\n").join("");
      process.stderr.write("2026-09-23T00:00:30Z E0923 00:00:30.000000 1 kubelet_node_status.go:1] " +
        "\"Error updating node status\" err=\"fixture node lease timeout\"\n" + retries);
      finish("2026-09-23T00:00:00Z network plugin is not ready\nTOKEN=do-not-publish-node-token\n");
    }
  }
  const sourceImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  if (sourceImage && equals(args, ["image", "inspect", "--format", "{{json .RepoDigests}}", sourceImage])) {
    if (scenario === "hung-host-digests") await hang();
    if (scenario === "image-absent-late-stderr" && !state.pulled) {
      // Keep the real stderr pipe open after the command exits, so its missing
      // image diagnostic arrives during stream drain rather than process exit.
      spawn(process.execPath, ["-e", 'setTimeout(() => process.stderr.write("Error response from daemon: No such image\\n"), 75)'], {
        stdio: ["ignore", "ignore", process.stderr],
      });
      process.exit(1);
    }
    if (
      scenario === "inspect-failed" ||
      (["image-absent", "podman-image-absent"].includes(scenario) && !state.pulled)
    ) {
      process.stderr.write(
        scenario === "inspect-failed"
           ? "Cannot connect to the Docker daemon\n"
           : scenario === "podman-image-absent"
             ? "failed to find image: image not known\n"
             : "Error response from daemon: No such image\n",
      );
      process.exit(1);
    }
    const matching = ["local-digest", "hung-host-id", "hung-host-tag", "hung-host-platform"].includes(scenario) ||
      (state.pulled && scenario !== "pull-mismatch");
    finish(JSON.stringify([matching ? sourceImage : "registry.example/other@sha256:" + "d".repeat(64)]));
  }
  if (sourceImage && equals(args, ["pull", sourceImage])) {
    state.pulled = true;
    finish();
  }
  if (sourceImage && equals(args, ["image", "inspect", "--format", "{{.Id}}", sourceImage])) {
    if (scenario === "hung-host-id") await hang();
    finish(configId + "\n");
  }
  if (sourceImage && args[0] === "tag" && args[1] === sourceImage) {
    if (scenario === "hung-host-tag") await hang();
    state.tag = args[2];
    finish();
  }
  if (args[0] === "compose" && args[1] === "-f" && args[3] === "-p") {
    assert.match(args[4], /^openclaw_ci_pg_/);
    if (equals(args.slice(5), ["up", "-d", "--wait"])) finish();
    if (equals(args.slice(5), ["down", "--volumes", "--remove-orphans"])) finish();
    if (args[5] === "exec" && args[8] === "psql") finish();
  }
  if (equals(args.slice(0, 3), ["inspect", "--format", "{{json .NetworkSettings.Networks}}"]) &&
      args[3] === "k3d-" + state.cluster + "-server-0") {
    finish(JSON.stringify({ ["k3d-" + state.cluster]: {
      Gateway: scenario === "public-gateway" ? "203.0.113.1" : "172.19.0.1",
    } }));
  }
  if (args[0] === "build" && args.includes("--build-arg")) {
    assert.equal(args[args.indexOf("--build-arg") + 1], "RUNTIME_IMAGE=" + state.runtime);
    assert.ok(args[args.indexOf("-f") + 1].endsWith("/Dockerfile.platform-fixture"));
    state.tag = args[args.indexOf("-t") + 1];
    finish();
  }
  // The cache-only probe reports each image's config digest. In the engine-*
  // scenarios the cache resolves to images the engine may hold: engine-holds-images
  // holds both; the others fail one step of the probe.
  const heldImages = { controller: "sha256:" + "d".repeat(64), runtime: "sha256:" + "e".repeat(64) };
  const absentImage = "sha256:" + "f".repeat(64);
  if (equals(args.slice(0, 4), ["buildx", "build", "--output", "type=image,push=false,store=false"])) {
    assert.equal(args[4], "--provenance=false");
    assert.equal(args.includes("--load") || args.includes("--cache-to"), false);
    const role = args.includes("--target") ? "controller" : "runtime";
    const metadata = args[args.indexOf("--metadata-file") + 1];
    if (scenario === "engine-bad-metadata") {
      // Unparsable for the controller, no image digest for the runtime.
      writeFileSync(metadata, role === "controller" ? "{" : JSON.stringify({
        "containerimage.config.digest": "sha256:not-a-digest",
      }));
      finish();
    }
    writeFileSync(metadata, JSON.stringify({
      "containerimage.config.digest": scenario.startsWith("engine-")
        ? heldImages[role]
        : absentImage,
    }));
    finish();
  }
  if (equals(args.slice(0, 4), ["image", "inspect", "--format", "{{.Id}}"]) &&
      [...Object.values(heldImages), absentImage].includes(args[4])) {
    if (scenario === "engine-inspect-hung") await hang();
    if (scenario === "engine-inspect-failed") {
      process.stderr.write("Cannot connect to the Docker daemon\n");
      process.exit(1);
    }
    // The engine holds another image under the reference (a different ID).
    if (scenario === "engine-holds-different") finish("sha256:" + "a".repeat(64) + "\n");
    if (scenario.startsWith("engine-")) finish(args[4] + "\n");
    process.stderr.write("Error response from daemon: No such image: " + args[4] + "\n");
    process.exit(1);
  }
  if (
    scenario === "engine-tag-failed" &&
    args[0] === "tag" &&
    args.length === 3 &&
    Object.values(heldImages).includes(args[1])
  ) {
    process.stderr.write("Error response from daemon: synthetic tag failure\n");
    process.exit(1);
  }
  if (scenario === "engine-holds-images" && args[0] === "tag" && args.length === 3) {
    const role = Object.keys(heldImages).find((key) => heldImages[key] === args[1]);
    assert.ok(role, args[1]);
    assert.match(args[2], new RegExp("/" + role + ":local$"));
    state[role] = args[2];
    finish();
  }
  if (equals(args.slice(0, 2), ["buildx", "build"]) && args.includes("--target")) {
    assert.equal(args[args.indexOf("--target") + 1], "runtime");
    if (scenario === "controller-build-failed") {
      // The tag is owned before the build; cleanup must still remove it.
      state.controller = args[args.indexOf("-t") + 1];
      commitState();
      process.stderr.write("#7 [runtime 3/9] synthetic controller step\nERROR: synthetic build failure\n");
      process.exit(1);
    }
    assert.equal(args.at(-1), ".");
    state.controller = args[args.indexOf("-t") + 1];
    finish();
  }
  if ((args[0] === "build" || equals(args.slice(0, 2), ["buildx", "build"])) && args.includes("-f")) {
    assert.ok(args[args.indexOf("-f") + 1].endsWith("/deploy/runtime/Dockerfile"));
    state.runtime = args[args.indexOf("-t") + 1];
    finish();
  }
  // The main image cache warm job keeps its runtime image under a tag naming its ID.
  if (state.runtime && equals(args, ["image", "inspect", "--format", "{{.Id}}", state.runtime])) {
    finish(configId + "\n");
  }
  if (args[0] === "tag" && args[2]?.startsWith("localhost/openclaw-ci-main/")) {
    assert.deepEqual(args, ["tag", state.runtime, "localhost/openclaw-ci-main/runtime:bbbbbbbbbbbb"]);
    finish();
  }
  if (equals(args.slice(0, 3), ["build", "--pull=false", "-t"]) && args.length === 5) {
    // The fixture build overlaps cluster creation, so its tag cannot name the cluster.
    assert.match(args[3], /^localhost\/openclaw-ci-image-[a-z0-9-]+\/fixture:local$/);
    state.tag = args[3];
    finish();
  }
  if (equals(args, ["image", "inspect", state.tag])) {
    if (scenario === "hung-host-owned") await hang();
    finish("[]\n");
  }
  // Images and Packaging pulls its pinned Node base image after the builds.
  if (equals(args.slice(0, 4), ["image", "inspect", "--format", "{{json .RepoDigests}}"]) &&
      args[4]?.startsWith("docker.io/library/node:")) {
    finish(JSON.stringify([args[4].replace(/:[^/@]+@/, "@")]) + "\n");
  }
  if (equals(args.slice(0, 4), ["image", "inspect", "--format", "{{.Id}}"]) &&
      args[4]?.startsWith("docker.io/library/node:")) {
    finish(configId + "\n");
  }
  if (equals(args, ["image", "inspect", "--format", "{{.Id}}", state.tag])) {
    finish((command === "podman" ? configId.slice("sha256:".length) : configId) + "\n");
  }
  if (equals(args, ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", state.tag])) {
    if (scenario === "hung-host-platform") await hang();
    finish("linux/amd64\n");
  }
  const expectedSave = command === "podman"
    ? ["image", "save", state.tag]
    : ["image", "save", "--platform", "linux/amd64", state.tag];
  if (equals(args, expectedSave)) {
    if (scenario === "save-failed-late-exit") {
      // The truncated stream ends before the export's exit is seen. A busy runner can
      // observe an ordinary exit that late; closing the output a second early
      // reproduces that order.
      writeSync(1, "synthetic image");
      writeSync(2, "synthetic export failure\n");
      closeSync(1);
      setTimeout(() => process.exit(23), 1_000);
      await new Promise(() => {});
    }
    if (scenario === "save-failed") {
      // A truncated export must fail preparation even if a node accepts it.
      process.stdout.write("synthetic image");
      process.stderr.write("synthetic export failure\n");
      process.exit(23);
    }
    finish("synthetic image archive " + state.tag + "\n");
  }
  if (equals(args, ["image", "rm", "-f", state.tag])) finish();
  // The hung tag never created its local tag, so the engine has nothing to remove.
  if (scenario === "hung-host-tag" && equals(args.slice(0, 3), ["image", "rm", "-f"]) &&
      args[3]?.startsWith("localhost/")) {
    process.stderr.write("Error response from daemon: No such image: " + args[3] + "\n");
    process.exit(1);
  }
  if (state.runtime && equals(args, ["image", "rm", "-f", state.runtime])) finish();
  if (state.controller && equals(args, ["image", "rm", "-f", state.controller])) finish();
  if (equals(args.slice(0, 2), ["exec", "-i"]) && ["server-0", "agent-0"].some((suffix) =>
      args[2] === "k3d-" + state.cluster + "-" + suffix)) {
    const node = args[2];
    assert.deepEqual(args.slice(3), ["ctr", "-n", "k8s.io", "images", "import", "--all-platforms", "-"]);
    // The worker fails before reading, which stops the export early.
    if (scenario === "nonzero-worker-import" && node.endsWith("-agent-0")) {
      process.stderr.write("synthetic import command failure\n");
      process.exit(17);
    }
    const archive = await readInput();
    if (scenario === "nonzero-import") {
      process.stderr.write("synthetic import command failure\n");
      process.exit(17);
    }
    if (archive !== "synthetic image archive " + state.tag + "\n") {
      process.stderr.write("ctr: unexpected EOF\n");
      process.exit(1);
    }
    if (scenario !== "missing-tag") {
      state.importedNodes ??= {};
      state.importedNodes[node] = true;
    }
    finish();
  }
  if (args[0] === "exec" && ["server-0", "agent-0"].some((suffix) =>
      args[1] === "k3d-" + state.cluster + "-" + suffix)) {
    const node = args[1];
    const alias = state.aliases?.[node];
    if (equals(args.slice(2), ["ip", "route", "get", "10.42.7.0"])) {
      assert.ok(node.endsWith("-server-0"));
      // Node readiness can precede Flannel's cross-node route. The first lookup
      // then selects the container network, which must never become the allowlist.
      state.routeLookups = (state.routeLookups ?? 0) + 1;
      if (scenario === "delayed-overlay-route" && state.routeLookups === 1) {
        finish("10.42.7.0 via 172.19.0.1 dev eth0 src 172.19.0.2\n");
      }
      finish(scenario === "missing-proxy-source"
        ? "10.42.7.0 dev flannel.1\n"
        : "10.42.7.0 via 10.42.7.0 dev flannel.1 src 10.42.3.0\n");
    }
    const ctr = ["ctr", "-n", "k8s.io", "images"];
    if (equals(args.slice(2), [...ctr, "list"])) {
      if (scenario === "hung-ctr-list" && node.endsWith("-agent-0")) await hang();
      // The first list on the server is the digest lookup after the import.
      if (scenario === "hung-server-list" && node.endsWith("-server-0")) await hang();
      const references = [state.importedNodes?.[node] && state.tag, alias].filter(Boolean);
      finish("REF TYPE DIGEST SIZE PLATFORMS LABELS\n" + references.map((ref) =>
        ref + " application/vnd.oci.image.manifest.v1+json " + manifestDigest + " 1 linux/amd64 -\n",
      ).join(""));
    }
    if (equals(args.slice(2, 8), [...ctr, "tag", state.tag]) && args.length === 9) {
      if (scenario === "hung-ctr-tag" && node.endsWith("-agent-0")) await hang();
      if (scenario !== "missing-alias") {
        state.aliases ??= {};
        state.aliases[node] = args[8];
      }
      finish();
    }
    if (equals(args.slice(2, 7), [...ctr, "rm"]) && args.length === 8 &&
        [state.tag, alias].includes(args[7])) finish();
    if (equals(args.slice(2), ["crictl", "inspecti", alias]) && alias) {
      if (scenario === "hung-worker-cri" && node.endsWith("-agent-0")) {
        // A cache-miss answer before the hang: a timeout must still not be retried as one.
        process.stderr.write('time="2026-10-06T11:05:15Z" level=fatal msg="no such image"\n');
        await hang();
      }
      if (scenario === "missing-cri" ||
          (scenario === "missing-worker-cri" && node.endsWith("-agent-0"))) {
        process.stderr.write("synthetic CRI image not found\n");
        process.exit(19);
      }
      // CRI fills its image cache from containerd events after ctr tags the
      // reference, so the worker's CRI can briefly miss it, or never catch up.
      state.criLookups ??= {};
      state.criLookups[node] = (state.criLookups[node] ?? 0) + 1;
      if (node.endsWith("-agent-0") &&
          (scenario === "absent-worker-cri" ||
            (scenario === "lagging-worker-cri" && state.criLookups[node] <= 2))) {
        commitState();
        process.stderr.write('time="2026-10-06T11:05:15Z" level=fatal msg="no such image \\"' + alias + '\\" present"\n');
        process.exit(1);
      }
      finish(JSON.stringify({ status: { id: configId, repoDigests: [alias] } }));
    }
  }
}
if (command === "helm" && equals(args, ["version", "--short"])) finish("v3.19.0\n");
if (command === "yq" && equals(args, ["--version"])) finish("yq (https://github.com/mikefarah/yq/) version v4.45.1\n");
if (command === "corepack" && equals(args, ["pnpm", "db:migrate"])) {
  assert.match(process.env.OCC_MIGRATION_DATABASE_URL, /^postgresql:\/\/occ_migrator:.*\/openclaw_k8s_/);
  finish();
}
if (command === "k3d") {
  if (equals(args, ["version"])) finish("k3d version v5.8.3\n");
  if (equals(args.slice(0, 2), ["cluster", "create"]) && [15, 17, 18].includes(args.length)) {
    assert.match(args[2], /^openclaw-k8s-/);
    assert.deepEqual(args.slice(3, 5), ["--image", process.env.OPENCLAW_CI_K3S_IMAGE || ${JSON.stringify(defaultK3sImage)}]);
    // A channel such as +v1.35 makes k3d query update.k3s.io on every cluster
    // create; the forwarded node image must be a digest-pinned K3s 1.35 image.
    assert.match(args[4], /:v1\.35\.\d+-k3s\d+@sha256:[a-f0-9]{64}$/);
    if (args.length >= 17) {
    assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "1", "--volume"]);
    const storage = args[10].split(":");
    assert.equal(storage[1], "/var/lib/rancher/k3s/storage@all");
    assert.ok(existsSync(storage[0]), "both nodes must mount an existing shared host directory");
    assert.equal(args[11], "--api-port");
    assert.match(args[12], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(args.slice(13, 17), [
      "--kubeconfig-update-default=false",
      "--kubeconfig-switch-context=false",
      "--lb-config-override",
      "settings.workerConnections=8192",
    ]);
    // The creation-failure case models k3d's default rollback so it can prove
    // that the preparation owner retains containers for diagnosis and cleanup.
    if (scenario !== "cluster-create-failed") {
      assert.deepEqual(args.slice(17), ["--no-rollback"]);
    } else {
      assert.ok(equals(args.slice(17), []) || equals(args.slice(17), ["--no-rollback"]));
    }
    } else {
    assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "0", "--api-port"]);
    assert.match(args[10], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(args.slice(11), [
      "--kubeconfig-update-default=false",
      "--kubeconfig-switch-context=false",
      "--lb-config-override",
      "settings.workerConnections=8192",
    ]);
    }
    state.cluster = args[2];
    state.clusterDeleted = false;
    const hangOnce = ["cluster-create-hangs-once", "cluster-create-hangs-escaped"].includes(scenario);
    if (scenario === "cluster-create-hangs" || (hangOnce && !state.createHung)) {
      state.createHung = true;
      commitState();
      // The escaped case ignores SIGTERM and its descendant leaves the group, so
      // only SIGKILL stops k3d and nothing can close the held pipes.
      const escaped = scenario === "cluster-create-hangs-escaped";
      if (escaped) process.on("SIGTERM", () => {});
      // A descendant that shares the output pipes, as a credential helper would.
      // The timeout must reach it, or "close" never comes.
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 40_000)"], {
        stdio: ["ignore", "inherit", "inherit"],
        detached: escaped,
      });
      appendFileSync(join(root, "hung-pids"), process.pid + "\n" + (escaped ? "" : descendant.pid + "\n"));
      if (escaped) appendFileSync(join(root, "escaped-pids"), descendant.pid + "\n");
      await hang();
    }
    if (scenario === "cluster-create-failed") {
      state.containersAvailable = args.includes("--no-rollback");
      commitState();
      process.stderr.write("synthetic cluster creation failure\n");
      process.exit(1);
    }
    finish();
  }
  if (equals(args, ["kubeconfig", "get", state.cluster])) finish("apiVersion: v1\n");
  if (equals(args, ["cluster", "list", "-o", "json"])) {
    finish(JSON.stringify(state.clusterDeleted ? [] : [{ name: state.cluster }]));
  }
  if (equals(args, ["cluster", "delete", state.cluster])) {
    state.clusterDeleted = true;
    finish();
  }
}
if (command === "kubectl") {
  if (equals(args, ["version", "--client=true"])) finish("{}\n");
  if (args[0] === "--kubeconfig" && args[2] === "--context" &&
      args[3] === "k3d-" + state.cluster) {
    if (!existsSync(args[1])) {
      process.stderr.write("kubeconfig is unavailable\n");
      process.exit(1);
    }
    if (equals(args.slice(4), ["config", "view", "--minify", "--flatten", "-o", "json"])) {
      finish(JSON.stringify({ clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }] }));
    }
    if (equals(args.slice(4), ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=120s"])) {
      if (scenario.startsWith("nodes-unready")) {
        process.stderr.write("synthetic node readiness timeout\n");
        process.exit(1);
      }
      finish();
    }
    if (equals(args.slice(4), ["version", "-o", "json"])) {
      finish(JSON.stringify({ serverVersion: {
        gitVersion: scenario === "wrong-server-version" ? "v1.34.11+k3s1" : "v1.35.8+k3s1",
      } }));
    }
    if (equals(args.slice(4), ["get", "node", "k3d-" + state.cluster + "-agent-0", "-o", "json"])) {
      finish(JSON.stringify({ spec: { podCIDR: "10.42.7.0/24" } }));
    }
    if (equals(args.slice(4), ["get", "nodes", "-o", "json"])) {
      if (scenario.startsWith("nodes-unready")) {
        finish(JSON.stringify({ items: [{
          metadata: { name: "k3d-" + state.cluster + "-agent-0", annotations: { private: "do-not-publish-node-annotation" } },
          spec: { providerID: "do-not-publish-node-spec" },
          status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady", message: "NetworkPluginNotReady" }] },
        }] }));
      }
      finish(JSON.stringify({ items: [{ metadata: { name: "worker" },
        spec: { taints: [{ key: "node.kubernetes.io/disk-pressure", effect: "NoSchedule" }] },
        status: { conditions: [{ type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure" }] } }] }));
    }
    if (equals(args.slice(4, 6), ["--namespace", "kube-system"])) {
      if (equals(args.slice(6), ["get", "pods", "-o", "json"])) {
        if (scenario === "nodes-unready-diagnostics-failed") {
          process.stderr.write("synthetic diagnostic API failure\n");
          process.exit(1);
        }
        finish(JSON.stringify({ items: [{ metadata: { name: "coredns-fixture" },
          spec: { containers: [{ env: [{ name: "PRIVATE", value: "do-not-publish-pod-spec" }] }] },
          status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] },
        }] }));
      }
      if (equals(args.slice(6), ["get", "events", "-o", "json"])) {
        if (scenario === "nodes-unready-diagnostics-failed") {
          // Keep this external command alive until the real preparation deadline kills it.
          setInterval(() => {}, 60_000);
          await new Promise(() => {});
        }
        finish(JSON.stringify({ items: [{ type: "Warning", reason: "FailedScheduling",
          message: "fixture network is not ready", involvedObject: { kind: "Pod", name: "coredns-fixture" },
        }] }));
      }
      if (equals(args.slice(6, 8), ["apply", "-f"]) && args.length === 9) {
        const manifest = JSON.parse(readFileSync(args[8], "utf8"));
        assert.equal(manifest.kind, "DaemonSet");
        assert.equal(manifest.metadata.name, "openclaw-ci-fixture-image-pin");
        assert.equal(manifest.metadata.namespace, "kube-system");
        const pod = manifest.spec.template.spec;
        assert.equal(pod.automountServiceAccountToken, false);
        assert.deepEqual(pod.tolerations, [{ operator: "Exists" }]);
        assert.equal(pod.containers.length, 1);
        assert.equal(pod.containers[0].image, Object.values(state.aliases)[0]);
        assert.equal(pod.containers[0].imagePullPolicy, "Never");
        assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
        assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
        state.fixtureImagePinned = true;
        finish();
      }
      if (equals(args.slice(6), ["rollout", "status", "daemonset/openclaw-ci-fixture-image-pin", "--timeout=120s"])) {
        assert.equal(state.fixtureImagePinned, true);
        finish();
      }
      if (equals(args.slice(6), ["rollout", "status", "deployment/local-path-provisioner", "--timeout=120s"])) {
        if (scenario === "storage-unready" || (scenario === "storage-after-image-unready" && state.storageRestarted)) {
          process.stderr.write("deployment exceeded its progress deadline\n");
          process.exit(1);
        }
        finish();
      }
      if (equals(args.slice(6), ["rollout", "restart", "deployment/local-path-provisioner"])) {
        state.storageRestarted = true;
        finish();
      }
      if (equals(args.slice(6), ["get", "pods", "--selector=app=local-path-provisioner", "-o", "json"])) {
        finish(JSON.stringify({ items: [{ metadata: { name: "local-path-provisioner-fixture" },
          spec: { nodeSelector: { "kubernetes.io/os": "linux" }, containers: [{ env: [{ name: "PRIVATE", value: "do-not-publish-pod-spec" }] }] },
          status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/2 nodes are available: untolerated disk-pressure taint" }], containerStatuses: [{ name: "local-path-provisioner", ready: false,
            restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } }] } }] }));
      }
      if (equals(args.slice(6), ["logs", "deployment/local-path-provisioner", "--tail=30"]) ||
          equals(args.slice(6), ["logs", "deployment/local-path-provisioner", "--tail=30", "--previous"])) {
        finish("Error starting daemon: fixture configuration rejected\n");
      }
    }
  }
}
throw new Error("Unexpected external command: " + command + " " + JSON.stringify(args));
`}`;
  for (const command of [
    "docker.mjs",
    "k3d.mjs",
    "kubectl.mjs",
    "podman",
    "corepack",
    "helm",
    "yq",
  ]) {
    await writeFile(join(bin, command), commandSource, { mode: 0o700 });
  }
  const statePath = join(root, "state.json");
  const githubEnv = join(root, "github.env");
  // No inherited credentials, infrastructure selectors, or real command fallback.
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    RUNNER_TEMP: root,
    CI_FIXTURE_ROOT: root,
    CI_FIXTURE_SCENARIO: scenario,
    OCC_DOCKER_BIN: join(
      bin,
      ["podman-success", "podman-image-absent"].includes(scenario) ? "podman" : "docker.mjs",
    ),
    OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
    OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
    ...extraEnv,
  };
  const run = (script, args) =>
    spawnSync(process.execPath, [join(repositoryRoot, "scripts/ci", script), ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
  return {
    statePath,
    githubEnv,
    prepare: () =>
      run("prepare.mjs", ["--lane", lane, "--state", statePath, "--github-env", githubEnv]),
    warmImageCache: (args = []) =>
      run("prepare.mjs", ["--warm-image-cache", "--state", statePath, ...args]),
    prepareFile: (file) =>
      run("prepare.mjs", ["--lane", lane, "--file", file, "--state", statePath]),
    cleanup: () => run("cleanup.mjs", ["--state", statePath]),
    commands: async () =>
      (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
  };
}
