import assert from "node:assert/strict";
import test from "node:test";
import { registerStreamReceiptPersistenceCases } from "./credential-proxy-stream-lease-cases.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { PROXY_REGISTRATION_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import { OpenShellEgressIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-identity.ts";
import { CredentialProxy, egressInjectionDigest } from "../../packages/occ/src/credential-proxy.ts";
import { deploymentErrorForWork } from "../../packages/occ/src/state/controller-work.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import {
  pluginRuntimeSpecForRevision,
  pluginRuntimeConfigMapData,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import {
  staticEgressFixture,
  staticEgressAdmissionFixture,
  loadGatewayDefinition,
  supervisorBearer,
  unary,
} from "../helpers/static-egress.mjs";

import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";
import {
  createReceiptPersistenceFaults,
  registerStaticEgressResponsesAndCapacityCases,
  runStaticEgressCredentialRejectionCase,
  runStaticEgressElapsedDeadlineCase,
  runStaticEgressReceiptAuthorizationFailureCase,
  runStaticEgressReceiptCapacityCase,
  runStaticEgressReceiptRestartCase,
  runStaticEgressResponseCommitCase,
} from "./static-egress-request-capacity-cases.ts";
import {
  registerStaticEgressResponsesPrefixCases,
  runStaticEgressNativeAgentMessageCase,
} from "./static-egress-responses-wire-cases.ts";

const retirementError = {
  code: "RESOURCE_CONFLICT",
  message:
    "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
};

function assertRetired(response) {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.error, retirementError);
}

async function admissionSnapshot(f) {
  return {
    rows: structuredClone(
      await f.controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      ),
    ),
    audit: structuredClone(await f.controller.transact((unit) => unit.audit.list())),
    materialReads: { ...f.materialReads },
    secretReads: f.countSecretReads(),
    gatewayEffects: [...f.gatewayEffects],
    providers: structuredClone([...f.providers]),
    requests: [...f.providerRequests],
  };
}

async function assertAdmissionUnchanged(f, before) {
  const after = await admissionSnapshot(f);
  // Denial audit is allowed; neither registration nor another success may be recorded.
  assert.deepEqual(
    after.audit.filter((event) => event.outcome === "success"),
    before.audit.filter((event) => event.outcome === "success"),
  );
  assert.deepEqual({ ...after, audit: [] }, { ...before, audit: [] });
}

test("bundled OpenShell startup refuses mixed static CREATE before material or registration; Gateway-only CREATE and PATCH remain ordinary", async (t) => {
  for (const gatewayOnly of [false, true]) {
    const f = await staticEgressAdmissionFixture(t, { gatewayOnly });
    const before = await admissionSnapshot(f);
    const result = await f.request("POST", f.path, {
      body: {
        name: "retirement-control",
        type: "openai",
        config: { authorized_base_url: f.modelProvider.baseUrl },
        secrets: { api_key: f.secret.ref },
      },
    });
    if (!gatewayOnly) {
      assertRetired(result);
      await assertAdmissionUnchanged(f, before);
    } else {
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.data.egress, undefined);
      assert.equal(f.materialReads.ordinary, before.materialReads.ordinary + 1);
      assert.equal(f.materialReads.versioned, before.materialReads.versioned);
      assert.deepEqual(f.gatewayEffects, [...before.gatewayEffects, "registerSource"]);
      const rows = await f.controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ownerCapability, "credential_gateway");
      assert.equal(rows[0].driverId, "openshell-credentials");
      assert.deepEqual(rows[0].secrets, { api_key: f.secret.ref });
      assert.equal(
        [...f.providers.values()][0].credentials.OPENAI_API_KEY,
        "synthetic-key-initial",
      );
      assert.deepEqual(f.providerRequests, []);

      const replacement = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
        body: { name: "ordinary-replacement", value: "synthetic-key-replacement" },
      });
      assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
      const original = structuredClone(rows[0]);
      const [[name, provider]] = structuredClone([...f.providers]);
      const profiles = structuredClone([...f.profiles]);
      const updateBefore = await admissionSnapshot(f);
      const wireStart = f.gatewayRequests.length;
      const updated = await f.request("PATCH", `${f.path}/${original.id}`, {
        body: { secrets: { api_key: replacement.data.ref } },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.deepEqual(updated.data, {
        ...result.data,
        secrets: { api_key: replacement.data.ref },
        status: { state: "ready" },
      });
      const updatedRows = await f.controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(f.namespace.id),
      );
      assert.deepEqual(updatedRows, [{ ...original, secrets: { api_key: replacement.data.ref } }]);
      assert.equal(updatedRows[0].egress, undefined);
      assert.equal(updatedRows[0].state, "ready");
      assert.deepEqual(
        [...f.providers],
        [
          [
            name,
            {
              ...provider,
              metadata: { ...provider.metadata, resource_version: "2" },
              credentials: { OPENAI_API_KEY: "synthetic-key-replacement" },
            },
          ],
        ],
      );
      assert.deepEqual([...f.profiles], profiles);
      const wire = f.gatewayRequests.slice(wireStart);
      assert.equal(wire.length, 2);
      assert.match(wire[1].request.request_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(wire, [
        {
          method: "GetProvider",
          request: { name, workspace_scope: { workspace: f.namespace.name } },
          found: true,
        },
        {
          method: "UpdateProvider",
          request: {
            provider: {
              metadata: { name },
              credentials: { OPENAI_API_KEY: "synthetic-key-replacement" },
            },
            workspace_scope: { workspace: f.namespace.name },
            // The empty credential_expiration_times map is omitted on the wire.
            request_id: wire[1].request.request_id,
          },
        },
      ]);
      assert.equal(f.materialReads.ordinary, updateBefore.materialReads.ordinary + 1);
      assert.equal(f.materialReads.versioned, updateBefore.materialReads.versioned);
      assert.equal(f.countSecretReads(), updateBefore.secretReads + 1);
      assert.deepEqual(f.gatewayEffects, [...updateBefore.gatewayEffects, "updateSource"]);
      assert.deepEqual(f.providerRequests, []);

      // A bound source must be unbound before adoption, even without a Proxy.
      const config = await f.createConfiguration(f.namespace.id, {
        agents: {
          defaults: {
            model: { primary: "codex/fixture-model" },
            models: { "codex/fixture-model": { agentRuntime: { id: "codex" } } },
          },
        },
      });
      const agent = await f.request("POST", `/namespaces/${f.namespace.id}/agents`, {
        body: {
          name: "bound-model",
          configurationId: config.id,
          executionMode: "dedicated",
          harnessAuth: { method: "credential_source", sourceId: original.id },
          credentialSources: [{ sourceId: original.id }],
        },
      });
      assert.equal(agent.status, 201, JSON.stringify(agent.body));
      const prior = await admissionSnapshot(f);
      const bound = await f.request("PATCH", `${f.path}/${original.id}`, {
        body: { adoption: "live", authorityScope: "execution" },
      });
      assert.deepEqual(
        { status: bound.status, reason: bound.body.error?.message },
        { status: 409, reason: "Protected source changes require an unbound source." },
      );
      await assertAdmissionUnchanged(f, prior);
    }
  }
});

