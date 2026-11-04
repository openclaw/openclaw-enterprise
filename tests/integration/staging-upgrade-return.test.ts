import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:https";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";
import { createProductionTuiRequest } from "../helpers/production-tui-request.ts";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
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
  assertRunningController,
  returnedDatabaseConnections,
  returnedAgentSnapshot,
  selectRehearsalControllers,
  verifyCompletedMigrationHistory,
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
  const baseline = returnedAgentSnapshot({
    executionMode: "embedded",
    gatewayManagedMode: true,
    backendId: null,
    harnessAuth: null,
    id: "agt_before",
    namespaceId: "ns_original",
    name: "before-upgrade",
    configurationId: "cfg_original",
  });
  const accepted = { ...baseline, id: "agt_accepted", name: "acknowledged-after-upgrade" };
  // A real Agent read can preserve its identity while reporting unreadable settings.
  const { harnessAuth: _harnessAuth, ...metadata } = accepted;
  assert.throws(
    () =>
      returnedAgentSnapshot({
        ...metadata,
        configurationReadError: { code: "SAVED_CONFIGURATION_UNREADABLE", field: "plugins" },
      }),
    /cannot read the saved Agent settings/u,
  );
  assert.equal(accepted.executionMode, "embedded");
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [
        baseline,
        returnedAgentSnapshot({ ...accepted, executionMode: "dedicated" }),
      ]),
    /missing or changed acknowledged Agent/u,
  );
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [
        baseline,
        returnedAgentSnapshot({ ...accepted, plugins: { "occ-plugin:diffs": { enabled: true } } }),
      ]),
    /missing or changed acknowledged Agent/u,
  );
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

test("release checkout admission rejects hidden edits and ignored execution inputs before Docker", async (t) => {
  const directory = await scratch(t);
  const candidate = join(directory, "candidate");
  const previous = join(directory, "previous");
  await mkdir(candidate);
  const git = (args: string[]) => runFixtureCommand("git", args, { cwd: candidate });
  await git(["init", "--quiet"]);
  await writeFile(join(candidate, ".gitignore"), "dist/\n");
  await mkdir(join(candidate, "templates"));
  await writeFile(join(candidate, "templates", "base.yaml"), "apiVersion: v1\nkind: ConfigMap\n");
  await writeFile(join(candidate, "upgrade-script"), "reviewed source\n");
  await git(["add", "."]);
  const commit = () =>
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
  await commit();
  await git(["clone", "--quiet", "--local", candidate, previous]);
  await writeFile(join(candidate, "upgrade-script"), "reviewed candidate\n");
  await git(["add", "."]);
  await commit();
  let dockerCalls = 0;
  const run: FixtureRun = (command, args, options) => {
    if (command === "docker") {
      dockerCalls++;
      return Promise.reject(new Error("reached image inspection"));
    }
    return runFixtureCommand(command, args, options);
  };
  const env = {
    OCC_TEST_REHEARSAL_PREVIOUS_SOURCE: previous,
    OCC_TEST_REHEARSAL_CANDIDATE_SOURCE: candidate,
    OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: controller("1", "2", "3").reference,
    OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: controller("4", "5", "6").reference,
  };
  await assert.rejects(selectRehearsalControllers(run, env), /reached image inspection/u);
  assert.equal(dockerCalls, 1);
  dockerCalls = 0;
  // These real Git index flags hide worktree edits from porcelain status.
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    await git(["update-index", `--${flag}`, "upgrade-script"]);
    await writeFile(join(candidate, "upgrade-script"), "unreviewed execution input\n");
    assert.equal((await git(["status", "--porcelain"])).trim(), "");
    await assert.rejects(selectRehearsalControllers(run, env), /only unmodified committed files/u);
    assert.equal(dockerCalls, 0);
    await git(["update-index", `--no-${flag}`, "upgrade-script"]);
    await git(["restore", "upgrade-script"]);
  }
  await mkdir(join(candidate, "templates", "dist"));
  // Helm can render ignored templates, so clean porcelain status is insufficient.
  await writeFile(
    join(candidate, "templates", "dist", "injected.yaml"),
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: unreviewed\n",
  );
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
  await assert.rejects(selectRehearsalControllers(run, env), /only unmodified committed files/u);
  assert.equal(dockerCalls, 0);
});

