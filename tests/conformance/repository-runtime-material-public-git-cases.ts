import { openShellDriver } from "../integration/sandbox-driver-openshell-fixture.ts";
import { buildSandboxInstallation } from "../integration/sandbox-driver-startup-installation-fixture.ts";
import type { V1Container } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import {
  CoreV1Api,
  createConfiguration,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import type { FixtureSecret } from "./repository-runtime-material-kubernetes-fixture.ts";
import type { Server } from "node:http";
import type { SandboxDriver } from "../../packages/contracts/src/index.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

import {
  PUBLIC_GITHUB_READ_TRANSPORT_FILE,
  PUBLIC_GITHUB_READ_TRANSPORT_ENV,
  PUBLIC_GITHUB_READ_TRANSPORT_SOURCE,
} from "../../apps/controller/src/drivers/repo/github/public-read/runtime-source.ts";
import { KubernetesPublicGithubReadAuthorizationStore } from "../../apps/controller/src/drivers/compute/kubernetes/public-github-read-authorizations.ts";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { admitRevisionHarness } from "../helpers/kubernetes-routed-scenarios.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync, brotliDecompressSync } from "node:zlib";
import { createServer } from "node:http";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { publicReaderTls } from "../helpers/public-github-read-fixture.mjs";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { codexLaunchEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import {
  fixture,
  present,
  codexAppServer,
  recordField,
} from "./repository-runtime-material-fixture.ts";
import {
  publicReader,
  publicReaderPolicies,
} from "./repository-runtime-material-public-reader-fixture.ts";

test("public Git read admission freezes the authored Agent scope and exact service before normalization", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  const reader = present(f.ports.options.network.publicGithubRead);
  Object.assign(reader, {
    authorizationConfigMapName: "public-github-authorizations",
    caBundle: "public-ca",
  });
  const source = structuredClone(f.revision.configuration);
  const input = {
    installationId: "installation-test",
    configuration: source,
    harness: f.revision.harness,
  };
  assert.deepEqual(
    f.driver.admitServiceAccess(input),
    [],
    "enabling the service grants no Agent access",
  );
  publicConfig(source).publicGithubRead = {
    mode: "repositories",
    repositories: ["Example/Project", "example/project"],
  };
  const selected = f.driver.admitServiceAccess(input);
  assert.deepEqual(selected, [
    {
      id: "public-github-read",
      driverId: f.driver.id,
      implementation: f.driver.implementation,
      endpoint: `https://${reader.address}:8080`,
      configuration: {
        policy: { mode: "repositories", repositories: ["example/project"] },
        peer: { namespace: reader.namespace, podLabels: reader.podLabels },
        installationId: "installation-test",
        authorizationConfigMapName: "public-github-authorizations",
        caBundle: "public-ca",
      },
    },
  ]);
  recordField(publicConfig(source), "publicGithubRead").repositories = [];
  assert.deepEqual(f.driver.admitServiceAccess(input), []);
  publicConfig(source).publicGithubRead = { mode: "all" };
  codexAppServer(source).networkProxy = {
    enabled: true,
    domains: { [reader.address]: "deny" },
  };
  assert.deepEqual(
    f.driver.admitServiceAccess(input),
    [],
    "a native deny cannot become a service grant",
  );
  assert.deepEqual(
    f.driver.admitServiceAccess({ ...input, harness: { ...input.harness, mode: "embedded" } }),
    [],
  );
});

test("admitted public Git runtime carries only nonsecret configuration and a distinct launcher", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  const originalLauncher = codexLaunchEntrypoint(f.ports.codexLaunch(f.revision, undefined));
  Object.assign(present(f.ports.options.network.publicGithubRead), {
    authorizationConfigMapName: "public-github-authorizations",
    caBundle: "public-ca",
  });
  publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
  Object.assign(present(f.ports.options.runtime), {
    modelProvider: {
      protocol: "openai-responses",
      baseUrl: "https://models.example.test/v1",
    },
  });
  const services = f.driver.admitServiceAccess({
    installationId: "installation-test",
    configuration: f.revision.configuration,
    harness: f.revision.harness,
  });
  f.revision.compute.serviceAccess = services;
  admitRevisionHarness(f.driver, f.revision);
  assert.match(
    present(f.revision.compute.admission),
    /^model-provider:v1:[a-f0-9]{64}:public-github-read:/,
  );
  const snapshot = present(f.ports.pluginRuntimeSnapshot(f.revision));
  assert.equal(snapshot.runtime.kind, "codex");
  assert.ok(snapshot.runtime.kind === "codex");
  assert.equal(
    present(snapshot.runtime.publicGithubRead).endpoint,
    `https://${publicReader.address}:8080`,
  );
  assert.notEqual(
    codexLaunchEntrypoint(f.ports.codexLaunch(f.revision, undefined)),
    originalLauncher,
    "new service access requires a separately admitted launcher",
  );
  assert.equal(present(snapshot.runtime.modelEndpoint).baseUrl, "https://models.example.test/v1");
  const files = f.ports.sandboxWorkloadFiles(snapshot);
  const config = JSON.parse(
    present(files.find(({ name }) => name === "public-github-read.json")).content,
  );
  assert.deepEqual(config, {
    endpoint: `https://${publicReader.address}:8080`,
    caBundle: "public-ca",
    authenticatedRepositories: [],
  });
  assert.ok(files.some(({ name }) => name === "public-github-read.md"));
  // The Gateway translates independently of the Harness that generates these
  // children; both must agree on the narrow native read-only parent.
  const translated = await runOpenClawRuntimeHelper({ manifest: snapshot.runtime }, [], {
    baseConfig: f.revision.configuration,
  });
  const native = JSON.parse(translated.files.get("/home/node/.openclaw/openclaw.json"));
  const paths = native.plugins.entries.codex.config.appServer.networkProxy.readOnlyPaths;
  assert.ok(paths.includes("/home/node/.oce-public-git"));
  assert.ok(!paths.includes("/tmp") && !paths.includes("/home/node"));
  const source = present(files.find(({ name }) => name === PUBLIC_GITHUB_READ_TRANSPORT_FILE));
  assert.equal(source.content, PUBLIC_GITHUB_READ_TRANSPORT_SOURCE);
  // The static helper names its capability input; only its exact reviewed source
  // is allowed alongside the data projections, which carry no credential.
  assert.equal(
    JSON.stringify(files.filter((file) => file !== source)).includes("capability"),
    false,
    "the public runtime data projection must contain no service credential",
  );
  // Persisted JSON documents preserve values, not object property insertion order.
  const rehydrated = JSON.parse(JSON.stringify(f.revision), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.deepEqual(f.ports.pluginRuntimeSnapshot(rehydrated), snapshot);
  // Provider and public-service facts have separate authority. A preserved provider
  // cannot authorize altered service scope; a preserved service cannot authorize a
  // changed provider. Both refusals precede credential delivery or workload writes.
  const alteredService = structuredClone(f.revision);
  Object.assign(present(present(alteredService.compute.serviceAccess)[0]).configuration, {
    policy: {
      mode: "repositories",
      repositories: ["example/other"],
    },
  });
  assert.throws(() => f.ports.pluginRuntimeSnapshot(alteredService), /no exact Compute admission/);
  const before = structuredClone(f.calls);
  const alteredProvider = structuredClone(f.revision);
  recordField(alteredProvider.harness.configuration, "modelProvider").baseUrl =
    "https://changed.example.test/v1";
  assert.throws(
    () => f.ports.validateRevisionExecution(alteredProvider, f.context()),
    /saved model provider does not match/,
  );
  assert.deepEqual(f.calls, before);
});

for (const operation of ["stopRevision", "retireRevision"] as const) {
  test(`${operation} fences the owned runtime even when the public authorization registry is unavailable`, async () => {
    const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
    delete f.revision.repositoryCredentials;
    codexAppServer(f.revision.configuration).networkProxy = {
      enabled: true,
      domains: { [publicReader.address]: "allow" },
    };
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
    await f.driver.prepareRevision(f.revision, f.context());
    assert.equal(publicReaderPolicies(f).length, 1);
    assert.ok(f.deployments().some((deployment) => deployment.metadata.name.startsWith("agent-")));
    // Resume the owned runtime with its service admission, after its external
    // authorization registry has disappeared. Shutdown must still fence it.
    Object.assign(present(f.ports.options.network.publicGithubRead), {
      authorizationConfigMapName: "unavailable-authorizations",
      caBundle: "public-ca",
    });
    publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
    f.revision.compute.serviceAccess = f.driver.admitServiceAccess({
      installationId: "installation-test",
      configuration: f.revision.configuration,
      harness: f.revision.harness,
    });
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
    await assert.rejects(f.driver[operation](f.revision), /404|authorization|registry/);
    assert.equal(
      f.deployments().filter((deployment) => deployment.metadata.name.startsWith("agent-")).length,
      0,
    );
    assert.equal(
      publicReaderPolicies(f).length,
      0,
      "fenced service must retire its owned reader policy",
    );
  });
}

test("service maintenance fences the owned runtime when its admitted reader peer changes", async () => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: { ...publicReader } });
  delete f.revision.repositoryCredentials;
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
  await f.driver.prepareRevision(f.revision, f.context());
  assert.equal(publicReaderPolicies(f).length, 1);
  Object.assign(present(f.ports.options.network.publicGithubRead), {
    authorizationConfigMapName: "unavailable-authorizations",
    caBundle: "public-ca",
  });
  publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
  f.revision.compute.serviceAccess = f.driver.admitServiceAccess({
    installationId: "installation-test",
    configuration: f.revision.configuration,
    harness: f.revision.harness,
  });
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
  Object.assign(present(f.ports.options.network.publicGithubRead), { address: "10.43.0.249" });
  await assert.rejects(
    f.driver.maintainServiceAccess(f.revision, new AbortController().signal),
    /404|reader|registry/,
  );
  assert.equal(
    f.deployments().filter((deployment) => deployment.metadata.name.startsWith("agent-")).length,
    0,
  );
  assert.equal(
    publicReaderPolicies(f).length,
    0,
    "withdrawn peer must retire its owned reader policy",
  );
});

