import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { selfSigned } from "../helpers/certificates.mjs";
import { once } from "node:events";
import {
  observeControllerUpgrade,
  prepareControllerUpgrade,
} from "../helpers/egress-controller-upgrade.mjs";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
  deploymentStatusForWork,
} from "../../packages/occ/src/state/controller-work.ts";
import { waitFor } from "../helpers/qa-utils.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import {
  activateRepositoryAgent,
  admitRepositoryAgent,
} from "../helpers/egress-custody-installed-agent.mjs";
import {
  describeGatewayAppServerDeclaration,
  observeConnectedOperation,
  rememberCustodyContext,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.mjs";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import { withEnvironment } from "../helpers/environment.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  requestInstalledGatewayTurn,
  waitForInstalledGateway,
  waitForProtectedAgentActivation,
} from "../helpers/egress-installed-agent.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { deleteInstalledResource } from "../helpers/egress-installed-resource-cleanup.mjs";
import { createKubernetesClient } from "../helpers/kubernetes-real.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  encodeSyntheticEvents,
  startSyntheticEgressProvider,
  syntheticResponsesEvents,
} from "../fixtures/synthetic-egress-provider.mjs";
import {
  assertConnectedResponse,
  assertNoConnectedAssistantOutput,
  connectedReceiptRevision,
  protectedAgentBody,
  protectedConfigurationBody,
  protectedSourceBody,
  sendConnectedRequest,
  serializeConnectedRequest,
  sourceAccessBindingBody,
  takeConnectedControllerBinding,
  validateConnectedDatabaseUrl,
  validateConnectedInputs,
} from "../helpers/egress-connected-inputs.mjs";
import {
  acceptedSupervisorSessions,
  requireSupervisorReconnect,
  supervisorSessionLifecycle,
} from "../helpers/egress-supervisor-reconnect.mjs";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { openShellExchangeCapabilities as capabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { listen } from "../helpers/listen.mjs";

import {
  assertOpenShellHarnessBinding,
  createOpenShellKubernetesFixture,
  openShellAgentName,
  openShellRevisionName,
} from "../helpers/openshell-kubernetes-real.mjs";

// These are oracle inputs, not simulated evidence of a running supplier. The
// selected account comes from the maintained launcher, independently of the Pod.
test("connected workload binding accepts only the maintained launcher identity and isolation", async (t) => {
  const revision = { namespaceId: "ns_fixture", agentId: "agent_fixture", id: "revision_fixture" };
  const sandbox = {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    metadata: {
      namespace: "workspace",
      name: "sandbox-fixture",
      uid: "sandbox-uid",
      labels: { "openshell.ai/sandbox-id": "sandbox-id" },
    },
  };
  const valid = {
    metadata: {
      namespace: "workspace",
      labels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/network-profile": "provider-fenced-v1",
        "app.kubernetes.io/name": openShellRevisionName(revision),
        "openshell.ai/boundary-pair": "sandbox-id",
        "openshell.ai/boundary-role": "workload",
      },
      annotations: { "openshell.ai/sandbox-id": "sandbox-id" },
      ownerReferences: [
        {
          apiVersion: sandbox.apiVersion,
          kind: "Sandbox",
          name: sandbox.metadata.name,
          uid: "sandbox-uid",
          controller: true,
        },
      ],
    },
    spec: {
      serviceAccountName: "openshell-sandbox",
      automountServiceAccountToken: false,
      volumes: [
        {
          name: "openshell-pod-identity",
          downwardAPI: {
            items: [{ path: "uid", fieldRef: { fieldPath: "metadata.uid" } }],
          },
        },
      ],
    },
  };
  const check = (pod, profile = "maintainedLauncher") =>
    assertOpenShellHarnessBinding("workspace", revision, sandbox, pod, profile);
  check(valid);
  // The shared helper must still reject the launcher account for per-Agent callers.
  assert.throws(() => assertOpenShellHarnessBinding("workspace", revision, sandbox, valid), {
    code: "ERR_ASSERTION",
  });
  const perAgent = structuredClone(valid);
  perAgent.spec.serviceAccountName = openShellAgentName(revision.agentId);
  assertOpenShellHarnessBinding("workspace", revision, sandbox, perAgent);
  assert.throws(() => check(valid, "unknown"), { code: "ERR_ASSERTION" });

  await t.test(
    "namespace-shared account preserves exact workload ownership without a token",
    () => {
      const configuredAccount = openShellAgentName("first_agent");
      const shared = structuredClone(valid);
      shared.spec.serviceAccountName = configuredAccount;
      const checkShared = (pod, expected = configuredAccount) =>
        assertOpenShellHarnessBinding(
          "workspace",
          revision,
          sandbox,
          pod,
          "namespaceShared",
          expected,
        );
      checkShared(shared);
      assert.throws(() => checkShared(shared, ""), { code: "ERR_ASSERTION" });
      assert.throws(
        () =>
          assertOpenShellHarnessBinding("workspace", revision, sandbox, shared, "namespaceShared"),
        { code: "ERR_ASSERTION" },
      );
      assert.throws(() => checkShared(shared, "wrong-account"), { code: "ERR_ASSERTION" });
      assert.throws(() => assertOpenShellHarnessBinding("workspace", revision, sandbox, shared), {
        code: "ERR_ASSERTION",
      });
      for (const mutate of [
        (pod) => {
          pod.metadata.labels["openclaw.dev/agent"] = "first_agent";
        },
        (pod) => {
          pod.metadata.labels["openclaw.dev/revision"] = "other_revision";
        },
        (pod) => {
          pod.metadata.ownerReferences[0].uid = "replaced-sandbox";
        },
        (pod) => {
          pod.spec.automountServiceAccountToken = true;
        },
        (pod) => {
          delete pod.spec.automountServiceAccountToken;
        },
        (pod) => {
          pod.spec.volumes.push({
            name: "unexpected-token",
            projected: { sources: [{ serviceAccountToken: { path: "token" } }] },
          });
        },
      ]) {
        const changed = structuredClone(shared);
        mutate(changed);
        assert.throws(() => checkShared(changed), { code: "ERR_ASSERTION" });
      }
    },
  );

  const rejects = (name, overrides) =>
    t.test(name, () => {
      const pod = { ...valid, ...overrides };
      assert.throws(() => check(pod), { code: "ERR_ASSERTION" });
    });
  const { metadata, spec } = valid;
  const token = { audience: "openshell-gateway", path: "token", expirationSeconds: 600 };
  for (const [name, change] of Object.entries({
    "wrong account": { serviceAccountName: "default" },
    "per-Agent account in launcher profile": {
      serviceAccountName: perAgent.spec.serviceAccountName,
    },
    "automount enabled": { automountServiceAccountToken: true },
    "token projection even without a workload mount": {
      volumes: [
        ...spec.volumes,
        { name: "bootstrap-token", projected: { sources: [{ serviceAccountToken: token }] } },
      ],
    },
  })) {
    await rejects(name, { spec: { ...spec, ...change } });
  }
  const missingAutomount = { ...spec };
  delete missingAutomount.automountServiceAccountToken;
  await rejects("automount unspecified", { spec: missingAutomount });
  for (const [name, change] of Object.entries({
    "recreated Sandbox UID": { uid: "stale-uid" },
    "wrong Sandbox name": { name: "other" },
    "wrong owner API": { apiVersion: "other/v1" },
    "noncontrolling owner": { controller: false },
  })) {
    const ownerReferences = [{ ...metadata.ownerReferences[0], ...change }];
    await rejects(name, { metadata: { ...metadata, ownerReferences } });
  }
  await rejects("wrong annotation", {
    metadata: { ...metadata, annotations: { "openshell.ai/sandbox-id": "other" } },
  });
  for (const label of Object.keys(metadata.labels)) {
    const role = label === "openshell.ai/boundary-role";
    const labels = { ...metadata.labels, [label]: role ? "supervisor" : "other" };
    const name = label === "openshell.ai/boundary-pair" ? "pair" : label;
    await rejects(role ? "supervisor instead of workload" : `wrong ${name}`, {
      metadata: { ...metadata, labels },
    });
  }
});

test("installed checkout evidence requires clean related product and harness commits in every mode", async (t) => {
  const directory = await temporaryDirectory(t, "connected-source-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (name) => {
    git("add", "source.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  await writeFile(`${directory}/source.txt`, "initial");
  const initial = commit("initial");
  await writeFile(`${directory}/source.txt`, "product");
  const product = commit("product");
  await writeFile(`${directory}/source.txt`, "harness");
  const harness = commit("harness");
  git("checkout", "--quiet", "--detach", initial);
  await writeFile(`${directory}/source.txt`, "unrelated product");
  const unrelated = commit("unrelated");
  git("checkout", "--quiet", "--detach", harness);
  const helper = new URL("../helpers/egress-connected-inputs.mjs", import.meta.url).href;
  const check = (input) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { assertConnectedCheckout } from ${JSON.stringify(helper)}; assertConnectedCheckout(${JSON.stringify(input)});`,
      ],
      { cwd: directory, encoding: "utf8" },
    );
  for (const controllerUpgrade of [undefined, { fromCommit: initial }]) {
    const input = { oceCommit: product, harnessCommit: harness, controllerUpgrade };
    assert.equal(check(input).status, 0, "clean descendant harness qualifies source provenance");
    for (const oceCommit of [unrelated, "f".repeat(40)]) {
      assert.notEqual(
        check({ ...input, oceCommit }).status,
        0,
        "unrelated or missing product fails",
      );
    }
    assert.notEqual(
      check({ ...input, harnessCommit: product }).status,
      0,
      "wrong harness HEAD fails",
    );
    // Exercise actual Git dirtiness, including an untracked change excluded by diff alone.
    await writeFile(`${directory}/source.txt`, "uncommitted");
    assert.notEqual(check(input).status, 0, "modified source fails");
    git("checkout", "--", "source.txt");
    await writeFile(`${directory}/untracked.txt`, "unreviewed");
    assert.notEqual(check(input).status, 0, "untracked source fails");
    await rm(`${directory}/untracked.txt`);
  }
  assert.equal(check({ oceCommit: harness, harnessCommit: harness }).status, 0);
  assert.notEqual(
    check({
      oceCommit: product,
      harnessCommit: harness,
      controllerUpgrade: { fromCommit: unrelated },
    }).status,
    0,
  );
});

test("connected inputs accept exact bearer and mTLS shapes and only scoped HTTPS fixtures", () => {
  const input = {
    version: 2,
    namespaceId: "ns_fixture",
    model: "fixture-model",
    apiOrigin: "http://127.0.0.1:3000",
    kubeconfigPath: "/fixture/kubeconfig",
    kubernetesContext: "k3d-fixture",
    controllerNamespace: "oce-system",
    controllerSelector: "app=controller",
    openShellGatewayNamespace: "openshell",
    openShellGatewaySelector: "app=gateway",
    runtimeClass: "openshell",
    oceCommit: "a".repeat(40),
    harnessCommit: "d".repeat(40),
    supplierCommit: "b".repeat(40),
    images: Object.fromEntries(
      ["agent", "controller", "gateway", "openShellGateway", "sandbox", "supervisor"].map(
        (role) => [role, `fixture/${role}@sha256:${"a".repeat(64)}`],
      ),
    ),
    credentialConnector: {
      path: "/usr/bin/model-client",
      sha256: "b".repeat(64),
      image: `fixture/agent@sha256:${"a".repeat(64)}`,
      verification: "operator-verified-image-executable",
    },
    openShellBackend: {
      endpoint: "https://gateway.test:8443",
      rootCertificatePath: "/fixture/root.pem",
      auth: { mode: "bearerTokenFile", path: "/fixture/bearer" },
    },
    provider: {
      origin: "https://provider.test:9443/v1",
      bindHost: "127.0.0.1",
      bindPort: 9443,
      certificatePath: "/fixture/provider.pem",
      privateKeyPath: "/fixture/provider.key",
    },
  };
  const selection = (input) => ({
    apiOrigin: input.apiOrigin,
    namespaceId: input.namespaceId,
    model: input.model,
    providerOrigin: input.provider.origin,
  });
  const controller = selection(input);
  for (const field of Object.keys(controller)) {
    assert.throws(() => validateConnectedInputs(input, { ...controller, [field]: "different" }), {
      code: "ERR_ASSERTION",
    });
  }
  const validate = (input) => validateConnectedInputs(input, selection(input));
  const mtls = {
    mode: "mtls",
    certificatePath: "/fixture/client.pem",
    privateKeyPath: "/fixture/client.key",
  };
  for (const auth of [input.openShellBackend.auth, mtls]) {
    for (const host of ["provider.test", "host.openshell.internal"]) {
      const origin = `https://${host}:9443/v1`;
      const candidate = {
        ...input,
        openShellBackend: { ...input.openShellBackend, auth },
        provider: { ...input.provider, origin },
      };
      assert.equal(validate(candidate), candidate);
    }
  }
  for (const pin of [
    undefined,
    {},
    { ...input.credentialConnector, sha256: "" },
    { ...input.credentialConnector, image: input.images.sandbox },
    { ...input.credentialConnector, path: "model-client" },
    { ...input.credentialConnector, verification: "discovered" },
  ]) {
    assert.throws(
      () => validateConnectedInputs({ ...input, credentialConnector: pin }, controller),
      { code: "ERR_ASSERTION" },
    );
  }
  const fresh = {
    ...input,
    credentialConnector: undefined,
    authorityProfile: "fresh-whole-execution",
    provider: { ...input.provider, origin: "https://provider.test/v1", bindPort: 443 },
  };
  const wholeExecution = (input) =>
    validateConnectedInputs(input, selection(input), {
      wholeExecution: true,
      allowControllerUpgrade: true,
    });
  // The supplier terminal exchange requires HTTPS 443; a valid-looking high
  // port previously passed preflight and failed only at the real model probe.
  assert.equal(wholeExecution(fresh), fresh);
  assert.throws(() => wholeExecution({ ...fresh, provider: input.provider }), {
    code: "ERR_ASSERTION",
  });
  for (const harnessCommit of [undefined, "short-sha"]) {
    assert.throws(() => wholeExecution({ ...fresh, harnessCommit }), {
      code: "ERR_ASSERTION",
    });
  }
  assert.throws(
    () => validate(fresh),
    { code: "ERR_ASSERTION" },
    "legacy lane cannot silently broaden a connector grant",
  );
  assert.throws(
    () => wholeExecution(input),
    { code: "ERR_ASSERTION" },
    "fresh profile must not inherit connector authority",
  );
  assert.throws(
    () => wholeExecution({ ...fresh, credentialConnector: input.credentialConnector }),
    {
      code: "ERR_ASSERTION",
    },
  );
  assert.throws(() => wholeExecution({ ...fresh, authorityProfile: undefined }), {
    code: "ERR_ASSERTION",
  });
  const controllerUpgrade = {
    fromCommit: "c".repeat(40),
    fromImage: `fixture/controller@sha256:${"c".repeat(64)}`,
    timeoutMs: 60_000,
  };
  const upgrading = { ...fresh, controllerUpgrade };
  assert.equal(wholeExecution(upgrading), upgrading);
  assert.throws(
    () => validateConnectedInputs(upgrading, selection(upgrading), { wholeExecution: true }),
    { code: "ERR_ASSERTION" },
    "the repository-custody caller must reject a cutover it cannot perform",
  );
  assert.throws(() => validate({ ...input, controllerUpgrade }), { code: "ERR_ASSERTION" });
  for (const change of [
    { fromCommit: input.oceCommit },
    { fromCommit: "short-sha" },
    { fromImage: input.images.controller },
    { fromImage: `other/controller@sha256:${"a".repeat(64)}` },
    { fromImage: "fixture/controller:mutable" },
    { timeoutMs: 0 },
    { timeoutMs: 15 * 60_000 + 1 },
    { timeoutMs: "60000" },
    { script: "/unreviewed/upgrade.sh" },
  ]) {
    assert.throws(
      () => wholeExecution({ ...fresh, controllerUpgrade: { ...controllerUpgrade, ...change } }),
      { code: "ERR_ASSERTION" },
    );
  }
  const rejectedAuth = [
    undefined,
    { mode: "unauthenticated" },
    { mode: "bearerTokenFile", path: "relative" },
    { mode: "bearerTokenFile", path: "/fixture/token", privateKeyPath: "/fixture/key" },
    { mode: "mtls", certificatePath: "/fixture/client.pem" },
    { ...mtls, certificatePath: "relative.pem" },
    { ...mtls, privateKeyPath: "relative.key" },
    { ...mtls, path: "/fixture/token" },
    { ...mtls, rejectUnauthorized: false },
  ];
  for (const auth of rejectedAuth) {
    const openShellBackend = { ...input.openShellBackend, auth };
    assert.throws(() => validate({ ...input, openShellBackend }), { code: "ERR_ASSERTION" });
  }
  // These guards precede credential reads and provider binding. Alias acceptance
  // must not admit ordinary providers, suffix lookalikes or implicit routing.
  assert.throws(() => validate({ ...input, serviceKeyPath: "/fixture/not-the-controller-key" }), {
    code: "ERR_ASSERTION",
  });
  for (const change of [
    { endpoint: "http://gateway.test:8443" },
    { rootCertificatePath: "relative.pem" },
    { insecureTransport: true },
  ]) {
    const openShellBackend = { ...input.openShellBackend, ...change };
    assert.throws(() => validate({ ...input, openShellBackend }), { code: "ERR_ASSERTION" });
  }
  for (const change of [
    { origin: "http://provider.test:9443/v1" },
    { origin: "https://api.openai.com:9443/v1" },
    { origin: "https://other.openshell.internal:9443/v1" },
    { origin: "https://host.openshell.internal.example.com:9443/v1" },
    { origin: "https://host.openshell.internal:9443/v1?override=1" },
    { bindHost: "host.openshell.internal" },
    { bindPort: 9444 },
    { certificatePath: "relative.pem" },
    { privateKeyPath: "relative.key" },
  ]) {
    const provider = { ...input.provider, ...change };
    assert.throws(() => validate({ ...input, provider }), JSON.stringify(change));
  }
});

