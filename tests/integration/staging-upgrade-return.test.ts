import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  bindLocalRehearsalCluster,
  createRehearsalCustody,
  localRehearsalEnvironment,
  runFixtureCommand,
  writeFixtureObject,
  type FixtureRun,
} from "../helpers/production-rehearsal-custody.ts";
import {
  assertDistinctControllers,
  assertReturnedAgents,
  assertReturnedInstallationAuthentication,
  assertRunningController,
  returnedDatabaseConnections,
  selectRehearsalControllers,
} from "../helpers/staging-upgrade-return.ts";

const controller = (digest: string, config: string, commit: string) => ({
  reference: `ghcr.io/openclaw/openclaw-enterprise-controller@sha256:${digest.repeat(64)}`,
  configDigest: `sha256:${config.repeat(64)}`,
  revision: commit.repeat(40),
});

test("return rehearsal rejects different manifest references that contain the same controller", () => {
  const previous = controller("1", "2", "3");
  assert.doesNotThrow(() => assertDistinctControllers(previous, controller("4", "5", "6")));
  assert.throws(
    () => assertDistinctControllers(previous, controller("4", "2", "6")),
    /platform configs must differ/u,
  );
});

test("return rehearsal refuses image selection in the credentialed TUI lane", async () => {
  const noImageInspection = () => Promise.reject(new Error("unexpected image inspection"));
  await assert.rejects(
    selectRehearsalControllers(noImageInspection, { CI: "true" }),
    /run the controller rehearsal locally/u,
  );
  await assert.rejects(
    selectRehearsalControllers(noImageInspection, { OPENAI_API_KEY: "invented-fixture-value" }),
    /without model credentials/u,
  );
});

test("return readback rejects a stale restore and a recreated Agent with the same name", () => {
  const baseline = {
    id: "agt_before",
    namespaceId: "ns_original",
    name: "before-upgrade",
    configurationId: "cfg_original",
  };
  const accepted = { ...baseline, id: "agt_accepted", name: "acknowledged-after-upgrade" };
  assert.doesNotThrow(() => assertReturnedAgents(baseline, accepted, [baseline, accepted]));
  assert.throws(
    () => assertReturnedAgents(baseline, accepted, [baseline]),
    /missing or changed acknowledged Agent agt_accepted/u,
  );
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [baseline, { ...accepted, id: "agt_recreated" }]),
    /missing or changed acknowledged Agent agt_accepted/u,
  );
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [
        { ...baseline, configurationId: "cfg_other" },
        accepted,
      ]),
    /missing or changed preexisting Agent agt_before/u,
  );
});

