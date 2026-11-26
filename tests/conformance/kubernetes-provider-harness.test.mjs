import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reservePort, reservedPortArgs } from "../helpers/available-port.ts";
import { waitFor } from "../helpers/qa-wait.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { listen } from "../helpers/listen.ts";
import { credentialFreeMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_HELPER,
  HARNESS_EGRESS_ENROLLMENT_PATH,
} from "../../apps/controller/src/drivers/compute/harness-egress-enrollment.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { strandsBoxResources } from "../../apps/controller/src/drivers/sandbox/strands-box-resources.ts";
import { StrandsBoxSandboxDriver } from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import test from "node:test";
import {
  checkProviderEndpointRequirements,
  checkProviderExactPeers,
  checkProviderInvalidEvidence,
  checkProviderLegacyPolicyActivation,
  checkProviderMalformedActivation,
  checkProviderPreparationStatus,
  heldFailure,
  invalidProviderEvidence,
  statusScenarios,
  transportScenarios,
  withoutCause,
} from "./kubernetes-provider-observation-cases.ts";
import { containerProgram } from "./kubernetes-workload-program-cases.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  InstalledDriver,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { tenant, authContext, digest } from "../helpers/kubernetes-routed-scenarios.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const providerUrl = "ws://tenant--sandbox.openshell.localhost:8080/";
const providerWorkspaceRoot = "/sandbox/enterprise";
const expectedRevision = ({ revision }) => ({
  namespaceId: tenant.id,
  agentId: revision.agentId,
  revisionId: revision.id,
});

// Advance only the prerequisite Gateway. Each scenario gets fresh API and Sandbox state.
async function endpointWithGateway(fixture = providerEndpointFixture(), context) {
  await fixture.prepare(undefined, context);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  return fixture;
}

async function preparedEndpoint(fixture = providerEndpointFixture(), context) {
  await endpointWithGateway(fixture, context);
  fixture.observePods([fixture.pod("ready")]);
  assert.deepEqual(await fixture.prepare(undefined, context), {
    ...expectedRevision(fixture),
    ready: true,
  });
  return fixture;
}

