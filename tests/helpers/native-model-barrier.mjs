import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertLocalRehearsalDaemon,
  FixtureCommandError,
  localRehearsalEnvironment,
  protectedJSON,
  runFixtureCommand,
} from "./production-rehearsal-custody.ts";
import {
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
  withBoundedTeardown,
} from "./kubernetes-real.mjs";
import { createModelProviderFiles, writeModelProviderTrust } from "./runtime-model-provider.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{64}$/;
const ownerLabel = "dev.openclaw.native-model-barrier";
const clusterLabel = "dev.openclaw.native-model-cluster";
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");

// Publish a complete replacement without truncating the last recovery record.
async function writeOwnership(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// This is a controlled provider, not external model acceptance. The caller owns
// an exclusive disposable k3d cluster and stops its Agent before this teardown.
export async function prepareNativeModelBarrier(
  context,
  { directory, kubeconfigPath, kubernetesContext, cluster, codexImage, providerImage },
) {
  context = withBoundedTeardown(context);
  assert.equal(process.platform, "linux");
  assert.ok(["x64", "arm64"].includes(process.arch));
  assert.match(cluster, /^[a-z0-9][a-z0-9-]{0,40}$/);
  assert.equal(kubernetesContext, `k3d-${cluster}`);
  for (const image of [codexImage, providerImage]) {
    assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/);
  }
  const selection = { kubeconfigPath, kubernetesContext };
  assert.ok(
    process.env.OPENCLAW_ENTERPRISE_CI_STATE,
    "Prepared CI state is required before provider acquisition",
  );
  const statePath = resolve(process.env.OPENCLAW_ENTERPRISE_CI_STATE);
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  let preparedCluster;
  let preparedPostgres;
  let preparedDatabase;
  let postgresContainerId;
  let dnsRolloutPending = false;
  let clusterUid;
  let consumers;
  let consumerOutcome = "not-bound";
  let dnsProbeUid;
  const mutations = [];
  const unsettled = new Set();
  const owner = randomUUID();
  const prefix = `oce-native-model-${owner}`;
  const root = resolve(directory, `model-${owner.slice(0, 8)}`);
  const controlDirectory = join(root, "control");
  const controlPath = join(controlDirectory, "provider.sock");
  assert.ok(Buffer.byteLength(controlPath) < 104, "Use a short fixture directory for Unix sockets");
  const tag = `docker.io/library/${prefix}:trust`;
  const dnsKey = `${prefix}.server`;
  const dnsProbeName = `${prefix}-dns`;
  const octets = randomBytes(2);
  const subnet = `11.${octets[0]}.${octets[1]}`;
  const address = `${subnet}.2`;
  const modelKey = `synthetic-${randomBytes(24).toString("hex")}`;
  const environment = {
    ...localRehearsalEnvironment(process.env),
    DOCKER_TLS: undefined,
    OPENAI_API_KEY: undefined,
  };
  let rootCreated = false;
  let closing = false;
  let armDispatched = false;
  let releaseDispatched = false;
  let cleanupDeadline;
  let preparation;
  let networkId;
  let providerId;
  let trustedId;
  let reference;
  let dnsUid;
  let dnsCreated = false;
  let gateId;
  let nodes = [];
  const obligations = new Set();
  const invoke = (program, args, options = {}) => {
    const timeout = cleanupDeadline
      ? Math.min(30_000, cleanupDeadline - Date.now())
      : (options.timeout ?? 120_000);
    assert.ok(timeout > 0, "Provider cleanup deadline elapsed");
    return runFixtureCommand(
      program,
      args,
      { ...options, env: environment, timeout },
      () => "fixture command failed (output withheld)",
      true,
    );
  };
  const command = (program, args, options) => {
    assert.ok(!closing, "Fixture is closing");
    context.signal?.throwIfAborted();
    return invoke(program, args, options);
  };
  const docker = (args, cleanup = false) =>
    (cleanup ? invoke : command)("docker", ["--host=unix:///var/run/docker.sock", ...args]);
  const kube = (args, options, cleanup = false) =>
    (cleanup ? invoke : command)(
      "kubectl",
      kubectlArguments(selection, ["--request-timeout=30s", ...args]),
      options,
    );
  const inspect = async (kind, name, cleanup = false) =>
    JSON.parse(await docker([kind, "inspect", name], cleanup))[0];
  const dns = async (cleanup = false) => {
    const text = await kube(
      [
        "-n",
        "kube-system",
        "get",
        "configmap",
        "coredns-custom",
        "--ignore-not-found",
        "-o",
        "json",
      ],
      undefined,
      cleanup,
    );
    return text.trim() ? JSON.parse(text) : undefined;
  };
  const dnsValue = `api.openai.com:53 {\n    hosts {\n        ${address} api.openai.com\n    }\n}\n`;
  const record = () =>
    writeOwnership(join(root, "ownership.json"), {
      owner,
      cluster,
      networkId,
      providerId,
      trustedId,
      reference,
      dnsUid,
      dnsProbeUid,
      clusterUid,
      consumerOutcome,
      mutations,
      dnsRolloutPending,
      postgresContainerId,
      postgresResourceId: preparedPostgres?.id,
      databaseResourceId: preparedDatabase?.id,
      unsettled: [...unsettled],
      nodes: nodes.map(({ id, name, uid }) => ({ id, name, uid })),
      obligations: [...obligations],
    });
  const reserve = async (kind) => {
    obligations.add(kind);
    await record();
  };
  // Only dispatched mutations create uncertain resource obligations. A failed read
  // must not suppress cleanup of unrelated, acknowledged acquisitions.
  async function mutate(kind, action, { clusterWrite = false } = {}) {
    if (clusterWrite) {
      await assertCluster(Boolean(cleanupDeadline));
    }
    const mutation = { kind, outcome: "dispatched" };
    mutations.push(mutation);
    await record();
    // Cancellation before dispatch creates no uncertain external mutation.
    if (!cleanupDeadline && (closing || context.signal?.aborted)) {
      mutation.outcome = "not-dispatched";
      await record();
      assert.fail("Fixture closed before mutation dispatch");
    }
    let value;
    try {
      value = await action();
    } catch (error) {
      // Even a normal nonzero client exit can mean the server accepted the write
      // but its response was lost. Redacted CLI failures carry no server rejection.
      mutation.clientSettled = error instanceof FixtureCommandError && error.settled;
      mutation.outcome =
        error instanceof FixtureCommandError && !error.outcome.spawned
          ? "not-dispatched"
          : "unsettled";
      if (mutation.outcome === "unsettled") {
        unsettled.add(kind);
      }
      await record().catch(() => {});
      throw error;
    }
    mutation.clientSettled = true;
    mutation.outcome = "acknowledged";
    await record();
    return value;
  }
  async function assertPrepared() {
    const state = protectedJSON(await readFile(statePath, "utf8"));
    assert.equal(state.version, 1);
    assert.equal(resolve(state.repositoryRoot), resolve(repositoryRoot));
    assert.equal(resolve(state.statePath), statePath);
    let databaseUrl;
    try {
      databaseUrl = new URL(process.env.OCC_TEST_DATABASE_URL);
    } catch {
      assert.fail("Selected prepared database URL is invalid");
    }
    assert.ok(
      databaseUrl.protocol === "postgresql:" &&
        databaseUrl.hostname === "127.0.0.1" &&
        databaseUrl.username === "occ_app" &&
        databaseUrl.search === "" &&
        databaseUrl.hash === "",
      "Selected database must use the prepared limited local connection",
    );
    const services = state.resources.filter(({ kind }) => kind === "compose-postgres");
    assert.equal(services.length, 1, "Prepared owner must identify one PostgreSQL service");
    const postgres = services[0];
    assert.ok(
      postgres.status === "ready" && postgres.owner === state.prefix,
      "PostgreSQL service must be ready and owned by prepared state",
    );
    assert.ok(
      Number.isSafeInteger(postgres.port) &&
        postgres.port > 0 &&
        postgres.port <= 65535 &&
        postgres.port !== 55432,
    );
    assert.equal(resolve(postgres.composeFile), join(repositoryRoot, "compose.postgres.yaml"));
    assert.ok(
      databaseUrl.port === String(postgres.port),
      "Prepared PostgreSQL port differs from selected database",
    );
    const databases = state.resources.filter(
      ({ kind, name }) => kind === "postgres-database" && `/${name}` === databaseUrl.pathname,
    );
    assert.equal(databases.length, 1, "Selected database must belong to prepared state");
    const database = databases[0];
    assert.ok(
      database.status === "ready" &&
        database.owner === state.prefix &&
        database.composeProject === postgres.name &&
        database.port === postgres.port &&
        database.laneTemplate === undefined,
      "Selected database must be a ready owned non-template database on the prepared service",
    );
    if (preparedPostgres) {
      assert.deepEqual(postgres, preparedPostgres, "Prepared PostgreSQL reservation changed");
      assert.deepEqual(database, preparedDatabase, "Prepared database reservation changed");
    } else {
      preparedPostgres = postgres;
      preparedDatabase = database;
    }
    const clusters = state.resources.filter(({ kind }) => kind === "k3d-cluster");
    assert.equal(clusters.length, 1, "Prepared owner must have exactly one cluster");
    const selected = clusters[0];
    assert.equal(selected.status, "ready");
    assert.equal(selected.owner, state.prefix);
    assert.ok(typeof selected.owner === "string" && selected.owner.length > 0);
    assert.equal(selected.name, cluster);
    assert.equal(resolve(selected.kubeconfig), resolve(kubeconfigPath));
    assert.equal(selected.context, kubernetesContext);
    if (preparedCluster) {
      assert.deepEqual(selected, preparedCluster, "Prepared cluster reservation changed");
    } else {
      preparedCluster = selected;
    }
  }
  async function assertPostgresBinding() {
    context.signal?.throwIfAborted();
    assert.ok(!closing, "Fixture is closing");
    await assertPrepared();
    assert.ok(
      !process.env.OCC_DOCKER_BIN || process.env.OCC_DOCKER_BIN === "docker",
      "Attachment requires the verified Docker client",
    );
    assert.ok(
      !process.env.DOCKER_HOST || process.env.DOCKER_HOST === "unix:///var/run/docker.sock",
      "Attachment Docker host must be local",
    );
    for (const key of ["DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
      assert.ok(!process.env[key], "Attachment must not use Docker TLS overrides");
    }
    // The attachment helper inherits ambient configuration, unlike command().
    const ambient = (args) =>
      runFixtureCommand(
        "docker",
        args,
        { timeout: 15_000 },
        () => "attachment metadata unavailable (output withheld)",
        true,
      );
    const endpoint = protectedJSON(
      await ambient(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]),
    );
    assert.ok(
      endpoint === "unix:///var/run/docker.sock",
      "Attachment context must select the verified local daemon",
    );
    const localDaemon = (await docker(["info", "--format", "{{.ID}}"])).trim();
    assert.ok(
      localDaemon && (await ambient(["info", "--format", "{{.ID}}"])).trim() === localDaemon,
      "Ambient attachment daemon differs from provider daemon",
    );
    const ids = (
      await docker([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${preparedPostgres.name}`,
        "--filter",
        "label=com.docker.compose.service=postgres",
      ])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    assert.equal(ids.length, 1, "Prepared PostgreSQL must have one container");
    assert.match(ids[0], idPattern);
    const format =
      '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}}}';
    const postgres = protectedJSON(await docker(["inspect", "--format", format, ids[0]]));
    assert.ok(
      postgres.running &&
        postgres.project === preparedPostgres.name &&
        postgres.service === "postgres",
      "Prepared PostgreSQL identity is unavailable",
    );
    assert.deepEqual(
      postgres.ports?.["5432/tcp"],
      [{ HostIp: "127.0.0.1", HostPort: String(preparedPostgres.port) }],
      "Prepared PostgreSQL published port changed",
    );
    assert.ok(
      (await ambient(["inspect", "--format", "{{.Id}}", ids[0]])).trim() === postgres.id,
      "Ambient PostgreSQL attachment identity differs",
    );
    const server = nodes.find(({ name }) => name === `k3d-${cluster}-server-0`);
    assert.ok(server);
    assert.ok(
      (await ambient(["inspect", "--format", "{{.Id}}", server.name])).trim() === server.id,
      "Ambient selected server differs from provider server",
    );
    const networks = protectedJSON(
      await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", server.id]),
    );
    const matching = Object.keys(networks).filter((name) => name.startsWith(`k3d-${cluster}`));
    assert.deepEqual(
      matching,
      [`k3d-${cluster}`],
      "PostgreSQL attachment network must be unambiguous",
    );
    if (postgresContainerId) {
      assert.equal(postgres.id, postgresContainerId, "Prepared PostgreSQL container was replaced");
    } else {
      postgresContainerId = postgres.id;
    }
  }
  async function assertCluster(cleanup = false) {
    await assertPrepared();
    const run = cleanup ? invoke : command;
    await assertLocalRehearsalDaemon(run);
    const external = (
      await kube(
        ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"],
        undefined,
        cleanup,
      )
    ).trim();
    const server = nodes.find(({ name }) => name === `k3d-${cluster}-server-0`);
    assert.ok(server, "Prepared cluster requires its selected server");
    const internal = (
      await docker(
        [
          "exec",
          server.id,
          "kubectl",
          "--kubeconfig=/output/kubeconfig.yaml",
          "--server=https://127.0.0.1:6443",
          "--request-timeout=15s",
          "get",
          "namespace",
          "kube-system",
          "-o",
          "jsonpath={.metadata.uid}",
        ],
        cleanup,
      )
    ).trim();
    assert.match(external, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.equal(internal, external, "Selected API must belong to the local prepared server");
    if (clusterUid) {
      assert.equal(external, clusterUid, "Prepared cluster was replaced");
    } else {
      clusterUid = external;
    }
    const current = JSON.parse(
      await kube(["get", "nodes", "-o", "json"], undefined, cleanup),
    ).items;
    assert.deepEqual(
      current
        .map(({ metadata }) => ({ name: metadata.name, uid: metadata.uid }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      nodes.map(({ name, uid }) => ({ name, uid })).sort((a, b) => a.name.localeCompare(b.name)),
    );
    for (const node of nodes) {
      await assertNode(node, cleanup);
    }
  }
  const nodeCommand = (node, args, cleanup = false) =>
    docker(["exec", node.id, "ctr", "-n", "k8s.io", "images", ...args], cleanup);
  const nodeEntries = async (node, cleanup = false) =>
    (await nodeCommand(node, ["list"], cleanup))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/));
  async function assertNode(node, cleanup = false) {
    const current = await inspect("container", node.id, cleanup);
    assert.equal(current.Name, `/${node.name}`);
    assert.equal(current.Config.Labels["k3d.cluster"], cluster);
    assert.equal(current.State.Running, true);
    assert.equal(current.Config.Labels.app, "k3d");
    assert.ok(Number.isSafeInteger(current.State.Pid) && current.State.Pid > 1);
    const cgroup = await (cleanup ? invoke : command)("cat", [`/proc/${current.State.Pid}/cgroup`]);
    assert.ok(
      cgroup.split(/[\n/:]/).some((part) => [node.id, `docker-${node.id}.scope`].includes(part)),
      "Selected node must run in the local Docker host",
    );
  }
  function assertDnsAvailable(current) {
    assert.ok(
      Object.keys(current?.binaryData ?? {}).length === 0 &&
        !Object.entries(current?.data ?? {}).some(
          ([key, value]) => key.endsWith(".server") || /api\.openai\.com/i.test(value),
        ),
      "Another provider or unsupported custom configuration owns cluster DNS",
    );
  }
  async function refuseRetainedProvider() {
    assertDnsAvailable(await dns());
    for (const [kind, args] of [
      ["containers", ["ps", "-aq", "--filter", `label=${clusterLabel}=${cluster}`]],
      ["networks", ["network", "ls", "-q", "--filter", `label=${clusterLabel}=${cluster}`]],
      ["images", ["image", "ls", "-q", "--filter", `label=${clusterLabel}=${cluster}`]],
    ]) {
      assert.equal(
        (await docker(args)).trim(),
        "",
        `Retained provider ${kind} require reconciliation before reuse`,
      );
    }
    const probes = JSON.parse(
      await kube([
        "get",
        "pods",
        "--all-namespaces",
        "-l",
        `${clusterLabel}=${cluster}`,
        "-o",
        "json",
      ]),
    );
    assert.equal(probes.items.length, 0, "Retained provider probe requires reconciliation");
    // Earlier attempts had only the owner label. Check selected-node attachments
    // as well, without scanning or adopting any unrelated network.
    for (const node of nodes) {
      const current = await inspect("container", node.id);
      for (const attachment of Object.values(current.NetworkSettings.Networks)) {
        const network = await inspect("network", attachment.NetworkID);
        assert.equal(
          network.Labels?.[ownerLabel],
          undefined,
          "Retained provider network requires reconciliation",
        );
      }
    }
  }
  async function dnsProbe(cleanup = false) {
    const text = await kube(
      ["get", "pod", dnsProbeName, "-n", "default", "--ignore-not-found", "-o", "json"],
      undefined,
      cleanup,
    );
    if (!text.trim()) {
      return undefined;
    }
    const pod = JSON.parse(text);
    assert.equal(pod.metadata.name, dnsProbeName);
    assert.equal(pod.metadata.namespace, "default");
    assert.equal(pod.metadata.labels?.[ownerLabel], owner);
    assert.ok(dnsProbeUid, "Missing acknowledged DNS probe identity");
    assert.equal(pod.metadata.uid, dnsProbeUid);
    assert.equal(pod.spec.nodeName, nodes[0].name);
    assert.equal(pod.spec.containers.length, 1);
    assert.equal(pod.spec.containers[0].image, reference);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    return pod;
  }
  async function removeDnsProbe(cleanup = false) {
    const pod = await dnsProbe(cleanup);
    if (!pod) {
      return;
    }
    await mutate(
      "dnsProbe",
      () =>
        kube(
          ["delete", "--raw", `/api/v1/namespaces/default/pods/${dnsProbeName}`, "-f", "-"],
          {
            input: JSON.stringify({
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: { uid: dnsProbeUid },
            }),
          },
          cleanup,
        ),
      { clusterWrite: true },
    );
    const deadline = Math.min(Date.now() + 30_000, cleanupDeadline ?? Infinity);
    while (await dnsProbe(cleanup)) {
      assert.ok(Date.now() < deadline, "DNS probe removal did not settle");
      await delay(100);
    }
  }
  async function waitForResolver() {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, "Cluster resolver did not converge");
      const current = protectedJSON(
        await kube(["get", "pods", "-n", "kube-system", "-l", "k8s-app=kube-dns", "-o", "json"], {
          timeout: Math.min(15_000, remaining),
        }),
      );
      assert.ok(Date.now() < deadline, "Cluster resolver read exceeded deadline");
      if (
        current.items.length === 1 &&
        !current.items[0].metadata.deletionTimestamp &&
        current.items[0].status.conditions?.some(
          ({ type, status }) => type === "Ready" && status === "True",
        )
      ) {
        return;
      }
      await delay(250);
    }
  }
  async function verifyDns() {
    assert.equal(
      (
        await kube([
          "get",
          "pod",
          dnsProbeName,
          "-n",
          "default",
          "--ignore-not-found",
          "-o",
          "name",
        ])
      ).trim(),
      "",
    );
    // No credential, service-account token or model request enters this Pod.
    // Use the already imported image only for its Node DNS client.
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: dnsProbeName,
        namespace: "default",
        labels: { [ownerLabel]: owner, [clusterLabel]: cluster },
      },
      spec: {
        nodeName: nodes[0].name,
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        activeDeadlineSeconds: 30,
        terminationGracePeriodSeconds: 1,
        dnsPolicy: "ClusterFirst",
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "lookup",
            image: reference,
            imagePullPolicy: "Never",
            command: [
              "node",
              "-e",
              `const dns = require("node:dns").promises;
const delay = require("node:timers/promises").setTimeout;
const deadline = setTimeout(() => process.exit(1), 25000);
(async () => {
  for (;;) {
    const result = await dns.lookup("api.openai.com", {family:4}).catch(() => undefined);
    if (result?.address === ${JSON.stringify(address)}) {
      clearTimeout(deadline);
      process.stdout.write(result.address);
      return;
    }
    await delay(250);
  }
})().catch(() => process.exit(1));`,
            ],
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "200m", memory: "96Mi" },
            },
          },
        ],
      },
    };
    await reserve("dnsProbe");
    const created = JSON.parse(
      await mutate(
        "dnsProbe",
        () => kube(["create", "-f", "-", "-o", "json"], { input: JSON.stringify(pod) }),
        { clusterWrite: true },
      ),
    );
    dnsProbeUid = created.metadata.uid;
    assert.ok(typeof dnsProbeUid === "string" && dnsProbeUid.length > 0);
    await record();
    const deadline = Date.now() + 45_000;
    for (;;) {
      const current = await dnsProbe();
      assert.ok(current && !current.metadata.deletionTimestamp);
      const terminated = current.status.containerStatuses?.[0]?.state?.terminated;
      if (terminated) {
        assert.equal(
          terminated.exitCode,
          0,
          "Unauthenticated cluster DNS lookup must select the fixture",
        );
        assert.equal(current.status.phase, "Succeeded");
        break;
      }
      assert.ok(Date.now() < deadline, "Cluster DNS lookup did not finish");
      await delay(100);
    }
    const before = await dnsProbe();
    assert.ok(before);
    assert.equal(
      (
        await kube(["logs", dnsProbeName, "-n", "default", "-c", "lookup", "--limit-bytes=256"])
      ).trim(),
      address,
    );
    assert.ok(await dnsProbe(), "DNS probe must keep its identity through log readback");
    await removeDnsProbe();
  }
  async function control(value) {
    assert.ok(!closing, "Fixture is closing");
    context.signal?.throwIfAborted();
    const stat = await lstat(controlPath);
    assert.ok(stat.isSocket() && (stat.mode & 0o777) === 0o600);
    assert.equal(stat.uid, process.getuid());
    return new Promise((resolveReply, reject) => {
      const socket = connect(controlPath);
      let text = "";
      let reply;
      const timer = setTimeout(
        () => socket.destroy(new Error("Provider control timed out")),
        5_000,
      );
      socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.length > 8_192) {
          socket.destroy(new Error("Provider control reply too large"));
        } else if (text.includes("\n")) {
          try {
            reply = JSON.parse(text.slice(0, text.indexOf("\n")));
          } catch {
            socket.destroy(new Error("Malformed provider control reply"));
            return;
          }
          socket.end();
          socket.destroy();
        }
      });
      socket.on("error", reject);
      socket.on("close", () => {
        clearTimeout(timer);
        if (reply?.ok === true) {
          resolveReply(reply);
        } else {
          reject(new Error("Provider control did not acknowledge operation"));
        }
      });
    });
  }

  context.after(async () => {
    closing = true;
    await Promise.allSettled([preparation]);
    if (!rootCreated) {
      return;
    }
    cleanupDeadline = Date.now() + 150_000;
    // The topology installs this guard before creating its first consumer. Failed
    // workload cleanup must not remove its DNS/provider dependencies underneath it.
    if (consumers) {
      try {
        await consumers({ deadline: cleanupDeadline });
        consumerOutcome = "absent";
        await record();
      } catch (error) {
        consumerOutcome = "unconfirmed";
        await record().catch(() => {});
        throw error;
      }
    }
    const failures = [];
    const retained = new Set(unsettled);
    const dependencies = {
      dnsProbe: ["dnsProbe"],
      dns: ["dns", "dnsProbe"],
      provider: ["provider", "dns", "dnsProbe"],
      network: ["network", "provider", "dns", "dnsProbe"],
      import: ["import", "dnsProbe"],
      image: ["image", "import", "dnsProbe"],
    };
    const settle = async (kind, operation) => {
      try {
        assert.ok(
          !dependencies[kind].some((entry) => retained.has(entry)),
          `Unsettled ${kind} dependency; retain owned resources`,
        );
        await operation();
      } catch (error) {
        retained.add(kind);
        failures.push(error);
      }
    };
    if (obligations.has("dnsProbe")) {
      await settle("dnsProbe", () => removeDnsProbe(true));
    }
    // CAS protects other tests' CoreDNS keys; never restore an old whole ConfigMap.
    if (obligations.has("dns")) {
      await settle("dns", async () => {
        await assertCluster(true);
        const current = await dns(true);
        if (!current) {
          assert.ok(!dnsUid);
          return;
        }
        if (dnsUid) {
          assert.equal(current.metadata.uid, dnsUid);
        } else {
          assert.equal(current.metadata.labels?.[ownerLabel], owner);
        }
        const patches = [
          { op: "test", path: "/metadata/uid", value: current.metadata.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: current.metadata.resourceVersion,
          },
        ];
        if (current.data?.[dnsKey] !== undefined) {
          assert.equal(current.data[dnsKey], dnsValue);
          patches.push(
            { op: "test", path: `/data/${pointer(dnsKey)}`, value: dnsValue },
            { op: "remove", path: `/data/${pointer(dnsKey)}` },
          );
          await mutate(
            "dns",
            () =>
              kube(
                [
                  "-n",
                  "kube-system",
                  "patch",
                  "configmap",
                  "coredns-custom",
                  "--type=json",
                  "-p",
                  JSON.stringify(patches),
                ],
                undefined,
                true,
              ),
            { clusterWrite: true },
          );
        }
        const removedValue = current.data?.[dnsKey] !== undefined;
        const after = await dns(true);
        assert.equal(after.metadata.uid, current.metadata.uid);
        assert.equal(after.data?.[dnsKey], undefined);
        if (
          dnsCreated &&
          Object.keys(after.data ?? {}).length === 0 &&
          Object.keys(after.binaryData ?? {}).length === 0
        ) {
          assert.equal(after.metadata.labels?.[ownerLabel], owner);
          await mutate(
            "dns",
            () =>
              kube(
                [
                  "delete",
                  "--raw",
                  "/api/v1/namespaces/kube-system/configmaps/coredns-custom",
                  "-f",
                  "-",
                ],
                {
                  input: JSON.stringify({
                    apiVersion: "v1",
                    kind: "DeleteOptions",
                    preconditions: {
                      uid: after.metadata.uid,
                      resourceVersion: after.metadata.resourceVersion,
                    },
                  }),
                },
                true,
              ),
            { clusterWrite: true },
          );
        }
        if (removedValue || dnsRolloutPending) {
          await mutate(
            "dns",
            () =>
              kube(
                ["-n", "kube-system", "rollout", "restart", "deployment/coredns"],
                undefined,
                true,
              ),
            { clusterWrite: true },
          );
          await kube(
            ["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=25s"],
            undefined,
            true,
          );
          dnsRolloutPending = false;
        }
      });
    }
    if (obligations.has("provider")) {
      await settle("provider", async () => {
        const ids = (await docker(["ps", "-aq", "--filter", `name=^/${prefix}$`], true)).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("container", prefix, true);
        assert.equal(current.Config.Labels[ownerLabel], owner);
        if (providerId) {
          assert.equal(current.Id, providerId);
        }
        await mutate("provider", () => docker(["rm", "--force", "--volumes", current.Id], true));
      });
    }
    if (obligations.has("network")) {
      await settle("network", async () => {
        const ids = (
          await docker(["network", "ls", "-q", "--filter", `name=^${prefix}$`], true)
        ).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("network", prefix, true);
        assert.equal(current.Labels[ownerLabel], owner);
        if (networkId) {
          assert.equal(current.Id, networkId);
        }
        for (const id of Object.keys(current.Containers ?? {})) {
          const node = nodes.find((entry) => entry.id === id);
          assert.ok(node, "Unexpected consumer of fixture network");
          await assertCluster(true);
          await mutate("network", () => docker(["network", "disconnect", current.Id, id], true));
        }
        await mutate("network", () => docker(["network", "rm", current.Id], true));
      });
    }
    if (obligations.has("import")) {
      for (const node of nodes) {
        await settle("import", async () => {
          await assertCluster(true);
          for (const [name, , digest] of await nodeEntries(node, true)) {
            if (name !== tag && name !== reference) {
              continue;
            }
            assert.match(digest, digestPattern);
            if (reference) {
              assert.ok(reference.endsWith(`@${digest}`));
            }
            await mutate("import", () => nodeCommand(node, ["rm", name], true), {
              clusterWrite: true,
            });
          }
        });
      }
    }
    if (obligations.has("image")) {
      await settle("image", async () => {
        const ids = (await docker(["image", "ls", "--quiet", "--no-trunc", tag], true)).trim();
        if (!ids) {
          return;
        }
        const current = await inspect("image", tag, true);
        assert.equal(current.Config.Labels[ownerLabel], owner);
        if (trustedId) {
          assert.equal(current.Id, trustedId);
        }
        await mutate("image", () => docker(["image", "rm", tag], true));
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, `Provider cleanup incomplete; retained ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  });

  preparation = (async () => {
    await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    rootCreated = true;
    await record();
    await assertPrepared();
    await assertLocalRehearsalDaemon(command);
    await validateExplicitK3dLoopbackContext(selection);
    const observed = JSON.parse(await kube(["get", "nodes", "-o", "json"])).items;
    assert.ok(observed.length > 0 && observed.length <= 4);
    for (const node of observed) {
      assert.match(node.metadata.name, new RegExp(`^k3d-${cluster}-(server|agent)-[0-9]+$`));
      const container = await inspect("container", node.metadata.name);
      assert.match(container.Id, idPattern);
      assert.equal(container.Config.Labels["k3d.cluster"], cluster);
      assert.ok(
        node.status.addresses.some(
          ({ type, address: ip }) =>
            type === "InternalIP" &&
            Object.values(container.NetworkSettings.Networks).some(
              (network) => network.IPAddress === ip,
            ),
        ),
      );
      nodes.push({ id: container.Id, name: node.metadata.name, uid: node.metadata.uid });
      await assertNode(nodes.at(-1));
    }
    assert.deepEqual(nodes.map(({ name }) => name).sort(), [...preparedCluster.nodes].sort());
    await assertCluster();
    await assertPostgresBinding();
    await refuseRetainedProvider();
    await record();
    const platform = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
    const base = JSON.parse(
      await docker(["image", "inspect", "--platform", platform, codexImage]),
    )[0];
    const files = join(root, "model");
    await createModelProviderFiles({ directory: files, caName: prefix, run: command });
    await mkdir(controlDirectory, { mode: 0o700 });
    const trust = join(root, "trust");
    await writeModelProviderTrust({ context: trust, caPath: join(files, "ca.pem") });
    assert.equal((await docker(["image", "ls", "--quiet", tag])).trim(), "");
    await reserve("image");
    await mutate("image", () =>
      command(
        "docker",
        [
          "--host=unix:///var/run/docker.sock",
          "build",
          "--network=none",
          "--platform",
          platform,
          "--pull=false",
          "--label",
          `${ownerLabel}=${owner}`,
          "--label",
          `${clusterLabel}=${cluster}`,
          "--build-arg",
          `RUNTIME_IMAGE=${codexImage}`,
          "--tag",
          tag,
          trust,
        ],
        { timeout: 300_000 },
      ),
    );
    const built = await inspect("image", tag);
    for (const field of ["User", "Entrypoint", "Cmd", "WorkingDir"]) {
      assert.deepEqual(built.Config[field], base.Config[field]);
    }
    assert.deepEqual(built.RootFS.Layers.slice(0, base.RootFS.Layers.length), base.RootFS.Layers);
    assert.deepEqual(built.Config.Labels, {
      ...base.Config.Labels,
      [ownerLabel]: owner,
      [clusterLabel]: cluster,
    });
    trustedId = built.Id;
    assert.match(trustedId, digestPattern);
    for (const node of nodes) {
      assert.ok(!(await nodeEntries(node)).some(([name]) => name === tag));
    }
    await reserve("import");
    await mutate(
      "import",
      () => command("k3d", ["image", "import", "--cluster", cluster, tag], { timeout: 180_000 }),
      { clusterWrite: true },
    );
    for (const node of nodes) {
      await assertNode(node);
      const entry = (await nodeEntries(node)).find(([name]) => name === tag);
      assert.ok(entry, "Trust image must be imported into every selected node");
      assert.match(entry[2], digestPattern);
      let manifest = JSON.parse(
        await docker(["exec", node.id, "ctr", "-n", "k8s.io", "content", "get", entry[2]]),
      );
      if (manifest.manifests) {
        const choices = manifest.manifests.filter(
          (item) =>
            item.platform?.os === "linux" && item.platform?.architecture === platform.split("/")[1],
        );
        assert.equal(choices.length, 1);
        manifest = JSON.parse(
          await docker([
            "exec",
            node.id,
            "ctr",
            "-n",
            "k8s.io",
            "content",
            "get",
            choices[0].digest,
          ]),
        );
      }
      assert.equal(
        manifest.config.digest,
        trustedId,
        "Imported runtime must be the built CA derivative",
      );
      const candidate = `${tag.slice(0, tag.lastIndexOf(":"))}@${entry[2]}`;
      if (reference) {
        assert.equal(candidate, reference);
      }
      reference = candidate;
      await mutate("import", () => nodeCommand(node, ["tag", tag, reference]), {
        clusterWrite: true,
      });
    }
    assert.equal(
      (await docker(["network", "ls", "--quiet", "--filter", `name=^${prefix}$`])).trim(),
      "",
    );
    await reserve("network");
    networkId = (
      await mutate("network", () =>
        docker([
          "network",
          "create",
          "--internal",
          "--subnet",
          `${subnet}.0/28`,
          "--label",
          `${ownerLabel}=${owner}`,
          "--label",
          `${clusterLabel}=${cluster}`,
          prefix,
        ]),
      )
    ).trim();
    assert.match(networkId, idPattern);
    for (let index = 0; index < nodes.length; index++) {
      await assertNode(nodes[index]);
      await mutate(
        "network",
        () =>
          docker([
            "network",
            "connect",
            "--ip",
            `${subnet}.${index + 3}`,
            networkId,
            nodes[index].id,
          ]),
        { clusterWrite: true },
      );
    }
    assert.equal((await docker(["ps", "-aq", "--filter", `name=^/${prefix}$`])).trim(), "");
    await reserve("provider");
    providerId = (
      await mutate("provider", () =>
        docker([
          "run",
          "--pull=never",
          "--platform",
          platform,
          "--detach",
          "--name",
          prefix,
          "--label",
          `${ownerLabel}=${owner}`,
          "--label",
          `${clusterLabel}=${cluster}`,
          "--network",
          networkId,
          "--ip",
          address,
          "--user",
          `${process.getuid()}:${process.getgid()}`,
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--sysctl",
          "net.ipv4.ip_unprivileged_port_start=0",
          "--volume",
          `${files}:/fixture:ro`,
          "--volume",
          `${controlDirectory}:/control:rw`,
          "--env",
          "PROBE_ENDPOINT_MODE=answer",
          "--env",
          "PROBE_ENDPOINT_HOST=0.0.0.0",
          "--env",
          "PROBE_ENDPOINT_ECHO_PATTERN=OCC-[A-Za-z0-9_-]+",
          "--env",
          "PROBE_ENDPOINT_CONTROL_SOCKET=/control/provider.sock",
          "--env",
          `PROBE_ENDPOINT_CREDENTIAL_DIGESTS=${JSON.stringify({ fixture: createHash("sha256").update(modelKey).digest("hex") })}`,
          "--entrypoint",
          "node",
          providerImage,
          "/fixture/endpoint.mjs",
        ]),
      )
    ).trim();
    assert.match(providerId, idPattern);
    await record();
    const deadline = Date.now() + 30_000;
    while (
      !(await lstat(controlPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }))
    ) {
      assert.ok(Date.now() < deadline, "Provider control socket did not start");
      context.signal?.throwIfAborted();
      await delay(100);
    }
    const before = await dns();
    dnsUid = before?.metadata.uid;
    dnsCreated = !before;
    assert.equal(before?.data?.[dnsKey], undefined);
    assertDnsAvailable(before);
    await reserve("dns");
    if (before) {
      await mutate(
        "dns",
        () =>
          kube([
            "-n",
            "kube-system",
            "patch",
            "configmap",
            "coredns-custom",
            "--type=json",
            "-p",
            JSON.stringify([
              { op: "test", path: "/metadata/uid", value: dnsUid },
              {
                op: "test",
                path: "/metadata/resourceVersion",
                value: before.metadata.resourceVersion,
              },
              ...(before.data ? [] : [{ op: "add", path: "/data", value: {} }]),
              { op: "add", path: `/data/${pointer(dnsKey)}`, value: dnsValue },
            ]),
          ]),
        { clusterWrite: true },
      );
    } else {
      await mutate(
        "dns",
        () =>
          kube(["create", "-f", "-"], {
            input: JSON.stringify({
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: {
                name: "coredns-custom",
                namespace: "kube-system",
                labels: { [ownerLabel]: owner, [clusterLabel]: cluster },
              },
              data: { [dnsKey]: dnsValue },
            }),
          }),
        { clusterWrite: true },
      );
    }
    const after = await dns();
    assert.equal(after.data[dnsKey], dnsValue);
    dnsUid = after.metadata.uid;
    await record();
    await mutate(
      "dns",
      () => kube(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]),
      { clusterWrite: true },
    );
    dnsRolloutPending = true;
    await record();
    await kube(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=120s"], {
      timeout: 150_000,
    });
    await waitForResolver();
    dnsRolloutPending = false;
    await record();
    await verifyDns();
    return {
      bindConsumers(read) {
        assert.equal(consumers, undefined, "Consumer ownership may be bound only once");
        assert.equal(typeof read, "function");
        consumers = read;
        consumerOutcome = "bound";
      },
      modelKey,
      assertPostgresBinding,
      codexImage: reference,
      providerImage,
      directory: root,
      async arm({ marker, timeoutMs = 300_000 }) {
        assert.equal(armDispatched, false, "Only one barrier may be armed");
        armDispatched = true;
        const replyToken = `OCC-response-${randomUUID()}`;
        const reply = await control({ op: "arm", marker, replyToken, timeoutMs });
        gateId = reply.gateId;
        assert.equal(reply.state, "armed");
        return { ...reply, replyToken };
      },
      status: ({ gateId: expected }) => {
        assert.ok(gateId && expected === gateId, "Wrong provider gate");
        return control({ op: "status", gateId });
      },
      release: ({ gateId: expected }) => {
        assert.ok(gateId && expected === gateId, "Wrong provider gate");
        assert.equal(releaseDispatched, false, "Release cannot be replayed");
        releaseDispatched = true;
        return control({ op: "release", gateId });
      },
    };
  })();
  return preparation;
}
