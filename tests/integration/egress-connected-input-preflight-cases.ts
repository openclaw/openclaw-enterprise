import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import test from "node:test";
import type { V1OwnerReference } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { connect as connectTls } from "node:tls";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  encodeSyntheticEvents,
  startSyntheticEgressProvider,
  syntheticResponsesEvents,
  type SyntheticEvent,
} from "../fixtures/synthetic-egress-provider.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.ts";
import {
  assertConnectedResponse,
  assertConnectedCheckout,
  assertNoConnectedAssistantOutput,
  assertSecretReference,
  connectedReceiptRevision,
  protectedAgentBody,
  protectedConfigurationBody,
  protectedSourceBody,
  sendConnectedRequest,
  serializeConnectedRequest,
  sourceAccessBindingBody,
  validateConnectedDatabaseUrl,
} from "../helpers/egress-connected-inputs.mjs";
import {
  takeConnectedControllerBinding,
  validateConnectedInputs,
} from "../helpers/egress-connected-manifest.ts";
import { deleteInstalledResource } from "../helpers/egress-installed-resource-cleanup.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import {
  hasResourceId,
  hasStringField,
  isArray,
  isRecord,
  parseJson,
} from "../helpers/egress-observation-values.ts";
import type { ConnectedApiOperation } from "../helpers/egress-upgrade-contracts.ts";
import { listen } from "../helpers/listen.ts";
import {
  assertOpenShellHarnessBinding,
  openShellAgentName,
  openShellRevisionName,
} from "../helpers/openshell-kubernetes-real.mjs";
import { waitForResult } from "../helpers/wait-for.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

type WorkloadPod = Parameters<typeof assertOpenShellHarnessBinding>[3];
type SyntheticUrlOptions = Parameters<typeof syntheticCredentialUrl>[0];

function isApiOperation(value: unknown): value is ConnectedApiOperation {
  return (
    isRecord(value) &&
    typeof value.operationId === "string" &&
    typeof value.method === "string" &&
    typeof value.phase === "string" &&
    typeof value.outcome === "string" &&
    (typeof value.status === "number" || value.status === null) &&
    (typeof value.code === "string" || value.code === null) &&
    (typeof value.requestId === "string" || value.requestId === null)
  );
}

function readApiObservations(raw: string) {
  const saved = parseJson(raw);
  assert.ok(isRecord(saved) && isApiOperation(saved.lastApi));
  assert.ok(isArray(saved.apiOperations) && saved.apiOperations.every(isApiOperation));
  return { lastApi: saved.lastApi, apiOperations: saved.apiOperations };
}

