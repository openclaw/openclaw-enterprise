import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { cleanupState, deleteOwnedK3dCluster } from "../../scripts/ci/cleanup.mjs";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import {
  createK3dClusterResource,
  fixture,
  repositoryRoot,
  runCleanup,
  writeState,
} from "./ci-cleanup-fixture.ts";

export function registerK3dRemovalCases() {
  test("cleanup removes an owned k3d cluster resource through the CLI", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-1234567890abcdef";
    const clusterName = "openclaw-k8s-old-truncated-name-abc123def456";
    const k3dLog = join(root, "k3d.log");
    const dockerLog = join(root, "docker.log");
    const clusterDirectory = join(root, `${clusterName}-state`);
    const cluster = await createK3dClusterResource(
      { owner: prefix, name: clusterName },
      clusterDirectory,
    );
    // An empty shared storage (no volume was ever written, or the node image was never pulled)
    // needs no root container: cleanup must not try to start one with --pull=never.
    await mkdir(join(clusterDirectory, "storage"));
    const deletedMarker = join(root, "deleted");
    await writeCommand(
      join(root, "bin"),
      "k3d",
      [
        'if [ "$2" = "list" ]; then',
        `  if [ -e ${JSON.stringify(deletedMarker)} ]; then printf '[]\\n'; else printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}; fi`,
        'elif [ "$2" = "delete" ]; then',
        `  touch ${JSON.stringify(deletedMarker)}`,
        "fi",
        "",
      ].join("\n"),
      { log: k3dLog },
    );
    await writeCommand(join(root, "bin"), "docker", "exit 0\n", { log: dockerLog });

    const statePath = join(root, "state.json");
    await writeState(statePath, {
      version: 1,
      repositoryRoot,
      prefix,
      resources: [
        cluster,
        {
          id: "image-1",
          kind: "k3d-image",
          owner: prefix,
          name: `localhost/${clusterName}/occ-test:local`,
          reference:
            "registry.example/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          cluster: clusterName,
          envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
        },
      ],
    });

    const result = runCleanup(statePath, {
      OCC_DOCKER_BIN: join(root, "bin/docker"),
      OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
    });

    assert.equal(result.status, 0, result.stderr);
    const k3dCommands = await commandCalls(k3dLog);
    assert.deepEqual(k3dCommands, [
      "cluster list -o json",
      `cluster delete ${clusterName}`,
      "cluster list -o json",
    ]);
    const dockerCommands = await readFile(dockerLog, "utf8");
    assert.match(
      dockerCommands,
      /images rm registry\.example\/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
    );
    assert.match(dockerCommands, new RegExp(`images rm localhost/${clusterName}/occ-test:local`));
    assert.doesNotMatch(dockerCommands, /^run /m);
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
  });

  test("cleanup empties a fixture lane's shared k3d storage as root after deleting the cluster", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-storage1234567890ab";
    const clusterName = "openclaw-k8s-storage-123abc456def";
    const nodeImage = "registry.example/k3s@sha256:" + "b".repeat(64);
    const clusterDirectory = join(root, `${clusterName}-state`);
    const cluster = {
      ...(await createK3dClusterResource({ owner: prefix, name: clusterName }, clusterDirectory)),
      nodeImage,
    };
    // local-path leaves a deleted claim's volume directory behind as root. A directory without
    // write permission stands in for it: the runner user's rm cannot empty it.
    const storage = join(clusterDirectory, "storage");
    const volume = join(storage, "pvc-1_tenant_workspace");
    await mkdir(volume, { recursive: true });
    await writeFile(join(volume, "state"), "written by a workload\n");
    await chmod(volume, 0o500);
    t.after(() => chmod(volume, 0o700).catch(() => {}));
    const deletedMarker = join(root, "deleted");
    const k3dLog = join(root, "k3d.log");
    await writeCommand(
      join(root, "bin"),
      "k3d",
      [
        'if [ "$2" = "list" ]; then',
        `  if [ -e ${JSON.stringify(deletedMarker)} ]; then printf '[]\\n'; else printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}; fi`,
        'elif [ "$2" = "delete" ]; then',
        `  touch ${JSON.stringify(deletedMarker)}`,
        "fi",
        "",
      ].join("\n"),
      { log: k3dLog },
    );
    // The container runs as root: here, restore write permission and empty the mount. It must
    // start only after the cluster, whose nodes could still write volumes, is gone.
    const dockerLog = join(root, "docker.log");
    await writeCommand(
      join(root, "bin"),
      "docker",
      [
        'if [ "$1" = "run" ]; then',
        `  [ -e ${JSON.stringify(deletedMarker)} ] || exit 9`,
        `  chmod -R u+w ${JSON.stringify(storage)} && rm -rf ${JSON.stringify(volume)}`,
        "fi",
        "",
      ].join("\n"),
      { log: dockerLog },
    );
    const statePath = join(root, "state.json");
    await writeState(statePath, { version: 1, repositoryRoot, prefix, resources: [cluster] });

    const result = runCleanup(statePath, {
      OCC_DOCKER_BIN: join(root, "bin/docker"),
      OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await commandCalls(dockerLog)).filter((call) => call.startsWith("run ")),
      [
        `run --rm --pull=never --network=none --user=0 --security-opt=label=disable --entrypoint=find --volume ${storage}:/storage ${nodeImage} /storage -mindepth 1 -delete`,
      ],
    );
    await assert.rejects(() => stat(clusterDirectory), { code: "ENOENT" });
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  });

  for (const scenario of [
    "surviving",
    "invalid-inventory",
    "already-absent",
    "partial-network",
    "partial-volume",
    "surviving-volume",
    "failed-volume-removal",
  ] as const) {
    test(`cleanup verifies owned cluster absence: ${scenario}`, async (t) => {
      const root = await fixture(t);
      const prefix = "openclaw-ci-local-abcdef1234567890";
      const clusterName = "openclaw-k8s-readback-123abc456def";
      const clusterDirectory = join(root, `${clusterName}-state`);
      const log = join(root, "k3d.log");
      const cluster = await createK3dClusterResource(
        { owner: prefix, name: clusterName },
        clusterDirectory,
      );
      let inventory = "  printf '[]\\n'";
      if (scenario === "invalid-inventory") {
        inventory = "  printf '{}\\n'";
      } else if (scenario === "surviving") {
        inventory = `  printf '[{"name":"%s"}]\\n' ${JSON.stringify(clusterName)}`;
      }
      await writeCommand(
        join(root, "bin"),
        "k3d",
        ['if [ "$2" = "list" ]; then', inventory, "fi", ""].join("\n"),
        { log },
      );
      // An unlabelled network is ambiguous; a labelled image volume is owned.
      const dockerLog = join(root, "docker.log");
      const removed = join(root, "volume-removed");
      const partialVolume = ["partial-volume", "failed-volume-removal"].includes(scenario);
      await writeCommand(
        join(root, "bin"),
        "docker",
        [
          scenario === "partial-network"
            ? 'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then case "$*" in *name=*) printf "k3d-owned-network\\n";; esac; fi'
            : "",
          partialVolume
            ? `if [ "$1" = "volume" ] && [ "$2" = "ls" ] && [ ! -e ${JSON.stringify(removed)} ]; then printf '%s\\n' ${JSON.stringify(`k3d-${clusterName}-images`)}; fi`
            : "",
          scenario === "partial-volume"
            ? `if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then touch ${JSON.stringify(removed)}; fi`
            : "",
          scenario === "failed-volume-removal"
            ? 'if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then exit 7; fi'
            : "",
          // The removal answers success, but the labelled list still names the volume afterwards;
          // the name check does not, so only the list after the removal catches it.
          scenario === "surviving-volume"
            ? `if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then case "$*" in *label=*) printf '%s\\n' ${JSON.stringify(`k3d-${clusterName}-images`)};; esac; fi`
            : "",
          "",
        ].join("\n"),
        { log: dockerLog },
      );
      const statePath = join(root, "state.json");
      const state = {
        version: 1,
        repositoryRoot,
        prefix,
        resources: [cluster],
      };
      await writeState(statePath, state);
      const result = runCleanup(statePath, {
        OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
        OCC_DOCKER_BIN: join(root, "bin/docker"),
      });
      if (scenario === "already-absent" || scenario === "partial-volume") {
        assert.equal(result.status, 0, result.stderr);
        if (scenario === "partial-volume") {
          assert.match(
            await readFile(dockerLog, "utf8"),
            new RegExp(`volume rm k3d-${clusterName}-images`),
          );
        }
        assert.doesNotMatch(await readFile(log, "utf8"), /cluster delete/);
        if (scenario === "already-absent") {
          // An empty labelled list is not asked again (finding 2591); the name check still runs.
          assert.deepEqual(
            (await commandCalls(dockerLog)).map((call) => call.match(/--filter (\S+)/)?.[1]),
            ["containers", "networks", "volumes"].flatMap(() => [
              `label=k3d.cluster=${clusterName}`,
              `name=k3d-${clusterName}`,
            ]),
          );
        }
        await assert.rejects(() => stat(statePath), { code: "ENOENT" });
      } else {
        assert.notEqual(result.status, 0);
        const diagnostic = {
          surviving: /remains after deletion/,
          "invalid-inventory": /invalid cluster inventory/,
          "partial-network": /Possible owned k3d networks remain/,
          "surviving-volume": /Possible owned k3d volumes remain/,
          "failed-volume-removal": /volume rm/,
        }[scenario];
        assert.match(result.stderr, diagnostic);
        const retainedState: unknown = JSON.parse(await readFile(statePath, "utf8"));
        assert.deepEqual(retainedState, state);
        assert.equal((await stat(clusterDirectory)).isDirectory(), true);
      }
    });
  }
}