test("reader service maintenance enforces the frozen runtime identity at registry ownership boundaries", async () => {
  const installationId = "ins_runtime_owner";
  const reader = {
    ...publicReader,
    authorizationConfigMapName: "authorizations",
    caBundle: "public-ca",
  };
  const f = await fixture("dedicated", undefined, { publicGithubRead: reader });
  publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
  f.revision.compute.serviceAccess = f.driver.admitServiceAccess({
    installationId,
    configuration: f.revision.configuration,
    harness: f.revision.harness,
  });
  assert.equal(f.revision.compute.serviceAccess.length, 1);
  f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
  const registry = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "authorizations",
      namespace: reader.namespace,
      resourceVersion: "1",
      labels: {
        "openclaw.dev/public-read-installation": createHash("sha256")
          .update("ins_foreign")
          .digest("hex")
          .slice(0, 32),
      },
    },
    data: { "authorizations.json": "{}\n" },
  };
  f.save(registry);
  // The real Compute maintenance path constructs its store from frozen runtime context.
  // A controlled Kubernetes API boundary suffices: both refusals precede HTTPS observation.
  await assert.rejects(
    f.driver.maintainServiceAccess(f.revision, new AbortController().signal),
    /registry is unavailable or foreign/,
  );
  registry.metadata.labels["openclaw.dev/public-read-installation"] = createHash("sha256")
    .update(installationId)
    .digest("hex")
    .slice(0, 32);
  registry.data["authorizations.json"] = JSON.stringify({
    [f.revision.id]: {
      installationId: "ins_foreign",
      namespaceId: f.revision.namespaceId,
      agentId: f.revision.agentId,
      revisionId: f.revision.id,
      tokenSha256: "a".repeat(64),
      policy: { mode: "all" },
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  f.save(registry);
  await assert.rejects(
    f.driver.maintainServiceAccess(f.revision, new AbortController().signal),
    /belongs to a different Agent/,
  );
  assert.equal(
    f.calls.filter(({ operation, kind }) => operation === "write" && kind === "ConfigMap").length,
    0,
  );
});

test("capability retirement refuses foreign or concurrently changed Secrets and never creates one", async (t) => {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  const installationId = "installation-test";
  f.save({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "authorizations",
      namespace: publicReader.namespace,
      resourceVersion: "1",
      labels: {
        "openclaw.dev/public-read-installation": createHash("sha256")
          .update(installationId)
          .digest("hex")
          .slice(0, 32),
      },
    },
    data: { "authorizations.json": "{}\n" },
  });
  const core = Object.assign(new CoreV1Api(createConfiguration()), f.clients.core);
  const store = new KubernetesPublicGithubReadAuthorizationStore({
    core,
    namespace: publicReader.namespace,
    configMapName: "authorizations",
    installationId,
    driverId: f.driver.id,
  });
  await store.prepare(f.revision, f.namespace, { mode: "all" });
  const key = `Secret:${f.namespace}:${store.secretName(f.revision)}`;
  const observedSecret = f.objects.get(key);
  assert.ok(observedSecret?.kind === "Secret" && observedSecret.data);
  const original: FixtureSecret = {
    ...structuredClone(observedSecret),
    kind: "Secret",
    data: structuredClone(observedSecret.data),
  };
  await store.withdraw(f.revision);
  const corruptions: [string, (s: FixtureSecret) => void][] = [
    [
      "managed owner",
      (s: FixtureSecret) => {
        present(s.metadata.labels)["app.kubernetes.io/managed-by"] = "foreign";
      },
    ],
    ...["namespace", "agent", "revision", "public-read-driver"].map(
      (field): [string, (s: FixtureSecret) => void] => [
        field,
        (s: FixtureSecret) => {
          present(s.metadata.labels)[`openclaw.dev/${field}`] = "foreign";
        },
      ],
    ),
    [
      "UID",
      (s: FixtureSecret) => {
        delete s.metadata.uid;
      },
    ],
    [
      "version",
      (s: FixtureSecret) => {
        delete s.metadata.resourceVersion;
      },
    ],
    [
      "deleting",
      (s: FixtureSecret) => {
        s.metadata.deletionTimestamp = new Date().toISOString();
      },
    ],
    [
      "mutable",
      (s: FixtureSecret) => {
        s.immutable = false;
      },
    ],
    [
      "type",
      (s: FixtureSecret) => {
        s.type = "kubernetes.io/tls";
      },
    ],
    [
      "extra material",
      (s: FixtureSecret) => {
        s.data.other = "Zm9yZWlnbg==";
      },
    ],
    [
      "foreign capability",
      (s: FixtureSecret) => {
        s.data.capability = Buffer.from(
          "foreign." + Buffer.alloc(32, 1).toString("base64url"),
        ).toString("base64");
      },
    ],
    [
      "malformed capability",
      (s: FixtureSecret) => {
        s.data.capability += "=";
      },
    ],
  ];
  for (const [label, corrupt] of corruptions) {
    await t.test(label, async () => {
      const changed = structuredClone(original);
      corrupt(changed);
      f.objects.set(key, changed);
      await assert.rejects(store.retireCapability(f.revision, f.namespace), /capability.*invalid/);
      assert.deepEqual(f.objects.get(key), changed);
    });
  }
  f.objects.set(key, structuredClone(original));
  const remove = core.deleteNamespacedSecret;
  core.deleteNamespacedSecret = async (request) => {
    assert.deepEqual(request.body?.preconditions, {
      uid: original.metadata.uid,
      resourceVersion: original.metadata.resourceVersion,
    });
    present(f.objects.get(key)).metadata.resourceVersion = "concurrent-version";
    return remove(request);
  };
  await assert.rejects(store.retireCapability(f.revision, f.namespace), /409/);
  assert.ok(f.objects.has(key), "a changed Secret must survive stale deletion");
  core.deleteNamespacedSecret = remove;
  await store.retireCapability(f.revision, f.namespace);
  const writes = f.calls.filter((call) => call.operation === "write").length;
  await store.retireCapability(f.revision, f.namespace);
  assert.equal(f.objects.has(key), false);
  assert.equal(
    f.calls.filter((call) => call.operation === "write").length,
    writes,
    "missing capability retirement must not create or publish material",
  );
});