export function registerConnectedEgressInputPreflightCases(): void {
  // These are oracle inputs, not simulated evidence of a running supplier. The
  // selected account comes from the maintained launcher, independently of the Pod.
  test("connected workload binding accepts only the maintained launcher identity and isolation", async (t) => {
    const revision = {
      namespaceId: "ns_fixture",
      agentId: "agent_fixture",
      id: "revision_fixture",
    };
    const sandbox = {
      apiVersion: "agents.x-k8s.io/v1alpha1",
      metadata: {
        namespace: "workspace",
        name: "sandbox-fixture",
        uid: "sandbox-uid",
        labels: { "openshell.ai/sandbox-id": "sandbox-id" },
      },
    };
    const valid: WorkloadPod & {
      metadata: { ownerReferences: [V1OwnerReference]; labels: Record<string, string> };
      spec: { volumes: NonNullable<WorkloadPod["spec"]["volumes"]> };
    } = {
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
    const check = (pod: WorkloadPod, profile = "maintainedLauncher") =>
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
        const checkShared = (pod: WorkloadPod, expected = configuredAccount) =>
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
            assertOpenShellHarnessBinding(
              "workspace",
              revision,
              sandbox,
              shared,
              "namespaceShared",
            ),
          { code: "ERR_ASSERTION" },
        );
        assert.throws(() => checkShared(shared, "wrong-account"), { code: "ERR_ASSERTION" });
        assert.throws(() => assertOpenShellHarnessBinding("workspace", revision, sandbox, shared), {
          code: "ERR_ASSERTION",
        });
        const mutations: ((pod: typeof shared) => void)[] = [
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
        ];
        for (const mutate of mutations) {
          const changed = structuredClone(shared);
          mutate(changed);
          assert.throws(() => checkShared(changed), { code: "ERR_ASSERTION" });
        }
      },
    );

    const rejects = (name: string, overrides: Partial<WorkloadPod>) =>
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
    const missingAutomount: WorkloadPod["spec"] = { ...spec };
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
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
    const commit = (name: string) => {
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
    const check = (input: Parameters<typeof assertConnectedCheckout>[0]) => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { assertConnectedCheckout } from ${JSON.stringify(helper)}; assertConnectedCheckout(${JSON.stringify(input)});`,
        ],
        { cwd: directory, encoding: "utf8" },
      );
      assert.ifError(child.error);
      assert.equal(child.signal, null, "the checkout verifier must exit normally");
      assert.ok(child.status !== null);
      return child.status;
    };
    for (const controllerUpgrade of [undefined, { fromCommit: initial }]) {
      const input = { oceCommit: product, harnessCommit: harness, controllerUpgrade };
      assert.equal(check(input), 0, "clean descendant harness qualifies source provenance");
      for (const oceCommit of [unrelated, "f".repeat(40)]) {
        assert.notEqual(check({ ...input, oceCommit }), 0, "unrelated or missing product fails");
      }
      assert.notEqual(check({ ...input, harnessCommit: product }), 0, "wrong harness HEAD fails");
      // Exercise actual Git dirtiness, including an untracked change excluded by diff alone.
      await writeFile(`${directory}/source.txt`, "uncommitted");
      assert.notEqual(check(input), 0, "modified source fails");
      git("checkout", "--", "source.txt");
      await writeFile(`${directory}/untracked.txt`, "unreviewed");
      assert.notEqual(check(input), 0, "untracked source fails");
      await rm(`${directory}/untracked.txt`);
    }
    assert.equal(check({ oceCommit: harness, harnessCommit: harness }), 0);
    assert.notEqual(
      check({
        oceCommit: product,
        harnessCommit: harness,
        controllerUpgrade: { fromCommit: unrelated },
      }),
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
    type ManifestSelection = Pick<typeof input, "apiOrigin" | "namespaceId" | "model"> & {
      provider: { origin: string };
    };
    const selection = (input: ManifestSelection) => ({
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
    const validate = <Input extends ManifestSelection>(input: Input) =>
      validateConnectedInputs(input, selection(input));
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
    const wholeExecution = <Input extends ManifestSelection>(input: Input) =>
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
    const serve = async (handler: RequestListener) =>
      `127.0.0.1:${await listen(t, createServer(handler))}`;
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
    const controller = (apiOrigin: string) => {
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
    const get = async (path: string) =>
      sendConnectedRequest(
        binding,
        serializeConnectedRequest("GET", path),
        AbortSignal.timeout(5_000),
      );
    assert.equal(
      (await get("/prepared")).status,
      204,
      "the selected controller did receive the key",
    );
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
    let selected: (typeof cases)[number] | undefined;
    let pending: ConnectedApiOperation | undefined;
    const port = await listen(
      t,
      createServer(async (request, response) => {
        assert.equal(request.headers["x-api-key"], serviceKey);
        const saved = readApiObservations(
          await readFile(evidence.directory + "/observations.json", "utf8"),
        );
        pending = saved.lastApi;
        assert.equal(pending.outcome, "unknown", "the attempt must be durable before dispatch");
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        assert.ok(selected);
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
    const progress: Parameters<typeof createRunEvidence>[2] = {};
    const evidence = await createRunEvidence(
      t,
      {
        input: { images: {} },
        controller: { apiOrigin: `http://127.0.0.1:${port}`, serviceKey },
      },
      progress,
    );
    const directory = evidence.directory;
    t.after(() => rm(directory, { recursive: true, force: true }));
    const route = `/namespaces/ns_${randomUUID()}/agents/agt_${randomUUID()}`;
    let firstFailure: ConnectedApiOperation | undefined;
    for (selected of cases) {
      // A real HTTP rejection is recorded before the caller's expected-status assertion.
      // Later cleanup must not erase its correlation ID or retain arbitrary response material.
      progress.stage = "deploy-request";
      await assert.rejects(evidence.api("POST", route + "/deploy", {}, 202), {
        code: "ERR_ASSERTION",
      });
      assert.ok(pending);
      const expected: ConnectedApiOperation = {
        ...pending,
        outcome: "received-error-status",
        status: 409,
        code: selected.expectedCode,
        requestId: selected.expectedId,
      };
      firstFailure ??= expected;
      await evidence.request("DELETE", route, undefined, true);
      const raw = await readFile(directory + "/observations.json", "utf8");
      const saved = readApiObservations(raw);
      assert.deepEqual(
        saved.apiOperations.at(-2),
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
    const saved = readApiObservations(await readFile(directory + "/observations.json", "utf8"));
    assert.ok(firstFailure);
    const { operationId: firstId } = firstFailure;
    assert.deepEqual(
      saved.apiOperations.find(({ operationId }) => operationId === firstId),
      firstFailure,
      "the first failed POST must survive the entire cleanup sequence",
    );
  });

  test("connected response evidence preserves uncertainty after decoding and transport failures", async (t) => {
    const requestId = `req_${randomUUID()}`;
    const sentinel = `private-diagnostic-${randomUUID()}`;
    const faults = ["malformed", "disconnected", "malformed-with-ledger-failure"] as const;
    let fault: (typeof faults)[number] | undefined;
    const received: (string | undefined)[] = [];
    const port = await listen(
      t,
      createServer(async (request, response) => {
        received.push(request.method);
        if (request.method === "DELETE") {
          const saved = readApiObservations(
            await readFile(evidence.directory + "/observations.json", "utf8"),
          );
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
        controller: {
          apiOrigin: `http://127.0.0.1:${port}`,
          serviceKey: `fixture-${randomUUID()}`,
        },
      },
      progress,
    );
    t.after(() => rm(evidence.directory, { recursive: true, force: true }));
    const route = `/namespaces/ns_${randomUUID()}/agents/agt_${randomUUID()}`;
    for (fault of faults.slice(0, 2)) {
      await assert.rejects(
        evidence.request("POST", route + "/deploy", {}),
        fault === "malformed" ? SyntaxError : TypeError,
      );
      await evidence.request("DELETE", route, undefined, true);
      const raw = await readFile(evidence.directory + "/observations.json", "utf8");
      const saved = readApiObservations(raw);
      const operation = saved.apiOperations.at(-2);
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
    const saved = readApiObservations(
      await readFile(evidence.directory + "/observations.json", "utf8"),
    );
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
    const recovered = readApiObservations(
      await readFile(evidence.directory + "/observations.json", "utf8"),
    );
    const failedPost = recovered.apiOperations.find(
      ({ operationId }) => operationId === failedPostId,
    );
    assert.ok(failedPost);
    assert.equal(failedPost.outcome, "unknown");
  });

  test("connected response headers cannot retain known credentials as request IDs", async (t) => {
    // A malformed but accepted runner key can fit inside the canonical ID shape.
    // Generate both values locally; no real credential or controller is involved.
    const serviceKey = randomUUID();
    const protectedValue = randomUUID();
    let reflected: string | undefined;
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
      const saved = readApiObservations(raw);
      assert.equal(raw.includes(reflected), false);
      assert.equal(saved.lastApi.requestId, null);
      assert.equal(saved.lastApi.outcome, "unknown");
    }
  });

  test("connected database selection rejects missing, remote and redirected observers before effects", () => {
    const url = (overrides: Partial<SyntheticUrlOptions> = {}) =>
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
        (error) =>
          (isRecord(error) && error.code === "ERR_ASSERTION") ||
          (error instanceof Error && /valid PostgreSQL URL/.test(error.message)),
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
    const records: Parameters<Parameters<typeof deleteInstalledResource>[0]["record"]>[0][] = [];
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
      record: async (details) => {
        records.push(details);
      },
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
      const secured: Promise<unknown> = once(client, "secureConnect");
      await secured;
      assert.equal(provider.tcpConnections, 1);
      assert.equal(provider.applicationBytes, 0, "TLS handshake bytes are not application bytes");
      assert.equal(provider.observations.length, 0);

      const partial = "GET /v1/responses HTTP/1.1\r\nHost: localhost\r\n";
      client.write(partial);
      await waitForResult("partial HTTP bytes at origin", () => provider.applicationBytes > 0, {
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      assert.equal(provider.applicationBytes, Buffer.byteLength(partial));
      assert.equal(provider.observations.length, 0, "the HTTP parser has no complete headers yet");

      // Completing the same request must count every byte exactly once. No credential
      // is supplied, so the real provider rejects it after recording the HTTP request.
      const ending = "Connection: close\r\n\r\n";
      client.resume();
      const closed: Promise<unknown> = once(client, "close");
      client.end(ending);
      await closed;
      assert.equal(provider.applicationBytes, Buffer.byteLength(partial + ending));
      assert.equal(provider.observations.length, 1);
      const [request] = provider.observations;
      assert.ok(request);
      assert.equal(request.status, 403);
      assert.deepEqual(provider.errors, []);
    },
  );

  test("connected adversarial wire carries split and nested-JSON material without raw reflection", () => {
    const credential = `SYNTHETIC-OCE-EGRESS-${randomUUID()}-v1`;
    for (const mode of ["reflect-split-id", "reflect-encoded-arguments"] as const) {
      const events = syntheticResponsesEvents("gpt-6", "SAFE", { mode, credential });
      const wire = encodeSyntheticEvents(events).toString("utf8");
      assert.equal(wire.includes(credential), false, "the vector must bypass a raw-byte-only scan");
      const completed = events.at(-1);
      assert.ok(completed);
      assert.equal(completed.type, "response.completed");
      if (mode === "reflect-split-id") {
        const deltas = events.filter(
          (event): event is Extract<SyntheticEvent, { type: "response.output_text.delta" }> =>
            event.type === "response.output_text.delta",
        );
        assert.equal(deltas.length, 2);
        assert.deepEqual(
          deltas.map(({ output_index }) => output_index),
          [0, 0],
        );
        const [first, second] = deltas;
        assert.ok(first && second);
        assert.equal(first.item_id, "msg_synthetic_other");
        assert.equal(second.item_id, "msg_synthetic");
        assert.equal(deltas.map(({ delta }) => delta).join(""), credential);
      } else {
        assert.ok(completed.type === "response.completed");
        const call = completed.response.output[0];
        assert.ok(call && call.type === "function_call");
        assert.equal(call.arguments.includes(credential), false);
        const argumentsValue = parseJson(call.arguments);
        assert.ok(hasStringField(argumentsValue, "value"));
        assert.equal(argumentsValue.value, credential);
      }
    }
  });

  test("connected request bytes pass the real Fastify parser and preserve missing-capability refusals", async (t) => {
    // This is offline HTTP admission proof only. In-memory storage/Compute keep
    // the parser test source-only; no installed receipt or provider is substituted.
    const { app, bootstrap, createNamespace, createSecret, signIn } = await createConsoleAppFixture(
      t,
      {
        backends: [],
        computeDriver: createReadyComputeDriver("egress-preflight-compute"),
      },
    );
    await bootstrap("Connected wire preflight");
    const namespace = await createNamespace("egress-preflight", { ready: true });
    const secret = await createSecret(namespace.id, "synthetic", "SYNTHETIC-preflight-only");
    const session = await signIn();
    const prefix = "/namespaces/" + namespace.id;
    const post = async (route: string, body: object, expectedStatus = 201) => {
      const wire = serializeConnectedRequest("POST", prefix + route, body);
      const response = await app.inject({
        method: wire.method,
        url: wire.path,
        headers: {
          host: new URL(session.origin).host,
          ...authenticatedHeaders(session, wire.headers),
        },
        ...(wire.body !== undefined && { payload: wire.body }),
      });
      const result = assertConnectedResponse(
        { status: response.statusCode, body: parseJson(response.body) },
        expectedStatus,
      );
      assert.ok(isRecord(result), "expected a resource or error response");
      return result;
    };
    assertSecretReference(secret);
    const sourceBody = protectedSourceBody(
      "synthetic",
      secret.ref,
      "https://provider.test:9443/v1",
    );
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
    assert.ok(hasResourceId(configuration));
    const agentBody = protectedAgentBody("synthetic", configuration.id, `cs_${randomUUID()}`);
    const agentError = await post("/agents", agentBody, 409);
    assert.equal(agentError.code, "CREDENTIAL_GATEWAY_NOT_CONFIGURED");
    const role = await post("/iam/roles", {
      name: "exact source only",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    const principal = await post("/iam/service-principals", {});
    assert.ok(hasResourceId(role) && hasResourceId(principal));
    const binding = sourceAccessBindingBody({ servicePrincipalId: principal.id }, role, {
      id: agentBody.harnessAuth.sourceId,
    });
    const bindingError = await post("/iam/access-bindings", binding, 400);
    assert.equal(bindingError.code, "INVALID_REQUEST");
    assert.deepEqual(bindingError.details, [{ path: "/resourceId", code: "INVALID_VALUE" }]);
  });
}
