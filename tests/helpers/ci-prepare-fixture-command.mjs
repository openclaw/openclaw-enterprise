import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultK3sImage, lanesWithoutK3sAddons } from "../../scripts/ci/prepare.mjs";
import {
  commandShim as fixtureCommandShim,
  startCommandServer,
} from "./fixture-command-server.mjs";

// The external commands preparation runs (docker, podman, k3d, kubectl, helm, yq,
// corepack), faked for ci-prepare*.test.mjs through fixture-command-server.mjs: each is
// a bash script answered by the test's command server. scripts/ci/prepare.mjs and
// cleanup.mjs still start every command as a real process and own its timeouts, signals
// and pipes; only the scenario logic below runs in the test process. A command sends
// the environment variables below. The fixture directory the scenarios write to is the
// server's, never the client's.
export const forwardedEnv = [
  "CI_FIXTURE_SCENARIO",
  "CI_FIXTURE_LANE",
  "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
  "OCC_MIGRATION_DATABASE_URL",
  "OPENCLAW_CI_K3S_IMAGE",
];

// The state every command of one fixture shares, as the command processes shared one
// JSON file. A command works on a copy taken when it starts, and merges its changed
// keys back when it commits (an exit without a commit drops them), so concurrent
// commands see the same state they did as processes.
function createStateStore() {
  return { json: "{}" };
}