test("the authenticated connected request stays on the runner's exact loopback controller", async (t) => {
  const serve = async (handler) => `127.0.0.1:${await listen(t, createServer(handler))}`;
  let foreignRequests = 0;
  const foreign = await serve((_request, response) => {
    foreignRequests++;
    response.writeHead(403).end();
  });
  const serviceKey = `fixture-${randomUUID()}`;
  const local = await serve((request, response) => {
    assert.equal(request.headers["x-api-key"], serviceKey);
    if (request.url === "/redirect") {
      response.writeHead(307, { location: `http://${foreign}/foreign` }).end();
    } else {
      response.writeHead(204).end();
    }
  });
  const controller = (apiOrigin) => {
    const env = {
      OCC_TEST_EGRESS_CONNECTED_CONTROLLER: JSON.stringify({ apiOrigin }),
      OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY: serviceKey,
    };
    const result = takeConnectedControllerBinding(env);
    assert.equal(
      env.OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY,
      undefined,
      "child commands must not inherit the service key",
    );
    return result;
  };
  for (const origin of [
    `http://localhost:${local.split(":")[1]}`,
    `http://${local}/`,
    "http://127.0.0.1",
    "http://foreign.test:3000",
  ]) {
    assert.throws(() => controller(origin), { code: "ERR_ASSERTION" });
  }
  const binding = controller(`http://${local}`);
  const get = async (path) =>
    sendConnectedRequest(
      binding,
      serializeConnectedRequest("GET", path),
      AbortSignal.timeout(5_000),
    );
  assert.equal((await get("/prepared")).status, 204, "the selected controller did receive the key");
  // Fetch follows a leading slash and backslash as an authority, and a custom API-key
  // header is not stripped on cross-origin redirects. Both must stop before disclosure.
  await assert.rejects(
    get("/" + "\\" + foreign + "/foreign"),
    /only go to the selected controller/,
  );
  await assert.rejects(get("/redirect"), TypeError);
  assert.equal(foreignRequests, 0, "neither request reached the foreign listener");
});

test("connected response evidence survives cleanup without retaining untrusted fields", async (t) => {
  const sentinel = `private-diagnostic-${randomUUID()}`;
  const requestId = `req_${randomUUID()}`;
  const serviceKey = `fixture-${randomUUID()}`;
  const cases = [
    {
      code: "RESOURCE_CONFLICT",
      metaId: requestId,
      headerId: sentinel,
      expectedCode: "RESOURCE_CONFLICT",
      expectedId: requestId,
    },
    {
      code: sentinel,
      metaId: sentinel,
      headerId: requestId,
      expectedCode: "UNKNOWN",
      expectedId: requestId,
    },
    {
      code: { value: sentinel },
      metaId: requestId + "\n",
      headerId: sentinel,
      expectedCode: "UNKNOWN",
      expectedId: null,
    },
  ];
  let selected;
  let pending;
  let evidence;
  const port = await listen(
    t,
    createServer(async (request, response) => {
      assert.equal(request.headers["x-api-key"], serviceKey);
      const saved = JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8"));
      pending = saved.lastApi;
      assert.equal(pending.outcome, "unknown", "the attempt must be durable before dispatch");
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(409, { "x-request-id": selected.headerId, "x-private": sentinel });
      response.end(
        JSON.stringify({
          error: { code: selected.code, message: sentinel, details: [{ value: sentinel }] },
          meta: { requestId: selected.metaId, private: sentinel },
          data: sentinel,
        }),
      );
    }),
  );
  const progress = {};
  evidence = await createRunEvidence(
    t,
    {
      input: { images: {} },
      controller: { apiOrigin: `http://127.0.0.1:${port}`, serviceKey },
    },
    progress,
  );
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const route = `/namespaces/ns_${randomUUID()}/agents/agt_${randomUUID()}`;
  let firstFailure;
  for (selected of cases) {
    // A real HTTP rejection is recorded before the caller's expected-status assertion.
    // Later cleanup must not erase its correlation ID or retain arbitrary response material.
    progress.stage = "deploy-request";
    await assert.rejects(evidence.api("POST", route + "/deploy", {}, 202), {
      code: "ERR_ASSERTION",
    });
    const expected = {
      ...pending,
      outcome: "received-error-status",
      status: 409,
      code: selected.expectedCode,
      requestId: selected.expectedId,
    };
    firstFailure ??= expected;
    await evidence.request("DELETE", route, undefined, true);
    const raw = await readFile(evidence.directory + "/observations.json", "utf8");
    const saved = JSON.parse(raw);
    assert.deepEqual(
      saved.apiOperations?.at(-2),
      expected,
      "the initiating response must remain available after cleanup",
    );
    assert.equal(expected.phase, "deploy-request");
    assert.equal(saved.lastApi.method, "DELETE");
    assert.equal(saved.lastApi.phase, "cleanup");
    assert.notEqual(saved.lastApi.operationId, expected.operationId);
    assert.equal(raw.includes(sentinel), false);
    assert.equal(raw.includes(serviceKey), false);
    assert.equal(raw.includes(route), false);
  }
  const saved = JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8"));
  assert.deepEqual(
    saved.apiOperations.find(({ operationId }) => operationId === firstFailure.operationId),
    firstFailure,
    "the first failed POST must survive the entire cleanup sequence",
  );
});

test("connected response evidence preserves uncertainty after decoding and transport failures", async (t) => {
  const requestId = `req_${randomUUID()}`;
  const sentinel = `private-diagnostic-${randomUUID()}`;
  let fault;
  const received = [];
  const port = await listen(
    t,
    createServer(async (request, response) => {
      received.push(request.method);
      if (request.method === "DELETE") {
        const saved = JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8"));
        assert.equal(saved.lastApi.method, "DELETE");
        assert.equal(saved.lastApi.outcome, "unknown", "cleanup must checkpoint before dispatch");
        response.writeHead(204).end();
      } else if (fault === "disconnected") {
        request.socket.destroy();
      } else {
        if (fault === "malformed-with-ledger-failure") {
          await mkdir(evidence.directory + "/observations.pending.json");
        }
        response.writeHead(202, { "x-request-id": requestId });
        // This is a faulting HTTP peer, not a substitute for a valid product response.
        response.end("{malformed:" + sentinel);
      }
    }),
  );
  const progress = { stage: "deploy-request" };
  const evidence = await createRunEvidence(
    t,
    {
      input: { images: {} },
      controller: { apiOrigin: `http://127.0.0.1:${port}`, serviceKey: `fixture-${randomUUID()}` },
    },
    progress,
  );
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const route = `/namespaces/ns_${randomUUID()}/agents/agt_${randomUUID()}`;
  for (fault of ["malformed", "disconnected"]) {
    await assert.rejects(
      evidence.request("POST", route + "/deploy", {}),
      fault === "malformed" ? SyntaxError : TypeError,
    );
    await evidence.request("DELETE", route, undefined, true);
    const raw = await readFile(evidence.directory + "/observations.json", "utf8");
    const saved = JSON.parse(raw);
    const operation = saved.apiOperations?.at(-2);
    assert.ok(operation, "the uncertain initiating operation must survive cleanup");
    assert.equal(operation.outcome, "unknown", "status alone must not settle write custody");
    assert.equal(operation.status, fault === "malformed" ? 202 : null);
    assert.equal(operation.requestId, fault === "malformed" ? requestId : null);
    assert.equal(operation.code, null);
    assert.equal(raw.includes(sentinel), false);
    assert.equal(saved.lastApi.outcome, "received-success-status");
  }
  // A second failure while saving diagnostics must not replace the original
  // decoder error or imply that the already-dispatched write can be replayed.
  fault = "malformed-with-ledger-failure";
  await assert.rejects(evidence.request("POST", route + "/deploy", {}), SyntaxError);
  const saved = JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8"));
  assert.equal(saved.lastApi.outcome, "unknown");
  assert.equal(saved.lastApi.status, null, "the durable pre-dispatch record must survive");
  const failedPostId = saved.lastApi.operationId;
  const beforeCleanup = [...received];
  await assert.rejects(evidence.request("DELETE", route, undefined, true), { code: "EISDIR" });
  assert.deepEqual(received, beforeCleanup, "a failed checkpoint must prevent dispatch");
  // Repair only the fixture's filesystem obstruction. The next independent cleanup
  // gets a new checkpoint; the failed POST must never be sent again.
  await rm(evidence.directory + "/observations.pending.json", { recursive: true });
  await evidence.request("DELETE", route, undefined, true);
  assert.deepEqual(received, [...beforeCleanup, "DELETE"]);
  const recovered = JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8"));
  assert.equal(
    recovered.apiOperations.find(({ operationId }) => operationId === failedPostId).outcome,
    "unknown",
  );
});

test("connected response headers cannot retain known credentials as request IDs", async (t) => {
  // A malformed but accepted runner key can fit inside the canonical ID shape.
  // Generate both values locally; no real credential or controller is involved.
  const serviceKey = randomUUID();
  const protectedValue = randomUUID();
  let reflected;
  const port = await listen(
    t,
    createServer((_request, response) => {
      response.writeHead(204, { "x-request-id": `req_${reflected}` }).end();
    }),
  );
  const evidence = await createRunEvidence(
    t,
    {
      input: { images: {} },
      controller: { apiOrigin: `http://127.0.0.1:${port}`, serviceKey },
    },
    { stage: "request" },
  );
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  evidence.protect(protectedValue);
  for (reflected of [serviceKey, protectedValue]) {
    await assert.rejects(evidence.request("GET", "/installation"), { code: "ERR_ASSERTION" });
    const raw = await readFile(evidence.directory + "/observations.json", "utf8");
    const saved = JSON.parse(raw);
    assert.equal(raw.includes(reflected), false);
    assert.equal(saved.lastApi.requestId, null);
    assert.equal(saved.lastApi.outcome, "unknown");
  }
});

test("connected database selection rejects missing, remote and redirected observers before effects", () => {
  const url = (overrides = {}) =>
    syntheticCredentialUrl({
      protocol: "postgresql",
      username: "occ_app",
      password: "synthetic-preflight-only",
      host: "127.0.0.1",
      port: 15432,
      pathname: "/openclaw_k8s_egress",
      ...overrides,
    });
  assert.equal(validateConnectedDatabaseUrl(url()), url());
  for (const rejected of [
    undefined,
    "invalid",
    url({ host: "database.test" }),
    url({ pathname: "/openclaw" }),
    url({ username: "occ_migrator" }),
    url({ search: "?host=database.test" }),
    url({ search: "?dbname=unowned" }),
  ]) {
    assert.throws(
      () => validateConnectedDatabaseUrl(rejected),
      (error) => error.code === "ERR_ASSERTION" || /valid PostgreSQL URL/.test(error.message),
    );
  }
});

test("connected receipt observation preserves proto3 zero and uint64 precision", () => {
  assert.equal(connectedReceiptRevision(undefined), "0");
  assert.equal(connectedReceiptRevision("0"), "0");
  assert.equal(connectedReceiptRevision("18446744073709551615"), "18446744073709551615");
  for (const rejected of [null, 1, 9007199254740992, "01", "-1", "18446744073709551616"]) {
    assert.throws(() => connectedReceiptRevision(rejected), { code: "ERR_ASSERTION" });
  }
});

test("connected failed-turn observation rejects partial text without a completed message", () => {
  assertNoConnectedAssistantOutput({ assistant: "", items: [] });
  // Codex can notify a delta before a later terminal failure. Looking only at
  // item/completed would falsely qualify that visible partial response.
  for (const event of [
    { method: "item/agentMessage/delta", params: { delta: "visible before failure" } },
    { method: "item/started", params: { item: { type: "agentMessage", text: "visible" } } },
    { method: "item/completed", params: { item: { type: "agentMessage", text: "visible" } } },
  ]) {
    assert.throws(() => assertNoConnectedAssistantOutput({ assistant: "", items: [event] }), {
      code: "ERR_ASSERTION",
    });
  }
});