test("bundled OpenShell startup refuses unbound legacy adoption; original Gateway DELETE remains available", async (t) => {
  let clock = Date.now();
  const f = await staticEgressAdmissionFixture(t, {
    includeLegacy: true,
    now: () => new Date(clock),
  });
  const replacement = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
    body: { name: "replacement", value: "synthetic-key-replacement" },
  });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
  const before = await admissionSnapshot(f);
  assertRetired(
    await f.request("PATCH", `${f.path}/${f.legacySource.id}`, {
      body: {
        adoption: "live",
        authorityScope: "execution",
        secrets: { api_key: replacement.data.ref },
      },
    }),
  );
  await assertAdmissionUnchanged(f, before);

  // The original unbound Gateway copy remains deletable in the mixed installation.
  const legacy = await f.controller.transact((unit) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, f.legacySource.id),
  );
  assert.equal(legacy.ownerCapability, "credential_gateway");
  assert.equal(legacy.driverId, "openshell-credentials");
  assert.equal(legacy.state, "ready");
  assert.equal(legacy.egress, undefined);
  assert.equal(legacy.createdAt, new Date(clock).toISOString());
  assert.deepEqual(legacy.secrets, { api_key: f.secret.ref });
  assert.deepEqual(f.legacySource.ref, {
    kind: "credential_source",
    namespaceId: f.namespace.id,
    id: legacy.id,
  });
  const [[name, provider]] = [...f.providers];
  assert.equal(f.providers.size, 1);
  assert.equal(provider.metadata.labels["openclaw.dev/credential-source-id"], legacy.id);
  assert.ok(f.profiles.has(name));
  // An unrelated fake provider is a sentinel, never a substitute for the real target.
  const unrelated = structuredClone(provider);
  unrelated.metadata = {
    ...unrelated.metadata,
    name: "unrelated-provider",
    id: "unrelated-id",
    labels: {},
  };
  f.providers.set(unrelated.metadata.name, unrelated);
  const deleteBefore = await admissionSnapshot(f);
  const profilesBefore = structuredClone([...f.profiles]);
  const wireStart = f.gatewayRequests.length;
  // Two 30-second Gateway operation windows plus the 10-second registration grace.
  clock = Date.parse(legacy.createdAt) + 70_001;
  const deleted = await f.request("DELETE", `${f.path}/${legacy.id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  const wire = f.gatewayRequests.slice(wireStart);
  assert.equal(wire.length, 4);
  for (const index of [1, 3]) {
    assert.match(wire[index].request.request_id, /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(wire, [
    {
      method: "GetProvider",
      request: { name, workspace_scope: { workspace: f.namespace.name } },
      found: true,
    },
    {
      method: "DeleteProvider",
      request: {
        name,
        workspace_scope: { workspace: f.namespace.name },
        allow_missing: true,
        request_id: wire[1].request.request_id,
      },
    },
    {
      method: "GetProvider",
      request: { name, workspace_scope: { workspace: f.namespace.name } },
      found: false,
    },
    {
      method: "DeleteProviderProfile",
      request: {
        id: name,
        workspace_scope: { workspace: f.namespace.name },
        allow_missing: true,
        request_id: wire[3].request.request_id,
      },
    },
  ]);
  assert.deepEqual(
    [...f.providers],
    deleteBefore.providers.filter(([id]) => id !== name),
  );
  assert.equal(f.providers.has(name), false);
  assert.equal(f.profiles.has(name), false);
  assert.deepEqual(
    [...f.profiles],
    profilesBefore.filter(([id]) => id !== name),
  );
  const deleteAfter = await admissionSnapshot(f);
  assert.deepEqual(
    deleteAfter.rows,
    deleteBefore.rows.filter((row) => row.id !== legacy.id),
  );
  assert.equal(
    await f.controller.transact((unit) =>
      unit.credentialSources.findCredentialSource(f.namespace.id, legacy.id),
    ),
    undefined,
  );
  assert.deepEqual(deleteAfter.materialReads, deleteBefore.materialReads);
  assert.equal(deleteAfter.secretReads, deleteBefore.secretReads);
  assert.deepEqual(f.gatewayEffects, [...deleteBefore.gatewayEffects, "removeSource"]);
  assert.deepEqual(f.providerRequests, []);
});

test("credential header digest uses ordered UTF-8 bytes and u64 lengths", () => {
  assert.equal(
    egressInjectionDigest([
      ["authorization", "Bearer synthetic-vector"],
      ["x-api-key", "key-é"],
    ]),
    "d1e3baea080e3a4d5ec5ac5feb168ded341a545d201aea2d1d1104dca7ec6b23",
  );
});

test("supplier-produced receipt protobuf and registered-instance claims decode through the consumer contract", async () => {
  const vector = JSON.parse(
    readFileSync(new URL("../fixtures/static-egress/openshell-receipt.json", import.meta.url)),
  );
  const definition = loadGatewayDefinition();
  // Bytes were produced by Rust's actual OPA/registry/gateway fixture, independently
  // of this decoder. In particular, uint64 generations must not round through Number.
  const receipt = definition["openshell.v1.LoadedEnforcementEvidence"].deserialize(
    Buffer.from(vector.protobuf_hex, "hex"),
  );
  assert.deepEqual(receipt, vector.receipt);
  assert.equal(receipt.instance_id, vector.verified_extension_claims.instance_id);
  assert.equal(receipt.sandbox_id, vector.verified_extension_claims.sandbox_id);
  const keys = generateKeyPairSync("ed25519");
  const identity = new OpenShellEgressIdentity({
    issuer: vector.verified_extension_claims.iss,
    audience: vector.verified_extension_claims.aud,
    keyId: "fixture-key",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    sender: { id: "fixture-sender", generation: 1 },
  });
  // The capture has no bearer or signing key. Re-sign its claim shape with a local
  // fixture key and fresh times; this checks compatibility, not producer key custody.
  const current = Math.floor(Date.now() / 1000);
  const claims = { ...vector.verified_extension_claims, iat: current, exp: current + 60 };
  const token = (value) => supervisorBearer(value, keys.privateKey);
  const peer = identity.supervisor(token(claims));
  assert.equal(
    await identity.verify(token(claims)),
    undefined,
    "a valid bearer is not an exchange",
  );
  assert.equal(peer.instanceId, receipt.instance_id);
  assert.equal(peer.sandboxId, receipt.sandbox_id);
  assert.equal(identity.supervisor(token({ ...claims, instance_id: undefined })), undefined);
});

test("protected inference uses real admission, fresh IAM, versioned Secret reads and TLS authority/provider wires", async (t) => {
  const f = await staticEgressFixture(t, { physicalPlacement: true });
  assert.notEqual(f.namespace.name, f.runtimeNamespace.name);
  assert.equal(f.namespace.id, f.runtimeNamespace.id);
  assert.deepEqual(f.source.egress, { adoption: "live", retention: "none" });
  assert.throws(
    () => pluginRuntimeConfigMapData(pluginRuntimeSpecForRevision(f.revision)),
    /explicit normalized model endpoint/,
    "protected configuration cannot silently use default retry or transport behavior",
  );
  const runtime = pluginRuntimeSpecForRevision(
    f.revision,
    undefined,
    "https://provider.example.test/v1",
  );
  const config = pluginRuntimeConfigMapData(runtime)["config.toml"];
  assert.match(config, /^web_search = "disabled"/m);
  assert.match(config, /supports_websockets = false/);
  assert.match(config, /request_max_retries = 0\nstream_max_retries = 0/);
  assert.deepEqual(
    runtime.selections,
    {},
    "protected grant does not replace local plugin selection",
  );
  // Deleting the plan must never downgrade an admitted protected execution.
  const { unprotected, refused } = admissionCases(f.revision);
  for (const [revision, expected] of refused) {
    assert.throws(() => pluginRuntimeSpecForRevision(revision), expected);
  }
  assert.doesNotMatch(
    pluginRuntimeConfigMapData(pluginRuntimeSpecForRevision(unprotected))["config.toml"],
    /web_search/,
  );
  const capture = f.capture();
  const result = await f.resolve(capture);
  assert.ok(result.ready, JSON.stringify(result));
  const permit = f.permitRequest(capture, result.ready);
  assert.ok((await f.authorize(permit)).allowed);
  const response = await f.send(capture, result.ready);
  assert.deepEqual(f.providerRequests[0].body, {
    model: "fixture-model",
    input: "hello",
    store: false,
  });
  assert.equal(f.providerRequests[0].authorization, "Bearer synthetic-key-initial");
  const protectedResponse = await f.protect(capture, response);
  assert.deepEqual(JSON.parse(protectedResponse.body), {
    output: "fixture answer",
  });
  const replay = await f.beginExchange();
  replay.stream.write({ authorize: permit });
  await assert.rejects(replay.next(), { code: 7 });

  // Rotation changes material version without replacing source configuration or grants.
  await f.rotateSecret("synthetic-key-rotated");
  const next = f.capture();
  const resolved = await f.resolve(next);
  assert.ok(resolved.ready, JSON.stringify(resolved));
  assert.notEqual(resolved.ready.evidence.material_version, result.ready.evidence.material_version);
  assert.equal(resolved.ready.credential_headers[0].value, "Bearer synthetic-key-rotated");
  await f.revoke();
  assert.ok(
    (await f.authorize(f.permitRequest(next, resolved.ready))).refused,
    "revocation after access must deny selected material at send",
  );
  assert.equal(f.providerRequests.length, 1);
  const beforeReads = f.secretReads;
  assert.ok((await f.resolve(f.capture())).refused);
  assert.equal(f.secretReads, beforeReads, "current IAM denial must precede Secret access");
  const denials = (await f.controller.transact((unit) => unit.audit.list())).filter(
    (event) => event.action === "openclaw.egress.authorize",
  );
  assert.deepEqual(
    denials.map(({ namespaceId, actorId, resource, details }) => ({
      namespaceId,
      actorId,
      resource,
      phase: details.phase,
    })),
    ["before_send", "before_access"].map((phase) => ({
      namespaceId: f.namespace.id,
      actorId: f.revision.servicePrincipalId,
      resource: { kind: "credential_source", namespaceId: f.namespace.id, id: f.source.id },
      phase,
    })),
    "runtime placement must not replace logical IAM or audit identity",
  );
});

test("protected authority refuses forged execution, unsupported operations, replay and changed selected-material evidence", async (t) => {
  const f = await staticEgressFixture(t);
  const before = f.secretReads;
  for (const body of [
    { model: "other-model", input: "hello", store: false },
    { model: "fixture-model", input: "hello" },
    { model: "fixture-model", input: "hello", store: false, stream: "true" },
    { model: "fixture-model", input: "hello", store: false, tools: [{ type: "web_search" }] },
  ]) {
    assert.ok((await f.resolve(f.capture(body))).refused);
  }
  const ambiguous = f.capture();
  ambiguous.request.body = Buffer.from(
    '{"model":"other-model","model":"fixture-model","input":"hello","store":false}',
  );
  assert.ok((await f.resolve(ambiguous)).refused);
  const wrongPeer = f.metadata({
    sandbox_id: "other-sandbox",
    sub: "spiffe://openshell/sandbox/other-sandbox",
  });
  await assert.rejects(f.resolve(f.capture(), wrongPeer), { code: 7 });
  await assert.rejects(f.resolve(f.capture(), f.metadata({ aud: "different-authority" })), {
    code: 7,
  });
  assert.equal(
    f.secretReads,
    before,
    "identity and operation refusals must not touch credential material",
  );
  const captured = f.capture();
  const ready = (await f.resolve(captured)).ready;
  assert.ok(ready);
  assert.ok(
    (await f.resolve({ ...captured, response_custody: randomBytes(32) })).refused,
    "a new signed opening and custody cannot replay the captured use",
  );
  for (const change of [
    (p) => {
      p.evidence.material_version = "not-selected";
    },
    (p) => {
      p.deadline.seconds = String(Number(p.deadline.seconds) + 1);
    },
    (p) => {
      p.credential_headers_sha256 = Buffer.alloc(32);
    },
    (p) => {
      p.context.verified_credential_connector = { path: "/usr/bin/not-authority" };
    },
  ]) {
    // A malformed authorization consumes the one exchange. Start the next negative
    // with a genuinely resolved sibling so it reaches the specific evidence guard.
    const sibling = f.capture();
    const resolved = await f.resolve(sibling);
    const permit = f.permitRequest(sibling, resolved.ready);
    change(permit);
    assert.ok((await f.authorize(permit)).refused);
  }
  const permit = f.permitRequest(captured, ready);
  const decisions = await Promise.allSettled([f.authorize(permit), f.authorize(permit)]);
  assert.ok(decisions.filter((d) => d.value?.allowed).length <= 1);
  assert.ok(
    decisions.some((d) => d.status === "rejected" && d.reason.code === 7),
    "pipelined authorizations are refused on the actual exchange",
  );
  assert.equal(f.providerRequests.length, 0);
});

test("provider authentication rejection fences the exact material version and encoded credential reflection is withheld", async (t) => {
  const f = await staticEgressFixture(t);
  let result = await f.exchangeResponse({
    status: 200,
    body: { output: Buffer.from("synthetic-key-initial").toString("base64") },
  });
  assert.ok(result.blocked, "the actual provider response must pass conservative protection");
  result = await f.exchangeResponse({
    status: 200,
    rawBody: '{"output":"synthetic-key-initial","output":"hidden duplicate"}',
  });
  assert.ok(result.blocked, "duplicate JSON keys cannot conceal reflected material from parsing");
  // Function arguments have their own protocol-defined JSON layer. Ordinary tool
  // decoding must never recover the protected value from escaped response text.
  const escaped = unicodeEscapes("synthetic-key-initial");
  result = await f.exchangeResponse({
    status: 200,
    body: {
      output: [
        {
          type: "function_call",
          id: "call-escaped",
          call_id: "tool-escaped",
          name: "fixture_function_0",
          arguments: '{"cmd":"' + escaped + '"}',
        },
      ],
    },
  });
  assert.ok(
    result.blocked,
    "decoding supported JSON function arguments cannot expose credential material",
  );
  result = await f.exchangeResponse({
    status: 401,
    body: {
      error: {
        code: "invalid_api_key",
        type: "invalid_request_error",
        message: "Invalid credential",
      },
    },
  });
  assert.ok(result.body);
  const captured = f.capture();
  const ready = (await f.resolve(captured)).ready;
  assert.ok(ready);
  assert.ok(
    (await f.authorize(f.permitRequest(captured, ready))).refused,
    "authoritative reread cannot resurrect a rejected version",
  );
  await f.rotateSecret("synthetic-key-new-version");
  result = await f.exchangeResponse({ status: 200, body: { output: "after rotation" } });
  assert.ok(result.body, "new authoritative version does not inherit the old rejection");
});

test("protected admission requires the actual counterpart and exact loaded policy; revision removal deletes only its owned Sandbox", async (t) => {
  const f = await staticEgressFixture(t, { includeLegacy: true });
  // Inspect the production attachment before protobuf can erase an explicit zero.
  // OpenShell requires omission for automatic TLS termination, not TERMINATE or SKIP.
  for (const [index, route] of f.context.plan.routes.entries()) {
    const { binaries, endpoints } =
      f.attachment.configuration.network_policies[`oce-egress-${index}`];
    assert.deepEqual(binaries, [{ path: "/**" }]);
    assert.equal(Object.hasOwn(endpoints[0], "tls"), false);
    const origin = new URL(route.origin);
    assert.deepEqual(endpoints, [
      {
        host: origin.hostname,
        ports: [Number(origin.port || 443)],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_FULL",
        path: route.path,
      },
    ]);
  }
  const middleware = f.attachment.configuration.network_middlewares["oce-egress"];
  assert.equal(middleware.on_error, "fail_closed");
  assert.equal(middleware.credential_authority, true);
  assert.equal(Object.hasOwn(middleware, "config"), false);
  assert.equal(Object.hasOwn(middleware, "order"), false);
  assert.equal(Object.hasOwn(middleware.endpoints, "exclude"), false);
  // Strict Sandbox adoption compares the outgoing policy with its decoded form.
  // Use the production schema and decoder options without normalizing either side.
  const definition = loadGatewayDefinition({ defaults: false, oneofs: true });
  const policy = definition["openshell.v1.SandboxPolicy"];
  assert.deepStrictEqual(
    policy.deserialize(policy.serialize(f.attachment.configuration)),
    f.attachment.configuration,
  );
  const contract = "openshell.supervisor-middleware.contract";
  const capability = "openshell.supervisor-middleware.http-credential-access.v1";
  // The supervisor performs its own Describe with locally compiled capabilities. An
  // old sender cannot merely inherit the upgraded gateway's negotiation result.
  await assert.rejects(
    unary(
      f.clients.SupervisorMiddleware,
      "Describe",
      {
        gateway: { protocol_version: { major: 1 }, supported_capabilities: [contract] },
      },
      f.metadata(),
    ),
    { code: 14 },
  );
  const manifest = await unary(
    f.clients.SupervisorMiddleware,
    "Describe",
    {
      gateway: {
        protocol_version: { major: 1 },
        supported_capabilities: [contract, ...openShellExchangeCapabilities],
        required_capabilities: [contract],
      },
    },
    f.metadata(),
  );
  assert.ok(manifest.extension.required_capabilities.includes(capability));
  f.observed.available = false;
  const refused = await f.request("POST", f.path, {
    body: {
      name: "unsupported-peer",
      type: "openai",
      config: { authorized_base_url: f.modelProvider.baseUrl },
      secrets: { api_key: f.secret.ref },
    },
  });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(
    (await f.request("GET", f.path)).data.length,
    2,
    "failed candidate cannot leave admitted source metadata",
  );
  // Retained Gateway sources need explicit adoption and the same available peer.
  const retainedBefore = (await f.request("GET", `${f.path}/${f.legacySource.id}`)).data;
  const gatewayBefore = structuredClone([...f.providers.entries()]);
  const effectsBefore = [...f.gatewayEffects];
  const adoption = await f.request("PATCH", `${f.path}/${f.legacySource.id}`, {
    body: { adoption: "live", authorityScope: "execution" },
  });
  assert.equal(adoption.status, 503, JSON.stringify(adoption.body));
  assert.equal(retainedBefore.egress, undefined);
  assert.deepEqual((await f.request("GET", `${f.path}/${f.legacySource.id}`)).data, retainedBefore);
  assert.deepEqual([...f.providers.entries()], gatewayBefore);
  assert.deepEqual(f.gatewayEffects, effectsBefore);
  await assert.rejects(f.egress.configureRevision(f.context), {
    name: "RetryLaterError",
    message: PROXY_REGISTRATION_UNAVAILABLE,
  });
  f.observed.available = true;
  const expectedPolicy = structuredClone(f.observed.policy);
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), true);
  assert.equal(
    await f.egress.verifyInstallation(f.context, { ...f.installation, sandboxId: undefined }),
    false,
    "verification cannot discover a missing installation Sandbox identity",
  );
  // A previously generated route without a binary matcher cannot stand in for
  // the canonical attachment or establish a new installation.
  const oldConfiguration = structuredClone(f.attachment.configuration);
  delete oldConfiguration.network_policies["oce-egress-0"].binaries;
  await assert.rejects(
    f.egress.wiringStatus(f.context, { ...f.attachment, configuration: oldConfiguration }),
    /changed protected egress routes/,
  );
  delete f.observed.policy.network_policies["oce-egress-0"].binaries;
  await assert.rejects(f.egress.wiringStatus(f.context, f.attachment), /differs/);
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), false);
  f.observed.policy = structuredClone(expectedPolicy);
  // A reported TLS bypass must fail both initial installation and receipt revalidation,
  // even when the supplier still reports the original loaded-enforcement evidence.
  f.observed.policy.network_policies["oce-egress-0"].endpoints[0].tls = "NETWORK_TLS_MODE_SKIP";
  await assert.rejects(f.egress.wiringStatus(f.context, f.attachment), /differs/);
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), false);
  f.observed.policy = structuredClone(expectedPolicy);
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), true);
  f.observed.policy.network_middlewares["oce-egress"].credential_authority = false;
  assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
  f.observed.policy = structuredClone(expectedPolicy);
  f.observed.policy.network_policies["oce-egress-0"].endpoints[0].allow_uninspected_credentials =
    true;
  await assert.rejects(f.egress.wiringStatus(f.context, f.attachment), /differs/);
  f.observed.policy = structuredClone(expectedPolicy);
  f.observed.policy.network_policies["workspace-node-enrollment"] = {
    name: "workspace-node-enrollment",
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [{ host: "unexpected.example.test", ports: [443] }],
  };
  await assert.rejects(f.egress.wiringStatus(f.context, f.attachment), /differs/);
  f.observed.policy = expectedPolicy;
  // Matching network maps cannot hide a change to the admitted process/filesystem.
  for (const change of [
    { process: { run_as_user: "0", run_as_group: "0" } },
    { filesystem: { read_only: ["/usr"], read_write: ["/"] } },
    { landlock: { compatibility: "best_effort" } },
    { version: 2 },
  ]) {
    f.observed.policy = { ...structuredClone(expectedPolicy), ...change };
    await assert.rejects(f.egress.wiringStatus(f.context, f.attachment), /differs/);
    assert.equal(await f.egress.verifyInstallation(f.context, f.installation), false);
  }
  f.observed.policy = expectedPolicy;
  const originalAnnotations = f.observed.sandbox.annotations;
  f.observed.sandbox.annotations = {
    ...originalAnnotations,
    "openclaw.dev/agent-id": "other-agent",
  };
  await assert.rejects(f.egress.removeRevision(f.context), {
    message: "Protected Sandbox ownership differs from admission.",
  });
  assert.equal(f.observed.deleted.length, 0);
  f.observed.sandbox.annotations = originalAnnotations;
  assert.equal(await f.egress.removeRevision(f.context), true);
  assert.equal(f.observed.deleted.length, 1);
  // Finding 2055: a missing Sandbox is confirmed removed only while the identity still sees
  // the Workspace; a refusal there holds instead of recording the withdrawal.
  f.observed.workspaceVisible = false;
  await assert.rejects(f.egress.removeRevision(f.context), {
    message: /refused the controller gateway identity/,
  });
  f.observed.workspaceVisible = true;
  assert.equal(await f.egress.removeRevision(f.context), true);
  assert.equal(f.observed.deleted.length, 1);
});

test("legacy approved copies survive Secret rotation and failed live adoption; only exact source update opts in", async (t) => {
  const f = await staticEgressFixture(t, { includeLegacy: true });
  const path = `${f.path}/${f.legacySource.id}`;
  const before = structuredClone([...f.providers.values()]);
  assert.equal(before.length, 1);
  assert.equal(before[0].credentials.OPENAI_API_KEY, "synthetic-key-initial");
  assert.equal(f.legacySource.egress, undefined);
  await f.rotateSecret("synthetic-key-replacement");
  assert.equal((await f.request("GET", path)).data.egress, undefined);
  assert.deepEqual(
    [...f.providers.values()],
    before,
    "editing the input Secret must not reinterpret a legacy approved copy as live",
  );
  f.observed.available = false;
  const consent = { adoption: "live", authorityScope: "execution" };
  assert.equal(
    (await f.request("PATCH", path, { body: { adoption: "live" } })).status,
    409,
    "live reads alone are not consent to whole-execution authority",
  );
  assert.equal((await f.request("PATCH", path, { body: consent })).status, 503);
  assert.equal((await f.request("GET", path)).data.egress, undefined);
  assert.deepEqual([...f.providers.values()], before);
  f.observed.available = true;
  // A provider that needs managed login tokens cannot adopt a static key.
  const proxy = f.controller.selectedDriver("credential_proxy");
  const control = proxy.sourceControl;
  const original = control.providers.find((entry) => entry.sourceType.type === "openai");
  assert.ok(original);
  const providerType = structuredClone(original.sourceType);
  const gateway = f.controller.selectedDriver("credential_gateway");
  const listTypes = gateway.listSourceTypes;
  let gatewayType;
  let changeDuringAdmission;
  const reads = f.secretReads;
  try {
    // Simulate a Driver returning a retained mutable catalog entry. Keep the
    // real catalog, peer availability check, and Secret transport.
    gateway.listSourceTypes = async (...args) => {
      const catalog = await listTypes.apply(gateway, args);
      return catalog.map((entry) => {
        if (entry.type !== "openai") {
          return entry;
        }
        gatewayType ??= structuredClone(entry);
        return gatewayType;
      });
    };
    assert.ok(
      Reflect.set(proxy, "sourceControl", {
        ...control,
        providers: control.providers.map((p) =>
          p === original ? { ...p, sourceType: providerType } : p,
        ),
        async assertAvailable(signal) {
          await control.assertAvailable(signal);
          if (changeDuringAdmission) {
            changeDuringAdmission.harnessAuth.loginMode = "chatgptAuthTokens";
          }
        },
      }),
    );
    assert.equal(providerType.harnessAuth.loginMode, "api_key");
    providerType.harnessAuth.loginMode = "chatgptAuthTokens";
    const catalog = await f.request("GET", `/namespaces/${f.namespace.id}/agent-capabilities`);
    assert.equal(catalog.status, 200);
    const offered = catalog.data.capabilities.credentialSources.types.some(
      (entry) => entry.type === "openai",
    );
    const create = await f.request("POST", f.path, {
      body: {
        name: "incompatible-lifecycle",
        type: "openai",
        config: { authorized_base_url: f.modelProvider.baseUrl },
        secrets: { api_key: f.secret.ref },
      },
    });
    const patch = await f.request("PATCH", path, { body: consent });
    assert.deepEqual(
      { offered, create: create.status, patch: patch.status, reads: f.secretReads - reads },
      { offered: false, create: 409, patch: 409, reads: 0 },
    );
    providerType.harnessAuth.loginMode = "api_key";
    for (const [side, type] of [
      ["Proxy", providerType],
      ["Gateway", gatewayType],
    ]) {
      // Change one declaration across the await while its counterpart stays static.
      assert.equal(type.harnessAuth.loginMode, "api_key");
      changeDuringAdmission = type;
      const raced = await f.request("PATCH", path, { body: consent });
      assert.equal(type.harnessAuth.loginMode, "chatgptAuthTokens");
      assert.deepEqual(
        { status: raced.status, reads: f.secretReads - reads },
        { status: 409, reads: 0 },
        side + " lifecycle changed before Secret access",
      );
      type.harnessAuth.loginMode = "api_key";
      assert.equal((await f.request("GET", path)).data.egress, undefined);
      assert.deepEqual([...f.providers.values()], before);
    }
  } finally {
    gateway.listSourceTypes = listTypes;
    Reflect.set(proxy, "sourceControl", control);
  }
  const adopted = await f.request("PATCH", path, { body: consent });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.deepEqual(adopted.data.egress, { adoption: "live", retention: "none" });
  assert.deepEqual(
    [...f.providers.values()],
    before,
    "adoption never overwrites the previous gateway material",
  );
  // Restore a fixture in the *persisted* prior narrow provider generation. An
  // old PATCH must not be able to turn that approval into whole-execution use.
  const { id, namespaceId } = f.legacySource;
  await f.controller.transact(async ({ credentialSources: sources }) => {
    const { egress } = await sources.findCredentialSource(namespaceId, id);
    assert.equal(egress.key.provider.generation, 3);
    const key = {
      ...egress.key,
      source: { id, generation: egress.key.source.generation + 1 },
      provider: { ...egress.key.provider, generation: 1 },
    };
    await sources.admitEgressSource(namespaceId, id, egress.key.source.generation, {
      ...egress,
      key,
    });
  });
  assert.equal((await f.request("PATCH", path, { body: { adoption: "live" } })).status, 409);
  assert.equal((await f.request("PATCH", path, { body: consent })).status, 200);
  const bound = await f.request("PATCH", `${f.path}/${f.source.id}`, {
    body: { adoption: "live" },
  });
  assert.equal(bound.status, 409, "running source cutover is explicitly unsupported");
});

test("current supplier evidence is required at access and send; stored receipts cannot authorize a replacement", async (t) => {
  const f = await staticEgressFixture(t);
  const original = structuredClone(f.observed.evidence);
  const observation = f.observed.observation;
  const beforeLegacy = f.secretReads;
  delete f.observed.observation;
  // LOADED and valid legacy field 3 remain present; neither substitutes for V1.
  assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
  assert.ok((await f.resolve(f.capture())).refused);
  assert.equal(f.secretReads, beforeLegacy);
  f.observed.observation = observation;
  // Proto3 scalar zeros can be omitted on the wire; both encodings have one fingerprint.
  f.observed.evidence = { ...original, config_revision: "0", provider_env_revision: "0" };
  const zero = await f.egress.wiringStatus(f.context, f.attachment);
  assert.ok(zero);
  delete f.observed.evidence.config_revision;
  delete f.observed.evidence.provider_env_revision;
  assert.deepEqual(
    (await f.egress.wiringStatus(f.context, f.attachment)).enforcement,
    zero.enforcement,
  );
  const reads = f.secretReads;
  // Missing/old/failed receipts and mismatched generations must fail before material access.
  for (const evidence of [
    undefined,
    { ...original, enforced_capabilities: [] },
    { ...original, sandbox_id: "another-sandbox" },
    { ...original, policy_hash: "2b".repeat(32) },
    { ...original, policy_version: 2 },
    { ...original, config_revision: "17395563786422800000" },
    { ...original, provider_env_revision: "9019556378642280000" },
    { ...original, instance_id: "10000000-0000-4000-8000-000000000001" },
  ]) {
    f.observed.evidence = evidence;
    assert.ok((await f.resolve(f.capture())).refused);
    assert.equal(f.secretReads, reads, "historical installation must not permit credential access");
  }
  f.observed.evidence = original;
  const captured = f.capture();
  const ready = (await f.resolve(captured)).ready;
  assert.ok(ready, "restoring the original current observation permits a new operation");
  // Replacement happens after material access, while the operation still holds the old receipt.
  f.observed.evidence = { ...original, instance_id: "10000000-0000-4000-8000-000000000001" };
  assert.ok((await f.authorize(f.permitRequest(captured, ready))).refused);
  assert.equal(f.providerRequests.length, 0);
  const replacement = await f.egress.wiringStatus(f.context, f.attachment);
  assert.ok(replacement);
  await assert.rejects(
    f.controller.transact((unit) => unit.credentialSources.recordEgressInstallation(replacement)),
    /already bound/,
  );
});

test("retained Sandbox policy versions are independent of plan generation but still fence installation", async (t) => {
  const f = await staticEgressFixture(t, { recordInstallation: false });
  assert.equal(f.context.plan.generation, 1);
  f.observed.policyVersion = 4;
  f.observed.activePolicyVersion = 4;
  f.observed.evidence.policy_version = 4;
  const installed = await f.egress.wiringStatus(f.context, f.attachment);
  assert.ok(installed, "matching loaded policy must enroll after retained-Sandbox updates");
  assert.equal(await f.egress.verifyInstallation(f.context, installed), true);

  // Independent supplier fields must agree; none can borrow the OCE generation
  // or claim readiness for a policy that is still loading or failed.
  for (const change of [
    { policyVersion: 1 },
    { activePolicyVersion: 1 },
    { policyStatus: 1 },
    { policyStatus: 3 },
    { policyVersion: 0, activePolicyVersion: 0 },
  ]) {
    Object.assign(f.observed, change);
    assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
    assert.equal(await f.egress.verifyInstallation(f.context, installed), false);
    Object.assign(f.observed, { policyVersion: 4, activePolicyVersion: 4, policyStatus: 2 });
  }
  f.observed.evidence.policy_version = 1;
  assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
  assert.equal(await f.egress.verifyInstallation(f.context, installed), false);

  // Even unchanged policy content at a new supplier version invalidates the
  // earlier receipt; changing the comparison must not remove that fence.
  f.observed.policyVersion = 5;
  f.observed.activePolicyVersion = 5;
  f.observed.evidence.policy_version = 5;
  assert.equal(await f.egress.verifyInstallation(f.context, installed), false);
  const replacement = await f.egress.wiringStatus(f.context, f.attachment);
  assert.ok(replacement);
  assert.notEqual(replacement.enforcement.configurationId, installed.enforcement.configurationId);
  assert.equal(await f.egress.verifyInstallation(f.context, replacement), true);
});

test("V1 permits only the exact inert runtime rule and fences both policies before Secret access and send", async (t) => {
  const f = await staticEgressFixture(t, { inertProviderRule: true });
  const observation = structuredClone(f.observed.observation);
  const originalEvidence = structuredClone(f.observed.evidence);
  const source = structuredClone(f.observed.policy);
  const ruleName = observation.inert_provider_rule;
  assert.notEqual(observation.source_policy_hash, originalEvidence.policy_hash);
  assert.equal(observation.source_policy_hash, f.observed.policyHash);
  assert.deepEqual(observation.effective_policy.network_policies[ruleName], { name: ruleName });
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), true);
  const capture = f.capture();
  const ready = (await f.resolve(capture)).ready;
  assert.ok(ready, "the real consumer accepts the passive source != effective wire fixture");
  assert.ok((await f.authorize(f.permitRequest(capture, ready))).allowed);
  const reads = f.secretReads;
  // Each independently malformed derivation must refuse installation and current
  // authority before the versioned Secret Driver is called.
  const endpoint = { host: "unexpected.example.test", ports: [443] };
  const inert = `effective_policy.network_policies.${ruleName}`;
  const route = "effective_policy.network_policies.oce-egress-0.endpoints";
  for (const [path, value] of [
    ["source_policy_hash", "4d".repeat(32)],
    ["effective_policy", undefined],
    ["inert_provider_rule", ""],
    ["inert_provider_rule", `${ruleName}_other`],
    [`${inert}.name`, "other"],
    [`${inert}.endpoints`, [endpoint]],
    [`${inert}.binaries`, [{ path: "/usr/bin/extra" }]],
    [
      inert,
      { name: ruleName, endpoints: [endpoint], binaries: [{ path: "/usr/bin/model-client" }] },
    ],
    [`${route}.1`, endpoint],
    ["effective_policy.network_policies.extra", {}],
    ["effective_policy.process.run_as_user", "0"],
    ["effective_policy.filesystem.read_write", ["/"]],
    ["effective_policy.landlock.compatibility", "best_effort"],
    ["effective_policy.version", 2],
    [`${route}.0.rules`, [Buffer.from([0])]],
    [
      "effective_policy.network_middlewares.oce-egress.config",
      { fields: { enabled: { bool_value: false } } },
    ],
  ]) {
    const changed = structuredClone(observation);
    const fields = path.split(".");
    const key = fields.pop();
    const parent = fields.reduce((object, field) => object[field], changed);
    if (value === undefined) {
      delete parent[key];
    } else {
      parent[key] = value;
    }
    f.observed.observation = changed;
    assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
    assert.ok((await f.resolve(f.capture())).refused, path);
    assert.equal(f.secretReads, reads, "a widened or stale observation cannot read a Secret");
  }
  f.observed.observation = structuredClone(observation);
  // Individually valid replacement identities/policies still cannot replace the
  // saved installation fence, even when source and effective change together.
  for (const change of [
    () => {
      f.observed.evidence.policy_hash = "5e".repeat(32);
    },
    () => {
      f.observed.policyHash = "6f".repeat(32);
      f.observed.observation.source_policy_hash = f.observed.policyHash;
    },
    () => {
      f.observed.policy.process.run_as_user = "2000";
      f.observed.observation.effective_policy.process.run_as_user = "2000";
    },
  ]) {
    change();
    assert.ok((await f.resolve(f.capture())).refused);
    assert.equal(f.secretReads, reads);
    f.observed.evidence = structuredClone(originalEvidence);
    f.observed.policyHash = observation.source_policy_hash;
    f.observed.policy = structuredClone(source);
    f.observed.observation = structuredClone(observation);
  }
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), true);
  const sendCapture = f.capture();
  const sendReady = (await f.resolve(sendCapture)).ready;
  assert.ok(sendReady, "Resolve succeeds while the runtime rule is still inert");
  // Widen after material resolution: the fresh send check must reject a usable
  // endpoint even though this operation already holds valid access evidence.
  const widenedRule = f.observed.observation.effective_policy.network_policies[ruleName];
  const protectedRule = source.network_policies["oce-egress-0"];
  widenedRule.endpoints = structuredClone(protectedRule.endpoints);
  widenedRule.binaries = structuredClone(protectedRule.binaries);
  assert.ok((await f.authorize(f.permitRequest(sendCapture, sendReady))).refused);
  assert.equal(f.providerRequests.length, 0, "send-side widening must not permit a provider send");
});

function unicodeEscapes(text) {
  return [...text]
    .map((character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
}

registerStaticEgressResponsesPrefixCases();

test("Responses admits bounded native agent messages", async (t) => {
  await runStaticEgressNativeAgentMessageCase(t);
});

registerStaticEgressResponsesAndCapacityCases(unicodeEscapes);

test("cancelled and denied exchanges retain capacity until receipt work settles", async (t) => {
  await runStaticEgressReceiptCapacityCase(t);
});

for (const stage of ["policy check", "Kubernetes namespace verification"]) {
  test(`closing the accepted duplex during ${stage} prevents the Secret GET`, async (t) => {
    const fault = createReceiptPersistenceFaults();
    const finished = Promise.withResolvers();
    const f = await staticEgressFixture(t, {
      resolutionFinished: finished.resolve,
      appFactory: fault.appFactory,
    });
    const captured = f.capture();
    const exchange = await f.beginExchange();
    const before = f.secretReads;
    const gate =
      stage === "policy check"
        ? fault.arm("findCredentialWithdrawal", "pause")
        : f.pauseNamespaceVerification();
    t.after(gate.release);
    exchange.stream.write(exchange.opening(captured));
    await gate.reached;

    // Wait for the real authority to acknowledge the half-close before releasing work.
    // The final response alone could not tell us whether an unnecessary Secret GET ran.
    const ended = Promise.withResolvers();
    exchange.stream.once("status", ended.resolve);
    exchange.stream.end();
    assert.equal((await ended.promise).code, 0);
    gate.release();
    assert.deepEqual(await finished.promise, { kind: "refused", error: { kind: "cancelled" } });
    assert.equal(f.secretReads, before, "a lost response owner cannot start a new Secret GET");
    assert.equal(f.providerRequests.length, 0);
    assert.deepEqual(
      exchange.received.map((message) => message.event),
      ["challenge"],
    );
    assert.ok((await f.resolve(f.capture())).ready, "an independent exchange still resolves");
  });
}

test("an elapsed deadline prevents the Kubernetes Secret GET even before the timeout callback runs", async (t) => {
  await runStaticEgressElapsedDeadlineCase(t);
});

for (const stage of ["check", "read"]) {
  test(`material ${stage} reaching the request deadline must report deadline exceeded`, async (t) => {
    const f = await syntheticDispatchFixture(t);
    const forwarder = new CredentialProxy({
      ...f.ports,
      [stage]: async (...args) => {
        const result = await f.ports[stage](...args);
        f.advance(Date.parse(f.request.deadlineAt) - f.ports.now());
        return result;
      },
    });
    const result = await forwarder.resolve(
      "synthetic-peer",
      f.association.installation.sandboxId,
      f.request,
      new AbortController().signal,
    );
    assert.deepEqual(result, { kind: "refused", error: { kind: "deadline_exceeded" } });
    assert.equal(
      f.reads,
      stage === "read" ? 1 : 0,
      "only a selection started before the deadline may read",
    );
    assert.equal(f.arrivals, 0);
  });
}

registerStreamReceiptPersistenceCases(() => new EgressSendReceipts(new InMemoryPlatformState()));

test("authenticated sender receipts survive authority restart without replay permission and distinguish observations", async (t) => {
  await runStaticEgressReceiptRestartCase(t);
});

test("receipt observation fences only positive credential rejection, including blocked provider responses", async (t) => {
  await runStaticEgressCredentialRejectionCase(t);
});

test("receipt persistence failure, lost acknowledgment and late authorization never grant send permission", async (t) => {
  await runStaticEgressReceiptAuthorizationFailureCase(t);
});

test("response persistence must commit its observation and fence before policy bytes are acknowledged", async (t) => {
  await runStaticEgressResponseCommitCase(t);
});

function admissionCases(revision) {
  const withoutPlan = { ...revision };
  delete withoutPlan.egressPlan;
  const missing = { ...withoutPlan };
  delete missing.executionAdmission;
  const executionAdmission = { version: 2, mode: "unprotected" };
  return {
    unprotected: { ...withoutPlan, executionAdmission },
    refused: [
      [missing, /Missing or unsupported durable/],
      ...[1, 3].map((version) => [
        { ...missing, executionAdmission: { ...executionAdmission, version } },
        /Missing or unsupported durable/,
      ]),
      [withoutPlan, /Inconsistent durable/],
      [{ ...revision, executionAdmission }, /Inconsistent durable/],
    ],
  };
}

test("production Compute refuses protected admission and release, including empty plans", async (t) => {
  const compute = createTestKubernetesComputeDriver("admission-cutoff");
  const f = await staticEgressFixture(t);
  const admittingCompute = createTestKubernetesComputeDriver("admission-origin", {
    gatewayRuntime: true,
  });
  // Keep valid resolved-provider admission while testing the independent protection gate.
  const admitted = {
    ...f.revision,
    compute: { ...f.revision.compute, admission: admittingCompute.admitRevision(f.revision) },
  };
  const { unprotected, refused } = admissionCases(admitted);
  const cases = [
    ...refused,
    [admitted, /Protected execution is unavailable/],
    [
      {
        ...admitted,
        credentialSources: [],
        egressPlan: { ...f.revision.egressPlan, routes: [] },
      },
      /Protected execution is unavailable/,
    ],
  ];
  // Actual shipped Compute entrypoints: no clients are initialized and no cluster exists.
  // Even its runtime-disabled activation fast path must recognize admission first.
  for (const [revision, expected] of cases) {
    assert.throws(() => compute.validateExecutionAdmission(revision), expected);
    await assert.rejects(compute.prepareRevision(revision), expected);
    await assert.rejects(compute.activateRevision(revision), expected);
  }
  assert.doesNotThrow(() => compute.validateExecutionAdmission(unprotected));
  await assert.rejects(
    compute.activateRevision(unprotected),
    /AgentRevision Compute ownership is invalid/,
  );
  assert.equal((await compute.prepareRevision(unprotected)).ready, false);
  await compute.activateRevision({
    ...unprotected,
    gatewayManagedMode: false,
    compute: { ...unprotected.compute, id: compute.id, implementation: compute.implementation },
  });

  // Source-free runtime authentication retains an empty protected plan. Compute without
  // a qualified protected release must refuse it, even though no credentials are granted.
  const emptyAgent = await f.createAgent(
    f.namespace.id,
    "credential-free",
    f.revision.configuration,
    { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
  );
  const emptyMetadata = await f.deployAgent(f.namespace.id, emptyAgent.id);
  const emptyRevision = await f.controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, emptyAgent.id, emptyMetadata.id),
  );
  assert.deepEqual(emptyRevision.executionAdmission, { version: 3, mode: "protected" });
  assert.deepEqual(emptyRevision.egressPlan.routes, []);
  await assert.rejects(
    compute.prepareRevision(emptyRevision),
    /Protected execution is unavailable/,
  );

  // Exercise the real OCC deploy route with the shipped Compute admission policy.
  // Other Compute operations remain deterministic fixtures; this is not cluster proof.
  let admissionChecks = 0;
  const admission = await staticEgressFixture(t, {
    admitRevision: false,
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        computeDriver: {
          ...options.computeDriver,
          validateExecutionAdmission(revision, owner) {
            admissionChecks += 1;
            compute.validateExecutionAdmission(revision, owner);
          },
        },
      }),
  });
  const response = await admission.request(
    "POST",
    `/namespaces/${admission.namespace.id}/agents/${admission.agent.id}/deploy`,
  );
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(admissionChecks, 1, "the OCC route must reach the shipped Compute admission gate");
  assert.deepEqual(
    await admission.controller.transact((unit) =>
      unit.revisions.listRevisions(admission.namespace.id, admission.agent.id),
    ),
    [],
  );
});

function networkPolicyGrant() {
  return {
    id: "python-demo",
    binary: "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
}

async function networkPolicyFixture(t, { admitRevision = true } = {}) {
  const grant = networkPolicyGrant();
  const f = await staticEgressFixture(t, {
    admitRevision,
    appFactory: (context, options) =>
      createConsoleAppFixture(context, { ...options, sandboxNetworkPolicyCeiling: [grant] }),
  });
  return { f, grant };
}

async function enableNetworkPolicyEditing(f) {
  const base = `/namespaces/${f.namespace.id}/agents/${f.agent.id}/sandbox-policy/networking`;
  const enabled = await f.request("PATCH", `${base}/editing`, { body: { enabled: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const view = await f.request("GET", base);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  return { base, view: view.body.data };
}

test("protected admission refuses an Agent's network policy additions instead of dropping them", async (t) => {
  // The protected profile is the Sandbox's exact policy, so Agent additions cannot ride on it.
  // Admission says so at deploy time; it must not silently admit a revision without them.
  const { f, grant } = await networkPolicyFixture(t, { admitRevision: false });
  const savePolicy = (additions) =>
    f.controller.transact(async (unit) => {
      const policy = await unit.sandboxPolicies.find(f.namespace.id, f.agent.id);
      assert.ok(policy, "every Agent owns a sandbox policy");
      const saved = await unit.sandboxPolicies.save(
        { ...policy, additions, version: policy.version + 1 },
        policy.version,
      );
      assert.ok(saved);
    });
  await savePolicy([grant]);
  const refused = await f.request(
    "POST",
    `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
  );
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
  assert.match(
    refused.body.error.message,
    /^Protected execution keeps only the Credential Proxy egress policy, so this Agent's network policy additions are refused\./,
  );
  assert.deepEqual(
    await f.controller.transact((unit) => unit.revisions.listRevisions(f.namespace.id, f.agent.id)),
    [],
  );
  // Without additions the same Agent admits a protected revision that keeps only its
  // protected egress policy: no Agent policy snapshot rides beside the egress plan.
  await savePolicy([]);
  const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await f.controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, metadata.id),
  );
  assert.equal(revision.executionAdmission.mode, "protected");
  assert.ok(revision.egressPlan);
  assert.equal(revision.sandboxPolicy, undefined);
});