// Real Compute and reader/store lifecycle. Only Kubernetes transport is controlled;
// the selected reader uses its fixed production port and a trusted loopback leaf.
test(
  "permanent reader retirement removes its capability only after workload fencing and reader acknowledgement",
  { timeout: 30_000 },
  async (t) => {
    const tls = await publicReaderTls("127.0.0.1");
    const reader = {
      ...publicReader,
      address: "127.0.0.1",
      authorizationConfigMapName: "authorizations",
      caBundle: tls.ca,
    };
    const f = await fixture("dedicated", undefined, { publicGithubRead: reader });
    delete f.revision.repositoryCredentials;
    publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
    f.revision.compute.serviceAccess = f.driver.admitServiceAccess({
      installationId: "installation-test",
      configuration: f.revision.configuration,
      harness: f.revision.harness,
    });
    assert.equal(f.revision.compute.serviceAccess.length, 1);
    f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
    f.save({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "authorizations",
        namespace: reader.namespace,
        resourceVersion: "1",
        labels: {
          "openclaw.dev/public-read-installation": createHash("sha256")
            .update("installation-test")
            .digest("hex")
            .slice(0, 32),
        },
      },
      data: { "authorizations.json": "{}\n" },
    });
    const registry = () =>
      JSON.parse(
        present(
          present(f.objects.get(`ConfigMap:${reader.namespace}:authorizations`)).data?.[
            "authorizations.json"
          ],
        ),
      );
    let heldProjection: ReturnType<typeof registry> | undefined;
    const server = createPublicGithubReadServer({
      tls: { cert: tls.cert, key: tls.key },
      policy: { mode: "all" },
      loadAuthorizations: () => heldProjection ?? registry(),
    });
    await listen(t, server, "127.0.0.1", { port: 8080 });
    const store = new KubernetesPublicGithubReadAuthorizationStore({
      core: Object.assign(new CoreV1Api(createConfiguration()), f.clients.core),
      namespace: reader.namespace,
      configMapName: "authorizations",
      installationId: "installation-test",
      driverId: f.driver.id,
    });
    const secretKey = `Secret:${f.namespace}:${store.secretName(f.revision)}`;
    await f.driver.prepareRevision(f.revision, f.context());
    assert.equal(publicReaderPolicies(f).length, 1);
    const original = structuredClone(f.objects.get(secretKey));
    assert.ok(original?.metadata.uid);
    // Stop suspends the same immutable capability so ordinary resume remains possible.
    await f.driver.stopRevision(f.revision);
    assert.deepEqual(f.objects.get(secretKey), original);
    await f.driver.prepareRevision(f.revision, f.context());
    assert.deepEqual(f.objects.get(secretKey), original);
    assert.ok(f.deployments().some((d) => d.metadata.name.startsWith("agent-")));
    heldProjection = registry();
    let observedWithdrawal = () => {};
    const observed = new Promise<void>((resolve) => {
      observedWithdrawal = resolve;
    });
    server.on("request", (request) => {
      const current = registry()[f.revision.id];
      if (
        request.url?.startsWith("/healthz?revision=") &&
        (current === undefined || current.withdrawn)
      ) {
        observedWithdrawal();
      }
    });
    const retired = f.driver.retireRevision(f.revision);
    await Promise.race([
      observed,
      retired.then(() => assert.fail("retirement completed before acknowledgement")),
    ]);
    assert.equal(f.deployments().filter((d) => d.metadata.name.startsWith("agent-")).length, 0);
    assert.equal(publicReaderPolicies(f).length, 0);
    assert.deepEqual(
      f.objects.get(secretKey),
      original,
      "an unacknowledged registry projection cannot delete the capability",
    );
    heldProjection = undefined;
    await retired;
    assert.equal(
      f.objects.has(secretKey),
      false,
      "permanent retirement must remove its capability Secret",
    );
    await f.driver.retireRevision(f.revision);
    assert.equal(f.objects.has(secretKey), false, "retirement retry must not create a capability");
  },
);