test("the Box provisioner receives the private hook launcher and requires namespace proof during workspace setup", async () => {
  const fixture = providerEndpointFixture();
  const options = {
    kubernetes: {
      seccompProfile: "strands.json",
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      controlPlanePeer: { namespace: "controller", podLabels: { app: "controller" } },
    },
    policy: { network: { endpoints: [] } },
  };
  const box = new StrandsBoxSandboxDriver(options, {
    id: fixture.sandbox.id,
    authentication: { mode: "inCluster" },
    dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
    routing: fixture.driver.options.gatewayRouting,
  });
  fixture.sandbox.implementation = box.implementation;
  fixture.sandbox.harnessHome = box.harnessHome;
  fixture.sandbox.validateWorkspaceSetup = box.validateWorkspaceSetup.bind(box);
  fixture.revision.compute.admission = fixture.driver.admitRevision(fixture.revision);
  await preparedEndpoint(fixture, {
    ...authContext(fixture.revision),
    workspaceSetup: {
      id: "box-workspace-setup",
      namespaceId: fixture.revision.namespaceId,
      agentId: fixture.revision.agentId,
      files: { "USER.md": "Initial Box workspace file" },
      completed: false,
    },
  });
  const context = fixture.provisions.at(-1);
  const { command, labels } = context.requirements;
  const evaluation = command.lastIndexOf("-e");
  assert.ok(evaluation >= 0);
  const launcher = containerProgram({ args: command.slice(evaluation + 1) });
  assert.match(launcher, /Native hook storage must be private/u);
  // The Box renderer consumes the setup requirement emitted by Compute.
  const workload = strandsBoxResources(
    context,
    options,
    "box-fixture",
    labels,
    "workload-hash",
    digest("test-transport", 64),
    { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
    undefined,
    [],
  ).find(({ kind }) => kind === "Deployment");
  const initializer = workload.spec.template.spec.initContainers.find(
    ({ name }) => name === "initialize-workspace",
  );
  assert.deepEqual(
    initializer.env.filter(({ name }) => name === "OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF"),
    [{ name: "OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF", value: "1" }],
  );
});

for (const implementation of ["openshell", "strands-box"]) {
  test(
    implementation + " bootstraps the first Gateway with managed plugins and requests node setup",
    async () => {
      const fixture = providerEndpointFixture({
        revisionOverrides: {
          plugins: {
            driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
            plugins: { "codex-plugin:linear@openai-curated-remote": { enabled: true } },
          },
        },
      });
      fixture.sandbox.implementation = implementation;
      fixture.revision.compute.admission = fixture.driver.admitRevision(fixture.revision);
      const {
        driver,
        revision,
        read,
        gatewayName,
        gatewayNamespace,
        provisions,
        endpoints,
        setupRequests,
      } = fixture;
      const expected = expectedRevision(fixture);
      // The Agent Gateway must be available to mint node setup material. Its first
      // fail-closed template cannot justify creating the provider-owned Harness.
      fixture.observePods([]);
      assert.deepEqual(await fixture.prepare(), {
        ...expected,
        ready: false,
      });
      assert.equal(provisions.length, 0);
      assert.equal(endpoints.length, 0);
      const bootstrapGateway = read("Deployment", gatewayName, gatewayNamespace);
      assert.ok(bootstrapGateway);
      // This Gateway must issue the setup needed to create the Harness. Waiting for
      // the Harness's ordinary peer status here would deadlock first deployment.
      const gatewayEnvironment = bootstrapGateway.spec.template.spec.containers[0].env;
      assert.equal(
        gatewayEnvironment.find(({ name }) => name === "OPENCLAW_CODEX_PLUGINS_PREPARED")?.value,
        "true",
      );
      assert.equal(
        gatewayEnvironment.some(({ name }) => name === "OPENCLAW_PLUGIN_STATUS_PORT"),
        false,
      );
      assert.notEqual(
        bootstrapGateway.spec.template.spec.containers[0].env.find(
          ({ name }) => name === "APP_SERVER_URL",
        ).value,
        providerUrl,
      );

      // Once the Gateway is serving, its Agent-owned setup Secret lets Compute
      // render the final provider request and transition to the OpenShell endpoint.
      fixture.setGatewayServing();
      fixture.observePods([]);
      assert.deepEqual(await fixture.prepare(), {
        ...expected,
        ready: false,
      });
      assert.deepEqual(setupRequests, [
        {
          url: driver.getGatewayEndpoint(revision),
          // The node needs the scoped TLS route for HTTP transfers and proxy attribution.
          nodeUrl: `wss://agents.example.internal/namespaces/${revision.namespaceId}/agents/${revision.agentId}/node`,
        },
      ]);
      assert.equal(provisions.length, 1);
      assert.equal(endpoints.length, 1);
      assert.equal(
        provisions[0].requirements.environment.some(
          ({ name }) => name === "OPENCLAW_PLUGIN_STATUS_PORT",
        ),
        false,
      );
    },
  );
}

test("provider Harness endpoint preparation re-observes the same revision across Pod transitions", async (t) => {
  const fixture = await endpointWithGateway();
  const starting = fixture.pod("starting", "False");
  const ready = fixture.pod("ready");
  const stages = [
    { name: "starting Pod is not ready", pods: [starting], ready: false },
    { name: "ambiguous Pods are not ready", pods: [ready, starting], ready: false },
    { name: "unique ready Pod becomes ready", pods: [ready], ready: true },
    {
      name: "maintenance observes a Ready Pod returning to Starting",
      pods: [starting],
      ready: false,
      existingHarnessOnly: true,
    },
  ];
  // Keep the same Driver and revision: reconciliation must neither cache a false
  // result forever nor retain true after the workload becomes unready again.
  for (const stage of stages) {
    await t.test(stage.name, async () => {
      const provisionsBefore = fixture.provisions.length;
      const endpointsBefore = fixture.endpoints.length;
      const hooksBefore = fixture.hooks.length;
      fixture.observePods(stage.pods);
      const dispatch = stage.existingHarnessOnly
        ? { ...authContext(fixture.revision), existingHarnessOnly: true }
        : undefined;
      assert.deepEqual(await fixture.prepare(undefined, dispatch), {
        ...expectedRevision(fixture),
        ready: stage.ready,
      });
      const provision = fixture.provisions.at(-1);
      assert.equal(provision.existingHarnessOnly, stage.existingHarnessOnly);
      assert.equal(Object.hasOwn(provision.requirements, "existingHarnessOnly"), false);
      assert.deepEqual(fixture.hooks.slice(hooksBefore), ["start"]);
      assert.equal(fixture.provisions.length, provisionsBefore + 1);
      assert.equal(fixture.endpoints.length, endpointsBefore + 1);
    });
  }
});

test("provider Harness endpoint writes transport and runtime requirements", () =>
  checkProviderEndpointRequirements(
    providerEndpointFixture,
    preparedEndpoint,
    admitLoggingConfiguration,
    providerUrl,
    providerWorkspaceRoot,
    (fixture, configuration, harnessHome) => {
      fixture.revision.configuration = configuration;
      fixture.sandbox.harnessHome = harnessHome;
    },
  ));

test("provider Harness endpoint admits only exact node and provider peers", async () =>
  checkProviderExactPeers(await preparedEndpoint()));

test("provider Harness malformed Pod stops preparation and cannot write activation", async () =>
  checkProviderMalformedActivation(await preparedEndpoint()));

test("provider Harness activation replaces broad legacy peers and deletes obsolete policies with UID preconditions", async () =>
  checkProviderLegacyPolicyActivation(await preparedEndpoint(), {
    agentNetworkPolicies: (driver, revision, namespace) =>
      driver.agentNetworkPolicies(revision, namespace),
    manifest: (driver, apiVersion, kind, name, ownership, namespace) =>
      driver.manifest(apiVersion, kind, name, ownership, namespace),
  }));

for (const scenario of statusScenarios) {
  test(`provider Harness preparation observes ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    await checkProviderPreparationStatus(fixture, scenario, expectedRevision(fixture));
  });
}

for (const scenario of invalidProviderEvidence) {
  test(`provider Harness rejects ${scenario.name}`, async () => {
    await checkProviderInvalidEvidence(await endpointWithGateway(), scenario);
  });
}

test("provider Harness reads a supervisor's held failure while its workspace node is pending", async () => {
  // The Codex Harness supervisor holds a failed state migration or workspace setup before
  // Codex and the workspace node start, so the node never connects. Compute reads the hold
  // through the provider and fails the revision with it instead of waiting for the
  // deadline as WORKSPACE_NODE_PENDING (finding 2686).
  const fixture = await endpointWithGateway();
  fixture.observePods([fixture.pod("ready")]);
  fixture.driver.nodeEnrollment.isConnected = async () => false;
  const observations = [];
  let answer = { state: "serving" };
  fixture.sandbox.harnessStatus = async (context) => {
    observations.push(context);
    return answer;
  };
  // A Codex that serves while its node pairs keeps the named wait.
  assert.deepEqual(await fixture.prepare(), {
    ...expectedRevision(fixture),
    ready: false,
    pendingReason: "WORKSPACE_NODE_PENDING",
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].transportToken, "test-transport");
  for (const check of ["state-migration", "workspace-baseline"]) {
    const runtimeFailure = { ...withoutCause, check, code: "UNAVAILABLE" };
    answer = { state: "failed", runtimeFailure };
    assert.deepEqual(await fixture.prepare(), {
      ...expectedRevision(fixture),
      ready: false,
      runtimeFailure,
    });
  }
  assert.equal(observations.length, 3);
});

test("Strands reports a held workspace through its diagnostic Service before Pod readiness", async () => {
  const fixture = providerEndpointFixture();
  fixture.sandbox.implementation = "strands-box";
  fixture.revision.compute.admission = fixture.driver.admitRevision(fixture.revision);
  await endpointWithGateway(fixture);
  fixture.observePods([fixture.pod("starting", "False")]);
  const runtimeFailure = { ...withoutCause, check: "workspace-baseline", code: "UNAVAILABLE" };
  fixture.sandbox.harnessStatus = async ({ transportToken }) => {
    assert.equal(transportToken, "test-transport");
    return { state: "failed", runtimeFailure };
  };
  assert.deepEqual(await fixture.prepare(), {
    ...expectedRevision(fixture),
    ready: false,
    runtimeFailure,
  });
});

test("provider Harness unready Pod prevents transport status observation", async () => {
  const fixture = await endpointWithGateway();
  let observations = 0;
  fixture.sandbox.harnessStatus = async () => {
    observations++;
    return { state: "failed", runtimeFailure: heldFailure };
  };
  fixture.observePods([fixture.pod("starting", "False")]);
  assert.deepEqual(await fixture.prepare(), {
    ...expectedRevision(fixture),
    ready: false,
  });
  assert.equal(observations, 0);
});

for (const scenario of transportScenarios) {
  test(`provider Harness activation re-observes ${scenario.name}`, async () => {
    const fixture = await endpointWithGateway();
    fixture.observePods([fixture.pod("ready")]);
    const observations = [];
    let answer = { state: "serving" };
    fixture.sandbox.harnessStatus = async (context) => {
      observations.push(context);
      return answer;
    };
    assert.deepEqual(await fixture.prepare(), {
      ...expectedRevision(fixture),
      ready: true,
    });
    assert.equal(observations.length, 1);
    // The previously serving Harness can stop between preparation and activation.
    answer = scenario.answer;
    const before = fixture.writes.length;
    if (scenario.outcome.ready) {
      await fixture.activate();
      assert.ok(fixture.writes.length > before);
    } else {
      await assert.rejects(fixture.activate(), /The exact AgentRevision workload is not ready/);
      assert.equal(fixture.writes.length, before);
    }
    assert.equal(observations.length, 2);
    assert.equal(observations[1].transportToken, "test-transport");
  });
}

test("provider Harness unreachable transport is a transient Sandbox provisioning failure", async () => {
  const fixture = await endpointWithGateway();
  const { driver } = fixture;
  fixture.observePods([fixture.pod("ready")]);
  // An unreachable Harness transport is no evidence about the Harness: the pass fails in the
  // Sandbox provisioning stage as a transient dependency the worker rechecks until the
  // deadline without spending attempts (finding 1658).
  const transport = new DependencyUnavailableError("OpenShell service is unreachable.");
  fixture.sandbox.harnessStatus = async () => {
    throw transport;
  };
  const unreachable = await fixture.prepare().then(
    () => assert.fail("an unreachable Harness must not prepare"),
    (error) => error,
  );
  assert.ok(unreachable instanceof TransientDependencyError, String(unreachable));
  assert.equal(unreachable.dependency, "sandbox_gateway");
  assert.equal(unreachable.cause, transport);
  assert.deepEqual(driver.describePrepareRevisionFailure(unreachable), {
    code: "SANDBOX_GATEWAY_UNAVAILABLE",
    stage: "sandbox_provision",
    errorClass: "TransientDependencyError",
    message: "The Sandbox provider did not answer the Harness status read.",
  });
});

test("provider Harness verified endpoint trust is projected before rollout and immutable", async (t) => {
  const tls = await harnessTlsFixture(t);
  const untrusted = await harnessTlsFixture(t);
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
  const { WebSocketServer } = socketRequire("ws");
  const server = createHttpsServer({ key: tls.key, cert: tls.cert });
  const sockets = new WebSocketServer({ server });
  t.after(() => {
    for (const client of sockets.clients) {
      client.terminate();
    }
    sockets.close();
  });
  sockets.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test-transport");
    socket.send("trust-ok");
  });
  // listen() registers the server close after the WebSocket teardown above, so the
  // clients and the WebSocket server still close first.
  const providerPort = await listen(t, server);
  let providerCaBundle = tls.caBundle;

  const providerUrl = `wss://localhost:${providerPort}/`;
  const fixture = providerEndpointFixture({
    providerNetwork: {
      namespace: "openshell-system",
      podLabels: { app: "openshell-gateway" },
      address: "10.43.0.50",
      port: providerPort,
    },
    harnessEndpoint: async () => ({
      url: providerUrl,
      workspaceRoot: providerWorkspaceRoot,
      tls: { caBundle: providerCaBundle },
    }),
  });
  const { read, writes, revision, provisions, gatewayNamespace } = fixture;
  const configMap = (name) => read("ConfigMap", name, gatewayNamespace);
  await fixture.prepare();
  const bootstrap = fixture.gateway();
  assert.equal(
    bootstrap.spec.template.spec.containers[0].env.some(
      ({ name }) => name === "NODE_EXTRA_CA_CERTS",
    ),
    false,
  );
  const configurationName = `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const initialSnapshot = configMap(configurationName);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  fixture.observePods([fixture.pod("ready")]);
  assert.equal((await fixture.prepare()).ready, true);
  const pod = fixture.gateway().spec.template.spec;
  const gatewayContainer = pod.containers[0];
  // Endpoint discovery must not rewrite the immutable configuration created for
  // bootstrap. Only this revision's Gateway receives the separate public bundle.
  assert.deepEqual(configMap(configurationName), initialSnapshot);
  const trustMount = gatewayContainer.volumeMounts.find(({ name }) => name === "harness-trust");
  assert.ok(trustMount, "the provider endpoint CA must be mounted into the Gateway");
  const trustVolume = pod.volumes.find(({ name }) => name === trustMount.name);
  assert.equal(trustMount.readOnly, true);
  assert.equal(trustVolume.configMap.optional, false);
  const trust = configMap(trustVolume.configMap.name);
  assert.equal(trust.immutable, true);
  assert.equal(trust.metadata.labels["openclaw.dev/revision"], revision.id);
  assert.deepEqual(trust.data, { "ca-bundle.pem": tls.caBundle });
  const caPaths = gatewayContainer.env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS");
  assert.deepEqual(
    caPaths.map(({ value }) => value),
    [`${trustMount.mountPath}/${trustVolume.configMap.items[0].path}`],
  );
  assert.equal(
    provisions[0].requirements.environment.some(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
    false,
  );
  const trustWrite = writes.findIndex(
    ({ kind, metadata }) => kind === "ConfigMap" && metadata.name === trust.metadata.name,
  );
  const rolloutWrite = writes.findIndex(
    ({ kind, spec }) =>
      kind === "Deployment" &&
      spec.template.spec.volumes.some(({ name }) => name === "harness-trust"),
  );
  assert.ok(
    trustWrite >= 0 && trustWrite < rolloutWrite,
    "public trust exists before the Gateway rollout",
  );

  // Materialize the actual projection in a private directory. A fresh Node
  // process exercises ws's default TLS path, as the pinned Gateway client does;
  // no ca/rejectUnauthorized override or process trust mutation is supplied.
  const projectedPath = join(tls.directory, "projected-ca.pem");
  await writeFile(projectedPath, trust.data[trustVolume.configMap.items[0].key]);
  const wsProbe = `
      const WebSocket = require(${JSON.stringify(socketRequire.resolve("ws"))});
      const socket = new WebSocket(process.env.APP_SERVER_URL, {
        headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
        handshakeTimeout: 2000,
      });
      socket.on("message", (data) => {
        process.stdout.write(data.toString());
        socket.close();
      });
      socket.on("error", (error) => { process.stderr.write(String(error.code)); process.exitCode = 1; });
    `;
  const probe = (caPath, url = providerUrl) =>
    promisify(execFile)(process.execPath, ["-e", wsProbe], {
      env: {
        APP_SERVER_URL: url,
        APP_SERVER_TOKEN: "test-transport",
        ...(caPath === undefined ? {} : { NODE_EXTRA_CA_CERTS: caPath }),
      },
    });
  assert.deepEqual(await probe(projectedPath), { stdout: "trust-ok", stderr: "" });
  for (const caPath of [undefined, untrusted.rootCertificatePath]) {
    await assert.rejects(probe(caPath), {
      code: 1,
      // A different CA with the same issuer name can fail signature verification directly.
      stderr:
        caPath === undefined
          ? /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/
          : /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_SIGNATURE_FAILURE/,
    });
  }
  await assert.rejects(probe(projectedPath, `wss://127.0.0.1:${providerPort}/`), {
    code: 1,
    stderr: "ERR_TLS_CERT_ALTNAME_INVALID",
  });

  providerCaBundle = untrusted.caBundle;
  await assert.rejects(fixture.activate(), /invalid immutable Kubernetes ConfigMap/);
  assert.deepEqual(configMap(trust.metadata.name), trust);
});