// docs/reference/credential-sources.md: an unsettled prepared source may stay deleting until its
// token lifetime ends. Cleanup must name that outcome and must not wait it out.
test("installed cleanup names an unsettled prepared source and does not wait out the token lifetime", async () => {
  const records = [];
  let removes = 0;
  const removed = await deleteInstalledResource({
    remove: async () => {
      removes += 1;
      return {
        status: 409,
        body: {
          meta: { requestId: "req_cleanup" },
          error: { code: "CREDENTIAL_TOKEN_UNSETTLED", message: "retry later" },
        },
      };
    },
    record: async (details) => records.push(details),
    // Never reached: only a 500 INTERNAL_ERROR may observe custody and retry.
    prepared: {
      databaseUrl: "postgresql://127.0.0.1:1/unreachable",
      namespaceId: "ns",
      sourceId: "src",
    },
  });
  assert.deepEqual(
    { removed, removes, records },
    {
      removed: false,
      removes: 1,
      records: [
        { observation: "delete-started-result-not-yet-known" },
        { status: 409, reason: "CREDENTIAL_TOKEN_UNSETTLED" },
      ],
    },
  );
});

// Use a real TLS socket: HTTP request counts alone miss partially sent headers.
test(
  "synthetic provider separates TLS handshakes from partial HTTP bytes",
  { timeout: 10_000 },
  async (t) => {
    const directory = await temporaryDirectory(t, "egress-provider-bytes-");
    const tls = await selfSigned(directory);
    const provider = await startSyntheticEgressProvider(
      t,
      {
        bindHost: "127.0.0.1",
        bindPort: 0,
        certificatePath: tls.certPath,
        privateKeyPath: tls.keyPath,
      },
      {
        initial: `SYNTHETIC-OCE-EGRESS-${randomUUID()}-v1`,
        rotated: `SYNTHETIC-OCE-EGRESS-${randomUUID()}-v2`,
      },
    );
    const client = connectTls({ host: "127.0.0.1", port: provider.port, ca: tls.cert });
    t.after(() => client.destroy());
    await once(client, "secureConnect");
    assert.equal(provider.tcpConnections, 1);
    assert.equal(provider.applicationBytes, 0, "TLS handshake bytes are not application bytes");
    assert.equal(provider.observations.length, 0);

    const partial = "GET /v1/responses HTTP/1.1\r\nHost: localhost\r\n";
    client.write(partial);
    await waitFor("partial HTTP bytes at origin", () => provider.applicationBytes > 0, 5000, {
      interval: 10,
    });
    assert.equal(provider.applicationBytes, Buffer.byteLength(partial));
    assert.equal(provider.observations.length, 0, "the HTTP parser has no complete headers yet");

    // Completing the same request must count every byte exactly once. No credential
    // is supplied, so the real provider rejects it after recording the HTTP request.
    const ending = "Connection: close\r\n\r\n";
    client.resume();
    const closed = once(client, "close");
    client.end(ending);
    await closed;
    assert.equal(provider.applicationBytes, Buffer.byteLength(partial + ending));
    assert.equal(provider.observations.length, 1);
    assert.equal(provider.observations[0].status, 403);
    assert.deepEqual(provider.errors, []);
  },
);

test("connected adversarial wire carries split and nested-JSON material without raw reflection", () => {
  const credential = `SYNTHETIC-OCE-EGRESS-${randomUUID()}-v1`;
  for (const mode of ["reflect-split-id", "reflect-encoded-arguments"]) {
    const events = syntheticResponsesEvents("gpt-6", "SAFE", { mode, credential });
    const wire = encodeSyntheticEvents(events).toString("utf8");
    assert.equal(wire.includes(credential), false, "the vector must bypass a raw-byte-only scan");
    assert.equal(events.at(-1).type, "response.completed");
    if (mode === "reflect-split-id") {
      const deltas = events.filter(({ type }) => type === "response.output_text.delta");
      assert.equal(deltas.length, 2);
      assert.deepEqual(
        deltas.map(({ output_index }) => output_index),
        [0, 0],
      );
      assert.equal(deltas[0].item_id, "msg_synthetic_other");
      assert.equal(deltas[1].item_id, "msg_synthetic");
      assert.equal(deltas.map(({ delta }) => delta).join(""), credential);
    } else {
      const call = events.at(-1).response.output[0];
      assert.equal(call.type, "function_call");
      assert.equal(call.arguments.includes(credential), false);
      assert.equal(JSON.parse(call.arguments).value, credential);
    }
  }
});