async function fakeCommand({ command, args, env, cwd, root, store, hungCommandExitMs, io }) {
  const { stdout, stderr, exit, exitAfter, closeStdout, lateStderr, readInput, holdPipes } = io;
  const scenario = env.CI_FIXTURE_SCENARIO;
  const initialState = store.json;
  const state = JSON.parse(initialState);
  const equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const configId = "sha256:" + "b".repeat(64);
  const manifestDigest = "sha256:" + "c".repeat(64);
  // The node of this fixture's cluster that a container name refers to, as one of the
  // fixed keys "server-0" and "agent-0" (undefined for any other name). Per-node state
  // is keyed by it, never by the command's own argument.
  const clusterNode = (name) =>
    ["server-0", "agent-0"].find((node) => name === "k3d-" + state.cluster + "-" + node);
  appendFileSync(
    join(root, "commands.jsonl"),
    JSON.stringify({
      command,
      args,
      envPublished: existsSync(join(root, "github.env")),
      at: Date.now(),
    }) + "\n",
  );
  // Preparation runs independent commands concurrently. Merge this command's
  // changes into the latest shared state so none is lost.
  function commitState() {
    const serializedState = JSON.stringify(state);
    // Parallel diagnostic reads must not overwrite the shared fixture state.
    if (serializedState === initialState) {
      return;
    }
    const before = JSON.parse(initialState);
    const latest = JSON.parse(store.json);
    for (const [key, value] of Object.entries(state)) {
      if (JSON.stringify(value) === JSON.stringify(before[key])) {
        continue;
      }
      const nested = (entry) => entry && typeof entry === "object" && !Array.isArray(entry);
      latest[key] = nested(value) && nested(latest[key]) ? { ...latest[key], ...value } : value;
    }
    store.json = JSON.stringify(latest);
  }
  function finish(output = "") {
    commitState();
    stdout(output);
    return exit(0);
  }
  // An external command that does not answer; preparation must time it out. It exits
  // on its own after the CLI watchdog, so a regression or a killed preparation cannot
  // leave it running.
  function hang() {
    return exitAfter(124, hungCommandExitMs);
  }
  // A descendant that keeps the command's output pipes open until the same bound. The
  // escaped one leaves the process group, and the command then ignores SIGTERM.
  function spawnPipeHolder({ escaped }) {
    holdPipes({
      ms: hungCommandExitMs,
      escaped,
      pidFile: join(root, "hung-pids"),
      escapedPidFile: join(root, "escaped-pids"),
    });
  }

  if (command === "docker" || command === "podman") {
    if (equals(args, ["version", "--format", "{{.Server.Version}}"])) {
      return finish("29.4.0\n");
    }
    for (const [list, format] of [
      [["ps", "-a"], "{{.Names}}"],
      [["network", "ls"], "{{.Name}}"],
      [["volume", "ls"], "{{.Name}}"],
    ]) {
      if (equals(args.slice(0, list.length), list)) {
        assert.ok(state.clusterDeleted, "cluster inventory is checked after deletion");
        assert.ok(
          ["label=k3d.cluster=" + state.cluster, "name=k3d-" + state.cluster].includes(
            args[list.length + 1],
          ),
        );
        assert.deepEqual(args.slice(list.length), [
          "--filter",
          args[list.length + 1],
          "--format",
          format,
        ]);
        return finish();
      }
    }
    if (
      (scenario.startsWith("nodes-unready") || scenario === "cluster-create-failed") &&
      ["server-0", "agent-0"].some(
        (suffix) => args.at(-1) === "k3d-" + state.cluster + "-" + suffix,
      )
    ) {
      if (state.containersAvailable === false) {
        stderr("node container was removed by rollback\n");
        return exit(1);
      }
      if (equals(args.slice(0, 3), ["inspect", "--format", "{{json .State}}"])) {
        return finish(
          JSON.stringify({ Status: "running", Running: true, OOMKilled: false, ExitCode: 0 }),
        );
      }
      if (equals(args.slice(0, 3), ["logs", "--tail=20000", "--timestamps"])) {
        // The node's own error on stderr, followed by more kubectl retries against
        // localhost:8080 than the old 100-line tail held (finding 15).
        const retries = Array.from(
          { length: 150 },
          (_, second) =>
            new Date(Date.UTC(2026, 8, 23, 0, 1, second)).toISOString() +
            " The connection to the server localhost:8080 was refused - did you specify the right host or port?\n",
        ).join("");
        stderr(
          "2026-09-23T00:00:30Z E0923 00:00:30.000000 1 kubelet_node_status.go:1] " +
            '"Error updating node status" err="fixture node lease timeout"\n' +
            retries,
        );
        return finish(
          "2026-09-23T00:00:00Z network plugin is not ready\nTOKEN=do-not-publish-node-token\n",
        );
      }
    }
    // A hung create leaves the server running k3d's retry loop (finding 1174).
    if (
      scenario.startsWith("cluster-create-hangs") &&
      equals(args, ["top", "k3d-" + state.cluster + "-server-0"])
    ) {
      return finish(
        "UID PID PPID CMD\nroot 1 0 /bin/sh /bin/k3d-entrypoint.sh server\n" +
          "root 1600 1 kubectl uncordon k3d-" +
          state.cluster +
          "-server-0\n",
      );
    }
    const sourceImage = env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
    if (
      sourceImage &&
      equals(args, ["image", "inspect", "--format", "{{json .RepoDigests}}", sourceImage])
    ) {
      if (scenario === "hung-host-digests") {
        return hang();
      }
      if (scenario === "image-absent-late-stderr" && !state.pulled) {
        // Keep the real stderr pipe open after the command exits, so its missing
        // image diagnostic arrives during stream drain rather than process exit.
        lateStderr("Error response from daemon: No such image\n", 75);
        return exit(1);
      }
      if (
        scenario === "inspect-failed" ||
        (["image-absent", "podman-image-absent"].includes(scenario) && !state.pulled)
      ) {
        stderr(
          scenario === "inspect-failed"
            ? "Cannot connect to the Docker daemon\n"
            : scenario === "podman-image-absent"
              ? "failed to find image: image not known\n"
              : "Error response from daemon: No such image\n",
        );
        return exit(1);
      }
      const matching =
        ["local-digest", "hung-host-id", "hung-host-tag", "hung-host-platform"].includes(
          scenario,
        ) ||
        (state.pulled && scenario !== "pull-mismatch");
      return finish(
        JSON.stringify([
          matching ? sourceImage : "registry.example/other@sha256:" + "d".repeat(64),
        ]),
      );
    }
    if (sourceImage && equals(args, ["pull", sourceImage])) {
      state.pulled = true;
      return finish();
    }
    if (sourceImage && equals(args, ["image", "inspect", "--format", "{{.Id}}", sourceImage])) {
      if (scenario === "hung-host-id") {
        return hang();
      }
      return finish(configId + "\n");
    }
    if (sourceImage && args[0] === "tag" && args[1] === sourceImage) {
      if (scenario === "hung-host-tag") {
        return hang();
      }
      state.tag = args[2];
      return finish();
    }
    if (args[0] === "compose" && args[1] === "-f" && args[3] === "-p") {
      assert.match(args[4], /^openclaw_ci_pg_/);
      if (equals(args.slice(5), ["up", "-d", "--wait"])) {
        return finish();
      }
      if (equals(args.slice(5), ["down", "--volumes", "--remove-orphans"])) {
        return finish();
      }
      if (args[5] === "exec" && args[8] === "psql") {
        return finish();
      }
    }
    // The cache-only probe reports each image's config digest. In the engine-*
    // scenarios the cache resolves to images the engine may hold: engine-holds-images
    // holds both; the others fail one step of the probe.
    const heldImages = {
      controller: "sha256:" + "d".repeat(64),
      runtime: "sha256:" + "e".repeat(64),
    };
    const absentImage = "sha256:" + "f".repeat(64);
    if (
      equals(args.slice(0, 4), ["buildx", "build", "--output", "type=image,push=false,store=false"])
    ) {
      assert.equal(args[4], "--provenance=false");
      assert.equal(args.includes("--load") || args.includes("--cache-to"), false);
      // A cache miss builds every step in the probe; this one outlasts the lane's time.
      if (scenario === "image-probe-hung") {
        return hang();
      }
      const role = args.includes("--target") ? "controller" : "runtime";
      const metadata = resolve(cwd, args[args.indexOf("--metadata-file") + 1]);
      if (scenario === "engine-bad-metadata") {
        // Unparsable for the controller, no image digest for the runtime.
        writeFileSync(
          metadata,
          role === "controller"
            ? "{"
            : JSON.stringify({
                "containerimage.config.digest": "sha256:not-a-digest",
              }),
        );
        return finish();
      }
      writeFileSync(
        metadata,
        JSON.stringify({
          "containerimage.config.digest": scenario.startsWith("engine-")
            ? heldImages[role]
            : absentImage,
        }),
      );
      return finish();
    }
    if (
      equals(args.slice(0, 4), ["image", "inspect", "--format", "{{.Id}}"]) &&
      [...Object.values(heldImages), absentImage].includes(args[4])
    ) {
      if (scenario === "engine-inspect-hung") {
        return hang();
      }
      if (scenario === "engine-inspect-failed") {
        stderr("Cannot connect to the Docker daemon\n");
        return exit(1);
      }
      // The engine holds another image under the reference (a different ID).
      if (scenario === "engine-holds-different") {
        return finish("sha256:" + "a".repeat(64) + "\n");
      }
      if (scenario.startsWith("engine-")) {
        return finish(args[4] + "\n");
      }
      stderr("Error response from daemon: No such image: " + args[4] + "\n");
      return exit(1);
    }
    if (
      scenario === "engine-tag-failed" &&
      args[0] === "tag" &&
      args.length === 3 &&
      Object.values(heldImages).includes(args[1])
    ) {
      stderr("Error response from daemon: synthetic tag failure\n");
      return exit(1);
    }
    if (scenario === "engine-holds-images" && args[0] === "tag" && args.length === 3) {
      const role = Object.keys(heldImages).find((key) => heldImages[key] === args[1]);
      assert.ok(role, args[1]);
      assert.match(args[2], new RegExp("/" + role + ":local$"));
      state[role] = args[2];
      return finish();
    }
    // The warm job's cache export, after that image's build and load.
    if (equals(args.slice(0, 4), ["buildx", "build", "--output", "type=cacheonly"])) {
      assert.equal(args.includes("--load") || args.includes("-t"), false);
      const role = args.includes("--target") ? "controller" : "runtime";
      assert.ok(state[role], role + " exports after its build");
      if (role === "controller" && scenario === "controller-cache-export-hung") {
        return hang();
      }
      if (role === "controller" && scenario === "controller-cache-export-failed") {
        stderr("#52 exporting to GitHub Actions Cache\nERROR: synthetic export failure\n");
        return exit(1);
      }
      return finish();
    }
    if (equals(args.slice(0, 2), ["buildx", "build"]) && args.includes("--target")) {
      assert.equal(args[args.indexOf("--target") + 1], "runtime");
      if (scenario === "controller-build-failed") {
        // The tag is owned before the build; cleanup must still remove it.
        state.controller = args[args.indexOf("-t") + 1];
        commitState();
        stderr("#7 [runtime 3/9] synthetic controller step\nERROR: synthetic build failure\n");
        return exit(1);
      }
      assert.equal(args.at(-1), ".");
      state.controller = args[args.indexOf("-t") + 1];
      return finish();
    }
    if (
      (args[0] === "build" || equals(args.slice(0, 2), ["buildx", "build"])) &&
      args.includes("-f")
    ) {
      assert.ok(args[args.indexOf("-f") + 1].endsWith("/deploy/runtime/Dockerfile"));
      if (scenario === "image-build-hung") {
        return hang();
      }
      state.runtime = args[args.indexOf("-t") + 1];
      return finish();
    }
    // The main image cache warm job keeps its runtime image under a tag naming its ID.
    if (state.runtime && equals(args, ["image", "inspect", "--format", "{{.Id}}", state.runtime])) {
      return finish(configId + "\n");
    }
    if (args[0] === "tag" && args[2]?.startsWith("localhost/openclaw-ci-main/")) {
      assert.deepEqual(args, [
        "tag",
        state.runtime,
        "localhost/openclaw-ci-main/runtime:bbbbbbbbbbbb",
      ]);
      return finish();
    }
    if (equals(args.slice(0, 3), ["build", "--pull=false", "-t"]) && args.length === 5) {
      // The fixture build overlaps cluster creation, so its tag cannot name the cluster.
      assert.match(args[3], /^localhost\/openclaw-ci-image-[a-z0-9-]+\/fixture:local$/);
      state.tag = args[3];
      return finish();
    }
    if (equals(args, ["image", "inspect", state.tag])) {
      if (scenario === "hung-host-owned") {
        return hang();
      }
      return finish("[]\n");
    }
    // Images and Packaging pulls its pinned Node base image after the builds.
    if (
      equals(args.slice(0, 4), ["image", "inspect", "--format", "{{json .RepoDigests}}"]) &&
      args[4]?.startsWith("docker.io/library/node:")
    ) {
      return finish(JSON.stringify([args[4].replace(/:[^/@]+@/, "@")]) + "\n");
    }
    if (
      equals(args.slice(0, 4), ["image", "inspect", "--format", "{{.Id}}"]) &&
      args[4]?.startsWith("docker.io/library/node:")
    ) {
      return finish(configId + "\n");
    }
    if (equals(args, ["image", "inspect", "--format", "{{.Id}}", state.tag])) {
      return finish((command === "podman" ? configId.slice("sha256:".length) : configId) + "\n");
    }
    if (equals(args, ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", state.tag])) {
      if (scenario === "hung-host-platform") {
        return hang();
      }
      return finish("linux/amd64\n");
    }
    const expectedSave =
      command === "podman"
        ? ["image", "save", state.tag]
        : ["image", "save", "--platform", "linux/amd64", state.tag];
    if (equals(args, expectedSave)) {
      if (scenario === "save-failed-late-exit") {
        // The truncated stream ends before the export's exit is seen. A busy runner can
        // observe an ordinary exit that late; closing the output a second early
        // reproduces that order.
        stdout("synthetic image");
        stderr("synthetic export failure\n");
        closeStdout();
        return exitAfter(23, 1_000);
      }
      if (scenario === "save-failed") {
        // A truncated export must fail preparation even if a node accepts it.
        stdout("synthetic image");
        stderr("synthetic export failure\n");
        return exit(23);
      }
      return finish("synthetic image archive " + state.tag + "\n");
    }
    if (equals(args, ["image", "rm", "-f", state.tag])) {
      return finish();
    }
    // The hung tag never created its local tag, nor did a build stopped for the lane's time,
    // so the engine has nothing to remove.
    if (
      ["hung-host-tag", "image-probe-hung", "image-build-hung", "image-out-of-time"].includes(
        scenario,
      ) &&
      equals(args.slice(0, 3), ["image", "rm", "-f"]) &&
      args[3]?.startsWith("localhost/")
    ) {
      stderr("Error response from daemon: No such image: " + args[3] + "\n");
      return exit(1);
    }
    if (state.runtime && equals(args, ["image", "rm", "-f", state.runtime])) {
      return finish();
    }
    if (state.controller && equals(args, ["image", "rm", "-f", state.controller])) {
      return finish();
    }
    if (equals(args.slice(0, 2), ["exec", "-i"]) && clusterNode(args[2])) {
      const node = clusterNode(args[2]);
      assert.deepEqual(args.slice(3), [
        "ctr",
        "-n",
        "k8s.io",
        "images",
        "import",
        "--all-platforms",
        "-",
      ]);
      // The worker's containerd stops answering during its first import (finding 1006). The
      // other cases pin which failures get the one retry.
      const imports = (state["imports:" + node] ?? 0) + 1;
      state["imports:" + node] = imports;
      const socket = "/run/k3s/containerd/containerd.sock: connect: ";
      let refusal;
      if (node === "agent-0") {
        if (scenario === "containerd-refuses-imports") {
          refusal = socket + "connection refused";
        }
        if (imports === 1) {
          if (scenario === "containerd-restart") {
            refusal = socket + "connection refused";
          }
          if (scenario === "containerd-socket-missing") {
            refusal = socket + "no such file or directory";
          }
          if (scenario === "other-socket-refused") {
            refusal = "/run/other.sock: connect: connection refused";
          }
        }
      }
      if (refusal) {
        commitState();
        stderr(
          'ctr: connection error: desc = "transport: Error while dialing: dial unix ' +
            refusal +
            '"\n',
        );
        return exit(1);
      }
      // The worker fails before reading, which stops the export early.
      if (scenario === "nonzero-worker-import" && node === "agent-0") {
        stderr("synthetic import command failure\n");
        return exit(17);
      }
      const archive = await readInput();
      if (scenario === "nonzero-import") {
        stderr("synthetic import command failure\n");
        return exit(17);
      }
      if (archive !== "synthetic image archive " + state.tag + "\n") {
        stderr("ctr: unexpected EOF\n");
        return exit(1);
      }
      if (scenario !== "missing-tag") {
        state.importedNodes ??= {};
        state.importedNodes[node] = true;
      }
      return finish();
    }
    if (args[0] === "exec" && clusterNode(args[1])) {
      const node = clusterNode(args[1]);
      const alias = state.aliases?.[node];
      if (equals(args.slice(2), ["ip", "route", "get", "10.42.7.0"])) {
        assert.ok(node === "server-0");
        // Node readiness can precede Flannel's cross-node route. The first lookup
        // then selects the container network, which must never become the allowlist.
        state.routeLookups = (state.routeLookups ?? 0) + 1;
        if (scenario === "delayed-overlay-route" && state.routeLookups === 1) {
          return finish("10.42.7.0 via 172.19.0.1 dev eth0 src 172.19.0.2\n");
        }
        return finish(
          scenario === "missing-proxy-source"
            ? "10.42.7.0 dev flannel.1\n"
            : "10.42.7.0 via 10.42.7.0 dev flannel.1 src 10.42.3.0\n",
        );
      }
      if (equals(args.slice(2), ["ctr", "-n", "k8s.io", "version"])) {
        // A Ready worker whose containerd refuses connections for a while (finding 1006).
        const probes = (state["containerdProbes:" + node] ?? 0) + 1;
        state["containerdProbes:" + node] = probes;
        if (scenario === "hung-containerd-probe" && node === "agent-0") {
          return hang();
        }
        // In the hung case the server refuses until the worker's hang ends the wait.
        if (
          (node === "agent-0" &&
            (scenario === "containerd-down" || (scenario === "late-worker" && probes <= 2))) ||
          scenario === "hung-containerd-probe"
        ) {
          commitState();
          stderr(
            'ctr: connection error: desc = "transport: Error while dialing: dial unix ' +
              '/run/k3s/containerd/containerd.sock: connect: connection refused"\n',
          );
          return exit(1);
        }
        return finish("Client:\n  Version:  v2.1.5-k3s1\n\nServer:\n  Version:  v2.1.5-k3s1\n");
      }
      const ctr = ["ctr", "-n", "k8s.io", "images"];
      if (equals(args.slice(2), [...ctr, "list"])) {
        if (scenario === "hung-ctr-list" && node === "agent-0") {
          return hang();
        }
        // The first list on the server is the digest lookup after the import.
        if (scenario === "hung-server-list" && node === "server-0") {
          return hang();
        }
        const references = [state.importedNodes?.[node] && state.tag, alias].filter(Boolean);
        return finish(
          "REF TYPE DIGEST SIZE PLATFORMS LABELS\n" +
            references
              .map(
                (ref) =>
                  ref +
                  " application/vnd.oci.image.manifest.v1+json " +
                  manifestDigest +
                  " 1 linux/amd64 -\n",
              )
              .join(""),
        );
      }
      if (equals(args.slice(2, 8), [...ctr, "tag", state.tag]) && args.length === 9) {
        if (scenario === "hung-ctr-tag" && node === "agent-0") {
          return hang();
        }
        if (scenario !== "missing-alias") {
          state.aliases ??= {};
          state.aliases[node] = args[8];
        }
        return finish();
      }
      if (
        equals(args.slice(2, 7), [...ctr, "rm"]) &&
        args.length === 8 &&
        [state.tag, alias].includes(args[7])
      ) {
        return finish();
      }
      if (equals(args.slice(2), ["crictl", "inspecti", alias]) && alias) {
        if (scenario === "hung-worker-cri" && node === "agent-0") {
          // A cache-miss answer before the hang: a timeout must still not be retried as one.
          stderr('time="2026-10-06T11:05:15Z" level=fatal msg="no such image"\n');
          return hang();
        }
        if (
          scenario === "missing-cri" ||
          (scenario === "missing-worker-cri" && node === "agent-0")
        ) {
          stderr("synthetic CRI image not found\n");
          return exit(19);
        }
        // CRI fills its image cache from containerd events after ctr tags the
        // reference, so the worker's CRI can briefly miss it, or never catch up.
        state.criLookups ??= {};
        state.criLookups[node] = (state.criLookups[node] ?? 0) + 1;
        if (
          node === "agent-0" &&
          (scenario === "absent-worker-cri" ||
            (scenario === "lagging-worker-cri" && state.criLookups[node] <= 2))
        ) {
          commitState();
          stderr(
            'time="2026-10-06T11:05:15Z" level=fatal msg="no such image \\"' +
              alias +
              '\\" present"\n',
          );
          return exit(1);
        }
        return finish(JSON.stringify({ status: { id: configId, repoDigests: [alias] } }));
      }
    }
  }
  if (command === "helm" && equals(args, ["version", "--short"])) {
    return finish("v3.19.0\n");
  }
  if (command === "yq" && equals(args, ["--version"])) {
    return finish("yq (https://github.com/mikefarah/yq/) version v4.45.1\n");
  }
  if (command === "corepack" && equals(args, ["pnpm", "db:migrate"])) {
    assert.match(env.OCC_MIGRATION_DATABASE_URL, /^postgresql:\/\/occ_migrator:.*\/openclaw_k8s_/);
    return finish();
  }
  if (command === "k3d") {
    if (equals(args, ["version"])) {
      return finish("k3d version v5.8.3\n");
    }
    // Only lanes whose tests need no Gateway API or other K3s add-on skip them.
    const addonArgs = lanesWithoutK3sAddons.has(env.CI_FIXTURE_LANE)
      ? ["--k3s-arg", "--disable=traefik,servicelb,metrics-server@server:*"]
      : [];
    if (equals(args.slice(0, 2), ["cluster", "create"])) {
      assert.match(args[2], /^openclaw-k8s-/);
      assert.deepEqual(args.slice(3, 5), ["--image", env.OPENCLAW_CI_K3S_IMAGE || defaultK3sImage]);
      // A channel such as +v1.35 makes k3d query update.k3s.io on every cluster
      // create; the forwarded node image must be a digest-pinned K3s 1.35 image.
      assert.match(args[4], /:v1\.35\.\d+-k3s\d+@sha256:[a-f0-9]{64}$/);
      // Two-node clusters (the fixture lanes' cross-node plugin status) share a storage volume.
      if (args[8] === "1") {
        assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "1", "--volume"]);
        const storage = args[10].split(":");
        assert.equal(storage[1], "/var/lib/rancher/k3s/storage@all");
        assert.ok(
          existsSync(resolve(cwd, storage[0])),
          "both nodes must mount an existing shared host directory",
        );
        assert.equal(args[11], "--api-port");
        assert.match(args[12], /^127\.0\.0\.1:\d+$/);
        const optionsEnd = 16 + addonArgs.length;
        assert.deepEqual(args.slice(13, optionsEnd), [
          "--kubeconfig-update-default=false",
          "--kubeconfig-switch-context=false",
          "--no-lb",
          ...addonArgs,
        ]);
        // The creation-failure case models k3d's default rollback so it can prove
        // that the preparation owner retains containers for diagnosis and cleanup.
        if (scenario !== "cluster-create-failed") {
          assert.deepEqual(args.slice(optionsEnd), ["--no-rollback"]);
        } else {
          assert.ok(
            equals(args.slice(optionsEnd), []) || equals(args.slice(optionsEnd), ["--no-rollback"]),
          );
        }
      } else {
        assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "0", "--api-port"]);
        assert.match(args[10], /^127\.0\.0\.1:\d+$/);
        assert.deepEqual(args.slice(11), [
          "--kubeconfig-update-default=false",
          "--kubeconfig-switch-context=false",
          "--no-lb",
          ...addonArgs,
        ]);
      }
      state.cluster = args[2];
      state.agents = Number(args[args.indexOf("--agents") + 1]);
      state.clusterDeleted = false;
      const hangOnce = ["cluster-create-hangs-once", "cluster-create-hangs-escaped"].includes(
        scenario,
      );
      if (scenario === "cluster-create-hangs" || (hangOnce && !state.createHung)) {
        state.createHung = true;
        commitState();
        stderr("\u001b[36mINFO\u001b[0m[0002] Starting node 'k3d-" + args[2] + "-server-0'\n");
        // The escaped case ignores SIGTERM and its descendant leaves the group, so
        // only SIGKILL stops k3d and nothing can close the held pipes.
        const escaped = scenario === "cluster-create-hangs-escaped";
        // A descendant that shares the output pipes, as a credential helper would.
        // The timeout must reach it, or "close" never comes. The command records its
        // own and the descendant's process IDs in hung-pids (escaped: escaped-pids).
        spawnPipeHolder({ escaped });
        return hang();
      }
      if (scenario === "cluster-create-failed") {
        state.containersAvailable = args.includes("--no-rollback");
        commitState();
        stderr("synthetic cluster creation failure\n");
        return exit(1);
      }
      return finish();
    }
    if (equals(args, ["kubeconfig", "get", state.cluster])) {
      return finish("apiVersion: v1\n");
    }
    if (equals(args, ["cluster", "list", "-o", "json"])) {
      return finish(JSON.stringify(state.clusterDeleted ? [] : [{ name: state.cluster }]));
    }
    if (equals(args, ["cluster", "delete", state.cluster])) {
      state.clusterDeleted = true;
      return finish();
    }
  }
  if (command === "kubectl") {
    if (equals(args, ["version", "--client=true"])) {
      return finish("{}\n");
    }
    if (
      args[0] === "--kubeconfig" &&
      args[2] === "--context" &&
      args[3] === "k3d-" + state.cluster
    ) {
      if (!existsSync(resolve(cwd, args[1]))) {
        stderr("kubeconfig is unavailable\n");
        return exit(1);
      }
      if (equals(args.slice(4), ["config", "view", "--minify", "--flatten", "-o", "json"])) {
        return finish(
          JSON.stringify({ clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }] }),
        );
      }
      if (equals(args.slice(4), ["get", "nodes", "-o", "name"])) {
        // The worker can register after the server (finding 1006), and the API server can
        // refuse the first listing.
        state.nodeListings = (state.nodeListings ?? 0) + 1;
        const worker = state.agents > 0 && !(scenario === "late-worker" && state.nodeListings <= 2);
        commitState();
        if (scenario === "late-worker" && state.nodeListings === 1) {
          stderr("The connection to the server 127.0.0.1:6443 was refused\n");
          return exit(1);
        }
        return finish(
          "node/k3d-" +
            state.cluster +
            "-server-0\n" +
            (worker ? "node/k3d-" + state.cluster + "-agent-0\n" : ""),
        );
      }
      if (
        equals(args.slice(4), ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=120s"])
      ) {
        assert.equal(state.nodeListings > 0, true, "the Ready wait follows node registration");
        if (scenario.startsWith("nodes-unready")) {
          stderr("synthetic node readiness timeout\n");
          return exit(1);
        }
        return finish();
      }
      if (equals(args.slice(4), ["version", "-o", "json"])) {
        return finish(
          JSON.stringify({
            serverVersion: {
              gitVersion: scenario === "wrong-server-version" ? "v1.34.11+k3s1" : "v1.35.8+k3s1",
            },
          }),
        );
      }
      if (
        equals(args.slice(4), ["get", "node", "k3d-" + state.cluster + "-agent-0", "-o", "json"])
      ) {
        // The node IPAM controller can assign a Ready worker's Pod CIDR late (finding 1666).
        state.podCidrReads = (state.podCidrReads ?? 0) + 1;
        if (scenario === "hung-pod-cidr-read") {
          return hang();
        }
        const refusedFirst =
          scenario === "late-pod-cidr" || scenario === "refused-then-no-pod-cidr";
        if (refusedFirst && state.podCidrReads === 1) {
          // First refused, then Ready without a Pod CIDR, then (late-pod-cidr only) assigned.
          commitState();
          stderr("synthetic node read refusal\n");
          return exit(1);
        }
        if (
          scenario === "no-pod-cidr" ||
          scenario === "refused-then-no-pod-cidr" ||
          (scenario === "late-pod-cidr" && state.podCidrReads <= 2)
        ) {
          return finish(
            JSON.stringify({ spec: { providerID: "k3s://k3d-" + state.cluster + "-agent-0" } }),
          );
        }
        return finish(JSON.stringify({ spec: { podCIDR: "10.42.7.0/24" } }));
      }
      if (equals(args.slice(4), ["get", "nodes", "-o", "json"])) {
        if (scenario.startsWith("nodes-unready")) {
          return finish(
            JSON.stringify({
              items: [
                {
                  metadata: {
                    name: "k3d-" + state.cluster + "-agent-0",
                    annotations: { private: "do-not-publish-node-annotation" },
                  },
                  spec: { providerID: "do-not-publish-node-spec" },
                  status: {
                    conditions: [
                      {
                        type: "Ready",
                        status: "False",
                        reason: "KubeletNotReady",
                        message: "NetworkPluginNotReady",
                      },
                    ],
                  },
                },
              ],
            }),
          );
        }
        return finish(
          JSON.stringify({
            items: [
              {
                metadata: { name: "worker" },
                spec: {
                  taints: [{ key: "node.kubernetes.io/disk-pressure", effect: "NoSchedule" }],
                },
                status: {
                  conditions: [
                    { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure" },
                  ],
                },
              },
            ],
          }),
        );
      }
      if (equals(args.slice(4, 6), ["--namespace", "kube-system"])) {
        if (equals(args.slice(6), ["get", "pods", "-o", "json"])) {
          if (scenario === "nodes-unready-diagnostics-failed") {
            stderr("synthetic diagnostic API failure\n");
            return exit(1);
          }
          return finish(
            JSON.stringify({
              items: [
                {
                  metadata: { name: "coredns-fixture" },
                  spec: {
                    containers: [{ env: [{ name: "PRIVATE", value: "do-not-publish-pod-spec" }] }],
                  },
                  status: {
                    phase: "Pending",
                    conditions: [
                      { type: "PodScheduled", status: "False", reason: "Unschedulable" },
                    ],
                  },
                },
              ],
            }),
          );
        }
        if (equals(args.slice(6), ["get", "events", "-o", "json"])) {
          // The diagnostic command timeout kills this read.
          if (scenario === "nodes-unready-diagnostics-failed") {
            return hang();
          }
          return finish(
            JSON.stringify({
              items: [
                {
                  type: "Warning",
                  reason: "FailedScheduling",
                  message: "fixture network is not ready",
                  involvedObject: { kind: "Pod", name: "coredns-fixture" },
                },
              ],
            }),
          );
        }
        if (equals(args.slice(6, 8), ["apply", "-f"]) && args.length === 9) {
          const manifest = JSON.parse(readFileSync(resolve(cwd, args[8]), "utf8"));
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
          return finish();
        }
        if (
          equals(args.slice(6), [
            "rollout",
            "status",
            "daemonset/openclaw-ci-fixture-image-pin",
            "--timeout=120s",
          ])
        ) {
          assert.equal(state.fixtureImagePinned, true);
          return finish();
        }
        if (
          equals(args.slice(6), [
            "rollout",
            "status",
            "deployment/local-path-provisioner",
            "--timeout=120s",
          ])
        ) {
          if (
            scenario === "storage-unready" ||
            (scenario === "storage-after-image-unready" && state.storageRestarted)
          ) {
            stderr("deployment exceeded its progress deadline\n");
            return exit(1);
          }
          return finish();
        }
        if (equals(args.slice(6), ["rollout", "restart", "deployment/local-path-provisioner"])) {
          state.storageRestarted = true;
          return finish();
        }
        if (
          equals(args.slice(6), [
            "get",
            "pods",
            "--selector=app=local-path-provisioner",
            "-o",
            "json",
          ])
        ) {
          return finish(
            JSON.stringify({
              items: [
                {
                  metadata: { name: "local-path-provisioner-fixture" },
                  spec: {
                    nodeSelector: { "kubernetes.io/os": "linux" },
                    containers: [{ env: [{ name: "PRIVATE", value: "do-not-publish-pod-spec" }] }],
                  },
                  status: {
                    phase: "Pending",
                    conditions: [
                      {
                        type: "PodScheduled",
                        status: "False",
                        reason: "Unschedulable",
                        message: "0/2 nodes are available: untolerated disk-pressure taint",
                      },
                    ],
                    containerStatuses: [
                      {
                        name: "local-path-provisioner",
                        ready: false,
                        restartCount: 3,
                        state: { waiting: { reason: "CrashLoopBackOff" } },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        }
        if (
          equals(args.slice(6), ["logs", "deployment/local-path-provisioner", "--tail=30"]) ||
          equals(args.slice(6), [
            "logs",
            "deployment/local-path-provisioner",
            "--tail=30",
            "--previous",
          ])
        ) {
          return finish("Error starting daemon: fixture configuration rejected\n");
        }
      }
    }
  }
  throw new Error("Unexpected external command: " + command + " " + JSON.stringify(args));
}

// A fake command for this fixture's server; see fixture-command-server.mjs.
export function commandShim(options) {
  return fixtureCommandShim({ ...options, forwardedEnv });
}

// One server per fixture, writing to the fixture directory root.
export function startFixtureCommandServer({ root, hungCommandExitMs }) {
  assert.ok(Number.isSafeInteger(hungCommandExitMs));
  assert.ok(typeof root === "string" && root.length > 0);
  const store = createStateStore();
  return startCommandServer({
    forwardedEnv,
    handle: ({ command, args, env, cwd, io }) =>
      fakeCommand({ command, args, env, cwd, root, store, hungCommandExitMs, io }),
  });
}