test("return readback requires both serving Pods to use the restored database", () => {
  const podIPs = ["192.0.2.1", "192.0.2.2"];
  const restored = ["occ_return:192.0.2.1", "occ_return:192.0.2.2"];
  assert.equal(returnedDatabaseConnections(restored, podIPs), true);
  assert.equal(returnedDatabaseConnections(restored.slice(0, 1), podIPs), false);
  assert.throws(
    () => returnedDatabaseConnections([...restored, "openclaw_enterprise:192.0.2.2"], podIPs),
    /retained candidate database still has an application connection/u,
  );
});

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-rehearsal-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("rehearsal admission binds the direct local Docker port and Kubernetes identity before writes", async (t) => {
  const directory = await scratch(t);
  const uid = randomUUID();
  const nodeUID = randomUUID();
  const cluster = "fixture-control";
  const context = `k3d-${cluster}`;
  const node = `${context}-server-0`;
  const server = {
    id: "a".repeat(64),
    pid: 1024,
    running: true,
    app: "k3d",
    role: "server",
    cluster,
    loadBalancer: "",
    ports: [{ HostIp: "127.0.0.1", HostPort: "31421" }],
  };
  const connection: Record<string, string> = {
    server: "https://127.0.0.1:31421",
    "certificate-authority-data": "invented-ca",
  };
  const containerID = "b".repeat(64);
  const configDigest = `sha256:${"c".repeat(64)}`;
  let podUID = randomUUID();
  let internalUID = uid;
  let sameHost = true;
  let externalUIDReads = 0;
  const run: FixtureRun = async (command, args, options) => {
    if (command === "python3") {
      assert.equal(args.at(-1), "/var/run/docker.sock");
      return "";
    }
    if (command === "docker") {
      assert.equal(args[0], "--host=unix:///var/run/docker.sock");
      if (args[1] === "exec") {
        assert.equal(args[2], server.id);
        if (args.includes("crictl")) {
          assert.equal(args.at(-1), containerID);
          assert.ok(args.includes("--output=go-template"));
          assert.equal(options?.protectedInput, true);
          return `${containerID} ${podUID} ${configDigest}`;
        }
        return internalUID;
      }
      assert.equal(args.at(-1), node);
      return JSON.stringify(server);
    }
    if (command === "cat") {
      return sameHost ? `0::/system.slice/docker-${server.id}.scope\n` : "0::/system.slice/other";
    }
    if (command === "k3d") {
      assert.deepEqual(args, ["kubeconfig", "get", cluster]);
      assert.equal(options?.protectedInput, true);
      return "invented dedicated kubeconfig";
    }
    assert.equal(command, "kubectl");
    assert.ok(args.includes("get") || args.includes("config"), "admission must not issue writes");
    if (args.includes("config")) {
      assert.equal(options?.protectedInput, true);
      return JSON.stringify({
        contexts: [{ name: context, context: { cluster: context, user: "admin" } }],
        clusters: [{ name: context, cluster: connection }],
        users: [
          {
            name: "admin",
            user: { "client-certificate-data": "invented-cert", "client-key-data": "invented-key" },
          },
        ],
      });
    }
    if (args.includes("nodes")) {
      return JSON.stringify({ items: [{ metadata: { name: node, uid: nodeUID } }] });
    }
    assert.ok(args.includes("kube-system"));
    externalUIDReads++;
    return uid;
  };
  const accepted = await bindLocalRehearsalCluster(run, cluster, join(directory, "accepted"));
  assert.equal(accepted.selection.kubernetesContext, context);
  assert.equal(accepted.nodeUID, nodeUID);
  assert.equal((await stat(accepted.selection.kubeconfigPath)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(accepted.selection.kubeconfigPath, "utf8"),
    "invented dedicated kubeconfig",
  );
  await accepted.assertCluster();
  const expectedPodUID = podUID;
  assert.equal(
    await accepted.runningConfigDigest(`containerd://${containerID}`, expectedPodUID),
    configDigest,
  );
  podUID = randomUUID();
  await assert.rejects(
    accepted.runningConfigDigest(`containerd://${containerID}`, expectedPodUID),
    /did not inspect the scheduled Pod/u,
  );

  const readsBeforeFailure = externalUIDReads;
  connection["proxy-url"] = "http://127.0.0.1:8080";
  await assert.rejects(
    bindLocalRehearsalCluster(run, cluster, join(directory, "proxy")),
    /no proxy/u,
  );
  assert.equal(externalUIDReads, readsBeforeFailure);
  delete connection["proxy-url"];

  connection.server = "https://127.0.0.1:31422";
  await assert.rejects(
    bindLocalRehearsalCluster(run, cluster, join(directory, "tunnel")),
    /direct Docker API port/u,
  );
  assert.equal(externalUIDReads, readsBeforeFailure);
  connection.server = "https://127.0.0.1:31421";

  sameHost = false;
  await assert.rejects(
    bindLocalRehearsalCluster(run, cluster, join(directory, "remote")),
    /not in the local Docker host cgroup/u,
  );
  assert.equal(externalUIDReads, readsBeforeFailure);
  sameHost = true;
  internalUID = randomUUID();
  await assert.rejects(
    bindLocalRehearsalCluster(run, cluster, join(directory, "foreign")),
    /different cluster identities/u,
  );
  await assert.rejects(accepted.assertCluster(), /cluster was replaced/u);

  const env = localRehearsalEnvironment({
    DOCKER_HOST: "ssh://example.invalid",
    KUBECONFIG: "/invented/ambient",
    HELM_KUBEAPISERVER: "https://example.invalid",
    HELM_DRIVER: "sql",
    HTTPS_PROXY: "http://example.invalid",
    all_proxy: "http://example.invalid",
  });
  assert.equal(env.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(env.HELM_DRIVER, "secret");
  for (const name of ["KUBECONFIG", "HELM_KUBEAPISERVER", "HTTPS_PROXY", "all_proxy"]) {
    assert.equal(env[name], undefined);
  }
});

const namespace = "oce-tui-fixture";
const tenant = "fixture-tenant";
const release = "fixture-release";
const suffix = "fixture";
const node = "k3d-fixture-server-0";
const once = async <T>(_description: string, check: () => Promise<T | false>) => {
  const result = await check();
  assert.notEqual(result, false, "synthetic fixture should settle in one observation");
  return result as T;
};

test("a lost namespace create response cannot be replayed or used for SQL or teardown", async () => {
  let creates = 0;
  const run: FixtureRun = async (_command, args) => {
    assert.ok(args.includes("create"), "an unacknowledged target must never be used");
    creates++;
    throw new Error("invented lost create response");
  };
  const custody = createRehearsalCustody({
    run,
    kubeArgs: [],
    namespace,
    release,
    suffix,
    cluster: { node, assertCluster: async () => {} },
    waitFor: once,
  });
  const object = {
    kind: "Namespace",
    metadata: { name: namespace, labels: { "oce-test": suffix } },
  };
  await assert.rejects(custody.create(object), /lost create response/u);
  await assert.rejects(custody.create(object), /refusing to replay creation/u);
  await assert.rejects(custody.postgres("psql"), /no acknowledged creation of namespace/u);
  await assert.rejects(
    custody.teardown(async () => assert.fail("an unknown create must not uninstall Helm")),
    /no acknowledged creation of namespace/u,
  );
  assert.equal(creates, 1);
});

test("fixture database effects and Helm teardown refuse replaced resources and delete namespaces by UID", async () => {
  const uids = new Map<string, string>();
  const deleted: { name: string; uid: string }[] = [];
  const releaseUID = randomUUID();
  const pgIP = "192.0.2.12";
  let replacement: string | undefined;
  let execUID: string | undefined;
  let releaseReplaced = false;
  let pendingRevision = false;
  let databaseVersion = "2";
  let execSends = 0;
  let uninstallSends = 0;
  const run: FixtureRun = async (command, args, options) => {
    assert.equal(command, "kubectl");
    const kind = args.find((arg) => ["create", "get", "exec", "delete"].includes(arg));
    assert.ok(kind);
    if (kind === "create") {
      const object = JSON.parse(options?.input ?? "") as {
        kind: string;
        metadata: { name: string };
        spec?: { selector?: object; containers?: { env?: object[] }[] };
      };
      const resource = `${object.kind.toLowerCase()}/${object.metadata.name}`;
      assert.ok(!uids.has(resource));
      const uid = randomUUID();
      uids.set(resource, uid);
      if (resource === "pod/postgres") {
        assert.deepEqual(object.spec?.containers?.[0]?.env, [
          { name: "OCE_TEST_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
        ]);
      }
      if (resource === "service/postgres") {
        assert.deepEqual(object.spec?.selector, { app: "postgres", "oce-test": suffix });
      }
      return resource === "secret/occ-database" ? `${uid} 2` : uid;
    }
    if (kind === "exec") {
      execSends++;
      const [shell, ...argv] = args.slice(args.indexOf("--") + 1);
      assert.equal(shell, "sh");
      return runFixtureCommand(shell, argv, {
        protectedInput: true,
        env: { OCE_TEST_POD_UID: execUID ?? uids.get("pod/postgres") },
      });
    }
    if (kind === "delete") {
      const name = args
        .find((arg) => arg.startsWith("--raw=/api/v1/namespaces/"))
        ?.split("/")
        .at(-1);
      assert.ok(name);
      const uid = uids.get(`namespace/${name}`);
      assert.ok(uid);
      assert.deepEqual(JSON.parse(options?.input ?? ""), {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid },
      });
      uids.delete(`namespace/${name}`);
      deleted.push({ name, uid });
      return "";
    }
    const resource = args[args.indexOf("get") + 1];
    assert.ok(resource);
    const uid = replacement === resource ? randomUUID() : uids.get(resource);
    if (resource.startsWith("namespace/")) {
      return uid && !args.includes("--ignore-not-found") ? `${uid} Active` : (uid ?? "");
    }
    if (resource === "secrets") {
      const deployed = `sh.helm.release.v1.${release}.v1 ${releaseReplaced ? randomUUID() : releaseUID} deployed`;
      return pendingRevision
        ? `${deployed}\nsh.helm.release.v1.${release}.v2 ${randomUUID()} pending-upgrade`
        : deployed;
    }
    if (resource === "pod/postgres") {
      return JSON.stringify({
        metadata: { uid },
        spec: {
          nodeName: node,
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "postgres-data" } }],
        },
        status: { phase: "Running", podIP: pgIP },
      });
    }
    if (resource === "pvc/postgres-data") {
      return JSON.stringify({
        metadata: {
          uid:
            replacement === resource
              ? randomUUID()
              : uids.get("persistentvolumeclaim/postgres-data"),
        },
        spec: { volumeName: "fixture-volume" },
        status: { phase: "Bound" },
      });
    }
    if (resource === "service/postgres") {
      return JSON.stringify({
        metadata: { uid },
        spec: {
          type: "ClusterIP",
          selector: { app: "postgres", "oce-test": suffix },
          ports: [{ port: 5432, targetPort: 5432 }],
        },
      });
    }
    if (resource === "endpointslices") {
      return JSON.stringify({
        items: [
          {
            metadata: { ownerReferences: [{ kind: "Service", uid: uids.get("service/postgres") }] },
            endpoints: [
              {
                conditions: { ready: true },
                addresses: [pgIP],
                targetRef: { uid: uids.get("pod/postgres") },
              },
            ],
          },
        ],
      });
    }
    assert.equal(resource, "secret/occ-database");
    assert.equal(options?.protectedInput, true);
    return JSON.stringify({
      kind: "Secret",
      metadata: { name: "occ-database", namespace, uid, resourceVersion: databaseVersion },
      data: Object.fromEntries(
        [
          ["application-url", "occ_app"],
          ["migration-url", "occ_migrator"],
        ].map(([key, user]) => [
          key,
          Buffer.from(
            `postgresql://${user}:invented@postgres.${namespace}.svc.cluster.local:5432/openclaw_enterprise`,
          ).toString("base64"),
        ]),
      ),
    });
  };
  const custody = createRehearsalCustody({
    run,
    kubeArgs: [],
    namespace,
    release,
    suffix,
    cluster: { node, assertCluster: async () => {} },
    waitFor: once,
  });
  const labels = { "oce-test": suffix };
  const systemUID = await custody.create({
    kind: "Namespace",
    metadata: { name: namespace, labels },
  });
  const tenantUID = randomUUID();
  uids.set(`namespace/${tenant}`, tenantUID);
  await custody.bindTenant(tenant, tenantUID);
  for (const [kind, name] of [
    ["Pod", "postgres"],
    ["PersistentVolumeClaim", "postgres-data"],
    ["Service", "postgres"],
    ["Secret", "occ-database"],
  ] as const) {
    const object = {
      kind,
      metadata: { name, namespace, labels },
      spec: { containers: [{ name: "postgres", env: [] }] },
    };
    await custody.create(object);
  }
  await custody.bindRelease(1);
  const uninstall = async () => {
    uninstallSends++;
    return "";
  };
  for (const resource of [
    `namespace/${namespace}`,
    `namespace/${tenant}`,
    "pod/postgres",
    "pvc/postgres-data",
    "service/postgres",
    "secret/occ-database",
  ]) {
    replacement = resource;
    await assert.rejects(custody.postgres("echo", "invented database effect"), /replaced/u);
    await assert.rejects(custody.teardown(uninstall), /replaced/u);
  }
  replacement = undefined;
  databaseVersion = "3";
  await assert.rejects(custody.postgres("echo"), /database Secret was replaced or modified/u);
  databaseVersion = "2";
  assert.equal(execSends, 0);
  assert.equal(uninstallSends, 0);
  assert.deepEqual(deleted, []);

  // Race after the read: run the real exec shell with a different Downward API UID.
  execUID = randomUUID();
  await assert.rejects(custody.postgres("echo", "invented database effect"), /failed \(42\)/u);
  execUID = undefined;
  assert.match(
    await custody.postgres("echo", "invented database effect"),
    /invented database effect/u,
  );
  releaseReplaced = true;
  await assert.rejects(custody.teardown(uninstall), /release revision was replaced/u);
  assert.equal(uninstallSends, 0);
  releaseReplaced = false;
  pendingRevision = true;
  await assert.rejects(custody.teardown(uninstall), /release history was replaced/u);
  assert.equal(uninstallSends, 0);
  pendingRevision = false;
  await custody.teardown(uninstall);
  assert.equal(uninstallSends, 1);
  assert.deepEqual(deleted, [
    { name: tenant, uid: tenantUID },
    { name: namespace, uid: systemUID },
  ]);
});