test("connected request bytes pass the real Fastify parser and preserve missing-capability refusals", async (t) => {
  // This is offline HTTP admission proof only. In-memory storage/Compute keep
  // the parser test source-only; no installed receipt or provider is substituted.
  const f = await createConsoleAppFixture(t, {
    backends: [],
    computeDriver: createReadyComputeDriver("egress-preflight-compute"),
  });
  await f.bootstrap("Connected wire preflight");
  const namespace = await f.createNamespace("egress-preflight", { ready: true });
  const secret = await f.createSecret(namespace.id, "synthetic", "SYNTHETIC-preflight-only");
  const session = await f.signIn();
  const prefix = "/namespaces/" + namespace.id;
  const post = async (route, body, expectedStatus = 201) => {
    const wire = serializeConnectedRequest("POST", prefix + route, body);
    const response = await f.app.inject({
      method: wire.method,
      url: wire.path,
      headers: {
        host: new URL(session.origin).host,
        ...authenticatedHeaders(session, wire.headers),
      },
      payload: wire.body,
    });
    return assertConnectedResponse(
      { status: response.statusCode, body: response.json() },
      expectedStatus,
    );
  };
  const sourceBody = protectedSourceBody("synthetic", secret.ref, "https://provider.test:9443/v1");
  const unknownField = await post("/credential-sources", { ...sourceBody, invented: true }, 400);
  assert.equal(unknownField.code, "INVALID_REQUEST");
  // A valid body must reach the missing real counterpart guard, rather than a generic 400.
  for (const origin of [
    "https://provider.test:9443/v1",
    "https://host.openshell.internal:9443/v1",
  ]) {
    const source = protectedSourceBody("synthetic", secret.ref, origin);
    const error = await post("/credential-sources", source, 409);
    assert.equal(error.code, "CREDENTIAL_GATEWAY_NOT_CONFIGURED");
  }
  const configuration = await post("/configurations", protectedConfigurationBody("gpt-6"));
  const agentBody = protectedAgentBody("synthetic", configuration.id, `cs_${randomUUID()}`);
  const agentError = await post("/agents", agentBody, 409);
  assert.equal(agentError.code, "CREDENTIAL_GATEWAY_NOT_CONFIGURED");
  const role = await post("/iam/roles", {
    name: "exact source only",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const principal = await post("/iam/service-principals", {});
  const binding = sourceAccessBindingBody({ servicePrincipalId: principal.id }, role, {
    id: agentBody.harnessAuth.sourceId,
  });
  const bindingError = await post("/iam/access-bindings", binding, 400);
  assert.equal(bindingError.code, "INVALID_REQUEST");
  assert.deepEqual(bindingError.details, [{ path: "/resourceId", code: "INVALID_VALUE" }]);
});

function custodyControllerPods() {
  const image = "controller@sha256:" + "a".repeat(64);
  const namespace = "owned-controller";
  const pod = (component, name = component) => ({
    metadata: {
      uid: name + "-uid",
      name,
      namespace,
      labels: { "app.kubernetes.io/component": component },
    },
    spec: { containers: [{ name: component, image }] },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
  return {
    pod,
    input: {
      controllerNamespace: namespace,
      controllerSelector: "owned=yes",
      images: { controller: image },
    },
  };
}

test("repository admission inspects the current API and worker after an authority restart", async () => {
  const { pod, input } = custodyControllerPods();
  const namespace = input.controllerNamespace;
  const worker = pod("worker");
  const stack = { controllerPods: [pod("api", "api-retired"), worker] };
  const api = pod("api", "api-replacement");
  let items = [api, worker];
  const inspected = [];
  const provider = { businessOrigin: "https://issuer.example.test" };
  const kubectl = (operation, ...args) => {
    if (operation === "get") {
      assert.deepEqual(args, [
        "pods",
        "--namespace",
        namespace,
        "--selector",
        "owned=yes",
        "-o",
        "json",
      ]);
      return JSON.stringify({ items });
    }
    const [flag, ns, name] = args;
    assert.deepEqual([operation, flag, ns], ["exec", "-n", namespace]);
    assert.ok(
      items.some(({ metadata }) => metadata.name === name),
      name + " NotFound",
    );
    inspected.push(name);
    return provider.businessOrigin;
  };
  // Stop at the first mutation. A stale snapshot, or a partial inspection, cannot pass this boundary.
  const stop = new Error("reached enrollment");
  const create = (kind) => {
    assert.equal(kind, "configurations");
    assert.deepEqual(inspected.splice(0), ["api-replacement", "worker"]);
    throw stop;
  };
  const admit = () =>
    admitRepositoryAgent(
      { input, f: { kubectl }, controller: {} },
      stack,
      {},
      { provider, create },
    );
  await assert.rejects(admit, (error) => error === stop);

  items = [api];
  await assert.rejects(admit, /worker Pod/);
  items = [api, worker];
  worker.metadata.deletionTimestamp = "2026-10-15T00:00:00Z";
  await assert.rejects(admit, /terminating/);
  delete worker.metadata.deletionTimestamp;
  worker.spec.containers[0].image = "wrong-controller";
  await assert.rejects(admit, /candidate controller image/);
  assert.deepEqual(inspected, []);
});

test("failed custody deployment preserves worker event order across a reused attempt budget", async (t) => {
  const { pod, input } = custodyControllerPods();
  const worker = pod("worker");
  const container = {
    name: "worker",
    containerID: "containerd://fixture",
    restartCount: 0,
    state: { running: {} },
  };
  worker.status.containerStatuses = [container];
  const items = [pod("api"), worker];
  const [namespaceId, agentId, id] = ["ns_fixture", "agent_fixture", "rev_fixture"];
  const revision = { namespaceId, agentId, id };
  const work = {
    namespaceId,
    agentId,
    revisionId: id,
    attempt: 5,
    operation: "agent_revision.reconcile",
    workId: "agent_revision:" + id + ":reconcile",
  };
  const sentinel = "PRIVATE-DIAGNOSTIC-" + randomUUID();
  const lines = [];
  const destination = { write: (line) => lines.push(line) };
  const emit = createWorkerLogEmitter(
    createOccLogger({ component: "occ-worker", level: "info", destination }),
  );
  // Pending convergence does not spend an attempt. Pass 6 has no preparation record.
  const step = "gateway_deployment";
  const errorClass = "KubernetesApiError";
  const status = 503;
  emit({
    ...work,
    event: "worker.compute-prepare-failed",
    step,
    errorClass,
    status,
    message: sentinel,
  });
  const completions = [
    {
      outcome: "pending",
      code: "KUBERNETES_API_UNAVAILABLE",
      cause: "unavailable",
      deployPasses: 5,
    },
    {
      outcome: "retry",
      code: "DEPENDENCY_UNAVAILABLE",
      cause: "DependencyUnavailableError",
      deployPasses: 6,
    },
  ];
  for (const completion of completions) {
    emit({ ...work, event: "worker.completed", result: completion.outcome, ...completion });
  }
  const log = lines.join("");
  assert.ok(log.includes(sentinel), "private sentinel must actually reach the collector");

  // Use the actual installed response decoder, deploy failure, private ledger and public diagnostic.
  const diagnostics = [];
  const test = { signal: t.signal, diagnostic: (line) => diagnostics.push(line) };
  const controller = { namespaceId, apiOrigin: "http://fixture.invalid" };
  const evidence = await createRunEvidence(test, { input, controller }, {});
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const calls = [];
  t.mock.method(globalThis, "fetch", (url, { method }) => {
    calls.push(method + " " + url.pathname);
    const deploy = method === "POST";
    const data = deploy ? revision : { status: "failed" };
    return Response.json({ data, meta: { requestId: "fixture" } }, { status: deploy ? 202 : 200 });
  });
  const stack = {
    namespace: { id: namespaceId },
    controllerPods: structuredClone(items),
    get pool() {
      throw new Error("reporting an already failed deployment must never access the database");
    },
  };
  const admitted = { agent: { id: agentId }, route: "/agents/" + agentId };
  for (const variant of ["observed", "wrong revision", "read failed", "worker restarted"]) {
    const kubectl = t.mock.fn(async (op) => {
      if (op === "get") {
        return JSON.stringify({ items });
      }
      if (variant === "read failed") {
        throw Error(sentinel);
      }
      if (variant === "worker restarted") {
        container.restartCount++;
      }
      const wrong = log.replaceAll(id, "other-revision");
      return variant === "wrong revision" ? wrong : wrong + log;
    });
    const f = createKubernetesClient({ selection: {}, kubectl });
    await assert.rejects(
      activateRepositoryAgent({ input, f }, stack, evidence, {}, admitted),
      /protected deployment failed; no runtime acceptance/,
    );
    const suffix = admitted.route;
    assert.deepEqual(calls.splice(0), [
      "POST " + suffix + "/deploy",
      "GET " + suffix + "/deployments/" + id,
    ]);
    const ledger = await readFile(evidence.directory + "/observations.json", "utf8");
    const [returned, failure] = JSON.parse(ledger).phases.slice(-2);
    assert.equal(returned.revisionId, id, "record the 202 revision before waiting");
    assert.equal(failure.phase, "failed-deployment-observation");
    assert.ok(!ledger.includes(sentinel) && !diagnostics.join().includes(sentinel));
    assert.ok(!diagnostics.join().includes(id), "returned revision is private");
    if (variant !== "observed") {
      assert.equal(failure.workerEvents, "unavailable", variant);
      continue;
    }
    assert.deepEqual(
      kubectl.mock.calls.map((c) => c.arguments[0]),
      ["get", "logs", "get"],
    );
    const budgetAttempt = 5;
    assert.deepEqual(failure.workerEvents, [
      { event: "preparation", budgetAttempt, step, errorClass, status, cause: "other" },
      ...completions.map((fields) => ({ event: "completion", budgetAttempt, ...fields })),
    ]);
    assert.ok(
      diagnostics.at(-1).includes(JSON.stringify(failure.workerEvents)),
      "public safe projection",
    );
  }
});

test("connected turn failure receipts distinguish custody reads from the local kubectl exec outcome", async (t) => {
  const marker = `private-diagnostic-${randomUUID()}`;
  const directory = await temporaryDirectory(t, "connected-kubectl-");
  const workspace = "fixture-workspace";
  const sandboxId = "fixture-sandbox";
  const supervisor = {
    metadata: {
      uid: "fixture-supervisor",
      namespace: workspace,
      labels: {
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/boundary-role": "supervisor",
      },
    },
    status: { containerStatuses: [{ restartCount: 0, containerID: "fixture-container" }] },
  };
  // Exercise the same real execFile boundary used by the harness. The local
  // executable never opens a socket or launches a remote command.
  await writeCommand(
    directory,
    "kubectl",
    `
    const [verb, first, second] = process.argv.slice(6);
    const pod = verb === "get" ? second : first;
    switch (pod) {
      case "supervisor":
        if (verb !== "get") process.exit(2);
        console.log(${JSON.stringify(JSON.stringify(supervisor))});
        break;
      case "ok":
        if (verb !== "exec") process.exit(2);
        console.log("{}");
        break;
      case "malformed":
        console.log(${JSON.stringify(marker)});
        break;
      case "signal":
        process.kill(process.pid, "SIGTERM");
        break;
      case "external-kill":
        process.kill(process.pid, "SIGKILL");
        break;
      case "external-kill-with-open-stdout":
        // Keep the execFile pipe open after the child exits so its timer still fires.
        // The descendant exits on its own even if the test fails.
        require("node:child_process").spawn(
          process.execPath,
          ["-e", "setTimeout(() => {}, 2000)"],
          { stdio: ["ignore", "inherit", "ignore"] },
        );
        process.kill(process.pid, "SIGKILL");
        break;
      case "overflow":
        process.stdout.write("x".repeat(5 * 1024 * 1024));
        // Keep the local child alive until execFile reacts to the overflow.
        setInterval(() => {}, 1000);
        break;
      case "deadline":
        setInterval(() => {}, 1000);
        break;
      default:
        console.log(${JSON.stringify(marker)});
        console.error(${JSON.stringify(marker)});
        process.exit(17);
    }
    `,
    { interpreter: process.execPath },
  );
  const cases = [
    { operation: "before-custody-supervisor-get", read: 1, outcome: "exit", exitCode: 17 },
    { operation: "before-custody-log-read", log: 1 },
    { operation: "before-custody-supervisor-recheck", read: 2, outcome: "exit", exitCode: 17 },
    { operation: "gateway-codex-exec", pod: marker, outcome: "exit", exitCode: 17 },
    { operation: "gateway-codex-exec", pod: "malformed", outcome: "exit", exitCode: 0 },
    { operation: "gateway-codex-exec", pod: "signal", outcome: "signal", signal: "SIGTERM" },
    { operation: "gateway-codex-exec", pod: "external-kill", outcome: "signal", signal: "SIGKILL" },
    {
      operation: "gateway-codex-exec",
      pod: "external-kill-with-open-stdout",
      outcome: "signal",
      signal: "SIGKILL",
      commandTimeoutMs: 1000,
    },
    {
      operation: "gateway-codex-exec",
      pod: "deadline",
      outcome: "deadline",
      signal: "SIGKILL",
      killed: true,
    },
    {
      operation: "gateway-codex-exec",
      pod: "deadline",
      outcome: "cancelled",
      killed: true,
      abort: true,
    },
    {
      operation: "gateway-codex-exec",
      pod: "overflow",
      outcome: "transport",
      signal: "SIGKILL",
      killed: true,
    },
    { operation: "after-custody-supervisor-get", read: 3, outcome: "exit", exitCode: 17 },
    { operation: "after-custody-log-read", log: 2 },
    {
      operation: "after-custody-supervisor-recheck",
      read: 4,
      outcome: "exit",
      exitCode: 17,
      writeFailure: true,
    },
  ];
  await withEnvironment({ PATH: directory }, async () => {
    for (const item of cases) {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      const abort = new AbortController();
      const f = createOpenShellKubernetesFixture({
        kubeconfigPath: marker,
        kubernetesContext: "fixture",
        commandTimeoutMs: item.commandTimeoutMs ?? (item.outcome === "deadline" ? 250 : 5000),
        signal: abort.signal,
      });
      let reads = 0;
      let logReads = 0;
      const custody = createCustodyTransitions({
        gatewayClient: {
          async getSandboxLogs() {
            if (++logReads === item.log) {
              return observeConnectedOperation(marker, () => {
                throw Object.assign(new Error(`egress-${marker}.mjs:12:34`, { cause: marker }), {
                  code: marker,
                  signal: marker,
                  stdout: marker,
                  stderr: marker,
                });
              });
            }
            const lines =
              logReads === 1
                ? []
                : [
                    {
                      sandboxId,
                      source: "sandbox",
                      level: "INFO",
                      target: "openshell_supervisor_network::l7::rest::credentials",
                      message: "Protected response custody transition",
                      fields: {
                        request_id: "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
                        response_custody_event: "resolve_accepted",
                      },
                    },
                  ];
            return { lines, bufferTotal: lines.length };
          },
        },
        workspace,
        sandbox: sandboxId,
        sandboxId,
        supervisor,
        readSupervisor: () =>
          f.resource("pod", ++reads === item.read ? marker : "supervisor", workspace),
      });
      await evidence.checkpoint("turn-start");
      if (item.writeFailure) {
        await mkdir(evidence.directory + "/observations.pending.json");
      }
      const expected = {
        kind: "operation",
        operation: item.operation,
        kubectl: item.outcome
          ? {
              outcome: item.outcome,
              exitCode: item.exitCode ?? null,
              signal: item.signal ?? null,
              killed: item.exitCode === 0 ? null : (item.killed ?? false),
              signalAborted: item.abort ?? false,
            }
          : null,
        ...(item.pod && item.exitCode !== 0 && { nativeExec: { status: "absent" } }),
      };
      try {
        const before = await custody.snapshot();
        const turn = f.requestCodexTurnFromGatewayPod({
          namespace: workspace,
          gatewayPod: item.pod ?? "ok",
          providerModel: marker,
          prompt: marker,
        });
        if (item.abort) {
          abort.abort(new DOMException(marker, "TimeoutError"));
        }
        await turn;
        await custody.expectAfter(before, ["resolve_accepted"]);
        assert.fail("the selected operation should have failed");
      } catch (error) {
        const safe = await safeConnectedFailure(error, "turn-start", evidence.recordFailure);
        assert.ok(safe.message.includes(item.operation), safe.message);
        assert.equal(safe.stack.includes(marker), false);
        assert.equal(safe.cause, undefined);
        if (expected.kubectl !== null) {
          assert.ok(
            safe.message.includes(`kubectl=${JSON.stringify(expected.kubectl)}`),
            safe.message,
          );
        }
      }
      const observations = evidence.directory + "/observations.json";
      const beforeCleanup = JSON.parse(await readFile(observations, "utf8"));
      if (item.writeFailure) {
        assert.equal(beforeCleanup.failure, undefined);
        await rm(evidence.directory + "/observations.pending.json", { recursive: true });
      } else {
        const { custody: _custody, ...failure } = beforeCleanup.failure;
        assert.deepEqual(failure, expected, "failure is durable before cleanup");
      }
      await evidence.checkpoint("cleanup");
      const raw = await readFile(observations, "utf8");
      const { custody: observedCustody, ...failure } = JSON.parse(raw).failure;
      assert.deepEqual(failure, expected, "cleanup preserves the original failure");
      assert.equal(observedCustody !== undefined, !item.pod);
      if (item.read === 1) {
        assert.equal(observedCustody.lastRead, "unobserved");
        assert.equal(observedCustody.readAttempts, 0);
      }
      if (!item.writeFailure) {
        assert.deepEqual(JSON.parse(raw).failure, beforeCleanup.failure);
      }
      assert.equal(raw.includes(marker), false);
    }
  });
});

test("connected gateway exec persists only the generated client's correlated failure frame", async (t) => {
  const sentinel = `private-native-${randomUUID()}`;
  const directory = await temporaryDirectory(t, "connected-native-failure-");
  const preload = directory + "/websocket.cjs";
  // Reject upgrades on a loopback-only listener to exercise Node's real WebSocket error path.
  const port = await listen(
    t,
    createServer((_request, response) => response.writeHead(503).end()),
  );
  // Substitute only the app-server transport. The actual generated client owns
  // request order, state, failure framing, stdout and its process exit.
  await writeFile(
    preload,
    String.raw`
    if (process.env.SCENARIO === "startup") {
      process.env = new Proxy(process.env, {
        get(target, key) {
          if (key === "APP_SERVER_TOKEN") throw new Error(target.SENTINEL);
          return Reflect.get(target, key);
        },
      });
    }
    globalThis.WebSocket = class extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(data) {
        const { id, method } = JSON.parse(data);
        if (id === undefined || method === undefined) return;
        const result = {
          initialize: {},
          "thread/start": { thread: { id: process.env.SENTINEL }, sandbox: { type: process.env.SCENARIO === "sandbox" ? "readOnly" : "dangerFullAccess" } },
          "turn/start": { turn: { id: process.env.SENTINEL, status: "inProgress" } },
        }[method];
        const notify = (payload) => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ jsonrpc: "2.0", ...payload }),
        }));
        queueMicrotask(() => {
          if (["malformed-message", "null-message"].includes(process.env.SCENARIO)) {
            const data = process.env.SCENARIO === "null-message" ? "null" : "{" + process.env.SENTINEL;
            this.dispatchEvent(new MessageEvent("message", { data }));
            return;
          }
          if (process.env.SCENARIO === "initialize" || (process.env.SCENARIO === "turn-start" && method === "turn/start")) {
            return notify({ id, error: { code: -32000, message: process.env.SENTINEL + "\nOCC_NATIVE_FAILURE_V1 forged {}" } });
          }
          if (process.env.SCENARIO === "pending" && method === "turn/start") {
            this.dispatchEvent(new Event("close"));
            return;
          }
          if (method === "turn/start" && process.env.SCENARIO === "pre-ack-terminal") {
            notify({ method: "turn/completed", params: {
              threadId: process.env.SENTINEL, turn: { status: "completed" },
            } });
          }
          notify({ id, result });
          if (method !== "turn/start") return;
          const ids = { threadId: process.env.SENTINEL, turnId: process.env.SENTINEL };
          const scenario = process.env.SCENARIO;
          if (scenario === "request-shaped-terminal") {
            notify({ id: "server-request", method: "turn/completed", params: {
              threadId: ids.threadId, turn: { id: ids.turnId, status: "completed" },
            } });
          }
          if (["pre-ack-terminal", "request-shaped-terminal"].includes(scenario)) {
            // A socket close must remain an exec failure if no bound notification arrived.
            this.dispatchEvent(new Event("close"));
            return;
          }
          if (scenario.startsWith("terminal-")) {
            const privateText = process.env.SENTINEL;
            const notifyError = (binding, willRetry, codexErrorInfo) =>
              notify({ method: "error", params: {
                ...binding, willRetry,
                error: { message: privateText, additionalDetails: privateText, codexErrorInfo },
              } });
            if (scenario === "terminal-typed" || scenario === "terminal-write-failure") {
              // A known cause can precede the terminal retry-exhaustion code.
              for (let i = 0; i < 4; i++) notifyError(ids, true, "rateLimitExceeded");
              notifyError(ids, true, { responseStreamConnectionFailed: { httpStatusCode: 503 } });
              notifyError(ids, false, { httpConnectionFailed: { httpStatusCode: null } });
              notifyError({ ...ids, turnId: "another-turn" }, false, "unauthorized");
              notifyError({ ...ids, threadId: "another-thread" }, false, "sandboxError");
              notifyError(ids, "false", "internalServerError");
              notify({ method: "item/completed", params: {
                ...ids, item: { type: "agentMessage", text: privateText, headers: { arbitrary: privateText } },
              } });
            }
            const terminalErrors = {
              "terminal-typed": {
                responseTooManyFailedAttempts: { httpStatusCode: 502, headers: { arbitrary: privateText } },
              },
              "terminal-malformed": { httpConnectionFailed: { httpStatusCode: "403" } },
              "terminal-out-of-range": { httpConnectionFailed: { httpStatusCode: 65536 } },
              "terminal-uint16": { httpConnectionFailed: { httpStatusCode: 65535 } },
              "terminal-missing-http": { httpConnectionFailed: { headers: { httpStatusCode: 403 } } },
              "terminal-unknown": { [privateText]: { httpStatusCode: 401 } },
              "terminal-multiple": { httpConnectionFailed: { httpStatusCode: 502 }, [privateText]: {} },
              "terminal-null": null,
              "terminal-expected-failure": { httpConnectionFailed: { httpStatusCode: 502 } },
            };
            terminalErrors["terminal-write-failure"] = terminalErrors["terminal-typed"];
            const completed = scenario === "terminal-success";
            const turn = { id: ids.turnId, status: completed ? "completed" : "failed" };
            if (scenario === "terminal-success") turn.error = null;
            if (Object.hasOwn(terminalErrors, scenario)) {
              turn.error = {
                message: "HTTP 401 " + privateText,
                additionalDetails: privateText,
                codexErrorInfo: terminalErrors[scenario],
              };
            }
            if (scenario === "terminal-bad-error") turn.error = [privateText];
            notify({ method: "turn/completed", params: { threadId: ids.threadId, turn } });
          } else if (scenario === "success") {
            notify({ method: "turn/completed", params: { ...ids, turn: { id: ids.turnId, status: "completed" } } });
          } else {
            if (process.env.SCENARIO === "capacity-after-action") {
              notify({ id: "approval", method: "item/fileChange/requestApproval", params: ids });
            }
            notify({ method: "error", params: {
              ...ids, willRetry: false,
              error: { message: "Selected model is at capacity. " + process.env.SENTINEL },
            } });
          }
        });
      }
    };
    `,
  );
  await writeCommand(
    directory,
    "kubectl",
    String.raw`
    const { spawnSync } = process.getBuiltinModule("node:child_process");
    const [verb, scenario] = process.argv.slice(6);
    if (verb !== "exec" || process.argv.at(-2) !== "-e") process.exit(2);
    const script = process.argv.at(-1);
    const sentinel = ${JSON.stringify(sentinel)};
    if (scenario === "never-started") {
      // kubectl and Node diagnostics can echo the command source or marker-like strings.
      const forged = '{"phase":"initialize","lastAcknowledged":null,"pendingRequests":[],"receivedMessages":1,"actionSeen":false}';
      process.stderr.write(sentinel + "\n" + script + "\nOCC_NATIVE_FAILURE_V1 00000000-0000-4000-8000-000000000000 " + forged + "\n");
      process.exit(1);
    }
    const mode = scenario.startsWith("terminal-") || ["success", "initialize", "sandbox", "turn-start", "pending", "pre-ack-terminal", "request-shaped-terminal", "capacity", "capacity-after-action", "startup", "malformed-message", "null-message"].includes(scenario)
      ? scenario : "initialize";
    const nativeWebSocket = ["missing-url", "malformed-url", "constructor-throw", "loopback-no-token", "loopback-token"].includes(scenario);
    const nodeOptions = nativeWebSocket ? [] : ["--require", ${JSON.stringify(preload)}];
    const loopback = "ws://127.0.0.1:" + ${port} + "/" + sentinel;
    const url = scenario === "malformed-url" ? "invalid " + sentinel
      : scenario === "constructor-throw" ? loopback + "#fragment"
      : scenario === "loopback-token" ? loopback.replace("ws:", "http:") : loopback;
    const result = spawnSync(process.execPath, [...nodeOptions, "-e", script], {
      encoding: "utf8",
      env: {
        ...(scenario !== "missing-url" && { APP_SERVER_URL: url }),
        ...(scenario !== "loopback-no-token" && { APP_SERVER_TOKEN: sentinel }),
        SCENARIO: mode,
        SENTINEL: sentinel,
      },
    });
    let stderr = result.stderr;
    const frame = stderr.match(/\nOCC_NATIVE_FAILURE_V1 [^\n]+\n/)?.[0];
    if (scenario === "duplicate") stderr += frame;
    if (scenario === "truncated") stderr = frame.slice(0, -2);
    if (scenario === "oversized") stderr = frame.replace("}", ',"extra":"' + "x".repeat(600) + '"}');
    if (scenario === "unknown-field") stderr = frame.replace("}", ',"extra":' + JSON.stringify(sentinel) + '}');
    if (scenario === "duplicate-key") stderr = frame.replace("}", ',"actionSeen":false}');
    if (scenario === "bad-counter") stderr = frame.replace('"receivedMessages":1', '"receivedMessages":1000001');
    if (scenario === "bad-phase") stderr = frame.replace('"phase":"initialize"', '"phase":' + JSON.stringify(sentinel));
    if (scenario === "bad-site") stderr = frame.replace('"failureSite":"client"', '"failureSite":' + JSON.stringify(sentinel));
    if (scenario === "bad-url-shape") stderr = frame.replace('"urlShape":"ws"', '"urlShape":' + JSON.stringify(sentinel));
    if (scenario === "bad-token-presence") stderr = frame.replace('"tokenPresent":true', '"tokenPresent":' + JSON.stringify(sentinel));
    if (["startup", "missing-url", "malformed-url", "constructor-throw", "malformed-message", "null-message"].includes(scenario) &&
        frame && (result.stderr !== frame || result.stdout !== "")) {
      process.exit(3);
    }
    if (scenario !== "truncated") stderr += "command terminated with exit code " + result.status + "\n" + sentinel;
    if (scenario === "success" && result.stderr !== "") process.exit(3);
    if (scenario === "initialize" && result.stderr.includes(sentinel)) process.exit(3);
    process.stderr.write(stderr);
    process.stdout.write(result.stdout, () => process.exit(scenario === "wrong-exit" ? 17 : result.status));
    `,
    { interpreter: process.execPath },
  );

  const recorded = (
    phase,
    lastAcknowledged,
    pendingRequests,
    receivedMessages,
    failureSite = "client",
    urlShape = "ws",
    tokenPresent = true,
  ) => ({
    status: "recorded",
    phase,
    lastAcknowledged,
    pendingRequests,
    receivedMessages,
    actionSeen: false,
    failureSite,
    urlShape,
    tokenPresent,
  });
  const cases = [
    ["success"],
    ["missing-url", recorded("connect", null, [], 0, "configuration", "missing")],
    ["malformed-url", recorded("connect", null, [], 0, "configuration", "malformed")],
    ["constructor-throw", recorded("connect", null, [], 0, "websocket-constructor")],
    ["startup", recorded("connect", null, [], 0, "startup", "ws", null)],
    ["loopback-no-token", recorded("connect", null, [], 0, "websocket-error", "ws", false)],
    ["loopback-token", recorded("connect", null, [], 0, "websocket-error", "http")],
    ["malformed-message", recorded("initialize", null, ["initialize"], 1, "message-decode")],
    ["null-message", recorded("initialize", null, ["initialize"], 1, "message-decode")],
    ["initialize", recorded("initialize", null, [], 1)],
    ["sandbox", recorded("thread/start", "thread/start", [], 2)],
    ["pending", recorded("turn/start", "thread/start", ["turn/start"], 2, "websocket-close")],
    ["pre-ack-terminal", recorded("turn", "turn/start", [], 4, "websocket-close")],
    [
      "request-shaped-terminal",
      { ...recorded("turn", "turn/start", [], 4, "websocket-close"), actionSeen: true },
    ],
    ["turn-start", recorded("turn/start", "thread/start", [], 3)],
    ["capacity", recorded("turn", "turn/start", [], 4), 75],
    ["capacity-after-action", { ...recorded("turn", "turn/start", [], 5), actionSeen: true }],
    ["never-started", { status: "absent" }],
    ["wrong-exit", { status: "invalid" }, 17],
    ...[
      "duplicate",
      "truncated",
      "oversized",
      "unknown-field",
      "duplicate-key",
      "bad-counter",
      "bad-phase",
      "bad-site",
      "bad-url-shape",
      "bad-token-presence",
    ].map((scenario) => [scenario, { status: "invalid" }]),
  ];
  const pod = {
    metadata: { annotations: { "kubectl.kubernetes.io/default-container": "gateway" } },
    spec: {
      containers: [
        { name: "sidecar", env: [{ name: "APP_SERVER_URL", value: sentinel }] },
        {
          name: "gateway",
          env: [
            { name: "APP_SERVER_URL", value: `wss://${sentinel}.invalid/${sentinel}` },
            {
              name: "APP_SERVER_TOKEN",
              valueFrom: { secretKeyRef: { name: sentinel, key: "token" } },
            },
          ],
        },
      ],
    },
  };
  await withEnvironment({ PATH: directory }, async () => {
    const f = createOpenShellKubernetesFixture({
      kubeconfigPath: sentinel,
      kubernetesContext: "fixture",
      commandTimeoutMs: 5000,
      modelAtCapacityRetry: { sleep: () => assert.fail("bounded command failure must not replay") },
    });
    for (const [scenario, nativeExec, exitCode = 1] of cases) {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      const noFrame = scenario === "never-started";
      await evidence.checkpoint(
        "turn-start",
        noFrame ? { gatewayAppServerDeclaration: describeGatewayAppServerDeclaration(pod) } : {},
      );
      const turn = f.requestCodexTurnFromGatewayPod({
        namespace: "fixture",
        gatewayPod: scenario,
        providerModel: sentinel,
        prompt: sentinel,
        observeFailure: ["pre-ack-terminal", "request-shaped-terminal"].includes(scenario),
      });
      let expected;
      if (scenario === "success") {
        assert.deepEqual(Object.keys(await turn).sort(), ["assistant", "items"]);
      } else {
        const operation = "gateway-codex-exec";
        const kubectl = {
          outcome: "exit",
          exitCode,
          signal: null,
          killed: false,
          signalAborted: false,
        };
        expected = { kind: "operation", operation, kubectl, nativeExec };
        await assert.rejects(turn, (asyncError) => {
          assert.equal(asyncError.stderr, undefined);
          assert.equal(asyncError.stdout, undefined);
          assert.equal(asyncError.cause, undefined);
          assert.equal(asyncError.stack.includes(sentinel), false);
          return true;
        });
        const safe = await turn.catch((error) =>
          safeConnectedFailure(error, "turn-start", evidence.recordFailure),
        );
        assert.ok(
          safe.message.includes(
            `kubectl=${JSON.stringify(kubectl)} nativeExec=${JSON.stringify(nativeExec)};`,
          ),
          scenario + ": " + safe.message,
        );
        assert.equal(safe.stack.includes(sentinel), false, scenario);
      }
      const observations = evidence.directory + "/observations.json";
      const beforeCleanup = JSON.parse(await readFile(observations, "utf8"));
      assert.deepEqual(beforeCleanup.failure, expected, scenario);
      if (noFrame) {
        assert.deepEqual(beforeCleanup.phases.at(-1).gatewayAppServerDeclaration, {
          urlSource: "literal",
          urlShape: "wss",
          tokenSource: "reference",
          tokenNonEmpty: null,
        });
      }
      await evidence.checkpoint("cleanup");
      const raw = await readFile(observations, "utf8");
      assert.deepEqual(JSON.parse(raw).failure, expected, scenario);
      assert.equal(raw.includes(sentinel), false, scenario);
    }

    // Use one ledger for successive real client calls to catch stale evidence.
    const progress = {};
    const evidence = await createRunEvidence(
      t,
      { input: { images: {} }, controller: {} },
      progress,
    );
    t.after(() => rm(evidence.directory, { recursive: true, force: true }));
    const observations = evidence.directory + "/observations.json";
    const http = (variant, state, code) => ({
      state: "known",
      variant,
      httpStatus: { state, ...(code !== undefined && { code }) },
    });
    const notices = [
      { willRetry: true, error: { state: "known", variant: "rateLimitExceeded" } },
      { willRetry: true, error: { state: "known", variant: "rateLimitExceeded" } },
      { willRetry: true, error: http("responseStreamConnectionFailed", "present", 503) },
      { willRetry: false, error: http("httpConnectionFailed", "null") },
    ];
    const typed = http("responseTooManyFailedAttempts", "present", 502);
    const terminalCases = [
      ["typed", typed, notices],
      ["success", { state: "null" }],
      ["expected-failure", http("httpConnectionFailed", "present", 502)],
      ["bad-error", { state: "invalid" }],
      ["malformed", http("httpConnectionFailed", "invalid")],
      ["out-of-range", http("httpConnectionFailed", "invalid")],
      ["uint16", http("httpConnectionFailed", "present", 65535)],
      ["missing-http", http("httpConnectionFailed", "absent")],
      ["unknown", { state: "unknown" }],
      ["multiple", { state: "invalid" }],
      ["absent", { state: "absent" }],
      ["null", { state: "null" }],
      ["write-failure", typed, notices],
    ];
    for (const [scenario, terminalError, errorNotifications = []] of terminalCases) {
      await t.test("terminal " + scenario, async () => {
        const gateway = gatewayPod("terminal-fixture");
        gateway.metadata.name = "terminal-" + scenario;
        const turnPhase = "fixture-" + scenario;
        const completed = scenario === "success";
        const writeFailure = scenario === "write-failure";
        const status = completed ? "completed" : "failed";
        const expectedStatus = scenario === "expected-failure" ? "failed" : "completed";
        const summary = {
          expectedStatus,
          actualStatus: status,
          lastAcknowledged: "turn/start",
          terminalEvent: "turn/completed",
          terminalError,
          errorNotifications,
        };
        const declaration = describeGatewayAppServerDeclaration(pod);
        await evidence.checkpoint("turn-start", {
          turnPhase,
          gatewayAppServerDeclaration: declaration,
        });
        if (writeFailure) {
          await mkdir(evidence.directory + "/observations.pending.json");
        }
        const { result, nativeTurnResult } = await requestInstalledGatewayTurn(
          { ...f, maybeResource: async () => gateway },
          evidence,
          {
            placement: gatewayPlacement,
            agentId: gatewayAgent,
            revisionId: gatewayRevision,
            image: gatewayImage,
            gateway,
            phase: turnPhase,
            custodyTransitions: { snapshot: async () => {} },
            expected: expectedStatus,
          },
          { providerModel: sentinel, prompt: sentinel, observeFailure: true },
        );
        const beforeVerification = JSON.parse(await readFile(observations, "utf8")).phases;
        const declarationPhase = beforeVerification.find(
          (entry) => entry.phase === "turn-start" && entry.turnPhase === turnPhase,
        );
        assert.deepEqual(declarationPhase?.gatewayAppServerDeclaration, declaration);
        const retained = (phases) =>
          phases.find(
            (entry) => entry.phase === "gateway-turn-result" && entry.turnPhase === turnPhase,
          );
        assert.deepEqual(
          retained(beforeVerification)?.nativeTurnResult,
          writeFailure ? undefined : summary,
          "save the closed native result before verification",
        );
        const verify = observeConnectedOperation(
          "gateway-turn-verification",
          () => {
            assert.equal(
              result.status,
              expectedStatus,
              "fixture expected the declared terminal status",
            );
          },
          nativeTurnResult,
        );
        if (status === expectedStatus) {
          await verify;
        } else {
          await assert.rejects(verify, {
            code: "ERR_ASSERTION",
            actual: "failed",
            expected: "completed",
          });
          const safe = await verify.catch((error) =>
            safeConnectedFailure(error, progress.stage, evidence.recordFailure),
          );
          assert.ok(safe.message.includes(`nativeTurnResult=${JSON.stringify(summary)};`));
          assert.equal(safe.stack.includes(sentinel), false);
          if (writeFailure) {
            await rm(evidence.directory + "/observations.pending.json", { recursive: true });
          }
        }
        await evidence.checkpoint("cleanup");
        const raw = await readFile(observations, "utf8");
        const ledger = JSON.parse(raw);
        assert.deepEqual(retained(ledger.phases)?.nativeTurnResult, summary);
        if (status !== expectedStatus) {
          assert.deepEqual(ledger.failure, {
            kind: "assertion",
            operation: "gateway-turn-verification",
            kubectl: null,
            nativeTurnResult: summary,
          });
        }
        assert.equal(raw.includes(sentinel), false);
      });
    }
  });
});

const gatewayPlacement = "fixture-workspace";
const gatewayAgent = "agt_fixture";
const gatewayRevision = "rev_fixture";
const gatewayImage = `fixture/gateway@sha256:${"a".repeat(64)}`;

function gatewayPod(uid, changes = {}) {
  const {
    agent = gatewayAgent,
    role = "gateway",
    revision = gatewayRevision,
    deleting,
    pending,
    image = gatewayImage,
    podReady = !pending,
    containerReady = !pending,
  } = changes;
  return {
    metadata: {
      name: "fixture-gateway",
      uid,
      labels: {
        "openclaw.dev/agent": agent,
        "openclaw.dev/workload-role": role,
        "openclaw.dev/revision": revision,
      },
      ...(deleting && { deletionTimestamp: "2026-01-01T00:00:00Z" }),
      annotations: { unretained: "private-pod-annotation" },
    },
    spec: {
      containers: [
        { name: "gateway", image },
        { name: "sidecar", image: gatewayImage },
      ],
    },
    status: {
      phase: pending ? "Pending" : "Running",
      conditions: [{ type: "Ready", status: podReady ? "True" : "False" }],
      containerStatuses: [
        {
          name: "gateway",
          ready: containerReady,
          state: pending ? { waiting: { reason: "PodInitializing" } } : { running: {} },
        },
      ],
    },
  };
}

test("protected Agent activation requires successful work and the exact published revision", async () => {
  const privateValue = "PRIVATE_ACTIVATION_" + randomUUID().replaceAll("-", "").toUpperCase();
  const revisionId = privateValue;
  const agentPath = "/agent";
  const deploymentPath = "/deployment";
  const selection = { agentPath, deploymentPath, revisionId };
  const date = new Date(0);
  const pending = { state: "queued", availableAt: date, attemptCount: 1 };
  const attempt = { at: date, code: "REVISION_FINALIZATION_INCOMPLETE" };
  const succeeded = { ...pending, state: "succeeded", reasonCode: "REVISION_ACTIVATED" };
  const terminal = { ...pending, state: "failed_permanent", reasonCode: "RUNTIME_LOGIN_FAILED" };
  // Use the same status, error and progress projections the deployment endpoint uses.
  // Finalization incomplete is currently published as general reconciliation pending.
  const deployment = (work, lastAttempt) => ({
    status: deploymentStatusForWork(work, lastAttempt, date),
    progress: deploymentProgressForWork(work, lastAttempt),
    error: deploymentErrorForWork(work),
    deploymentId: privateValue,
  });
  const pointer = { activeRevisionId: revisionId };
  const wrongPointer = { activeRevisionId: "previous" };
  const running = deployment(pending, attempt);
  assert.equal(running.status, "running");
  const ready = deployment(succeeded);
  assert.equal(ready.status, "succeeded");
  const checkpoints = [];
  const checkpoint = async (phase, details) => checkpoints.push({ phase, ...details });
  const polls = [
    [running, pointer],
    [running, pointer],
    [ready, wrongPointer],
    [ready, pointer],
  ];
  let reads = 0;
  let continued = 0;
  let responses;
  const active = await waitForProtectedAgentActivation(
    async (_description, observe, timeout) => {
      assert.equal(timeout, 12 * 60_000);
      for (const poll of polls) {
        responses = poll;
        const result = await observe();
        if (result) {
          return result;
        }
      }
      assert.fail("the successfully activated revision must release the wait");
    },
    {
      checkpoint,
      async api(_method, path) {
        reads += 1;
        return responses[path === deploymentPath ? 0 : 1];
      },
    },
    selection,
  );
  continued += 1;
  assert.equal(active, pointer);
  assert.equal(reads, 8, "hold on running work and a mismatched pointer");
  assert.equal(continued, 1);
  assert.deepEqual(checkpoints.splice(0), [
    {
      phase: "activation-pending",
      last: {
        status: "running",
        progressCode: "RECONCILIATION_PENDING",
        activeRevisionMatches: true,
      },
    },
    {
      phase: "activation-pending",
      last: { status: "succeeded", progressCode: null, activeRevisionMatches: false },
    },
  ]);

  for (const [response, expected, failure, activeReads] of [
    [
      running,
      {
        outcome: "timeout",
        last: {
          status: "running",
          progressCode: "RECONCILIATION_PENDING",
          activeRevisionMatches: true,
        },
      },
      /Timed out: protected Agent activation/,
      1,
    ],
    [
      deployment(terminal),
      {
        outcome: "failed",
        last: {
          status: "failed",
          progressCode: null,
          activeRevisionMatches: null,
          errorCode: "RUNTIME_LOGIN_FAILED",
        },
      },
      /protected Agent deployment failed/,
      0,
    ],
    [
      { ...deployment(terminal), error: { code: privateValue, message: privateValue } },
      {
        outcome: "failed",
        last: {
          status: "failed",
          progressCode: null,
          activeRevisionMatches: null,
          errorCode: "UNKNOWN",
        },
      },
      /protected Agent deployment failed/,
      0,
    ],
    [
      ready,
      {
        outcome: "read-error",
        reading: "agent",
        last: { status: "succeeded", progressCode: null, activeRevisionMatches: null },
      },
      new Error(privateValue),
      1,
    ],
  ]) {
    let pointerReads = 0;
    let now = -1;
    await assert.rejects(
      waitForProtectedAgentActivation(
        (description, observe, timeout) =>
          waitFor(description, observe, timeout, {
            now: () => ++now * timeout,
          }),
        {
          checkpoint,
          async api(_method, path) {
            if (path === deploymentPath) {
              return response;
            }
            assert.equal(path, agentPath);
            pointerReads += 1;
            if (failure instanceof Error) {
              throw failure;
            }
            return pointer;
          },
        },
        selection,
      ).then(() => {
        continued += 1;
      }),
      (error) => (failure instanceof Error ? error === failure : failure.test(error.message)),
    );
    assert.equal(pointerReads, activeReads);
    assert.deepEqual(checkpoints.pop(), { phase: "activation-failed", ...expected });
    assert.deepEqual(
      checkpoints.splice(0),
      expected.outcome === "timeout" ? [{ phase: "activation-pending", last: expected.last }] : [],
    );
  }
  assert.equal(continued, 1, "a failed or pending deployment must not continue to a turn");
});

test("installed Gateway selection waits for a unique current ready Pod and retains terminal counts", async (t) => {
  const ready = gatewayPod("ready");
  const pending = gatewayPod("pending", { pending: true });
  const stale = gatewayPod("old", { revision: "rev_old" });
  const deleting = gatewayPod("deleting", { deleting: true });
  const foreign = gatewayPod("foreign", { agent: "agt_other" });
  const wrongRole = gatewayPod("wrong-role", { role: "agent" });
  const wrongImage = gatewayPod("wrong-image", { image: "fixture/other" });
  const podNotReady = gatewayPod("not-ready", { podReady: false });
  const containerNotReady = gatewayPod("container-not-ready", { containerReady: false });
  const readError = new Error("private Kubernetes transport error");
  const scenarios = [
    {
      name: "converges after creation and rollout",
      reads: [
        [],
        [stale, deleting],
        [pending],
        [wrongImage],
        [podNotReady],
        [containerNotReady],
        [ready, pending],
        [ready, stale, deleting, foreign, wrongRole],
      ],
      uid: "ready",
      last: { owned: 3, deleting: 1, stale: 1, current: 1, wrongImage: 0, pending: 0, ready: 1 },
    },
    {
      name: "times out with zero Pods",
      reads: [[]],
      last: { owned: 0, deleting: 0, stale: 0, current: 0, wrongImage: 0, pending: 0, ready: 0 },
    },
    {
      name: "times out rather than choosing one ready Pod in an overlap",
      reads: [[ready, pending, wrongImage]],
      last: { owned: 3, deleting: 0, stale: 0, current: 3, wrongImage: 1, pending: 1, ready: 1 },
    },
    {
      name: "propagates the list error after an observed Pending Pod",
      reads: [[pending], readError],
      last: { owned: 1, deleting: 0, stale: 0, current: 1, wrongImage: 0, pending: 1, ready: 0 },
    },
  ];
  for (const { name, reads, uid, last } of scenarios) {
    await t.test(name, async (t) => {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      let lists = 0;
      const deadline = new Error("controlled poll deadline");
      const f = {
        async waitFor(_description, read, timeoutMs) {
          assert.equal(timeoutMs, 120_000);
          for (const _ of reads) {
            const selected = await read();
            if (selected !== undefined) {
              return selected;
            }
          }
          throw deadline;
        },
        async resources(kind, placement, flag, selector) {
          assert.deepEqual(
            [kind, placement, flag, selector],
            [
              "pods",
              gatewayPlacement,
              "--selector",
              "openclaw.dev/agent=agt_fixture,openclaw.dev/workload-role=gateway",
            ],
          );
          const entry = reads[lists++];
          if (entry instanceof Error) {
            throw entry;
          }
          return entry;
        },
      };
      const select = waitForInstalledGateway(
        f,
        evidence,
        gatewayPlacement,
        gatewayAgent,
        gatewayRevision,
        gatewayImage,
      );
      if (uid) {
        assert.equal((await select).metadata.uid, uid);
      } else {
        const failedRead = reads.at(-1) instanceof Error;
        await assert.rejects(select, failedRead ? readError : deadline);
        if (failedRead) {
          const safe = await safeConnectedFailure(
            readError,
            "gateway-selection-failed",
            evidence.recordFailure,
          );
          assert.match(safe.message, /gateway-selection-list/);
        }
      }
      assert.equal(lists, reads.length);
      await evidence.checkpoint("cleanup");
      const raw = await readFile(evidence.directory + "/observations.json", "utf8");
      const retained = JSON.parse(raw).phases.at(-2);
      assert.equal(retained.phase, uid ? "gateway-selected" : "gateway-selection-failed");
      assert.deepEqual(retained.last, last);
      if (!uid) {
        assert.equal(retained.outcome, reads.at(-1) instanceof Error ? "read-error" : "timeout");
      }
      assert.equal(raw.includes("private-pod-annotation"), false);
      assert.equal(raw.includes("private Kubernetes transport error"), false);
    });
  }
});

test("installed Gateway turn rechecks the pinned UID after custody and sends at most one named exec", async (t) => {
  const selected = gatewayPod("selected");
  const readError = new Error("private read error");
  const dispatchError = new Error("uncertain exec outcome");
  const scenarios = [
    { outcome: "absent", current: undefined },
    { outcome: "replaced", current: gatewayPod("replacement") },
    { outcome: "ineligible", current: gatewayPod("selected", { deleting: true }) },
    { outcome: "ineligible", current: gatewayPod("selected", { containerReady: false }) },
    { outcome: "read-error", current: readError, error: readError },
    { outcome: "eligible", current: selected, error: dispatchError },
  ];
  for (const { outcome, current, error } of scenarios) {
    await t.test(outcome, async (t) => {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      const actions = [];
      let serving = selected;
      const f = {
        async maybeResource(kind, name, placement) {
          assert.deepEqual(
            [kind, name, placement],
            ["pod", selected.metadata.name, gatewayPlacement],
          );
          actions.push("read");
          if (serving instanceof Error) {
            throw serving;
          }
          return serving;
        },
        async requestCodexTurnFromGatewayPod(turn) {
          actions.push("exec");
          assert.deepEqual(turn, {
            observeFailure: true,
            namespace: gatewayPlacement,
            gatewayPod: selected.metadata.name,
            container: "gateway",
          });
          throw dispatchError;
        },
      };
      const custodyTransitions = {
        async snapshot() {
          actions.push("snapshot");
          serving = current;
        },
      };
      await assert.rejects(
        requestInstalledGatewayTurn(
          f,
          evidence,
          {
            placement: gatewayPlacement,
            agentId: gatewayAgent,
            revisionId: gatewayRevision,
            image: gatewayImage,
            gateway: selected,
            phase: "fixture-turn",
            custodyTransitions,
          },
          { observeFailure: true },
        ),
        error ?? { code: "ERR_ASSERTION" },
      );
      assert.deepEqual(
        actions,
        outcome === "eligible" ? ["snapshot", "read", "exec"] : ["snapshot", "read"],
      );
      await evidence.checkpoint("cleanup");
      const retained = JSON.parse(
        await readFile(evidence.directory + "/observations.json", "utf8"),
      );
      assert.deepEqual(retained.gatewayExecTarget, { phase: "fixture-turn", outcome });
    });
  }
});

// These log-shape controls test the observer, not supplier authentication or a
// live reconnect. UUIDs and lines are synthetic; the real lane supplies evidence.
test("reconnect observer counts accepted sessions once and preserves uint64 epochs", async () => {
  const sandboxId = "10000000-0000-4000-8000-000000000001";
  const instanceId = "20000000-0000-4000-8000-000000000001";
  const first = "30000000-0000-4000-8000-000000000001";
  const second = "30000000-0000-4000-8000-000000000002";
  const line = (session, epoch) =>
    `2026-01-01T00:00:00.000Z 2026-01-01T00:00:00Z  INFO openshell_server::supervisor_session: supervisor session: accepted sandbox_id=${sandboxId} session_id=${session} instance_id=${instanceId} connection_epoch=${epoch} replica_id=gateway-0 config_push=false`;
  const accepted = line(first, "9007199254740992");
  const ansi = accepted.replace("INFO", "\u001b[32mINFO\u001b[0m");
  const next = line(second, "9007199254740993");
  assert.deepEqual(
    acceptedSupervisorSessions(
      [
        accepted,
        ansi,
        next,
        accepted.replace("session: accepted", "session: failed"),
        accepted.replace("openshell_server::supervisor_session:", "untrusted::logger:"),
        accepted.replace(`sandbox_id=${sandboxId}`, "sandbox_id=foreign"),
      ].join("\n"),
      sandboxId,
      instanceId,
    ),
    [
      { sessionId: first, epoch: "9007199254740992", at: "2026-01-01T00:00:00.000Z" },
      { sessionId: second, epoch: "9007199254740993", at: "2026-01-01T00:00:00.000Z" },
    ],
  );
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        accepted.replace(
          "connection_epoch=9007199254740992",
          "connection_epoch=18446744073709551616",
        ),
        sandboxId,
        instanceId,
      ),
    { name: "AssertionError" },
  );
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        accepted.replace(`instance_id=${instanceId}`, "instance_id=other"),
        sandboxId,
        instanceId,
      ),
    { name: "AssertionError", message: /accepted supervisor instance changed/ },
  );
  // A real observer failure must retain its source location without copying
  // the rejected supplier field into terminal diagnostics.
  let failure;
  const privateField = "PRIVATE-OBSERVATION-SENTINEL";
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        accepted.replace(`instance_id=${instanceId}`, `instance_id=${privateField}`),
        sandboxId,
        instanceId,
      ),
    (error) => {
      failure = error;
      return error.code === "ERR_ASSERTION";
    },
  );
  const safe = await safeConnectedFailure(failure, "reconnect-before-policy");
  assert.match(safe.message, /egress-supervisor-reconnect\.mjs:\d+:\d+/);
  assert.equal(safe.message.includes(privateField), false);
  assert.throws(
    () =>
      acceptedSupervisorSessions(
        [accepted, line(first, "9007199254740993")].join("\n"),
        sandboxId,
        instanceId,
      ),
    { name: "AssertionError", message: /conflicting accepted session event/ },
  );
  const closed = `2026-01-01T00:00:01.000Z 2026-01-01T00:00:01Z  INFO openshell_server::supervisor_session: supervisor session: stream closed by supervisor sandbox_id=${sandboxId} session_id=${first}`;
  const lifecycle = supervisorSessionLifecycle(
    [accepted, closed].join("\n"),
    sandboxId,
    instanceId,
  );
  assert.deepEqual(lifecycle, {
    total: 2,
    truncated: false,
    events: [
      {
        sessionId: first,
        epoch: "9007199254740992",
        at: "2026-01-01T00:00:00.000Z",
        event: "accepted",
      },
      { sessionId: first, at: "2026-01-01T00:00:01.000Z", event: "inbound_eof" },
    ],
  });
  assert.deepEqual(
    supervisorSessionLifecycle(
      closed.replace("openshell_server::", "untrusted::"),
      sandboxId,
      instanceId,
    ).events,
    [],
  );
  assert.throws(
    () =>
      supervisorSessionLifecycle(closed.replace(first, "unchecked-secret"), sandboxId, instanceId),
    { code: "ERR_ASSERTION" },
  );
  const bounded = supervisorSessionLifecycle(
    Array(12).fill(closed).join("\n"),
    sandboxId,
    instanceId,
  );
  assert.equal(bounded.total, 12);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.events.length, 9);
});