test("migration check reports protected log failures without printing fixture credentials", async (t) => {
  const directory = await scratch(t);
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$FIXTURE_STDOUT"',
      'printf "%s\\n" "$FIXTURE_STDERR" >&2',
      'exit "$FIXTURE_EXIT"',
    ].join("\n") + "\n",
    { mode: 0o700 },
  );
  const marker = `key${randomUUID().slice(0, 6)}`;
  const url = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "migrator",
    password: marker,
    host: "fixture",
    port: undefined,
    pathname: "/occ_return",
  });
  const check = (stdout: string, stderr = "", exit = "0") => {
    const run: FixtureRun = (command, args, options) =>
      runFixtureCommand(command, args, {
        ...options,
        env: {
          PATH: [directory, process.env.PATH].join(delimiter),
          FIXTURE_STDOUT: stdout,
          FIXTURE_STDERR: stderr,
          FIXTURE_EXIT: exit,
        },
      });
    return verifyCompletedMigrationHistory(run, [], "return-compatibility");
  };
  const receipt = JSON.stringify({ event: "migration.checked", history: "completed", url });
  const rejectWithoutMarker = (diagnostic: RegExp) => (error: Error) => {
    const rendered = inspect(error);
    assert.ok(!rendered.includes(marker), "the failure printed a protected fixture marker");
    assert.match(rendered, diagnostic);
    return true;
  };
  const missingOrConflicting = /migration check requires exactly one completed history receipt/u;

  await check(`{"event":"migration.checked"}\n${receipt}`, marker);
  await assert.rejects(
    check(url, marker, "17"),
    rejectWithoutMarker(/kubectl failed \(17\) during a protected fixture operation/u),
  );
  await assert.rejects(
    check(`${marker}!`),
    rejectWithoutMarker(/migration check returned invalid protected log records/u),
  );
  await assert.rejects(check(""), rejectWithoutMarker(missingOrConflicting));
  await assert.rejects(check(`${receipt}\n${receipt}`), rejectWithoutMarker(missingOrConflicting));
  await assert.rejects(
    check(`${receipt}\n${JSON.stringify({ event: "migration.checked", history: marker })}`),
    rejectWithoutMarker(missingOrConflicting),
  );
});

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
            syntheticCredentialUrl({
              protocol: "postgresql",
              username: user,
              password: "invented",
              host: `postgres.${namespace}.svc.cluster.local`,
              port: 5432,
              pathname: "/openclaw_enterprise",
            }),
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

test(
  "rehearsal TLS requests reject malformed and interrupted responses without exposing bytes",
  { timeout: 10_000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    const secret = `fixture-service-key-${randomUUID()}`;
    const privateBytes = `private-response-${randomUUID()}`;
    const receivedKeys: (string | string[] | undefined)[] = [];
    const server = createServer(tls, (incoming, response) => {
      receivedKeys.push(incoming.headers["x-api-key"]);
      switch (incoming.url) {
        case "/ok":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { id: "installation-fixture" } }));
          return;
        case "/denied":
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        case "/malformed":
          response.writeHead(502, { "content-type": "text/plain" });
          response.end(`upstream failed: ${privateBytes}`);
          return;
        case "/leaked":
          response.end(JSON.stringify({ leaked: secret }));
          return;
        case "/interrupted":
          response.writeHead(200, { "content-length": 10_000 });
          response.write(privateBytes);
          setImmediate(() => response.destroy());
          return;
        default:
          incoming.socket.destroy();
      }
    });
    const port = await listen(t, server);
    const request = createProductionTuiRequest({
      baseURL: `https://localhost:${port}`,
      ca: tls.caBundle,
      serviceKey: () => secret,
      secrets: [secret],
    });
    // These responses prove transport and parsing only; real OCC proves authentication.
    const accepted = await request("GET", "/ok");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { data: { id: "installation-fixture" } });
    const denied = await request("GET", "/denied", undefined, { authenticated: false });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "unauthorized" });
    assert.deepEqual(receivedKeys, [secret, undefined]);
    // A proxy failure must settle the request rather than escape its Promise or hang it.
    for (const [path, message] of [
      ["/malformed", "API response was not valid JSON"],
      ["/leaked", "API response leaked a protected credential"],
      ["/interrupted", "API response was interrupted"],
      ["/disconnected", "API request failed"],
    ] as const) {
      await assert.rejects(request("GET", path), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, message);
        assert.ok(!inspect(error).includes(secret));
        assert.ok(!inspect(error).includes(privateBytes));
        return true;
      });
    }
  },
);