test("provider Harness protected execution is released only on current signed installation", async (t) => {
  const fixture = await preparedEndpoint(
    providerEndpointFixture({
      servicePrincipalCredentials: { mode: "disabled" },
      revisionOverrides: {
        id: "rev_2c9250cd-6aa2-4493-a73e-2422ec6c1537",
        agentId: "agt_9bee809d-62ec-4d41-b68d-25ead74b3a4d",
        servicePrincipalId: "spn_02aa5adc-0b5c-417d-b8d4-1a1de5157809",
      },
    }),
  );
  const { revision, provisions, objects, save, core } = fixture;
  let harnessAnswer = { state: "serving" };
  // A separately admitted protected revision waits for the installation commit.
  // These Driver dependencies expose ordering; actual authenticated release and
  // first model-request behavior are covered by the enrollment integration test.
  const protectedId = "ar_00000000-0000-4000-8000-000000000547";
  const execution = {
    installationId: "ins_00000000-0000-4000-8000-000000000001",
    namespaceId: tenant.id,
    agentId: revision.agentId,
    servicePrincipalId: revision.servicePrincipalId,
    revisionId: protectedId,
    executionId: "00000000-0000-4000-8000-000000000547",
  };
  const sandbox = {
    ...fixture.sandbox,
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    cleanup: assert.fail,
    enrollHarness: assert.fail,
    harnessStatus: async () => harnessAnswer,
  };
  const proxy = {
    id: sandbox.id,
    implementation: sandbox.implementation,
    capability: "credential_proxy",
    sourceControl: {
      sender: { id: "supervisor", generation: 1 },
      resolver: { id: "resolver", generation: 1 },
      providers: [credentialFreeMetadataProvider],
      assertAvailable: assert.fail,
    },
    async configureRevision({ plan }) {
      return { plan, configuration: { middleware: "protected-attachment" } };
    },
    async wiringStatus() {
      events.push("observe");
      return observation;
    },
    async verifyInstallation() {
      events.push("verify-current");
      return current;
    },
    withdrawBinding: assert.fail,
    removeRevision: assert.fail,
  };
  const protectedDriver = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  const driver = new KubernetesComputeDriver(fixture.driver.options, {
    protectedDriver,
    nodeEnrollment: fixture.driver.nodeEnrollment,
  });
  driver.apiClients = Promise.resolve(fixture.clients);
  const plan = {
    id: "00000000-0000-4000-8000-000000000548",
    generation: 1,
    execution,
    driver: protectedDriver.ref,
    sandboxDriverId: sandbox.id,
    egressDriverId: proxy.id,
    routes: [],
  };
  const protectedRevision = {
    ...revision,
    id: protectedId,
    executionAdmission: { version: 3, mode: "protected" },
    revision: revision.revision + 1,
    harnessAuth: { method: "runtime" },
    harness: { ...revision.harness, configuration: {} },
    egressPlan: plan,
    credentialSources: [],
  };
  protectedRevision.compute = {
    id: driver.id,
    implementation: driver.implementation,
    admission: driver.admitRevision(protectedRevision),
  };
  const installed = {
    plan,
    sandboxId: "installed-sandbox",
    sender: proxy.sourceControl.sender,
    installedAt: "2026-10-14T00:00:00.000Z",
    enforcement: {
      instanceId: "current-instance",
      configurationId: "current-configuration",
      peerKeyId: "enrolled-exchange-key",
      authorityScope: "execution",
      policyHash: "installed-protected-policy",
    },
  };
  const events = [];
  let observation = installed;
  let current = true;
  let enrollmentRequirements;
  let releaseByCompute;
  const released = new DependencyUnavailableError("stop after authenticated enrollment boundary");
  sandbox.enrollHarness = async (context, receipt, release) => {
    releaseByCompute = release;
    assert.equal(context.transportToken, "test-transport");
    assert.equal(context.revision, protectedRevision);
    assert.equal(receipt, installed);
    enrollmentRequirements = context.requirements;
    events.push("enroll");
    throw released;
  };
  // A new revision has its own node setup; the already-ready Gateway remains the
  // predecessor. Its setup Secret is independently seeded, not made ready by writes.
  const setup = await core.readNamespacedSecret({ name: driver.workspaceNodeName(revision) });
  const seedNode = (target) =>
    save({
      ...setup,
      metadata: {
        ...setup.metadata,
        name: driver.workspaceNodeName(target),
        labels: { ...setup.metadata.labels, "openclaw.dev/revision": target.id },
      },
    });
  seedNode(protectedRevision);
  const protectedContext = {
    harnessAuth: protectedRevision.harnessAuth,
    async recordEgressInstallation() {
      events.push("commit");
    },
    currentEgressInstallation: async () => observation,
  };
  observation = undefined;
  assert.equal((await driver.prepareRevision(protectedRevision, protectedContext)).ready, false);
  assert.deepEqual(events.splice(0), ["observe"]);
  observation = installed;
  const commitFailure = new Error("installation commit failed");
  await assert.rejects(
    driver.prepareRevision(protectedRevision, {
      ...protectedContext,
      async recordEgressInstallation() {
        events.push("commit-rejected");
        throw commitFailure;
      },
    }),
    (error) => error === commitFailure,
  );
  assert.deepEqual(events.splice(0), ["observe", "verify-current", "commit-rejected"]);
  current = false;
  assert.equal((await driver.prepareRevision(protectedRevision, protectedContext)).ready, false);
  assert.deepEqual(events.splice(0), ["observe", "verify-current"]);
  current = true;
  const changedAtCommit = await driver.prepareRevision(protectedRevision, {
    ...protectedContext,
    async recordEgressInstallation() {
      events.push("commit");
      current = false;
    },
  });
  assert.equal(changedAtCommit.ready, false);
  assert.deepEqual(events.splice(0), ["observe", "verify-current", "commit", "verify-current"]);
  current = true;
  const entered = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const preparing = driver.prepareRevision(protectedRevision, {
    ...protectedContext,
    async recordEgressInstallation() {
      events.push("commit-start");
      entered.resolve();
      await commit.promise;
      events.push("commit-finished");
    },
  });
  // Await both branches so an earlier preparation failure cannot leave the test hanging.
  await Promise.race([entered.promise, preparing]);
  assert.deepEqual(events, ["observe", "verify-current", "commit-start"]);
  commit.resolve();
  await assert.rejects(preparing, (error) => error === released);
  assert.deepEqual(events.splice(0), [
    "observe",
    "verify-current",
    "commit-start",
    "commit-finished",
    "verify-current",
    "enroll",
  ]);

  // Exercise the actual producer's output, not a hand-built environment that
  // can accidentally restore the revision variable removed during projection.
  const manifest = JSON.parse(
    enrollmentRequirements.files.find(
      (file) => file.environmentVariable === "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    ).content,
  );
  const projectedEnv = ({ environment }) =>
    Object.fromEntries(
      environment.filter((entry) => "value" in entry).map(({ name, value }) => [name, value]),
    );
  for (const name of [
    "OPENCLAW_AGENT_REVISION_ID",
    "OPENCLAW_RUNTIME_STATUS_PORT",
    "OPENCLAW_RUNTIME_STATUS_CONTAINER",
    "OPENCLAW_POD_UID",
    "APP_SERVER_TOKEN",
  ]) {
    assert.equal(
      enrollmentRequirements.environment.some((entry) => entry.name === name),
      false,
    );
  }
  assert.equal(
    provisions[0].requirements.environment.some(
      (entry) => entry.name === "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID",
    ),
    false,
    "unprotected provider Harnesses do not receive enrollment identity",
  );
  const environment = projectedEnv(enrollmentRequirements);
  const headers = { authorization: "Bearer test-transport", "content-type": "application/json" };
  async function launch(t, args, env) {
    // Each child owns a fresh port on the enrollment listener's actual bind address.
    const reservation = await reservePort({ host: "0.0.0.0" });
    t.after(reservation.release);
    const url = `http://127.0.0.1:${reservation.port}${HARNESS_EGRESS_ENROLLMENT_PATH}`;
    const release = async (body) => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      return response.status;
    };
    // Remap only the service port; authentication and identity come from prepareRevision.
    const child = spawn(process.execPath, [...reservedPortArgs(reservation), ...args], {
      env: { ...env, APP_SERVER_PORT: String(reservation.port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    });
    const response = await waitFor(
      "enrollment challenge",
      () => {
        assert.equal(child.exitCode, null, diagnostics);
        return fetch(url, { headers }).catch(() => undefined);
      },
      2000,
      { interval: 20, describe: () => diagnostics },
    );
    assert.equal(response.status, 200, diagnostics);
    // Only the authenticated enrollment listener can answer; it now owns the port.
    await reservation.release();
    return { challenge: await response.json(), exited, url, release };
  }
  const program = `
    function isPlainObject(value) {
      return value !== null && typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype;
    }
    ${HARNESS_EGRESS_ENROLLMENT_HELPER}
    waitForHarnessEgressEnrollment(${JSON.stringify(manifest.egressEnrollment)})
      .then(() => process.exit(0), (error) => {
        console.error(error.message); process.exit(1);
      });
  `;
  await t.test(
    "production provider requirements open the authenticated enrollment challenge",
    async (t) => {
      const { challenge, exited, url, release } = await launch(t, ["-e", program], environment);
      assert.deepEqual(challenge.execution, plan.execution);
      assert.deepEqual(challenge.plan, { id: plan.id, generation: plan.generation });
      assert.equal((await fetch(url)).status, 401);
      const execution = { ...challenge.execution, revisionId: "wrong-revision" };
      assert.equal(await release({ ...challenge, execution }), 409);
      // A bearer holder can read the real challenge but cannot echo it to release startup.
      assert.equal(await release(challenge), 409);
      for (const substitution of [
        undefined,
        { ...installed, sandboxId: "replacement" },
        {
          ...installed,
          enforcement: { ...installed.enforcement, peerKeyId: "new-enrolled-peer" },
        },
      ]) {
        observation = substitution;
        await assert.rejects(
          releaseByCompute(challenge.startupId),
          /exact current committed installation/,
        );
      }
      observation = installed;
      current = false;
      await assert.rejects(
        releaseByCompute(challenge.startupId),
        /exact current committed installation/,
      );
      current = true;
      const stale = await releaseByCompute("another-startup");
      assert.equal(await release(stale), 409);
      const signed = await releaseByCompute(challenge.startupId);
      const signer = [...objects.values()].find((v) =>
        v.metadata?.name.startsWith("compute-release-"),
      );
      assert.ok(signer?.immutable);
      assert.equal(JSON.stringify(enrollmentRequirements).includes(signer.data.signer), false);
      for (const forged of [
        { ...signed, signature: Buffer.alloc(64).toString("base64url") },
        { ...signed, installation: { ...signed.installation, peerKeyId: "new-peer" } },
      ]) {
        assert.equal(await release(forged), 409);
      }
      assert.equal(await release(signed), 200);
      assert.deepEqual(await exited, [0, null]);
    },
  );
  for (const [name, value, extra] of [
    ["mismatched revision", "wrong-revision", {}],
    ["omitted revision", undefined, {}],
    [
      "private status identity cannot substitute",
      undefined,
      { OPENCLAW_AGENT_REVISION_ID: protectedRevision.id },
    ],
  ]) {
    await t.test(name, () => {
      const env = { ...environment, ...extra };
      delete env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID;
      if (value !== undefined) {
        env.OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID = value;
      }
      const result = spawnSync(process.execPath, ["-e", program], {
        env,
        encoding: "utf8",
        timeout: 3000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Protected Harness enrollment configuration is invalid/);
    });
  }
  await t.test(
    "a zero-binding execution releases only its local app server, after the exact committed deny-all",
    async (t) => {
      const id = "ar_00000000-0000-4000-8000-000000000548";
      const zeroPlan = { ...plan, execution: { ...plan.execution, revisionId: id }, routes: [] };
      const zero = {
        ...protectedRevision,
        id,
        revision: protectedRevision.revision + 1,
        harnessAuth: { method: "runtime" },
        harness: { ...protectedRevision.harness, configuration: {} },
        compute: { id: driver.id, implementation: driver.implementation },
        egressPlan: zeroPlan,
        credentialSources: [],
      };
      seedNode(zero);
      const zeroInstalled = { ...installed, plan: zeroPlan };
      observation = zeroInstalled;
      let zeroRequirements;
      let authorizeZero;
      sandbox.enrollHarness = async ({ requirements }, receipt, release) => {
        assert.equal(receipt, zeroInstalled);
        zeroRequirements = requirements;
        authorizeZero = release;
        throw released;
      };
      const zeroContext = {
        harnessAuth: zero.harnessAuth,
        credentialSources: [],
        currentEgressInstallation: async () => zeroInstalled,
        recordEgressInstallation: async (receipt) => assert.equal(receipt, zeroInstalled),
      };
      await assert.rejects(
        driver.prepareRevision(zero, zeroContext),
        (error) => error === released,
      );
      const directory = await temporaryDirectory(t, "oce-compute-deny-all-");
      const calls = join(directory, "codex-calls");
      await writeFile(calls, "");
      // Stub only the CLI. Use the owning prepareRevision's actual files and environment.
      await writeFile(
        join(directory, "codex"),
        '#!/bin/sh\necho "$@" >> "$OCE_TEST_CODEX_CALLS"\n',
        { mode: 0o700 },
      );
      const env = {
        ...projectedEnv(zeroRequirements),
        PATH: directory + ":" + process.env.PATH,
        HOME: directory,
        CODEX_HOME: directory,
        OPENCLAW_WORKSPACE_DIR: directory,
        OCE_TEST_CODEX_CALLS: calls,
      };
      for (const file of zeroRequirements.files) {
        const path = join(directory, file.name);
        await writeFile(path, file.content);
        env[file.environmentVariable] = path;
      }
      const script = join(directory, "harness.cjs");
      await writeFile(script, AGENT_RUNTIME_ENTRYPOINT);
      const { challenge, exited, release } = await launch(t, [script], env);
      assert.equal(challenge.routeCount, 0);
      assert.equal(
        await readFile(calls, "utf8"),
        "",
        "protected startup ran no CLI before release",
      );
      const signed = await authorizeZero(challenge.startupId);
      assert.equal(await release(signed), 200);
      assert.deepEqual(await exited, [0, null]);
      const invocations = (await readFile(calls, "utf8")).trim().split("\n");
      assert.equal(invocations.length, 1);
      assert.match(invocations[0], /app-server/);
    },
  );
});

test("provider-owned storage uses API observation without a Harness claim", async () => {
  const fixture = providerEndpointFixture();
  fixture.sandbox.workspaceStorage = "provider";
  fixture.sandbox.observeHarness = async () => ({ state: "running" });
  // API responses are controlled inputs here. Assertions cover Compute's rendered
  // resources, not real OpenShell lifecycle, Kubernetes RBAC, or network enforcement.
  await endpointWithGateway(fixture);
  assert.deepEqual(await fixture.prepare(), { ...expectedRevision(fixture), ready: true });
  const { requirements } = fixture.provisions[0];
  assert.deepEqual(requirements.workspaceMounts, []);
  assert.deepEqual(requirements.retainedDirectories, [
    {
      purpose: "workspace",
      name: "workspace",
      path: "/home/node/workspace",
      environment: "OPENCLAW_WORKSPACE_DIR",
    },
    {
      purpose: "generated-images",
      name: "generated-images",
      path: "/home/node/.codex/generated_images",
    },
    { purpose: "sessions", name: "codex-sessions", path: "/home/node/.codex/sessions" },
    {
      purpose: "node-state",
      name: fixture.driver.workspaceNodeName(fixture.revision),
      path: "/home/node/.openclaw-node",
      environment: "OPENCLAW_NODE_STATE_DIR",
    },
  ]);
  const claims = fixture.writes.filter(({ kind }) => kind === "PersistentVolumeClaim");
  assert.ok(claims.length > 0, "Gateway private storage remains Kubernetes-owned");
  assert.ok(claims.every(({ metadata }) => !metadata.name.startsWith("harness-workspace-")));
});