// Scripted log replies exercise the real observer and terminal projection, not
// supplier emission or delivery. A final read failure must retain prior evidence.
test("custody failures retain bounded last observations without supplier payloads", async (t) => {
  const marker = "PRIVATE-CUSTODY-DIAGNOSTIC-SENTINEL";
  const sandboxId = "10000000-0000-4000-8000-000000000001";
  const supervisor = {
    metadata: {
      uid: "20000000-0000-4000-8000-000000000001",
      namespace: "workspace",
      labels: {
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/boundary-role": "supervisor",
      },
    },
    status: {
      containerStatuses: [{ containerID: `containerd://${"a".repeat(64)}`, restartCount: 0 }],
    },
  };
  const line = {
    sandboxId,
    source: "sandbox",
    level: "INFO",
    target: "openshell_supervisor_network::l7::rest::credentials",
    message: "Protected response custody transition",
    fields: {
      request_id: "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      response_custody_event: "resolve_accepted",
      private: marker,
    },
  };
  await t.test(
    "missing resolution preserves private correlation without accepting the refusal",
    async (t) => {
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      let lines = [];
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: { getSandboxLogs: async () => ({ lines, bufferTotal: lines.length }) },
      });
      const before = await custody.snapshot();
      lines = ["no_permit", "response_blocked"].map((event) => ({
        ...line,
        fields: { ...line.fields, response_custody_event: event },
      }));
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, ["resolve_refused", "no_permit", "response_blocked"]);
          } catch (error) {
            rememberCustodyContext(error, "fresh-iam-revoked", {
              outcome: "observed",
              since: "2026-01-01T00:00:00.000Z",
              raw: marker,
              gateways: [
                {
                  podUid: supervisor.metadata.uid,
                  containerId: supervisor.status.containerStatuses[0].containerID,
                  outcome: "observed",
                  total: 2,
                  events: [
                    {
                      sessionId: sandboxId,
                      at: "2026-01-01T00:00:01.000Z",
                      event: "inbound_eof",
                      raw: marker,
                    },
                    { sessionId: marker, at: "2026-01-01T00:00:01.000Z", event: "inbound_eof" },
                  ],
                },
              ],
            });
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(line.fields.request_id), false);
            assert.equal(safe.message.includes(sandboxId), false);
            assert.equal(safe.message.includes(marker), false);
            throw safe;
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      const { failure } = JSON.parse(
        await readFile(evidence.directory + "/observations.json", "utf8"),
      );
      assert.deepEqual(
        failure.custodyEvidence.events,
        ["no_permit", "response_blocked"].map((event) => ({
          requestId: line.fields.request_id,
          event,
        })),
      );
      assert.deepEqual(failure.custodyEvidence.expected, [
        "resolve_refused",
        "no_permit",
        "response_blocked",
      ]);
      assert.equal(failure.custodyEvidence.identityCheck, "matched");
      assert.equal(failure.custodyEvidence.uniqueRequest, true);
      assert.equal(failure.custodyEvidence.singleRequest, true);
      assert.equal(failure.custodyEvidence.ordered, false);
      assert.equal(failure.custodyContext.turnPhase, "fresh-iam-revoked");
      assert.equal(failure.custodyContext.sessions.requestSessionCorrelation, "unavailable");
      assert.equal(failure.custodyContext.sessions.gateways[0].events.length, 1);
      assert.equal(JSON.stringify(failure).includes(marker), false);
      // A new baseline must not reuse the prior turn's private evidence.
      const next = await custody.snapshot();
      lines = [...lines, ...Array(12).fill(line)];
      let second;
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(next, ["resolve_accepted"]);
          } catch (error) {
            throw await safeConnectedFailure(error, "next-turn", async (value) => {
              second = value;
            });
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      assert.equal(second.custodyEvidence.events.length, 9);
      assert.equal(second.custodyEvidence.truncated, true);
      assert.equal(second.custody.freshCount, 12);
      assert.equal(second.custodyEvidence.uniqueRequest, false);
      assert.equal(second.custodyContext, undefined);
    },
  );
  await t.test("multiline failure messages cannot choose the reported source frame", async () => {
    const spoofed = "egress-supplier-custody-transitions.mjs:12345:1234";
    for (const kind of ["operation", "assertion"]) {
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            const message = marker + "\n    at /untrusted/" + spoofed;
            if (kind === "assertion") {
              assert.fail(message);
            }
            throw new Error(message);
          },
        },
      });
      let failure;
      try {
        await custody.snapshot();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      const safe = await safeConnectedFailure(failure, "turn-result");
      assert.match(safe.message, /egress-supplier-custody-transitions\.mjs:\d+:\d+/);
      assert.equal(safe.message.includes(spoofed), false);
      assert.equal(safe.message.includes(marker), false);
    }
    // A stack with no usable frame keeps the fixed fallback.
    assert.match(
      (await safeConnectedFailure(new Error(marker), "turn-result")).message,
      /\(external-operation\)/,
    );
  });

  await t.test("non-Error rejection stays unchanged", async () => {
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw marker;
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(custody.snapshot(), (error) => error === marker);
  });
  await t.test("diagnostic write failure does not prevent cleanup recording", async () => {
    const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
    t.after(() => rm(evidence.directory, { recursive: true, force: true }));
    // A failed atomic write must not replace the observer's original failure;
    // the next cleanup checkpoint still persists that failure from memory.
    await mkdir(evidence.directory + "/observations.pending.json");
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw new Error(marker);
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(
      async () => {
        try {
          await custody.snapshot();
        } catch (error) {
          const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
          assert.equal(safe.message.includes(marker), false);
          assert.equal(safe.cause, undefined);
          throw safe;
        }
      },
      {
        message:
          /Connected egress operation failed at turn-result \/ before-custody-supervisor-get/,
      },
    );
    await rm(evidence.directory + "/observations.pending.json", { recursive: true });
    await evidence.checkpoint("cleanup");
    const { failure } = JSON.parse(
      await readFile(evidence.directory + "/observations.json", "utf8"),
    );
    assert.equal(failure.operation, "before-custody-supervisor-get");
    assert.equal(failure.custody.readAttempts, 0);
    assert.equal(failure.custody.lastRead, "unobserved");
  });
  await t.test(
    "continuation retains the acknowledged prefix when its first read fails",
    async () => {
      let reads = 0;
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            reads++;
            if (reads === 1) {
              return { lines: [], bufferTotal: 0 };
            }
            if (reads === 2) {
              return {
                lines: [
                  line,
                  {
                    ...line,
                    fields: { ...line.fields, response_custody_event: "permit_accepted" },
                  },
                ],
                bufferTotal: 2,
              };
            }
            throw new Error(marker);
          },
        },
      });
      const before = await custody.snapshot();
      await custody.expectAfter(before, ["resolve_accepted", "permit_accepted"]);
      let recorded;
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            throw await safeConnectedFailure(error, "turn-result", async (value) => {
              recorded = value;
            });
          }
        },
        { message: /Connected egress operation failed at turn-result \/ after-custody-log-read/ },
      );
      assert.equal(recorded.custody.lastRead, "error");
      assert.equal(recorded.custody.ring, "valid");
      assert.equal(recorded.custody.freshCount, 2);
      assert.deepEqual(recorded.custody.labels, ["resolve_accepted", "permit_accepted"]);
      assert.equal(recorded.custody.sequence, "partial");
      assert.equal(JSON.stringify(recorded).includes(marker), false);
    },
  );
  for (const kind of ["empty", "partial", "ring", "malformed"]) {
    await t.test(kind, async () => {
      let reads = 0;
      const custody = createCustodyTransitions(
        {
          workspace: "workspace",
          sandbox: "sandbox",
          sandboxId,
          supervisor,
          readSupervisor: async () => supervisor,
          gatewayClient: {
            async getSandboxLogs(_request, signal) {
              reads++;
              if (reads === 1) {
                return { lines: [], bufferTotal: 0 };
              }
              if (reads === 2) {
                if (kind === "ring") {
                  return { lines: [line], bufferTotal: 2001 };
                }
                if (kind === "malformed") {
                  return {
                    lines: [
                      { ...line, fields: { ...line.fields, response_custody_event: marker } },
                    ],
                    bufferTotal: 1,
                  };
                }
                return {
                  lines: kind === "partial" ? [line] : [],
                  bufferTotal: kind === "partial" ? 1 : 0,
                };
              }
              try {
                await delay(10000, undefined, { signal });
              } catch {
                throw signal.reason;
              }
              throw new Error("deadline did not abort the scripted read");
            },
          },
        },
        { deliveryTimeoutMs: 1000, pollIntervalMs: 1 },
      );
      const before = await custody.snapshot();
      const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(line.fields.request_id), false);
            assert.equal(safe.message.includes(marker), false);
            assert.equal(safe.cause, undefined);
            throw safe;
          }
        },
        {
          message:
            /Connected egress (?:assertion|operation) failed at turn-result \/ after-custody-log-read/,
        },
      );
      const { failure: recorded } = JSON.parse(
        await readFile(evidence.directory + "/observations.json", "utf8"),
      );
      await evidence.checkpoint("cleanup");
      assert.deepEqual(
        JSON.parse(await readFile(evidence.directory + "/observations.json", "utf8")).failure,
        recorded,
      );
      assert.equal(recorded.custody.successfulReads, 2);
      assert.equal(recorded.custody.readAttempts, kind === "empty" || kind === "partial" ? 3 : 2);
      assert.equal(JSON.stringify(recorded).includes(marker), false);
      // Validated correlation belongs only to the private evidence, never the
      // terminal error or the counter-only custody summary.
      assert.equal(JSON.stringify(recorded.custody).includes(line.fields.request_id), false);
      assert.equal(
        JSON.stringify(recorded.custodyEvidence ?? {}).includes(line.fields.request_id),
        kind === "partial",
      );
      if (kind === "empty" || kind === "partial") {
        assert.equal(recorded.custody.lastRead, "deadline");
        assert.equal(recorded.custody.ring, "valid");
        assert.equal(recorded.custody.lineCount, kind === "partial" ? 1 : 0);
        assert.equal(recorded.custody.sequence, kind === "partial" ? "partial" : "none");
        assert.deepEqual(recorded.custody.labels, kind === "partial" ? ["resolve_accepted"] : []);
      } else {
        assert.equal(recorded.custody.lastRead, "returned");
        assert.equal(recorded.custody.ring, kind === "ring" ? "incomplete" : "invalid-transition");
        assert.equal(recorded.custody.sequence, "unobserved");
        assert.equal(recorded.custody.bufferTotal, kind === "ring" ? null : 1);
      }
    });
  }
});

