import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import {
  activateRepositoryAgent,
  admitRepositoryAgent,
} from "../helpers/egress-custody-installed-agent.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { createKubernetesClient } from "../helpers/kubernetes-real.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  encodeSyntheticEvents,
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
import { listen } from "../helpers/listen.mjs";

import {
  assertOpenShellHarnessBinding,
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
  };
  const wholeExecution = (input) =>
    validateConnectedInputs(input, controller, { wholeExecution: true });
  assert.equal(wholeExecution(fresh), fresh);
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
      headers: authenticatedHeaders(session, wire.headers),
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
