import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  cleanupDevelopmentProfile,
  developmentCommand,
  developmentEnvironment,
} from "../../scripts/ci/development-profile.mjs";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const selected = process.env.OCC_TEST_DEV_KUBERNETES_REAL === "1";
const ownerLabel = "io.openclaw.development.owner";

async function absent(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

async function fileHash(path) {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function claimHashes() {
  const directory = join(userInfo().homedir, ".openclaw-development-claims");
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return Object.fromEntries(
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => [name, await fileHash(join(directory, name))]),
    ),
  );
}

test(
  "real OCC development CLI starts an authenticated Kubernetes profile and disposes only its owned resources",
  { skip: !selected, timeout: 1_200_000 },
  async (t) => {
    const directory =
      process.env.OCC_TEST_DEV_DIRECTORY ?? (await mkdtemp(join(tmpdir(), "openclaw-ci-dev-")));
    const stateDirectory = join(directory, "state");
    const executable = join(directory, "occ");
    const name = `${process.env.OCC_TEST_DEV_NAME_PREFIX ?? "occ-dev"}-${randomUUID().slice(0, 6)}`;
    const env = {
      ...developmentEnvironment(),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
      OCC_DEVELOPMENT_COMPOSE_PROJECT: name,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: name,
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "300",
      OCC_DEVELOPMENT_KUBERNETES_IMAGE:
        process.env.OCC_DEVELOPMENT_KUBERNETES_IMAGE ?? process.env.OPENCLAW_CI_K3S_IMAGE ?? "",
      OCC_KUBERNETES_RUNTIME_IMAGE: process.env.OCC_TEST_DEV_RUNTIME_IMAGE ?? "",
      OPENCLAW_DEV_PORT: await freePort(),
      OCC_POSTGRES_PORT: await freePort(),
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: await freePort(),
    };
    assert.ok(
      env.OCC_KUBERNETES_RUNTIME_IMAGE,
      "prepare an exact-source runtime image before selecting this case",
    );
    assert.ok(env.NODE_BASE_IMAGE, "select the approved Node 24 build image");
    await absent(stateDirectory);
    const run = (command, args, timeout) =>
      developmentCommand(command, args, { cwd: repository, env, timeout });
    const docker = async (...args) => (await run("docker", args)).stdout.trim();
    const clusters = async () =>
      JSON.parse((await run("k3d", ["cluster", "list", "-o", "json"])).stdout)
        .map(({ name }) => name)
        .sort();
    const inventory = async () => ({
      containers: (await docker("ps", "-aq", "--no-trunc")).split("\n").filter(Boolean),
      networks: (await docker("network", "ls", "-q", "--no-trunc")).split("\n").filter(Boolean),
      volumes: (await docker("volume", "ls", "-q")).split("\n").filter(Boolean),
      clusters: await clusters(),
      claims: await claimHashes(),
      kubeconfig: await fileHash(join(userInfo().homedir, ".kube/config")),
      dockerConfig: await fileHash(join(userInfo().homedir, ".docker/config.json")),
    });
    const baseline = await inventory();
    const subnets = [];
    for (const network of baseline.networks) {
      subnets.push(
        ...(
          JSON.parse(
            await docker("network", "inspect", "--format", "{{json .IPAM.Config}}", network),
          ) ?? []
        )
          .map(({ Subnet }) => Subnet)
          .filter(Boolean),
      );
    }
    // Choose a /24 outside every existing Docker subnet, including broad prefixes.
    const ipv4 = (value) =>
      value.split(".").reduce((acc, octet) => (acc * 256 + Number(octet)) >>> 0, 0);
    const overlaps = (candidate, subnet) => {
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) {
        return false;
      }
      const [address, bits] = subnet.split("/");
      const prefix = Math.min(24, Number(bits));
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return (ipv4(candidate) & mask) === (ipv4(address) & mask);
    };
    env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = Array.from(
      { length: 16 * 256 },
      (_, index) => `172.${16 + Math.floor(index / 256)}.${index % 256}.0`,
    )
      .concat(Array.from({ length: 256 }, (_, index) => `10.240.${index}.0`))
      .find((candidate) => subnets.every((subnet) => !overlaps(candidate, subnet)));
    assert.ok(
      env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR,
      "a nonoverlapping disposable subnet is required",
    );
    env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR += "/24";
    const receipt = { name, baseline, checks: [] };
    let started = false;
    let disposed = false;
    let finishing = false;
    let lifecycleActive = false;
    const lifecycle = async (args, timeout) => {
      assert.equal(finishing, false, "test cleanup has already begun");
      lifecycleActive = true;
      try {
        return await run(executable, args, timeout);
      } catch (error) {
        let uncertainMarker = "unknown";
        try {
          await lstat(join(stateDirectory, "subprocess-outcome-uncertain"));
          uncertainMarker = "present";
        } catch (lookupError) {
          if (lookupError.code === "ENOENT") {
            uncertainMarker = "absent";
          }
        }
        // Report only known progress labels, never the CLI output or resource names.
        const progress = new Map([
          [
            "Starting the Compose database, migration, and bootstrap services...",
            "compose-services",
          ],
          [`Creating k3d cluster ${name}...`, "k3d-cluster"],
          ["Starting the Compose controller and Kubernetes worker...", "controller-worker"],
        ]);
        const lastProgress = String(error.stdout ?? "")
          .split("\n")
          .map((line) => progress.get(line.trim()))
          .filter(Boolean)
          .at(-1);
        let outcome = "command-failure";
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          outcome = "output-limit";
        } else if (typeof error.signal === "string") {
          outcome = "terminated";
        }
        error.openclawCiDiagnostic = {
          kind: "development-lifecycle",
          operation: args[1],
          lastProgress: lastProgress ?? "unknown",
          exitCode: Number.isInteger(error.code) ? error.code : undefined,
          signal: error.signal,
          outcome,
          uncertainMarker,
        };
        throw error;
      } finally {
        lifecycleActive = false;
      }
    };
    const appImage =
      process.env.OCC_TEST_DEV_APP_IMAGE ?? `localhost/openclaw-ci-image-${name}:development`;
    const envFile = join(directory, "empty.env");
    const override = join(directory, "images.json");
    await writeFile(envFile, "", { mode: 0o600 });
    await writeFile(
      override,
      JSON.stringify({
        services: Object.fromEntries(
          ["migrate", "bootstrap", "controller", "worker-kubernetes"].map((service) => [
            service,
            { image: appImage },
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    t.after(async () => {
      finishing = true;
      try {
        assert.equal(lifecycleActive, false, "a live CLI still owns profile cleanup");
        if (started && !disposed) {
          await cleanupDevelopmentProfile({ directory }, repository);
        }
        await absent(stateDirectory);
        await writeFile(
          join(directory, "cleanup-complete"),
          "CLI settled; profile state absent\n",
          { mode: 0o600 },
        );
        if (!process.env.OCC_TEST_DEV_APP_IMAGE) {
          const images = await docker("image", "ls", "-q", appImage);
          if (images) {
            await docker("image", "rm", appImage);
          }
        }
        if (!process.env.OCC_TEST_DEV_DIRECTORY) {
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        if (process.env.OCC_TEST_DEV_RECEIPT) {
          await writeFile(
            process.env.OCC_TEST_DEV_RECEIPT,
            `${JSON.stringify(receipt, null, 2)}\n`,
            { mode: 0o600 },
          );
        }
      }
    });
    try {
      await access(executable);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await run("go", ["build", "-trimpath", "-o", executable, "./cmd/occ"]);
    }
    assert.match((await run("k3d", ["cluster", "create", "--help"])).stdout, /--runtime-label/);
    await rm(join(directory, "cleanup-complete"), { force: true });
    started = true;
    const up = await lifecycle(["dev", "up", "--", "--env-file", envFile, "-f", override], 720_000);
    assert.match(up.stdout, /development stack is ready/);
    await absent(join(stateDirectory, "subprocess-outcome-uncertain"));
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(state.keyPath)).mode & 0o777, 0o600);
    const installation = JSON.parse(
      (
        await developmentCommand(executable, ["installation", "get", "--output", "json"], {
          cwd: repository,
          env: {
            ...env,
            OCC_URL: `http://127.0.0.1:${env.OPENCLAW_DEV_PORT}`,
            OCC_SERVICE_KEY_FILE: state.keyPath,
          },
        })
      ).stdout,
    );
    assert.ok(up.stdout.includes(`Installation ID: ${installation.id}`));
    receipt.installationId = installation.id;
    const kubectl = (...args) =>
      run("kubectl", [
        "--kubeconfig",
        join(stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${name}`,
        ...args,
      ]);
    await kubectl("wait", "--for=condition=Ready", "nodes", "--all", "--timeout=120s");
    const nodes = JSON.parse((await kubectl("get", "nodes", "-o", "json")).stdout).items;
    assert.equal(nodes.length, 1);
    assert.match(nodes[0].status.nodeInfo.kubeletVersion, /^v1\.35\./);
    receipt.nodes = nodes.map((node) => ({
      name: node.metadata.name,
      version: node.status.nodeInfo.kubeletVersion,
      ready: node.status.conditions.find(({ type }) => type === "Ready")?.status,
    }));
    for (const service of ["controller", "worker-kubernetes"]) {
      const id = await docker(
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${name}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      );
      assert.ok(id, `${service} must be running`);
      assert.equal(await docker("inspect", "--format", "{{.State.Running}}", id), "true");
      if (service === "worker-kubernetes") {
        await docker("exec", id, "node", "scripts/production-healthcheck.mjs", "worker", "ready");
      }
    }
    const configuration = await readFile(join(stateDirectory, "installation.yaml"), "utf8");
    const reference = configuration.match(/gateway: (\S+@sha256:[a-f0-9]{64})/)?.[1];
    assert.ok(reference, "the configured runtime must be pinned to its imported digest");
    const imported = await docker(
      "exec",
      `k3d-${name}-server-0`,
      "ctr",
      "-n",
      "k8s.io",
      "images",
      "list",
    );
    assert.ok(
      imported
        .split("\n")
        .some(
          (line) =>
            line.split(/\s+/)[0] === reference && line.split(/\s+/)[2] === reference.split("@")[1],
        ),
    );
    receipt.runtimeReference = reference;
    for (const container of [`k3d-${name}-server-0`, `k3d-${name}-serverlb`]) {
      assert.equal(
        await docker("inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, container),
        state.owner,
      );
    }
    assert.equal(
      await docker(
        "volume",
        "inspect",
        "--format",
        `{{index .Labels "${ownerLabel}"}}`,
        `k3d-${name}-images`,
      ),
      state.owner,
    );
    const claimsDirectory = join(userInfo().homedir, ".openclaw-development-claims");
    const ownedClaims = [];
    for (const file of await readdir(claimsDirectory)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const claim = JSON.parse(await readFile(join(claimsDirectory, file), "utf8"));
      if (claim.id === state.owner) {
        assert.equal(claim.directory, stateDirectory);
        assert.equal(claim.composeProject, name);
        assert.equal(claim.cluster, name);
        assert.equal(claim.dockerHost, state.dockerHost);
        ownedClaims.push(file);
      }
    }
    assert.equal(ownedClaims.length, 2);
    receipt.checks.push(
      "authenticated-installation",
      "ready-node",
      "running-controller-and-worker",
      "imported-runtime-digest",
      "native-owner-labels",
      "two-owned-claims",
    );
    await lifecycle(["dev", "down"], 180_000);
    disposed = true;
    await absent(stateDirectory);
    for (const claim of ownedClaims) {
      await absent(join(claimsDirectory, claim));
    }
    for (const [kind, filter] of [
      ["container", `label=com.docker.compose.project=${name}`],
      ["container", `label=k3d.cluster=${name}`],
      ["volume", `label=com.docker.compose.project=${name}`],
      ["volume", `label=k3d.cluster=${name}`],
      ["network", `label=com.docker.compose.project=${name}`],
    ]) {
      const args = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
      assert.equal(await docker(...args, "--filter", filter), "", `owned ${kind} must be absent`);
    }
    assert.equal((await clusters()).includes(name), false);
    assert.equal(await docker("volume", "ls", "-q", "--filter", `name=^k3d-${name}-images$`), "");
    const after = await inventory();
    receipt.after = after;
    for (const kind of ["containers", "networks", "volumes", "clusters"]) {
      assert.deepEqual(
        baseline[kind].filter((id) => !after[kind].includes(id)),
        [],
        `unrelated baseline ${kind} must remain`,
      );
    }
    for (const [file, hash] of Object.entries(baseline.claims)) {
      assert.equal(after.claims[file], hash, "unrelated claim bytes must remain");
    }
    assert.equal(after.kubeconfig, baseline.kubeconfig);
    assert.equal(after.dockerConfig, baseline.dockerConfig);
    receipt.checks.push(
      "actual-down",
      "owned-resource-state-and-claim-disposal",
      "unrelated-baseline-preserved",
    );
    receipt.success = true;
  },
);