test(
  "reconnect checkpoints keep correlation in the private ledger on success and failure",
  { concurrency: false },
  async (t) => {
    for (const failFinalReadiness of [false, true]) {
      await t.test(
        failFinalReadiness ? "failed final readiness" : "successful reconnect",
        async (t) => {
          const sandboxId = "10000000-0000-4000-8000-000000000001";
          const instanceId = "20000000-0000-4000-8000-000000000001";
          const first = "30000000-0000-4000-8000-000000000001";
          const second = "30000000-0000-4000-8000-000000000002";
          const agent = { id: "private-agent-id", servicePrincipalId: "private-principal-id" };
          const revision = { id: "private-revision-id" };
          const namespace = { id: "private-namespace-id" };
          const placement = "private-placement";
          const images = Object.fromEntries(
            ["supervisor", "agent", "openShellGateway"].map((name) => [
              name,
              `registry.example/private-${name}@sha256:${"b".repeat(64)}`,
            ]),
          );
          const pod = (name, image) => ({
            metadata: {
              name,
              uid: `private-${name}-uid`,
              namespace: placement,
              labels: {
                "openshell.ai/sandbox-id": sandboxId,
                "openshell.ai/boundary-role": "supervisor",
              },
            },
            spec: { containers: [{ name: `private-${name}-container`, image }] },
            status: {
              containerStatuses: [
                {
                  name: `private-${name}-container`,
                  ready: true,
                  containerID: `containerd://private-${name}`,
                  imageID: `private-${name}-image-id`,
                  restartCount: 0,
                  state: { running: { startedAt: "2026-01-01T01:02:03Z" } },
                },
              ],
            },
          });
          const supervisor = pod("supervisor", images.supervisor);
          const harness = pod("harness", images.agent);
          const supplier = pod("supplier", images.openShellGateway);
          const pods = [supervisor, harness, supplier];
          const key = Buffer.alloc(32, 1);
          const policyHash = "a".repeat(64);
          // Fixed consistent input for the observer. This case does not test pin derivation.
          const committed = {
            sandboxId,
            plan: {
              generation: 7,
              execution: {
                namespaceId: namespace.id,
                agentId: agent.id,
                revisionId: revision.id,
                installationId: "private-installation-id",
                servicePrincipalId: agent.servicePrincipalId,
              },
            },
            enforcement: {
              instanceId,
              policyHash,
              peerKeyId: key.toString("base64url"),
              authorityScope: "execution",
              configurationId: "b010bc3c3d213c355e43eccffbee704648968a7f42fc973f8ab1a4afe0f33bf5",
            },
          };
          const loaded = {
            active_version: 7,
            revision: { version: 7, status: 2, policy_hash: policyHash, policy: {} },
            loaded_policy_observation: {
              registered_exchange_public_key: key,
              source_policy_hash: policyHash,
              effective_policy: {},
              enforcement: {
                sandbox_id: sandboxId,
                instance_id: instanceId,
                policy_version: 7,
                policy_hash: policyHash,
                config_revision: "1",
                provider_env_revision: "1",
                enforced_capabilities: capabilities,
              },
            },
          };
          let logReads = 0;
          let policyReads = 0;
          let reconnectAt;
          const line = (session, epoch, at) =>
            `${at} ${at}  INFO openshell_server::supervisor_session: supervisor session: accepted sandbox_id=${sandboxId} session_id=${session} instance_id=${instanceId} connection_epoch=${epoch}`;
          const f = {
            resource: async (_kind, name) => {
              const found = pods.find((value) => value.metadata.name === name);
              assert.ok(found);
              return found;
            },
            kubectl: async () => {
              logReads++;
              const baseline = line(first, "9007199254740992", "2026-01-01T00:00:00.000Z");
              if (logReads === 1) {
                return baseline;
              }
              reconnectAt ??= new Date().toISOString();
              return `${baseline}\n${line(second, "9007199254740993", reconnectAt)}`;
            },
            waitFor: async (_label, read) => {
              // Scripted observations exercise pending enrollment as well as the loaded branch.
              for (let attempt = 0; attempt < 3; attempt++) {
                await delay(5);
                const result = await read();
                if (result) {
                  return result;
                }
              }
              assert.fail("scripted observations never satisfied the observer");
            },
          };
          const setup = {
            input: { images, supplierCommit: "c".repeat(40), openShellGatewayNamespace: placement },
            controller: {},
            f,
          };
          const stack = {
            pool: {},
            placement,
            namespace,
            namespacePath: "/private-namespace",
            installation: { id: "private-installation-id" },
            supplierPods: [supplier],
            gatewayClient: {
              getSandboxPolicyStatus: async () =>
                ++policyReads === 2 ? { ...loaded, loaded_policy_observation: undefined } : loaded,
            },
          };
          const deploymentPath = "/private-deployment";
          const diagnostics = [];
          const progress = {};
          const evidence = await createRunEvidence(
            { signal: t.signal, diagnostic: (line) => diagnostics.push(line) },
            setup,
            progress,
          );
          const originalRead = PostgresPlatformState.prototype.read;
          // Replace only the external state input. Real observer, assertions, checkpoint,
          // atomic ledger writes and terminal projection run unchanged.
          PostgresPlatformState.prototype.read = async (read) =>
            read({ credentialSources: { findRevisionEgressInstallation: () => committed } });
          let failure;
          try {
            await requireSupervisorReconnect(
              setup,
              stack,
              {
                ...evidence,
                api: async (_method, path) =>
                  path === deploymentPath
                    ? {
                        deploymentId: revision.id,
                        namespaceId: namespace.id,
                        agentId: agent.id,
                        status: failFinalReadiness ? "private-unexpected-status" : "succeeded",
                        error: null,
                        cleanup: null,
                      }
                    : { activeRevisionId: revision.id },
              },
              { agent, revision, sandboxId, deploymentPath },
              { supervisor, harness, sandboxName: "private-sandbox-name" },
            );
          } catch (error) {
            failure = error;
          } finally {
            PostgresPlatformState.prototype.read = originalRead;
          }
          try {
            if (failFinalReadiness) {
              assert.equal(failure?.code, "ERR_ASSERTION");
              const terminal = await safeConnectedFailure(
                failure,
                progress.stage,
                evidence.recordFailure,
              );
              diagnostics.push(terminal.message);
              assert.match(terminal.message, /reconnect-before-turn/);
            } else {
              assert.equal(failure, undefined);
            }
            const retained = JSON.parse(
              await readFile(`${evidence.directory}/observations.json`, "utf8"),
            );
            const phases = retained.phases;
            const phase = (name) => phases.find((entry) => entry.phase === name);
            assert.equal(
              phase("reconnect-wait-start").supervisor.containerId,
              supervisor.status.containerStatuses[0].containerID,
            );
            assert.equal(phase("reconnect-wait-start").harness.image, images.agent);
            assert.equal(
              phase("reconnect-wait-start").supplierProcesses[0].podUid,
              supplier.metadata.uid,
            );
            assert.equal(phase("reconnect-wait-start").sandboxId, sandboxId);
            assert.equal(phase("reconnect-before-policy").instanceId, instanceId);
            assert.equal(phase("reconnect-baseline").sessions[0].sessionId, first);
            assert.equal(phase("reconnect-accepted").reconnect.sessionId, second);
            assert.equal(phase("reconnect-accepted").reconnect.epoch, "9007199254740993");
            assert.equal(phase("reconnect-before-turn").deploymentId, revision.id);
            assert.equal(phase("reconnect-before-turn").deploymentReady, !failFinalReadiness);
            assert.ok(
              phases.some(
                (entry) => entry.phase === "reconnect-after-policy" && entry.loaded === false,
              ),
            );
            const printed = diagnostics.join("\n");
            const privateValues = [
              sandboxId,
              instanceId,
              first,
              second,
              agent.id,
              revision.id,
              "c".repeat(40),
              "9007199254740992",
              "9007199254740993",
              "private-unexpected-status",
              ...Object.values(images),
              ...pods.flatMap((value) => [
                value.metadata.name,
                value.metadata.uid,
                value.status.containerStatuses[0].containerID,
                value.status.containerStatuses[0].imageID,
                value.status.containerStatuses[0].name,
              ]),
              phase("reconnect-baseline").baselineAt,
              phase("reconnect-accepted").logThrough,
            ];
            // Generic names can be phase labels, so check their private identity fields instead.
            for (const value of privateValues.filter(
              (value) => !["supervisor", "harness", "supplier"].includes(value),
            )) {
              assert.equal(
                printed.includes(value),
                false,
                `private reconnect metadata reached reporter: ${value}`,
              );
            }
            const report = diagnostics
              .filter((line) => line.startsWith("egress-connected reconnect-"))
              .map((line) => ({
                phase: line.split(" ")[1],
                details: JSON.parse(line.slice(line.indexOf("{"))),
              }));
            assert.equal(
              report.find((entry) => entry.phase === "reconnect-accepted").details.sessionCount,
              2,
            );
            assert.equal(
              report.find((entry) => entry.phase === "reconnect-before-policy").details.equalities
                .enforcementMatches,
              true,
            );
            assert.equal(
              report.find((entry) => entry.phase === "reconnect-before-turn").details
                .deploymentReady,
              !failFinalReadiness,
            );
            const forbidden = [
              "supplierCommit",
              "supervisor",
              "harness",
              "supplierProcesses",
              "sandboxId",
              "agentId",
              "revisionId",
              "logSince",
              "instanceId",
              "policyVersion",
              "baselineAt",
              "sessions",
              "reconnect",
              "logThrough",
              "deploymentId",
              "status",
            ];
            for (const { details } of report) {
              for (const field of forbidden) {
                assert.equal(Object.hasOwn(details, field), false, `${field} must remain private`);
              }
            }
          } finally {
            await rm(evidence.directory, { recursive: true, force: true });
          }
        },
      );
    }
  },
);