test("Secret writes suppress the actual child failure output, including encoded and multiline values", async (t) => {
  const directory = await scratch(t);
  await writeFile(
    join(directory, "kubectl"),
    "#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' \"$payload\"\nprintf '%s\\n' \"$payload\" >&2\nexit 17\n",
    { mode: 0o700 },
  );
  const marker = `invented-${randomUUID()}`;
  const encoded = Buffer.from(marker).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`;
  const run: FixtureRun = (command, args, options) =>
    runFixtureCommand(
      command,
      args,
      {
        ...options,
        env: { PATH: [directory, process.env.PATH].join(delimiter) },
      },
      String,
      true,
    );
  const object = {
    kind: "Secret",
    metadata: { name: "invented" },
    data: { encoded },
    stringData: { marker, pem },
  };
  await assert.rejects(
    writeFixtureObject(run, [], "apply", { ...object, kind: "ConfigMap" }),
    (error: Error) => error.message.includes(marker) && error.message.includes(encoded),
  );
  for (const verb of ["apply", "create", "replace"] as const) {
    await assert.rejects(writeFixtureObject(run, [], verb, object), (error: Error) => {
      assert.match(error.message, /kubectl failed \(17\) during a protected fixture operation/u);
      assert.ok(!error.message.includes(marker));
      assert.ok(!error.message.includes(encoded));
      assert.ok(!error.message.includes("BEGIN PRIVATE KEY"));
      return true;
    });
  }
});

test("a running controller must match the scheduled platform and the verified child", async () => {
  const image = {
    ...controller("a", "b", "c"),
    platform: "linux/amd64",
    manifestDigest: `sha256:${"d".repeat(64)}`,
  };
  const noChild = async () => undefined;
  assert.equal(
    await assertRunningController(image, "linux/amd64", image.manifestDigest, noChild),
    image.manifestDigest,
  );
  assert.equal(
    await assertRunningController(
      image,
      "linux/amd64",
      image.reference,
      async () => image.configDigest,
    ),
    image.configDigest,
  );
  await assert.rejects(
    assertRunningController(image, "linux/arm64", image.manifestDigest, noChild),
    /different OS or architecture/u,
  );
  await assert.rejects(
    assertRunningController(image, "linux/amd64", image.reference, noChild),
    /selected platform image/u,
  );
  await assert.rejects(
    assertRunningController(
      image,
      "linux/amd64",
      image.reference,
      async () => `sha256:${"e".repeat(64)}`,
    ),
    /selected platform image/u,
  );
});

test("the returned Installation denies anonymous reads and accepts the original key and identity", async () => {
  const calls: boolean[] = [];
  const read: Parameters<typeof assertReturnedInstallationAuthentication>[0] = async (
    method,
    path,
    body,
    { authenticated },
  ) => {
    assert.deepEqual([method, path, body], ["GET", "/installation", undefined]);
    calls.push(authenticated);
    return authenticated
      ? { status: 200, body: { data: { id: "installation-1" } } }
      : { status: 401, body: {} };
  };
  await assertReturnedInstallationAuthentication(read, "installation-1");
  assert.deepEqual(calls, [false, true]);
  await assert.rejects(
    assertReturnedInstallationAuthentication(
      async () => ({ status: 200, body: {} }),
      "installation-1",
    ),
    /must deny anonymous Installation reads/u,
  );
  await assert.rejects(
    assertReturnedInstallationAuthentication(
      async () => ({ status: 401, body: {} }),
      "installation-1",
    ),
    /must accept the original service key/u,
  );
  await assert.rejects(
    assertReturnedInstallationAuthentication(read, "installation-2"),
    /must serve the original Installation/u,
  );
});