test(
  "timed-out fixture commands reject success and terminate their subprocesses without exposing output",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-timeout-control-"));
    const marker = `protected-${randomUUID()}`;
    const parentPID = join(directory, "parent-pid");
    const descendantPID = join(directory, "descendant-pid");
    const ready = join(directory, "ready");
    const terminated = join(directory, "terminated");
    const heartbeat = join(directory, "heartbeat");
    const script = join(directory, "command.cjs");
    const descendant = `
    const fs = require("node:fs");
    let beats = 0;
    fs.writeFileSync(${JSON.stringify(heartbeat)}, String(beats));
    process.on("SIGTERM", () => {});
    process.send("ready");
    setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++beats)), 100);
  `;
    await writeFile(
      script,
      `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    fs.writeFileSync(${JSON.stringify(parentPID)}, String(process.pid));
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    fs.writeFileSync(${JSON.stringify(descendantPID)}, String(child.pid));
    child.on("message", () => fs.writeFileSync(${JSON.stringify(ready)}, "ready"));
    process.stdout.write(${JSON.stringify(marker)});
    process.stderr.write(${JSON.stringify(marker)});
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(terminated)}, "handled termination");
      process.exit(0);
    });
  `,
    );
    // Always dispose the real descendant, including when running against the buggy helper.
    t.after(async () => {
      try {
        for (const path of [parentPID, descendantPID]) {
          try {
            process.kill(Number(await readFile(path, "utf8")), "SIGKILL");
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
              throw error;
            }
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    await assert.rejects(
      runFixtureCommand(process.execPath, [script], { timeout: 2_000, protectedInput: true }),
      (error: Error) => {
        assert.match(error.message, /timed out during a protected fixture operation/u);
        assert.ok(!inspect(error).includes(marker), "timeout diagnostics exposed protected output");
        return true;
      },
    );
    assert.equal(await readFile(ready, "utf8"), "ready");
    assert.equal(await readFile(terminated, "utf8"), "handled termination");
    // The parent exits zero on SIGTERM, but its descendant ignores termination and
    // would mutate fixture state unless the helper kills the entire owned group.
    const finalHeartbeat = await readFile(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(await readFile(heartbeat, "utf8"), finalHeartbeat);
  },
);

test(
  "interrupted rehearsal runners stop concurrent command groups before exiting",
  { timeout: 45_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-interruption-control-"));
    const runners: import("node:child_process").ChildProcess[] = [];
    const childPIDs: string[] = [];
    const { spawn } = await import("node:child_process");
    t.after(async () => {
      for (const runner of runners) {
        try {
          process.kill(-runner.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      for (const path of childPIDs) {
        try {
          process.kill(-Number(await readFile(path, "utf8")), "SIGKILL");
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw error;
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    for (const mode of ["test", "process", "once", "mixed"] as const) {
      const signals = mode === "mixed" ? (["SIGINT"] as const) : (["SIGINT", "SIGTERM"] as const);
      for (const signal of signals) {
        const fixture = join(directory, `${mode}-${signal}.test.mjs`);
        const markers = [0, 1].map((index) => join(directory, `${mode}-${signal}-${index}-late`));
        const continued = [0, 1].map((index) =>
          join(directory, `${mode}-${signal}-${index}-continued`),
        );
        const ready = [0, 1].map((index) => join(directory, `${mode}-${signal}-${index}-pid`));
        childPIDs.push(...ready);
        const scripts = markers.map(
          (marker, index) => `
      const fs = require("node:fs");
      process.on("SIGINT", () => { ${index === 0 ? "process.exit(0);" : ""} });
      process.on("SIGTERM", () => { ${index === 0 ? "process.exit(0);" : ""} });
      fs.writeFileSync(${JSON.stringify(ready[index])}, String(process.pid));
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "orphaned command"), 1800);
      setInterval(() => {}, 1000);
    `,
        );
        const execution = {
          test: 'test("concurrent real rehearsal commands", run);',
          process: "await run();",
          once: `process.once(${JSON.stringify(signal)}, () => { process.exitCode = 23; });
            await run().catch(() => {});`,
          mixed: 'process.on("SIGINT", () => {}); await run().catch(() => {});',
        }[mode];
        await writeFile(
          fixture,
          `
      import test from "node:test";
      import { writeFileSync } from "node:fs";
      import { runFixtureCommand } from ${JSON.stringify(new URL("../helpers/production-rehearsal-custody.ts", import.meta.url).href)};
      const continued = ${JSON.stringify(continued)};
      const run = () => Promise.all(${JSON.stringify(scripts)}.map((script, index) =>
        runFixtureCommand(process.execPath, ["-e", script], { timeout: 10000 })
          .then(() => writeFileSync(continued[index], "advanced after interruption"))));
      ${execution}
    `,
        );
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const runner = spawn(process.execPath, mode === "test" ? ["--test", fixture] : [fixture], {
          detached: true,
          stdio: "ignore",
          env,
        });
        runners.push(runner);
        const closed = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          runner.once("error", reject);
          runner.once("close", (code, signal) => resolve({ code, signal }));
        });
        const deadline = Date.now() + 5000;
        while (
          !(
            await Promise.all(
              ready.map((path) =>
                stat(path).then(
                  () => true,
                  () => false,
                ),
              ),
            )
          ).every(Boolean)
        ) {
          assert.ok(Date.now() < deadline, "real command processes did not start");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // Deliver the same process-group signal as a terminal interrupt. One command
        // exits zero and the other ignores it; neither may advance the rehearsal.
        process.kill(-runner.pid!, signal);
        if (mode === "mixed") {
          // A second terminating signal must retain its default disposition even
          // while the handled first signal's command cleanup is still running.
          await new Promise((resolve) => setTimeout(resolve, 100));
          process.kill(-runner.pid!, "SIGTERM");
        }
        const result = await closed;
        const expectedExit = {
          test: { code: 1, signal: null },
          process: { code: null, signal },
          once: { code: 23, signal: null },
          mixed: { code: null, signal: "SIGTERM" },
        }[mode];
        assert.deepEqual(result, expectedExit);
        await new Promise((resolve) => setTimeout(resolve, 2200));
        for (const marker of [...markers, ...continued]) {
          await assert.rejects(stat(marker), { code: "ENOENT" });
        }
      }
    }
  },
);

test(
  "interrupted commands close local pipes without killing a separate-session holder",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-held-pipe-control-"));
    const commandPID = join(directory, "command-pid");
    const holderPID = join(directory, "holder-pid");
    const heartbeat = join(directory, "heartbeat");
    const receipt = join(directory, "receipt");
    const fixture = join(directory, "runner.mjs");
    const { spawn } = await import("node:child_process");
    t.after(async () => {
      try {
        if (runner?.pid) {
          try {
            process.kill(-runner.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
        for (const path of [commandPID, holderPID]) {
          try {
            process.kill(-Number(await readFile(path, "utf8")), "SIGKILL");
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
              throw error;
            }
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const holder = `
    const fs = require("node:fs");
    let beats = 0;
    fs.writeFileSync(${JSON.stringify(holderPID)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(heartbeat)}, String(beats));
    setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++beats)), 100);
    setTimeout(() => process.exit(0), 6000);
  `;
    const command = `
    require("node:fs").writeFileSync(${JSON.stringify(commandPID)}, String(process.pid));
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
    await writeFile(
      fixture,
      `
    import { writeFileSync } from "node:fs";
    import { runFixtureCommand } from ${JSON.stringify(new URL("../helpers/production-rehearsal-custody.ts", import.meta.url).href)};
    process.on("SIGTERM", () => {});
    try {
      await runFixtureCommand(process.execPath, ["-e", ${JSON.stringify(command)}], { timeout: 60000 });
      writeFileSync(${JSON.stringify(receipt)}, "unexpected success");
    } catch (error) {
      writeFileSync(${JSON.stringify(receipt)}, error.message);
    }
  `,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn(process.execPath, [fixture], {
      detached: true,
      stdio: "ignore",
      env,
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      runner!.once("error", reject);
      runner!.once("close", (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 5000;
    while (
      !(await stat(heartbeat).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "the separate-session holder did not start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const interruptedAt = Date.now();
    process.kill(-runner.pid!, "SIGTERM");
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.ok(
      Date.now() - interruptedAt < 4000,
      "interruption waited for an unrelated session's output pipe",
    );
    assert.match(await readFile(receipt, "utf8"), /interrupted/u);
    // The helper may close its own pipe ends, but only this test owns the detached
    // holder. A continuing heartbeat proves it was not killed or merely left a zombie.
    const before = Number(await readFile(heartbeat, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(Number(await readFile(heartbeat, "utf8")) > before);
  },
);