// These protocol peers exercise the real upgrade helper's ownership decisions;
// they do not establish Kubernetes, PostgreSQL, or installed-runtime acceptance.
async function controllerUpgradePeers(t, fault = {}) {
  const namespaceId = "ns_11111111-1111-4111-8111-111111111111";
  const existingId = "cs_11111111-1111-4111-8111-111111111111";
  const createdId = "cs_22222222-2222-4222-8222-222222222222";
  const runId = fault.recording?.runId ?? randomUUID();
  const provider = { observations: [], tcpConnections: 0 };
  const origin = createServer((_request, response) => {
    provider.observations.push({});
    response.end("ok");
  });
  origin.on("connection", () => provider.tcpConnections++);
  const port = await listen(t, origin);
  async function reachOrigin() {
    if (fault.traffic === "http") {
      await fetch(`http://127.0.0.1:${port}`).then((response) => response.text());
      return;
    }
    // Wait for acceptance by the origin, not merely the client's connect event.
    const accepted = once(origin, "connection");
    const socket = connect({ host: "127.0.0.1", port });
    const [serverSocket] = await accepted;
    socket.destroy();
    serverSocket.destroy();
  }
  function controllerPod(component, generation) {
    const image = generation === "before" ? "controller:before" : "controller:after";
    return {
      metadata: {
        name: `${component}-${generation}`,
        uid: `${component}-${generation}`,
        namespace: "controller",
        labels: { "app.kubernetes.io/component": component },
      },
      spec: {
        containers: [
          {
            name: component,
            image,
            args: [`apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`],
            env: [
              { name: "OCC_CONFIG_PATH", value: "/etc/openclaw/installation/installation.yaml" },
            ],
            volumeMounts: [
              { name: "installation", mountPath: "/etc/openclaw/installation", readOnly: true },
            ],
          },
        ],
        volumes: [{ name: "installation", secret: { items: [{ path: "installation.yaml" }] } }],
      },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          {
            name: component,
            containerID: `${component}-${generation}`,
            imageID: image,
            restartCount: 0,
            state: { running: { startedAt: "2026-01-01T00:00:00Z" } },
          },
        ],
      },
    };
  }
  let upgraded = false;
  let injected = false;
  const setup = {
    input: {
      controllerNamespace: "controller",
      controllerSelector: "controller",
      openShellGatewayNamespace: "supplier",
      openShellGatewaySelector: "supplier",
      oceCommit: "b".repeat(40),
      images: { controller: "controller:after" },
      controllerUpgrade: {
        fromCommit: "c".repeat(40),
        fromImage: "controller:before",
        timeoutMs: 10_000,
      },
    },
    controller: { providerOrigin: "https://provider.example" },
    f: {
      async kubectl(...args) {
        if (args[0] === "exec") {
          return "a".repeat(64);
        }
        if (args.includes("pod")) {
          return "";
        }
        if (args.includes("supplier")) {
          return JSON.stringify({ items: [] });
        }
        if (upgraded && fault.window === "replacement" && !injected) {
          injected = true;
          await reachOrigin();
        }
        return JSON.stringify({
          items: ["api", "worker"].map((component) =>
            controllerPod(component, upgraded ? "after" : "before"),
          ),
        });
      },
    },
  };
  const state = {
    sources: [{ id: existingId }],
    revisions: [{ id: "revision" }],
    installations: [{}],
    work: [
      {
        idempotency_key: "agent_revision:revision:reconcile",
        agent_id: "agent",
        revision_id: "revision",
        agent_target: null,
        state: "succeeded",
        reason_code: "REVISION_ACTIVATED",
      },
    ],
  };
  const stack = {
    namespace: { id: namespaceId },
    namespacePath: `/namespaces/${namespaceId}`,
    installation: { id: "installation" },
    supplierPods: [],
    pool: {
      async query(sql) {
        return { rows: sql.includes("count(*)") ? [{ pending: 0 }] : [{ state }] };
      },
    },
  };
  const ledger = fault.recording?.ledger ?? { resources: [] };
  const sourceReads = [];
  let requests = 0;
  const evidence = {
    runId,
    credentials: { initial: "synthetic" },
    ledger,
    async checkpoint(phase, details, privateDetails) {
      await fault.recording?.checkpoint(phase, details, privateDetails);
      // The operator can act as soon as readiness is published, before observe starts.
      if (phase === "controller-upgrade-ready" && fault.window === "ready") {
        await reachOrigin();
      }
    },
    async api(method, path) {
      if (method === "PATCH") {
        return { id: existingId, state: "ready", egress: { adoption: "live", retention: "none" } };
      }
      if (path === "/installation") {
        return stack.installation;
      }
      if (path.endsWith("/iam/access-bindings")) {
        return [];
      }
      sourceReads.push(path);
      if (fault.readError) {
        throw new Error("readback unavailable");
      }
      return { id: createdId, namespaceId, name: `egress-refused-${runId}`, ...fault.readback };
    },
    async request() {
      const index = requests++;
      if (fault.window === index) {
        await reachOrigin();
      }
      const meta = { requestId: `request-${index}` };
      return fault.created !== undefined && index === 0
        ? { status: 201, body: { data: fault.created, meta } }
        : {
            status: 409,
            body: {
              meta,
              error: {
                code: "RESOURCE_CONFLICT",
                message:
                  "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
              },
            },
          };
    },
  };
  const owned = {
    provider,
    async create(kind) {
      return kind === "secrets" ? { ref: "replacement-secret" } : { id: existingId };
    },
  };
  const deployment = {
    agent: { id: "agent" },
    revision: { id: "revision" },
    secret: { ref: "secret" },
  };
  const retained = await prepareControllerUpgrade(setup, stack, evidence, owned, deployment, {
    gatewayPods: [],
  });
  upgraded = true;
  return {
    ledger,
    provider,
    sourceReads,
    existingId,
    createdId,
    run: () => observeControllerUpgrade(setup, stack, evidence, owned, deployment, retained),
  };
}