test("the policy endpoint refuses additions and live application while the active revision is protected", async (t) => {
  // Fail early: the same rule createRevision and the worker enforce is refused at save and
  // apply time, with the Credential Proxy named, and the policy view says so up front.
  const { f, grant } = await networkPolicyFixture(t);
  assert.equal(f.revision.executionAdmission.mode, "protected");
  const { base, view } = await enableNetworkPolicyEditing(f);
  assert.equal(view.editingEnabled, true);
  assert.equal(view.protectedExecution, true);
  // The protected revision admitted no Agent policy snapshot, so no revision owns defaults.
  assert.equal(view.defaultsRevisionId, undefined);
  const version = view.policy.version;
  const refused = await f.request("PUT", base, {
    body: { expectedVersion: version, additions: [grant] },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
  assert.match(
    refused.body.error.message,
    /^Protected execution.*Credential Proxy.*additions are refused/,
  );
  // Nothing was saved, and an empty policy can still be written.
  assert.equal((await f.request("GET", base)).body.data.policy.version, version);
  const cleared = await f.request("PUT", base, {
    body: { expectedVersion: version, additions: [] },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.data.version, version + 1);
  const applied = await f.request("POST", `${base}/apply`, {
    body: { expectedVersion: version + 1, revisionId: f.revision.id },
  });
  assert.equal(applied.status, 409, JSON.stringify(applied.body));
  assert.equal(applied.body.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
  assert.match(
    applied.body.error.message,
    /protected execution.*Credential Proxy.*application is refused/,
  );
  assert.equal((await f.request("GET", base)).body.data.policy.application, undefined);
});

test("the policy endpoint refuses additions before an Agent's first protected deploy", async (t) => {
  // Finding 2053, fail early: with the Credential Proxy selected, the next deploy is protected
  // and would refuse saved additions, so save refuses them before any revision exists.
  const { f, grant } = await networkPolicyFixture(t, { admitRevision: false });
  const { base, view } = await enableNetworkPolicyEditing(f);
  assert.equal(view.protectedExecution, true, "no revision yet; the next one is protected");
  const version = view.policy.version;
  const refused = await f.request("PUT", base, {
    body: { expectedVersion: version, additions: [grant] },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "SANDBOX_POLICY_PROTECTED_EXECUTION");
  assert.equal(
    refused.body.error.message,
    "Protected execution applies to this Agent: the Credential Proxy routes alone govern its egress, so network policy additions are refused; only an empty policy can be saved.",
  );
  const unchanged = (await f.request("GET", base)).body.data.policy;
  assert.equal(unchanged.version, version);
  assert.deepEqual(unchanged.additions, []);
  const cleared = await f.request("PUT", base, {
    body: { expectedVersion: version, additions: [] },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  // The deploy that follows is protected and carries no Agent policy snapshot.
  const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await f.controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, metadata.id),
  );
  assert.equal(revision.executionAdmission.mode, "protected");
  assert.equal(revision.sandboxPolicy, undefined);
});

test("the OpenShell Driver refuses a protected revision carrying Agent network policy additions", async (t) => {
  // Finding 2053's provisioning backstop: the protected Sandbox policy is the protected egress
  // profile alone. Admission never stores additions on a protected revision; should one carry
  // them anyway, provisioning refuses it rather than silently dropping them.
  const f = await staticEgressFixture(t);
  const grant = networkPolicyGrant();
  const requirements = {
    loginMode: "api_key",
    image: "harness-fixture:local",
    command: ["node", "harness.mjs"],
    workspaceMounts: [],
    credentialAttachments: [],
    proxyWiring: f.attachment,
    labels: { "openclaw.dev/revision": f.revision.id },
    files: [],
    environment: [],
  };
  await assert.rejects(
    f.sandboxDriver.provisionHarness({
      ...f.context,
      kubernetes: {},
      signal: AbortSignal.timeout(5000),
      transportToken: "fixture-transport-token",
      requirements,
      revision: {
        ...f.revision,
        sandboxPolicy: {
          driverId: f.sandboxDriver.id,
          implementation: "openshell",
          version: 2,
          defaults: {},
          additions: [grant],
        },
      },
    }),
    {
      code: "SANDBOX_HARNESS_UNSUPPORTED",
      message:
        "Protected execution keeps only its protected egress policy; this revision carries Agent network policy additions.",
    },
  );
});

test("the policy worker names protected execution when it fails queued live application", async () => {
  // Finding 2053's worker backstop: OCC now refuses live application to a protected revision,
  // so only work queued by earlier admission code reaches this state. It must fail at once,
  // name the rule and touch no provider.
  const grant = networkPolicyGrant();
  const application = {
    id: "application-2053",
    revisionId: "rev-2053",
    policyVersion: 2,
    snapshot: {
      driverId: "sandbox",
      implementation: "openshell",
      version: 2,
      defaults: {},
      additions: [grant],
    },
    expectedProviderVersion: "1",
    state: "pending",
    requestedBy: "principal",
    requestedAt: new Date().toISOString(),
  };
  let policy = {
    id: "sbp-2053",
    namespaceId: "ns-2053",
    agentId: "agt-2053",
    version: 2,
    additions: [grant],
    application,
  };
  const outcomes = [];
  const unit = {
    namespaces: { lockNamespace: async () => ({ status: "ready" }) },
    agents: {
      lockAgent: async () => ({
        status: "active",
        desiredRuntimeState: "running",
        activeRevisionId: application.revisionId,
      }),
    },
    sandboxPolicies: {
      find: async () => policy,
      save: async (next) => (policy = next),
    },
    revisions: {
      findRevision: async () => ({
        id: application.revisionId,
        sandboxDriverId: "sandbox",
        executionAdmission: { version: 2, mode: "protected" },
        compute: { id: "compute", implementation: "kubernetes" },
      }),
    },
    audit: { append: async () => {} },
  };
  const queue = {
    heartbeat: async (claim) => claim,
    complete: async () => outcomes.push("complete"),
    fail: async (_claim, { code }) => outcomes.push(`fail ${code}`),
    retry: async (_claim, { code }) => outcomes.push(`retry ${code}`),
  };
  let providerCalls = 0;
  const outcome = await reconcileSandboxPolicy(
    {
      state: { transactWithQueue: (operation) => operation(unit, queue) },
      driver: {
        id: "sandbox",
        implementation: "openshell",
        async observeNetworkPolicy() {
          providerCalls++;
          return { resourceVersion: "1", policyVersion: "1", state: "applied", matches: false };
        },
        async applyNetworkPolicy() {
          providerCalls++;
        },
      },
      compute: {
        id: "compute",
        implementation: "kubernetes",
        resolveSandboxNamespace: async (namespace) => namespace,
      },
      iam: { id: "iam", authorize: async () => ({ allowed: true }) },
      installationId: "ins-2053",
      ceiling: [grant],
      signal: AbortSignal.timeout(5_000),
      maxAttempts: 5,
      deadlineMs: 600_000,
      leaseDurationMs: 30_000,
    },
    {
      idempotencyKey: `agent:${policy.agentId}:reconcile:sandbox_policy:${application.id}`,
      namespaceId: policy.namespaceId,
      agentId: policy.agentId,
      actorId: "principal",
      attemptCount: 1,
      ageMs: 0,
    },
  );
  assert.equal(outcome, "permanent");
  assert.equal(providerCalls, 0);
  assert.deepEqual(outcomes, ["fail SANDBOX_POLICY_PROTECTED_EXECUTION"]);
  assert.equal(policy.application.state, "failed");
  assert.equal(policy.application.reason, "SANDBOX_POLICY_PROTECTED_EXECUTION");
});

test("an unavailable protected egress provider fails the deployment with an operator message", () => {
  const error = deploymentErrorForWork({
    state: "failed_permanent",
    reasonCode: "EGRESS_PROVIDER_UNAVAILABLE",
  });
  assert.equal(error.code, "EGRESS_PROVIDER_UNAVAILABLE");
  assert.notEqual(error.message, "Deployment reconciliation failed.");
  assert.match(error.message, /protected egress provider/);
});