// A public-reader wrapper must not restore transport-open readiness on a Compute
// Pod. Run the selected rendered program through real material installation and
// its resident readiness callback; the peer substitutes only Codex's RPC server.
// This does not run native Codex, a model, or a Kubernetes workload.
test("public Git Harness ownership preserves material delivery and Codex initialization readiness", async (t) => {
  const execute = promisify(execFile);
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
  const {
    WebSocketServer,
  }: {
    WebSocketServer: new (options: { server: Server }) => {
      close(): void;
      on(
        event: "connection",
        listener: (socket: {
          on(event: "message", listener: (data: { toString(): string }) => void): void;
          send(data: string): void;
        }) => void,
      ): void;
    };
  } = socketRequire("ws");
  const tls = await publicReaderTls("127.0.0.1");
  for (const providerOwned of [false, true]) {
    for (const protectedReader of [false, true]) {
      await t.test(
        `${providerOwned ? "provider" : "Compute"} ${protectedReader ? "protected" : "ordinary"}`,
        async (t) => {
          const policyConfiguration = buildSandboxInstallation().drivers.sandbox.configuration;
          const policyOwner = protectedReader
            ? openShellDriver({}, policyConfiguration)
            : undefined;
          const protectedOwner =
            policyOwner === undefined
              ? undefined
              : new InstalledDriver(
                  {
                    id: policyOwner.id,
                    implementation: policyOwner.implementation,
                    configuration: policyConfiguration,
                  },
                  { capabilities: { sandbox: policyOwner } },
                );
          const sandboxDriver: SandboxDriver | undefined = providerOwned
            ? {
                id: protectedOwner?.ref.id ?? "public-reader-provider",
                implementation: protectedOwner?.ref.implementation ?? "public-reader-provider",
                capability: "sandbox",
                facets: ["networking", "filesystem", "process"],
                supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
                provisionHarness() {
                  throw new Error("This rendering check must not provision a Sandbox.");
                },
                async cleanup() {
                  throw new Error("This rendering check must not clean up a Sandbox.");
                },
              }
            : undefined;
          const f = await fixture("dedicated", undefined, {
            publicGithubRead: {
              ...publicReader,
              authorizationConfigMapName: "public-github-authorizations",
              caBundle: tls.ca,
            },
            ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
          });
          delete f.revision.repositoryCredentials;
          if (providerOwned) {
            f.revision.sandboxDriverId = present(sandboxDriver).id;
          }
          if (protectedReader) {
            const owner = present(protectedOwner);
            f.revision.executionAdmission = { version: 3, mode: "protected" };
            f.revision.egressPlan = {
              id: "public-reader-plan",
              generation: 1,
              driver: owner.ref,
              sandboxDriverId: owner.ref.id,
              egressDriverId: owner.ref.id,
              execution: {
                installationId: "installation-test",
                namespaceId: f.revision.namespaceId,
                agentId: f.revision.agentId,
                servicePrincipalId: f.revision.servicePrincipalId,
                revisionId: f.revision.id,
                executionId: "public-reader-execution",
              },
              routes: [],
            };
          }
          publicConfig(f.revision.configuration).publicGithubRead = { mode: "all" };
          f.revision.compute.serviceAccess = f.driver.admitServiceAccess({
            installationId: "installation-test",
            configuration: f.revision.configuration,
            harness: f.revision.harness,
          });
          if (protectedReader) {
            // Render the exact acknowledgement returned by the selected policy owner;
            // this fixture does not exercise a live OpenShell installation.
            f.revision.sandboxPolicy = present(policyOwner).admitProtectedNetworkPolicy(
              1,
              f.revision.compute.serviceAccess,
            ).snapshot;
          }
          f.revision.compute.admission = present(f.driver.admitRevision(f.revision));
          const snapshot = present(f.ports.pluginRuntimeSnapshot(f.revision));
          assert.equal(snapshot.runtime.kind, "codex");
          assert.ok(snapshot.runtime.kind === "codex");
          assert.equal(f.ports.codexLaunch(f.revision, sandboxDriver).protected, protectedReader);
          const ownership = f.ports.pluginRuntimeOwnership(f.revision);
          const deploymentFor = (withNode: boolean) =>
            f.ports.deployment(
              "public-reader-harness",
              ownership,
              { name: f.namespace, plane: "execution" },
              "agent:local",
              "agent",
              "agent",
              {},
              "info",
              undefined,
              false,
              undefined,
              f.ports.harnessAuthForRevision(f.revision, f.context(), {
                name: f.namespace,
                plane: "execution",
              }),
              [],
              [],
              snapshot,
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              { ...f.ports.codexLaunch(f.revision, sandboxDriver), withNode },
            );
          const deployment = deploymentFor(false);
          const spec = deployment.spec.template.spec;
          const container = spec.containers[0];
          const capabilityVolume = spec.volumes.find(
            ({ name }) => name === "public-github-capability",
          );
          assert.equal(Boolean(capabilityVolume), !providerOwned);
          const environment = Object.fromEntries(
            container.env.map(({ name, value }) => [name, value]),
          );
          assert.equal(
            environment.OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE,
            providerOwned ? undefined : "/run/oce/public-github-read/capability",
          );
          if (capabilityVolume) {
            assert.ok(capabilityVolume.secret);
            assert.equal(
              capabilityVolume.secret.secretName,
              "public-github-read-" +
                createHash("sha256").update(f.revision.id).digest("hex").slice(0, 24),
            );
            assert.equal(capabilityVolume.secret.optional, false);
          }
          const directory = await temporaryDirectory(t, "public-read-readiness-");
          const files = f.ports.sandboxWorkloadFiles(snapshot);
          const material = present(files.find(({ name }) => name === "public-github-read.json"));
          const materialPath = join(directory, material.name);
          await writeFile(materialPath, material.content);
          const source = present(
            files.find(({ name }) => name === PUBLIC_GITHUB_READ_TRANSPORT_FILE),
          );
          const sourcePath = join(directory, source.name);
          await writeFile(sourcePath, source.content);
          assert.equal(
            environment[PUBLIC_GITHUB_READ_TRANSPORT_ENV],
            "/etc/openclaw/plugin-runtime/" + source.name,
          );
          const projected = present(
            present(
              present(spec.volumes.find(({ name }) => name === "openclaw-plugin-runtime"))
                .configMap,
            ).items,
          );
          assert.ok(projected.some(({ key, path }) => key === source.name && path === source.name));
          const capability = providerOwned
            ? "openshell:resolve:env:s" + "a".repeat(64) + "_OCE_PUBLIC_GITHUB_READ_CAPABILITY"
            : "revision-test." + Buffer.alloc(32, 4).toString("base64url");
          const capabilityPath = join(directory, "capability");
          await writeFile(capabilityPath, capability, { mode: 0o600 });
          const server = createServer();
          const peer = new WebSocketServer({ server });
          t.after(() => peer.close());
          const port = await listen(t, server);
          let accepted = false;
          const requests: string[] = [];
          peer.on("connection", (socket) => {
            socket.on("message", (data) => {
              const request = JSON.parse(data.toString());
              requests.push(request.method);
              socket.send(
                JSON.stringify(
                  accepted
                    ? { id: request.id, result: { userAgent: "controlled-codex/1" } }
                    : { id: request.id, error: { code: -32600, message: "private-error-canary" } },
                ),
              );
            });
          });
          const program = (container: V1Container) => {
            assert.ok(container.args);
            assert.ok(container.args.every((argument) => Buffer.byteLength(argument) < 131072));
            return inflateRawSync(Buffer.from(container.args.slice(1).join(""), "base64")).toString(
              "utf8",
            );
          };
          const commandBudget = (kind: string, container: V1Container) => {
            assert.ok(container.args && container.command);
            const command = [...container.command, ...container.args];
            const bytes = Buffer.byteLength(JSON.stringify(command));
            assert.ok(bytes <= 65_536, `rendered ${kind} command is ${bytes} bytes`);
            assert.ok(command.every((argument) => Buffer.byteLength(argument) < 131072));
            t.diagnostic(
              `${providerOwned ? "provider" : "Compute"} ${protectedReader ? "protected" : "ordinary"} ${kind}: ${bytes} bytes`,
            );
          };
          commandBudget("standalone", container);
          const plain = program(container);
          const workspaceDeployment = deploymentFor(true);
          f.ports.addWorkspaceNode(
            workspaceDeployment,
            "workspace-node",
            undefined,
            f.revision,
            true,
          );
          const workspaceContainer = workspaceDeployment.spec.template.spec.containers[0];
          commandBudget("workspace", workspaceContainer);
          const workspace = program(workspaceContainer);
          const codexMatch = workspace.match(/name: "Codex",\s+args: (\[[^\n]*\])/);
          assert.ok(codexMatch);
          const codexArgs: string[] = JSON.parse(present(codexMatch[1]));
          assert.ok(codexArgs.every((argument) => Buffer.byteLength(argument) < 131072));
          const decompress = present(codexArgs[1]).includes("brotliDecompressSync")
            ? brotliDecompressSync
            : inflateRawSync;
          const workspaceChild = decompress(
            Buffer.from(codexArgs.slice(2).join(""), "base64"),
          ).toString("utf8");
          for (const [kind, selected] of [
            ["plain", plain],
            ["workspace", workspaceChild],
          ] as const) {
            const insertion = selected.indexOf('const pluginRuntime = readPluginRuntime("codex");');
            assert.ok(insertion >= 0);
            const end = selected.indexOf("if (pluginRuntime !== undefined) {", insertion);
            assert.ok(end > insertion);
            // Stop before login/model/plugin execution, retaining the selected
            // launcher's actual authentication validation and public material setup.
            const component =
              selected.slice(0, end) +
              `
agentRuntimeReady().then((ready) => console.log(JSON.stringify({
  ready,
  configuration: process.env.OCE_PUBLIC_GITHUB_READ_CONFIG,
  capability: process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY,
}))).catch(() => process.exit(1));`;
            const componentPath = join(directory, kind + ".cjs");
            await writeFile(componentPath, component);
            for (accepted of [false, true]) {
              requests.length = 0;
              const home = join(directory, kind + "-" + accepted);
              await mkdir(home, { mode: 0o700 });
              const result: { stdout: string; stderr: string } = await execute(
                process.execPath,
                [componentPath],
                {
                  timeout: 5000,
                  maxBuffer: 65536,
                  env: {
                    PATH: process.env.PATH,
                    NODE_PATH: dirname(dirname(socketRequire.resolve("ws"))),
                    HOME: home,
                    CODEX_HOME: join(home, ".codex"),
                    CODEX_LOGIN_MODE: "api_key",
                    OPENAI_API_KEY: "synthetic-model-key",
                    APP_SERVER_TOKEN: "synthetic-transport-token",
                    APP_SERVER_PORT: String(port),
                    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: snapshot.runtime }),
                    OCE_PUBLIC_GITHUB_READ_MATERIAL_FILE: materialPath,
                    [PUBLIC_GITHUB_READ_TRANSPORT_ENV]: sourcePath,
                    ...(providerOwned
                      ? { OCE_PUBLIC_GITHUB_READ_CAPABILITY: capability }
                      : { OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE: capabilityPath }),
                  },
                },
              );
              const observed = JSON.parse(result.stdout);
              assert.equal(
                observed.ready,
                providerOwned || accepted,
                kind + ": initialize rejection must withhold Compute readiness",
              );
              assert.deepEqual(requests, providerOwned ? [] : ["initialize"]);
              assert.equal(observed.capability, capability);
              assert.ok(observed.configuration.startsWith(join(home, ".oce-public-git") + "/"));
              const configured = await readFile(observed.configuration, "utf8");
              assert.equal(JSON.parse(configured).endpoint, JSON.parse(material.content).endpoint);
              assert.ok(!configured.includes(capability));
              assert.ok(
                !result.stdout.includes("private-error-canary") &&
                  !result.stderr.includes("private-error-canary"),
              );
            }
          }
        },
      );
    }
  }
});

function publicConfig(configuration: Readonly<Record<string, unknown>>) {
  return recordField(
    recordField(recordField(recordField(configuration, "plugins"), "entries"), "codex"),
    "config",
  );
}