test("unexpected retirement creates require new, read-back run ownership before cleanup", async (t) => {
  const createdId = "cs_22222222-2222-4222-8222-222222222222";
  const existingId = "cs_11111111-1111-4111-8111-111111111111";
  const cases = [
    { name: "pre-existing", created: { id: existingId }, error: /pre-upgrade baseline/, reads: 0 },
    { name: "missing", created: {}, error: /valid source ID/, reads: 0 },
    { name: "malformed", created: { id: "invalid" }, error: /valid source ID/, reads: 0 },
    { name: "wrong ID", readback: { id: existingId }, error: /returned source ID/ },
    { name: "wrong Namespace", readback: { namespaceId: "other" }, error: /this Namespace/ },
    { name: "wrong name", readback: { name: "unrelated" }, error: /run-specific name/ },
    { name: "failed read", readError: true, error: /readback unavailable/ },
    { name: "confirmed new source", owned: true, error: /HTTP 201/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const peer = await controllerUpgradePeers(t, { created: { id: createdId }, ...scenario });
      await assert.rejects(peer.run(), scenario.error);
      assert.deepEqual(
        peer.ledger.resources,
        scenario.owned ? [{ kind: "credential-sources", id: createdId }] : [],
      );
      assert.equal(peer.ledger.pendingCreate !== undefined, !scenario.owned);
      assert.equal(peer.sourceReads.length, scenario.reads ?? 1);
    });
  }
});

test("upgrade and retirement quiet windows reject TCP arrivals without HTTP", async (t) => {
  await t.test("quiet success", async (t) => {
    const peer = await controllerUpgradePeers(t);
    await peer.run();
    assert.equal(peer.ledger.pendingCreate, undefined);
    assert.equal(peer.ledger.pendingDeploy, undefined);
  });
  for (const window of ["ready", "replacement", 0, 1, 2, 3]) {
    for (const traffic of ["tcp", "http"]) {
      await t.test(`${window}: ${traffic}`, async (t) => {
        const peer = await controllerUpgradePeers(t, { window, traffic });
        await assert.rejects(
          peer.run(),
          traffic === "tcp" ? /provider connections/ : /provider traffic|provider I\/O/,
        );
        assert.equal(peer.provider.tcpConnections > 0, true);
        assert.equal(peer.provider.observations.length, traffic === "tcp" ? 0 : 1);
      });
    }
  }
});

test("controller upgrade checkpoints keep process identity in the private ledger", async (t) => {
  const diagnostics = [];
  const recording = await createRunEvidence(
    { signal: t.signal, diagnostic: (line) => diagnostics.push(line) },
    { input: { images: {} }, controller: {} },
    {},
  );
  t.after(() => rm(recording.directory, { recursive: true, force: true }));
  // Protocol peers supply identity observations; the actual checkpoint writer
  // decides what reaches public diagnostics and the private on-disk ledger.
  const peer = await controllerUpgradePeers(t, { recording });
  await peer.run();
  const saved = JSON.parse(await readFile(`${recording.directory}/observations.json`, "utf8"));
  for (const [phase, generation] of [
    ["controller-upgrade-ready", "before"],
    ["controller-upgrade-observed", "after"],
  ]) {
    const retained = saved.phases.find((entry) => entry.phase === phase);
    const line = diagnostics.find((entry) => entry.startsWith(`egress-connected ${phase} `));
    assert.ok(line, "public progress remains observable");
    const visible = JSON.parse(line.slice(line.indexOf("{")));
    assert.equal(
      Object.hasOwn(visible, "controllers"),
      false,
      "process identities must stay private",
    );
    assert.equal(visible.componentCount, 2);
    assert.equal(retained.controllers.length, 2);
    for (const process of retained.controllers) {
      assert.ok(process.name.endsWith(generation));
      for (const field of [
        "name",
        "uid",
        "containerID",
        "imageID",
        "startedAt",
        "configurationSha256",
        "installationSha256",
      ]) {
        assert.equal(typeof process[field], "string", `retained ${field}`);
        assert.equal(line.includes(process[field]), false, `${field} must stay private`);
      }
    }
    if (generation === "before") {
      for (const field of [
        "fromCommit",
        "toCommit",
        "fromImage",
        "toImage",
        "retainedStateSha256",
      ]) {
        assert.equal(typeof retained[field], "string", `retained ${field}`);
        assert.equal(line.includes(retained[field]), false, `${field} must stay private`);
      }
      assert.deepEqual(visible.providerBaseline, { httpRequests: 0, tcpConnections: 0 });
    } else {
      assert.equal(visible.retainedStateUnchanged, true);
      assert.equal(visible.providerSends, 0);
    }
  }
});
