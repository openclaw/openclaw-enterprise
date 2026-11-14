import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { connect as connectTls } from "node:tls";
import { selfSigned } from "../helpers/certificates.mjs";
import { once } from "node:events";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { waitFor } from "../helpers/qa-utils.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import {
  activateRepositoryAgent,
  admitRepositoryAgent,
} from "../helpers/egress-custody-installed-agent.mjs";
import {
  rememberCustodyContext,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.mjs";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
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
import { listen } from "../helpers/listen.mjs";
import { registerConnectedEgressGatewayPreflightCases } from "./egress-connected-gateway-preflight-cases.ts";

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

registerConnectedEgressGatewayPreflightCases();

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