export function registerK3dDirectoryCase() {
  test("cleanup rejects a k3d cluster directory outside the owned cluster prefix", async (t) => {
    const root = await fixture(t);
    const prefix = "openclaw-ci-local-abcdef1234567890";
    const clusterName = "openclaw-k8s-owned-cluster-abcdef123456";
    const clusterDirectory = join(root, "foreign-directory");
    const k3dLog = join(root, "k3d.log");
    const cluster = await createK3dClusterResource(
      { owner: prefix, name: clusterName },
      clusterDirectory,
    );
    await writeCommand(join(root, "bin"), "k3d", "exit 0\n", { log: k3dLog });

    const statePath = join(root, "state.json");
    const state = {
      version: 1,
      repositoryRoot,
      prefix,
      resources: [cluster],
    };
    await writeState(statePath, state);

    const result = runCleanup(statePath, {
      OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside cluster ownership/);
    const retainedState: unknown = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(retainedState, state);
    await assert.rejects(() => stat(k3dLog), { code: "ENOENT" });
    assert.equal((await stat(clusterDirectory)).isDirectory(), true);
  });
}

export function registerBoundK3dCases() {
  // The engine changes ownership after the caller's custody observation. The
  // destructive owner must use that observation instead of resolving the name again.
  test("bound k3d cleanup refuses a replacement before deleting its resources", async () => {
    const name = "openclaw-k8s-bound-abc123def456";
    const identity = {
      cluster: name,
      serverID: "1".repeat(64),
      networkID: "2".repeat(64),
      volumes: [{ name: `k3d-${name}-images`, createdAt: "2026-11-11T00:00:00Z" }],
    };
    let replacementDeleted = false;
    const run = async (command: string, args: string[]) => {
      if (command === "k3d") {
        if (args[1] === "delete") {
          replacementDeleted = true;
          return { stdout: "" };
        }
        return { stdout: JSON.stringify(replacementDeleted ? [] : [{ name }]) };
      }
      if (args[0] === "ps" && args.includes("--no-trunc")) {
        return { stdout: "3".repeat(64) + "\n" };
      }
      return { stdout: "" };
    };
    await assert.rejects(
      deleteOwnedK3dCluster({ name }, { execFile: run, identity }),
      /bound k3d server identity/,
    );
    assert.equal(replacementDeleted, false, "replacement must survive the owner's refusal");
  });

  // This protocol fixture models Docker responses, not live Docker effects. The
  // real staged-cleanup cases cover the latter through the supported cleanup CLI.
  for (const scenario of ["owned", "replaced-network", "shared-volume", "late-volume-consumer"]) {
    test(`bound k3d cleanup preserves destructive authority: ${scenario}`, async () => {
      const name = "openclaw-k8s-bound-abc123def456";
      const imageVolume = { name: `k3d-${name}-images`, createdAt: "2026-11-11T00:00:00Z" };
      const identity = {
        cluster: name,
        serverID: "1".repeat(64),
        networkID: "2".repeat(64),
        volumes: [imageVolume],
      };
      const removed: string[] = [];
      let serverPresent = true;
      let networkPresent = true;
      let volumePresent = true;
      const run = async (command: string, args: string[]) => {
        assert.equal(
          command,
          "docker",
          "bound cleanup must not resolve a cluster name through k3d",
        );
        const [kind, action] = args;
        if (kind === "ps") {
          const volume = args.some((arg) => arg.startsWith("volume="));
          const shared =
            scenario === "shared-volume" || (scenario === "late-volume-consumer" && !serverPresent);
          return {
            stdout: [serverPresent ? identity.serverID : "", volume && shared ? "3".repeat(64) : ""]
              .filter(Boolean)
              .join("\n"),
          };
        }
        if (kind === "network" && action === "ls") {
          // Real k3d networks have no k3d.cluster label; names are used only
          // for the final absence observation, never as deletion authority.
          return { stdout: networkPresent && !args.includes("--filter") ? `k3d-${name}` : "" };
        }
        if (kind === "network" && action === "inspect") {
          return {
            stdout: args.includes("{{.Name}}")
              ? `k3d-${name}`
              : JSON.stringify({ [identity.serverID]: {} }),
          };
        }
        if (kind === "container" && action === "inspect") {
          if (args.includes("{{json .NetworkSettings.Networks}}")) {
            return {
              stdout: JSON.stringify({
                [`k3d-${name}`]: {
                  NetworkID: scenario === "replaced-network" ? "4".repeat(64) : identity.networkID,
                },
              }),
            };
          }
          return { stdout: imageVolume.name };
        }
        if (kind === "volume" && action === "inspect") {
          return {
            stdout: JSON.stringify({
              Name: imageVolume.name,
              CreatedAt: imageVolume.createdAt,
              Driver: "local",
              Scope: "local",
            }),
          };
        }
        if (kind === "rm") {
          assert.deepEqual(args, ["rm", "-f", identity.serverID]);
          serverPresent = false;
          removed.push("server");
          return { stdout: identity.serverID };
        }
        if (kind === "network" && action === "rm") {
          assert.equal(args[2], identity.networkID);
          networkPresent = false;
          removed.push("network");
          return { stdout: identity.networkID };
        }
        if (kind === "volume" && action === "rm") {
          assert.deepEqual(args, ["volume", "rm", imageVolume.name]);
          volumePresent = false;
          removed.push("volume");
          return { stdout: imageVolume.name };
        }
        if (kind === "volume" && action === "ls") {
          return { stdout: volumePresent ? imageVolume.name : "" };
        }
        throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
      };
      const operation = deleteOwnedK3dCluster({ name }, { execFile: run, identity });
      if (scenario === "owned") {
        await operation;
        assert.deepEqual(removed, ["server", "network", "volume"]);
      } else {
        await assert.rejects(
          operation,
          scenario === "replaced-network" ? /network identity/ : /volume is shared/,
        );
        assert.deepEqual(removed, scenario === "late-volume-consumer" ? ["server", "network"] : []);
        assert.equal(volumePresent, true, "shared resource must survive refusal");
      }
    });
  }

  test("bound cleanup refuses changed prepared state before destructive work", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, repositoryRoot, prefix: "openclaw-ci-bound", resources: [] }),
    );
    await assert.rejects(
      cleanupState(statePath, {
        expectedStateSha256: "0".repeat(64),
        k3dIdentity: {
          cluster: "openclaw-k8s-bound",
          serverID: "1".repeat(64),
          networkID: "2".repeat(64),
          volumes: [],
        },
      }),
      /cleanup state changed after preparation/,
    );
    assert.ok((await readFile(statePath, "utf8")).includes("openclaw-ci-bound"));
  });
}
