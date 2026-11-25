import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { listen } from "../helpers/listen.ts";
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
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { tenant, authContext, digest } from "../helpers/kubernetes-routed-scenarios.mjs";

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

test("the Box provisioner receives the launcher for a mounted private hook directory", async () => {
  const fixture = providerEndpointFixture();
  fixture.sandbox.implementation = "strands-box";
  fixture.revision.compute.admission = fixture.driver.admitRevision(fixture.revision);
  await preparedEndpoint(fixture);
  const command = fixture.provisions.at(-1).requirements.command;
  const evaluation = command.lastIndexOf("-e");
  assert.ok(evaluation >= 0);
  const launcher = containerProgram({ args: command.slice(evaluation + 1) });
  assert.match(launcher, /Native hook storage must be private/u);
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
