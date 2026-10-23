import assert from "node:assert/strict";
import test from "node:test";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import {
  encodeSyntheticEvents,
  outputWithIndependentCitation,
} from "../fixtures/synthetic-egress-provider.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { OpenShellEgressIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-identity.ts";
import {
  CredentialProxy,
  OPERATION_AUTHENTICATION_BUDGET,
  OPERATION_CAPACITY,
  OPERATION_SANDBOX_SHARE,
  REPLAY_SANDBOX_SHARE,
  REPLAY_TABLE_CAPACITY,
  STREAM_LEASE_CEILING_MS,
  STREAM_LEASE_IDLE_MS,
  STREAM_LEASE_RECHECK_MS,
  egressInjectionDigest,
} from "../../packages/occ/src/credential-proxy.ts";
import { deploymentErrorForWork } from "../../packages/occ/src/state/controller-work.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import {
  pluginRuntimeSpecForRevision,
  pluginRuntimeConfigMapData,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import {
  staticEgressFixture,
  loadGatewayDefinition,
  supervisorBearer,
  syntheticDispatchFixture,
  requestId,
  unary,
  wireTime,
} from "../helpers/static-egress.mjs";

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
  const f = await staticEgressFixture(t);
  // Inspect the production attachment before protobuf can erase an explicit zero.
  // OpenShell requires omission for automatic TLS termination, not TERMINATE or SKIP.
  for (const [index, route] of f.context.plan.routes.entries()) {
    const endpoints = f.attachment.configuration.network_policies[`oce-egress-${index}`].endpoints;
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
    body: { name: "unsupported-peer", type: "openai", secrets: { api_key: f.secret.ref } },
  });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(
    (await f.request("GET", f.path)).data.length,
    1,
    "failed candidate cannot leave admitted source metadata",
  );
  await assert.rejects(f.egress.configureRevision(f.context), {
    name: "DependencyUnavailableError",
  });
  f.observed.available = true;
  const expectedPolicy = structuredClone(f.observed.policy);
  assert.equal(await f.egress.verifyInstallation(f.context, f.installation), true);
  assert.equal(
    await f.egress.verifyInstallation(f.context, { ...f.installation, sandboxId: undefined }),
    false,
    "verification cannot discover a missing installation Sandbox identity",
  );
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
    assert.equal(egress.key.provider.generation, 2);
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

const wire = JSON.parse(
  readFileSync(new URL("../fixtures/static-egress/codex-responses.json", import.meta.url)),
);
const responseEvents = () => structuredClone(wire.responseEvents);
const encode = (events) => encodeSyntheticEvents(events).toString("utf8");
const selectedMaterial = "synthetic-key-initial";
const reflectedMaterial = [selectedMaterial, Buffer.from(selectedMaterial).toString("base64")];

function splitText(text) {
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

function outputTextParts(...texts) {
  return texts.map((text) => ({ type: "output_text", text, annotations: [] }));
}

function unicodeEscapes(text) {
  return [...text]
    .map((character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
}

// Exercise the actual protected exchange in both directions. A denied response must
// release no messages (including its head); an allowed response must arrive byte-for-byte.
function responseChecks(f) {
  async function check(
    rawBody,
    { blocked, label, stream = true, request = { ...wire.request, stream } } = {},
  ) {
    const contentType = stream ? "text/event-stream" : "application/json";
    const result = await f.exchangeResponse({ status: 200, contentType, rawBody }, request);
    if (blocked) {
      assert.equal(result.blocked, true, label);
    } else {
      assert.equal(result.response_complete, true, label);
      assert.equal(result.body?.toString(), rawBody, label);
    }
    return rawBody;
  }
  return {
    wireBody: check,
    events(events, blocked, label, stream = true, request) {
      const body = stream ? encode(events) : JSON.stringify(events.at(-1).response);
      return check(body, { blocked, label, stream, request });
    },
  };
}

test("Responses output text assembled across parts and messages cannot reveal selected material", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const message = (id, parts) => ({
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: outputTextParts(...parts),
  });
  // Deltas and completed items stay harmless. Only the terminal envelope contains
  // the candidate, so protecting an earlier projection cannot mask this test.
  for (const stream of [false, true]) {
    for (const acrossMessages of [false, true]) {
      for (const text of [...reflectedMaterial, "ordinary response"]) {
        const parts = splitText(text);
        const events = responseEvents();
        events.at(-1).response.output = acrossMessages
          ? parts.map((part, i) => message(`msg_${i}`, [part]))
          : [message("msg_0", parts)];
        await check.events(
          events,
          reflectedMaterial.includes(text),
          `stream=${stream}, acrossMessages=${acrossMessages}`,
          stream,
          stream ? wire.request : { model: "fixture-model", input: "hello", store: false },
        );
      }
    }
  }
});

test("Responses refusal parts pass as assistant content and cannot reveal selected material", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  // A provider safety refusal streams as a `refusal` content part with refusal deltas.
  const refusalEvents = (refusal) => {
    const events = responseEvents();
    const [prefix, suffix] = splitText(refusal);
    return events.flatMap((event) => {
      const next = structuredClone(event);
      if (next.part) {
        next.part = { type: "refusal", refusal: event.type.endsWith(".added") ? "" : refusal };
      }
      if (next.type === "response.output_text.delta") {
        return [
          { ...next, type: "response.refusal.delta", delta: prefix },
          { ...next, type: "response.refusal.delta", delta: suffix },
        ];
      }
      if (next.type === "response.output_text.done") {
        delete next.text;
        return [{ ...next, type: "response.refusal.done", refusal }];
      }
      for (const item of [next.item, ...(next.response?.output ?? [])]) {
        if (item?.type === "message" && item.content.length > 0) {
          item.content = [{ type: "refusal", refusal }];
        }
      }
      return [next];
    });
  };
  for (const stream of [false, true]) {
    const request = stream
      ? wire.request
      : { model: "fixture-model", input: "hello", store: false };
    await check.events(
      refusalEvents("I can't help with that."),
      false,
      `refusal passes, stream=${stream}`,
      stream,
      request,
    );
    for (const material of reflectedMaterial) {
      await check.events(
        refusalEvents(`I can't help with ${material}.`),
        true,
        `refusal reflecting material, stream=${stream}`,
        stream,
        request,
      );
    }
  }
  // Split across an output_text delta and a refusal delta in the next part: the consumer may
  // join both, so the assistant stream protects their concatenation.
  const mixed = (text) => {
    const [created, item, part, delta, ...rest] = responseEvents();
    const [prefix, suffix] = splitText(text);
    return [
      created,
      item,
      part,
      { ...delta, delta: prefix },
      { ...part, content_index: 1, part: { type: "refusal", refusal: "" } },
      {
        ...delta,
        type: "response.refusal.delta",
        content_index: 1,
        delta: suffix,
      },
      ...rest,
    ];
  };
  await check.events(mixed("ordinary response"), false, "benign output_text and refusal deltas");
  for (const material of reflectedMaterial) {
    await check.events(mixed(material), true, "output_text and refusal deltas assembling material");
  }
  // Split across refusal deltas only: the terminal snapshot stays harmless.
  for (const material of reflectedMaterial) {
    const events = refusalEvents(material).map((event) => {
      if (event.type === "response.refusal.done") {
        return { ...event, refusal: "redacted" };
      }
      if (event.part?.refusal) {
        return { ...event, part: { ...event.part, refusal: "redacted" } };
      }
      for (const item of [event.item, ...(event.response?.output ?? [])]) {
        if (item?.type === "message" && item.content.length > 0) {
          item.content = [{ type: "refusal", refusal: "redacted" }];
        }
      }
      return event;
    });
    await check.events(events, true, "refusal deltas assembling the material");
  }
});

test("Responses assistant projections protect independent items and seeded deltas", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const parts = (text) => outputTextParts(...splitText(text));
  function eventsFor(text, kind) {
    const events = responseEvents();
    if (kind === "done") {
      // Change only this independent item. Deltas and terminal output stay READY.
      events[6].item.content = parts(text);
    } else if (kind === "envelope") {
      events[7].response.output[0].content = parts(text);
    } else if (kind === "added") {
      events[1].item.content = parts(text);
      // Seeded parts already occupy indexes 0 and 1; no duplicate append.
      events.splice(2, 1);
    } else if (kind === "deltas") {
      const [left, right] = parts(text);
      events.splice(3, 1, { ...events[3], delta: left.text }, { ...events[3], delta: right.text });
    } else {
      // Split the seed across two parts, then finish via an ID-free delta.
      // No single indexed SDK snapshot contains the full candidate.
      // Split inside the citation opener when present, so neither event has it.
      const citation = text.indexOf("citation");
      const boundary = citation === -1 ? Math.floor(text.length / 2) : citation + 3;
      const seed = parts(text.slice(0, boundary));
      events[3].delta = text.slice(boundary);
      if (kind === "seed") {
        events[1].item.content = seed;
        events.splice(2, 1);
      } else {
        // The delta names the first item, but the assistant consumer sends it
        // to the most recently added message. Both wire items remain valid.
        const active = structuredClone(events[1]);
        active.output_index = 1;
        active.item.id = "msg_active";
        active.item.content = seed;
        events.splice(3, 0, active);
        const done = structuredClone(events.at(-2));
        done.output_index = 1;
        done.item.id = "msg_active";
        events.splice(events.length - 1, 0, done);
      }
    }
    return events;
  }
  // Retain both encodings on the two independent item surfaces. Other cases
  // each exercise a distinct consumer boundary rather than a Cartesian matrix.
  for (const kind of ["done", "added", "seed"]) {
    for (const candidate of reflectedMaterial) {
      await check.events(eventsFor(candidate, kind), true, kind);
    }
  }
  const collapsed = "synthetic-key-<oai-mem-citation>note</oai-mem-citation>initial";
  for (const kind of ["done", "added", "envelope", "deltas", "seed", "active"]) {
    // protect() also asserts zero response messages, including the head.
    await check.events(eventsFor(collapsed, kind), true, kind);
  }
  await check.events(eventsFor(collapsed, "envelope"), true, "JSON envelope", false);
  // An open citation in one message cannot hide visible text in the next.
  // The preceding stream events remain benign, isolating the terminal envelope check.
  for (const streaming of [false, true]) {
    for (const text of [...reflectedMaterial, "ordinary response"]) {
      const events = responseEvents();
      const response = events.at(-1).response;
      response.output = outputWithIndependentCitation(response.output[0], text);
      const rawBody = await check.events(
        events,
        reflectedMaterial.includes(text),
        "citation in an independent message",
        streaming,
      );
      assert.equal(rawBody.includes(text), false, "text should be split by a citation");
    }
  }
  for (const [kind, candidate] of [
    ["done", "Answer.<oai-mem-citation>source</oai-mem-citation>"],
    ["added", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
    ["envelope", "Intro\n<proposed_plan>\n- step\n</proposed_plan>\nDone"],
    ["seed", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
    ["active", "Hello <oai-mem-citation>source</oai-mem-citation> world"],
    ["deltas", "Intro\n\u0085<proposed_plan>\u0085\n- step\n</proposed_plan>\nDone"],
    ["seed", "Intro\n<proposed_plan>\n- step\n</proposed_plan>\nDone"],
    ["done", "ordinary <oai-mem-citation>unclosed"],
    ["done", "ordinary <proposed_plan>inline</proposed_plan>"],
    ["done", "synthetic-key-&lt;oai-mem-citation&gt;note&lt;/oai-mem-citation&gt;initial"],
  ]) {
    await check.events(eventsFor(candidate, kind), false, `benign ${kind}`);
  }
  // Switching consumers must inspect the previous run before discarding it.
  for (const item of [
    { type: "message", role: "assistant", id: "msg_next", content: [] },
    { type: "reasoning", id: "rs_next", summary: [] },
  ]) {
    for (const malicious of [false, true]) {
      const events = eventsFor(
        malicious ? collapsed : "Hello <oai-mem-citation>source</oai-mem-citation> world",
        "seed",
      );
      const delta = events.findIndex((event) => event.type === "response.output_text.delta");
      events.splice(delta + 1, 0, { type: "response.output_item.added", output_index: 1, item });
      events.splice(events.length - 1, 0, {
        type: "response.output_item.done",
        output_index: 1,
        item,
      });
      await check.events(events, malicious, `switch to ${item.type}`);
    }
  }
  const safeEnvelope = eventsFor("Answer.<oai-mem-citation>source</oai-mem-citation>", "envelope");
  await check.events(safeEnvelope, false, "safe JSON envelope", false);
  // Hidden data still receives raw and citation-only protection in either mode.
  for (const candidate of [
    "<oai-mem-citation>synthetic-key-initial</oai-mem-citation>",
    "<proposed_plan>\nsynthetic-key-initial\n</proposed_plan>",
    "<proposed_plan>\n" + collapsed + "\n</proposed_plan>",
  ]) {
    await check.events(eventsFor(candidate, "seed"), true, "hidden data");
  }
  // Assistant projections must not reinterpret local tool data.
  const tool = {
    type: "function_call",
    id: "fc_markup",
    call_id: "call_markup",
    name: "fixture_function_0",
    arguments: JSON.stringify({ text: "<oai-mem-citation>note" }),
  };
  const nonMessage = [
    structuredClone(wire.responseEvents[0]),
    { type: "response.output_item.added", output_index: 0, item: tool },
    { type: "response.output_item.done", output_index: 0, item: tool },
    {
      type: "response.completed",
      response: { ...wire.responseEvents.at(-1).response, output: [tool] },
    },
  ];
  await check.events(nonMessage, false, "local tool markup");
});

test("signed Responses Plan projections protect completed and response-wide streamed text", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const added = (index, text) => ({
    type: "response.output_item.added",
    output_index: index,
    item: {
      type: "message",
      id: `msg_plan_${index}`,
      role: "assistant",
      content: outputTextParts(text),
    },
  });
  const done = (event, text = "READY") => ({
    ...event,
    type: "response.output_item.done",
    item: { ...event.item, content: outputTextParts(text) },
  });
  const response = (...events) => [wire.responseEvents[0], ...events, wire.responseEvents.at(-1)];
  for (const unsafe of [false, true]) {
    const expected = unsafe ? ["synthetic", "key", "initial"].join("-") : "ready to proceed";
    const split = expected.lastIndexOf(unsafe ? "-" : " ") + 1;
    const left = expected.slice(0, split);
    const right = expected.slice(split);
    // Completed Plan extracts the raw block before stripping its citations.
    // Ordinary citation-visible text and the terminal envelope stay harmless.
    const completed = responseEvents();
    const markup = `<oai-mem-citation>outer\n<proposed_plan>\n${left}<oai-mem-citation>note</oai-mem-citation>${right}\n</proposed_plan>\n`;
    completed[6].item.content = outputTextParts(markup);
    assert.ok(!encode(completed).includes(expected));
    await check.events(completed, unsafe, "completed Plan and benign twin");
    // Each completed message owns its Plan; a later safe message must not
    // erase an unsafe earlier message from the response-envelope projection.
    const envelope = responseEvents();
    envelope.at(-1).response.output = [
      { ...completed[6].item, content: outputTextParts(markup) },
      {
        ...completed[6].item,
        id: "msg_later_plan",
        content: outputTextParts("<proposed_plan>\nSafe final message\n</proposed_plan>"),
      },
    ];
    await check.events(envelope, unsafe, "independent completed Plan in envelope");
    // The response has one streamed Plan, even though each seed has its own
    // assistant parser and both completed messages independently say READY.
    const a = added(0, `<proposed_plan>\n${left}`);
    const b = added(1, `<proposed_plan>\n${right}`);
    const streamed = response(a, done(a), b, done(b));
    assert.ok(!encode(streamed).includes(expected));
    await check.events(streamed, unsafe, "cross-message Plan and benign twin");
  }
  assert.equal(wire.responseEvents.length, 8);
  await check.events(wire.responseEvents, false, "captured finite eight-event response");
  const generated =
    "Intro\n<proposed_plan>\n- Inspect <oai-mem-citation>source</oai-mem-citation>code\n</proposed_plan>\nDone";
  for (const split of [false, true]) {
    const events = responseEvents();
    events[4].text = generated;
    events[5].part.text = generated;
    events[6].item.content = outputTextParts(generated);
    events[7].response.output[0].content = outputTextParts(generated);
    events.splice(
      3,
      1,
      ...(split
        ? [
            "Intro\n<pro",
            "posed_plan>\n- Inspect <oai-mem-",
            "citation>source</oai-mem-citation>code\n</proposed_plan>\nDone",
          ]
        : [generated]
      ).map((delta) => ({ ...wire.responseEvents[3], delta })),
    );
    await check.events(events, false, `coherent generated plan, split=${split}`);
  }
  // These opposite verdicts distinguish the actual stream from a last-block,
  // per-message, close-completes, or raw-before-citations approximation.
  const a = added(0, "<proposed_plan>\nsynthetic-key-");
  const b = added(1, "<proposed_plan>\ninitial");
  await check.events(
    response(a, done(a, "<proposed_plan>\nfinished\n</proposed_plan>"), b, done(b)),
    false,
    "completed Plan stops later Plan deltas",
  );
  const spanning = added(0, "<proposed_plan>\nsynthetic-key-");
  const delta = (text) => ({ ...wire.responseEvents[3], item_id: spanning.item.id, delta: text });
  await check.events(
    response(
      spanning,
      delta(
        "<oai-mem-citation>\n</proposed_plan>\nignored\n<proposed_plan>\n</oai-mem-citation>initial",
      ),
      done(spanning),
    ),
    true,
    "stream strips citations before recognizing tags",
  );
  // A partial citation opener stays buffered when another assistant or
  // reasoning item displaces its owner. Flushing early would insert the opener
  // between the credential halves and miss the actual streamed Plan text.
  for (const next of [
    b,
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "reasoning", id: "rs_plan", summary: [] },
    },
  ]) {
    const tail = added(0, "<proposed_plan>\nsynthetic-key-<oai-mem-");
    const suffix = next.item.type === "message" ? [] : [added(2, "<proposed_plan>\ninitial")];
    const endNext =
      next.item.type === "message" ? done(next) : { ...next, type: "response.output_item.done" };
    // done(tail) flushes the currently active, unrelated assistant first.
    await check.events(
      response(tail, next, ...suffix, done(tail), endNext, ...suffix.map((event) => done(event))),
      true,
      `deferred citation tail after ${next.item.type}`,
    );
  }
  const tail = added(0, "<proposed_plan>\nsynthetic-key-<oai-mem-");
  await check.events(
    response(tail, done(tail), b, done(b)),
    false,
    "done before displacement really flushes the partial opener",
  );
  const blocks = added(0, "<proposed_plan>\n</proposed_plan>\n<proposed_plan>\nsynthetic-key-");
  await check.events(
    response(blocks, done(blocks), b, done(b)),
    true,
    "closing a block does not complete the streamed Plan",
  );
  // Completed Plan selects the last raw block, not every prior block. Ordinary
  // citation-visible text stays harmless while the earlier Plan would be unsafe.
  const last = responseEvents();
  last[6].item.content = outputTextParts(
    "<oai-mem-citation>outer\n<proposed_plan>\nsynthetic-key-<oai-mem-citation>note</oai-mem-citation>initial\n</proposed_plan>\n<proposed_plan>\nfinal safe plan\n</proposed_plan>",
  );
  await check.events(last, false, "completed Plan selects only the last block");
});

test("Responses incremental text snapshots cannot reveal selected material", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const events = (candidate, kind) => {
    const [created, item, part, delta, ...rest] = responseEvents();
    const [prefix, suffix] = splitText(candidate);
    if (kind === "item") {
      item.item.content = [{ ...part.part, text: prefix }];
      return [created, item, { ...delta, delta: suffix }, ...rest];
    }
    if (kind === "parts") {
      return [
        created,
        item,
        part,
        { ...delta, delta: prefix },
        { ...part, content_index: 1 },
        { ...delta, content_index: 1, delta: "distraction" },
        { ...delta, delta: suffix },
        ...rest,
      ];
    }
    if (kind === "duplicate") {
      part.part.text = prefix;
      return [
        created,
        item,
        part,
        { ...part, part: { ...part.part, text: "distraction" } },
        { ...delta, delta: suffix },
        ...rest,
      ];
    }
    if (kind === "initial") {
      created.response.output = [{ ...item.item, content: [{ ...part.part, text: prefix }] }];
      return [created, item, part, { ...delta, delta: suffix }, ...rest];
    }
    part.part.text = prefix;
    return [created, item, part, { ...delta, delta: suffix }, ...rest];
  };
  // A harmless terminal response cannot erase a credential exposed in an earlier
  // SDK snapshot assembled from an added part and later indexed deltas.
  for (const kind of ["part", "item", "parts", "duplicate", "initial"]) {
    for (const candidate of reflectedMaterial) {
      await check.events(events(candidate, kind), true, `${kind} snapshot must be withheld`);
    }
  }
  for (const kind of ["part", "item", "parts"]) {
    await check.events(events("ordinary response", kind), false, `benign ${kind}`);
  }
  const laterProgress = events("ordinary response", "part");
  const progress = structuredClone(laterProgress[0]);
  progress.type = "response.in_progress";
  progress.response.output = [structuredClone(laterProgress.at(-2).item)];
  laterProgress.splice(2, 0, progress);
  await check.events(laterProgress, false, "later in_progress snapshot");
});

test("selected Codex Responses wire admits local tools and finite SSE while rejecting remote tools and unprotected events", async (t) => {
  const f = await staticEgressFixture(t);
  // Sanitized packaged 0.163.0-alpha.2 request and synthetic response consumed by that
  // binary. This exercises OCE's real transport, not a model provider or installed Harness.
  const check = responseChecks(f);
  const body = encode(wire.responseEvents);
  await check.wireBody(body);
  assert.deepEqual(f.providerRequests[0].body, wire.request);
  await check.wireBody(body.replaceAll("\n", "\r\n"), { label: "CRLF" });
  const beforeReads = f.secretReads;
  for (const body of [
    { ...wire.request, tools: [...wire.request.tools, ...wire.refusedTools] },
    { ...wire.request, tools: [{ type: "mcp", server_url: "https://remote.example.test" }] },
    { ...wire.request, tools: [{ type: "namespace", name: "remote", tools: wire.refusedTools }] },
    { ...wire.request, previous_response_id: "unadmitted-state" },
    {
      ...wire.request,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://remote.example.test/image" }],
        },
      ],
    },
    { ...wire.request, client_metadata: { namespace_id: f.namespace.id } },
  ]) {
    assert.ok((await f.resolve(f.capture(body))).refused);
  }
  assert.equal(
    f.secretReads,
    beforeReads,
    "unsupported provider operations cannot read credentials",
  );

  const split = responseEvents();
  const deltaIndex = split.findIndex((event) => event.type === "response.output_text.delta");
  const delta = split[deltaIndex];
  split.splice(
    deltaIndex,
    1,
    { ...delta, delta: "synthetic-key-" },
    { ...delta, delta: "initial" },
  );
  const switched = responseEvents();
  const firstMessage = switched
    .slice(1, -1)
    .map((event) => JSON.parse(JSON.stringify(event).replaceAll("READY", "synthetic-key-")));
  const secondMessage = switched.slice(1, -1).map((event) => ({
    ...JSON.parse(
      JSON.stringify(event)
        .replaceAll("READY", "initial")
        .replaceAll("msg_runtime_probe", "msg_second"),
    ),
    output_index: 1,
  }));
  switched.splice(1, switched.length - 2, ...firstMessage, ...secondMessage);
  // Keep the terminal snapshot harmless so only cross-item deltas trigger refusal.
  await check.events(
    switched,
    true,
    "OutputTextDelta drops item IDs, so the consumer-observable concatenation must be scanned",
  );
  // Function arguments have a protocol-defined JSON layer, including when
  // unicode escapes straddle deltas. A harmless terminal snapshot cannot erase
  // arguments that a local tool consumer already accumulated.
  const functionEvents = (argumentsText) => {
    const item = {
      type: "function_call",
      id: "fc_local",
      call_id: "call_local",
      name: "fixture_function_0",
      arguments: argumentsText,
      status: "completed",
    };
    const end = structuredClone(wire.responseEvents.at(-1));
    end.response.output = [item];
    return [
      structuredClone(wire.responseEvents[0]),
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      ...splitText(argumentsText).map((delta) => ({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: item.id,
        delta,
      })),
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: item.id,
        arguments: argumentsText,
      },
      { type: "response.output_item.done", output_index: 0, item },
      end,
    ];
  };
  const safeFunction = functionEvents('{"cmd":"printf READY"}');
  await check.events(safeFunction, false, "ordinary Harness-local function tools remain supported");
  // Providers can omit argument deltas. The two completion events must still agree
  // on which arguments the Harness would execute.
  const withoutDeltas = structuredClone(safeFunction);
  withoutDeltas.splice(2, 2);
  await check.events(withoutDeltas, false, "function call without argument deltas");
  withoutDeltas[2].arguments = '{"cmd":"different arguments"}';
  await check.events(
    withoutDeltas,
    true,
    "function_call_arguments.done and output_item.done cannot disagree about the arguments",
  );
  const escapedCredential = unicodeEscapes("synthetic-key-initial");
  const escapedFunction = functionEvents('{"cmd":"' + escapedCredential + '"}');
  const disguisedFunction = structuredClone(escapedFunction);
  disguisedFunction.splice(4, 1);
  disguisedFunction.at(-2).item.arguments = '{"cmd":"printf READY"}';
  disguisedFunction.at(-1).response.output = [];
  const wrongAssociation = structuredClone(safeFunction);
  wrongAssociation[3].item_id = "fc_unassociated";
  const afterDone = structuredClone(safeFunction);
  afterDone.splice(-1, 0, safeFunction[2]);
  for (const events of [
    escapedFunction,
    disguisedFunction,
    wrongAssociation,
    afterDone,
    functionEvents('{"cmd":"unterminated'),
    functionEvents('{"cmd":"ok","cmd":"other"}'),
  ]) {
    await check.events(
      events,
      true,
      "argument decoding, item association and completion all precede release",
    );
  }
  const remote = responseEvents();
  remote[1].item = { type: "web_search_call", id: "remote-effect", status: "completed" };
  const wrongModel = responseEvents();
  wrongModel.at(-1).response.model = "unadmitted-model";
  for (const unsafe of [
    encode(wire.responseEvents.slice(0, -1)),
    encode(split),
    encode(remote),
    encode(wrongModel),
    body + 'event: response.future_event\ndata: {"type":"response.future_event"}\n\n',
    body.replace('"delta":"READY"', '"delta":"synthetic-key-initial","delta":"READY"'),
    body.replace("event: response.created", "event: response.completed"),
    ":ignored\rcomment\n" + body,
    body.replace("\n\n", "\n\n\n"),
    body.replace(/\n\n$/, "\n"),
  ]) {
    await check.wireBody(unsafe, { blocked: true });
  }
});

// A streamed response from the provider carries its full documented envelope on
// response.created, response.in_progress and response.completed. The shape follows
// openai-python src/openai/types/responses/response.py at
// 0f73f1d519f8719b226e9084d78c8bdb4a60e48f (2026-10-12) for the request fields the
// bounded inference policy admits; the fixture envelope only ever carried the minimum.
function liveResponsesEnvelope(status) {
  return {
    id: "resp_live_shaped",
    object: "response",
    created_at: 1791985502.0,
    status,
    background: false,
    billing: { payer: "developer" },
    completed_at: status === "completed" ? 1791985503.0 : null,
    conversation: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: wire.request.model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: wire.request.prompt_cache_key,
    prompt_cache_retention: null,
    reasoning: { effort: "medium", summary: "auto" },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: 1.0,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: wire.request.tools,
    top_logprobs: 0,
    top_p: 1.0,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

test("live-shaped Responses envelopes pass while undeclared or credential-bearing envelope fields refuse", async (t) => {
  const f = await staticEgressFixture(t);
  const check = responseChecks(f);
  const base = responseEvents();
  const completed = structuredClone(base.at(-1));
  completed.response = {
    ...liveResponsesEnvelope("completed"),
    output: completed.response.output,
    usage: {
      ...completed.response.usage,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
  const live = [
    {
      type: "response.created",
      sequence_number: 0,
      response: liveResponsesEnvelope("in_progress"),
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: liveResponsesEnvelope("in_progress"),
    },
    ...base.slice(1, -1).map((event, index) => ({ ...event, sequence_number: index + 2 })),
    { ...completed, sequence_number: base.length + 1 },
  ];
  await check.events(live, false, "documented envelope fields on every envelope event");
  // Documented fields that the admitted request cannot ask for still have to be absent,
  // and documented optional structures are typed, not free-form.
  const nullableStructures = structuredClone(live);
  Object.assign(nullableStructures.at(-1).response, {
    access_programs: { cyber: "standard" },
    prompt_cache_diagnostics: { type: "cache_hit" },
    prompt_cache_options: { mode: "implicit", ttl: "30m", comparison_response_id: null },
    reasoning: null,
    incomplete_details: { reason: null },
    error: null,
    text: null,
    moderation: null,
    prompt: null,
  });
  await check.events(nullableStructures, false, "typed optional envelope structures");
  const withEnvelope = (fields) => {
    const events = structuredClone(live);
    Object.assign(events[0].response, fields);
    return events;
  };
  for (const [label, fields] of [
    ["undeclared envelope field", { x_future_field: 0 }],
    ["undeclared field carrying the selected material", { debug: selectedMaterial }],
    [
      "declared text field reflecting the selected material",
      { safety_identifier: selectedMaterial },
    ],
    ["declared text field reflecting encoded material", { user: reflectedMaterial[1] }],
    ["undeclared structure member", { billing: { payer: "developer", token: "x" } }],
    ["undeclared conversation state", { conversation: { id: "conv_unadmitted" } }],
    ["undeclared prior response state", { previous_response_id: "resp_unadmitted" }],
    ["prompt template reference", { prompt: { id: "pmpt_unadmitted" } }],
    ["moderation result", { moderation: { input: { type: "error", code: "x", message: "y" } } }],
    ["wrong top_logprobs type", { top_logprobs: "0" }],
    ["unknown access program", { access_programs: { cyber: "unknown" } }],
    ["unknown cache diagnostic", { prompt_cache_diagnostics: { type: "future" } }],
    ["background execution", { background: true }],
  ]) {
    await check.events(withEnvelope(fields), true, label);
  }
});

test("signed supervisor instance and UUIDv7 creation horizon refuse old callers and deadline-extension replay", async (t) => {
  let elapsed = 0;
  const now = () => new Date(Date.now() + elapsed);
  const f = await staticEgressFixture(t, { now });
  const reads = f.secretReads;
  const operation = JSON.parse(
    readFileSync(new URL("../fixtures/static-egress/openshell-operation.json", import.meta.url)),
  );
  const serializedCreation = Number.parseInt(
    operation.request_context.request_id.replaceAll("-", "").slice(0, 12),
    16,
  );
  const serializedDeadline =
    Number(operation.deadline.seconds) * 1000 + operation.deadline.nanos / 1e6;
  assert.equal(serializedCreation, operation.creation_ms);
  assert.equal(serializedDeadline, serializedCreation + 30_000);
  assert.equal(operation.capture_delay_ms, 100);
  // The independently captured delayed sender wire is historical, never a reusable
  // authorization. Rebind only the fixture Sandbox to reach the real horizon check.
  const historical = f.capture();
  historical.request.context.request_id = operation.request_context.request_id;
  historical.deadline = operation.deadline;
  assert.ok((await f.resolve(historical)).refused);
  assert.equal(f.secretReads, reads);
  for (const claims of [
    { instance_id: undefined },
    { instance_id: "10000000-0000-4000-8000-000000000001" },
    { instance_id: f.namespace.id },
  ]) {
    if (claims.instance_id?.startsWith("10000000-")) {
      assert.ok((await f.resolve(f.capture(), f.metadata(claims))).refused);
    } else {
      await assert.rejects(f.resolve(f.capture(), f.metadata(claims)), { code: 7 });
    }
  }
  assert.equal(f.secretReads, reads);
  const captured = f.capture();
  captured.deadline = wireTime(now().getTime() + 1000);
  const ready = (await f.resolve(captured)).ready;
  assert.ok(ready);
  // A short submitted deadline does not shorten replay retention for this immutable operation ID.
  elapsed = 2000;
  captured.deadline = wireTime(now().getTime() + 20_000);
  assert.ok((await f.resolve({ ...captured, response_custody: randomBytes(32) })).refused);
  elapsed = 31_000;
  captured.deadline = wireTime(now().getTime() + 1000);
  assert.ok((await f.resolve({ ...captured, response_custody: randomBytes(32) })).refused);
  assert.equal(
    f.secretReads,
    reads + 1,
    "eviction cannot make an expired UUID into a new operation",
  );
  assert.ok((await f.resolve(f.capture())).ready);
});

test(
  "sustained sequential operations outlive replay capacity without waiting for JWT expiry",
  { timeout: 180_000 },
  async (t) => {
    let elapsed = 0;
    const f = await staticEgressFixture(t, { now: () => new Date(Date.now() + elapsed) });
    const peer = f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 });
    // Advance the controller's supported clock while keeping genuine signed identity, IAM,
    // Secret SDK, authority transport and HTTPS provider. Completion must release active capacity;
    // fixed operation horizons must release replay capacity during the same long-lived JWT.
    // One Sandbox at 40 requests/s holds about 1200 replay entries per 30 s horizon, under its
    // share. Its share is the first replay bound it meets, so each operation past the share
    // needs an expired entry released. Operation slots must also return on completion, or the
    // loop stops at the operation share or capacity. "one Sandbox's replay share bounds it
    // without refusing other Sandboxes" covers the installation-wide table's expiry.
    const step = 25;
    const operations = REPLAY_SANDBOX_SHARE + 64;
    assert.ok(30_000 / step < REPLAY_SANDBOX_SHARE);
    assert.ok(REPLAY_SANDBOX_SHARE < REPLAY_TABLE_CAPACITY);
    assert.ok(OPERATION_CAPACITY < operations);
    for (let i = 0; i < operations; i += 1) {
      elapsed += step;
      const captured = f.capture();
      const ready = (await f.resolve(captured, peer)).ready;
      assert.ok(ready, `sequential operation ${i} should resolve`);
      assert.ok((await f.authorize(f.permitRequest(captured, ready))).allowed);
      assert.ok((await f.protect(captured, await f.send(captured, ready))).body);
    }
    assert.equal(f.providerRequests.length, operations);
    assert.ok(
      f.providerRequests.every(
        (request) => request.authorization === "Bearer synthetic-key-initial",
      ),
    );
  },
);

test("send receipt records the digest of the accepted request", async (t) => {
  const receipts = new EgressSendReceipts(new InMemoryPlatformState());
  const f = await syntheticDispatchFixture(t, receipts);
  // In this request, body precedes deadlineAt. Moving it to the end while copying the
  // request must not silently change the digest we commit to the authorization receipt.
  const accepted = { ...f.request, body: f.request.body.toString("base64") };
  const expectedDigest = createHash("sha256").update(JSON.stringify(accepted)).digest("hex");

  assert.equal((await f.resolve()).kind, "ready");
  assert.equal((await f.authorizeSend()).kind, "allow");
  const stored = await receipts.recover(f.sender, f.attempt());
  assert.equal(stored.authorization.requestDigest, expectedDigest);
  assert.equal(f.arrivals, 0, "committing the authorization is not evidence of a send");
});

for (const bodyType of ["Uint8Array", "Buffer"]) {
  test(`credential proxy detaches ${bodyType} and request fields before identity verification`, async (t) => {
    const f = await syntheticDispatchFixture(t);
    const verification = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const callerRequest = {
      ...f.request,
      headers: f.request.headers.map((pair) => [...pair]),
      body: bodyType === "Buffer" ? Buffer.from(f.request.body) : new Uint8Array(f.request.body),
    };
    const proxy = new CredentialProxy({
      ...f.ports,
      exchangeOwner: {
        ...f.ports.exchangeOwner,
        async verify(authorization) {
          entered.resolve();
          await verification.promise;
          return f.ports.exchangeOwner.verify(authorization);
        },
      },
    });
    const cancellation = new AbortController();
    t.after(() => cancellation.abort());
    const resolving = proxy.resolve(
      "synthetic-peer",
      f.association.installation.sandboxId,
      callerRequest,
      cancellation.signal,
    );
    await entered.promise;
    // The caller reuses its buffers while authentication is pending. Classification and
    // custody must still use the originally accepted request, including Buffer bytes.
    callerRequest.body.fill(0);
    callerRequest.headers[0][1] = "application/octet-stream";
    callerRequest.headers.push(["authorization", "caller-controlled"]);
    callerRequest.url = "https://changed.example.test/";
    callerRequest.deadlineAt = "invalid";
    verification.resolve();
    assert.equal((await resolving).kind, "ready");
    assert.equal(f.reads, 1);
  });
}

test("credential proxy rejects an oversized body before copying request fields", async (t) => {
  const f = await syntheticDispatchFixture(t);
  const proxy = new CredentialProxy(f.ports);
  const request = {
    ...f.request,
    body: new Uint8Array(1024 * 1024 + 1),
    get headers() {
      throw new Error("an oversized request must not be copied");
    },
  };
  assert.deepEqual(
    await proxy.resolve(
      "synthetic-peer",
      f.association.installation.sandboxId,
      request,
      new AbortController().signal,
    ),
    { kind: "refused", error: { kind: "denied", code: "unsupported_operation" } },
  );
  assert.equal(f.reads, 0);
});

const saturated = { kind: "refused", error: { kind: "unavailable", code: "resolver" } };

test("in-flight Secret selection and outstanding handles consume the same bounded capacity", async (t) => {
  // Exercise the actual 1024-slot registry, not a race to finish 1024 TLS handshakes,
  // native IAM checks and Kubernetes reads inside their intentionally short deadlines.
  const f = await syntheticDispatchFixture(t);
  let reads = 0;
  let target = 0;
  let filled;
  const gate = Promise.withResolvers();
  const s = f.sandboxes((ports) => ({
    ...ports,
    async read(...args) {
      if (++reads === target) {
        filled.resolve();
      }
      await gate.promise;
      return ports.read(...args);
    },
  }));
  const first = new AbortController();
  const other = new AbortController().signal;
  // Four Sandboxes fill their shares; each burst exactly fits the authentication budget.
  assert.equal(OPERATION_SANDBOX_SHARE * 4, OPERATION_CAPACITY);
  assert.equal(OPERATION_AUTHENTICATION_BUDGET, OPERATION_SANDBOX_SHARE);
  const pending = [];
  for (const name of ["a", "b", "c", "d"]) {
    filled = Promise.withResolvers();
    target += OPERATION_SANDBOX_SHARE;
    for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
      pending.push(s.resolve(name, undefined, pending.length === 0 ? first.signal : other));
    }
    await filled.promise;
  }
  assert.deepEqual(
    await s.resolve("e", undefined, other),
    saturated,
    "pending selection is charged before material returns",
  );
  assert.deepEqual(
    await s.proxy.resolve(
      "e",
      "unauthenticated-sandbox",
      {
        ...f.request,
        get headers() {
          throw new Error("an exhausted registry must reject before copying request fields");
        },
      },
      other,
    ),
    saturated,
  );
  assert.equal(reads, OPERATION_CAPACITY, "the excess resolution never starts selection");
  gate.resolve();
  assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
  assert.deepEqual(
    await s.resolve("e", undefined, other),
    saturated,
    "ready handles remain charged",
  );
  first.abort();
  assert.equal(
    (await s.resolve("e", undefined, other)).kind,
    "ready",
    "closing the owning sender frees exactly its slot",
  );
  assert.deepEqual(await s.resolve("e", undefined, other), saturated);
});

test("one Sandbox's open handles leave operation capacity to other Sandboxes", async (t) => {
  const f = await syntheticDispatchFixture(t);
  const s = f.sandboxes();
  const held = new AbortController();
  // As many requests as the installation-wide cap, each holding its handle open.
  const decisions = [];
  for (let i = 0; i < OPERATION_CAPACITY; i += 1) {
    decisions.push(await s.resolve("a", undefined, held.signal));
  }
  assert.equal((await s.resolve("b")).kind, "ready", "another Sandbox's first request");
  assert.ok(decisions.slice(0, OPERATION_SANDBOX_SHARE).every((d) => d.kind === "ready"));
  for (const decision of decisions.slice(OPERATION_SANDBOX_SHARE)) {
    assert.deepEqual(decision, saturated, "a Sandbox holds at most its share");
  }
  assert.equal(f.reads, OPERATION_SANDBOX_SHARE + 1, "a refused request starts no selection");
  // Closing the handles returns the share, and so does their deadline.
  held.abort();
  const again = new AbortController();
  for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
    assert.equal((await s.resolve("a", undefined, again.signal)).kind, "ready");
  }
  assert.deepEqual(await s.resolve("a"), saturated);
  f.advance(20_000);
  assert.equal((await s.resolve("a")).kind, "ready", "expired handles were discarded");
});

test("requests still authenticating share a small budget charged before verification", async (t) => {
  const f = await syntheticDispatchFixture(t);
  let gate;
  let verified = 0;
  let filled;
  const s = f.sandboxes((ports) => ({
    ...ports,
    exchangeOwner: {
      ...ports.exchangeOwner,
      async verify(name) {
        verified += 1;
        if (gate && name === "a") {
          if (verified === OPERATION_AUTHENTICATION_BUDGET) {
            filled.resolve();
          }
          await gate.promise;
        }
        return ports.exchangeOwner.verify(name);
      },
    },
  }));
  gate = Promise.withResolvers();
  filled = Promise.withResolvers();
  const pending = Array.from({ length: OPERATION_AUTHENTICATION_BUDGET }, () => s.resolve("a"));
  await filled.promise;
  assert.deepEqual(await s.resolve("b"), saturated, "the budget is global before verification");
  assert.equal(verified, OPERATION_AUTHENTICATION_BUDGET, "the excess request is never verified");
  gate.resolve();
  assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
  gate = undefined;
  // Verified requests moved to their Sandbox's share and left the budget.
  assert.equal((await s.resolve("b")).kind, "ready");
});

test("every refusal returns its operation slot", async (t) => {
  const f = await syntheticDispatchFixture(t);
  let mode;
  let gate;
  let gated = 0;
  let filled;
  const s = f.sandboxes((ports) => ({
    ...ports,
    exchangeOwner: {
      ...ports.exchangeOwner,
      async verify(name) {
        if (mode === "gated" && name === "a") {
          if (++gated === OPERATION_AUTHENTICATION_BUDGET) {
            filled.resolve();
          }
          await gate.promise;
        }
        if (mode === "verification throws") {
          throw new Error("synthetic verification failure");
        }
        return mode === "unknown peer" ? undefined : ports.exchangeOwner.verify(name);
      },
    },
    installation: async (peer) =>
      mode === "installation missing" ? undefined : ports.installation(peer),
    async check(use) {
      if (mode === "policy throws") {
        throw new Error("synthetic policy failure");
      }
      return mode === "policy denies" ? { kind: "denied", code: "withdrawn" } : ports.check(use);
    },
    async read(...args) {
      if (mode === "Secret read throws") {
        throw new Error("synthetic Secret failure");
      }
      return ports.read(...args);
    },
  }));
  const denied = (code) => ({ kind: "refused", error: { kind: "denied", code } });
  const unavailable = (code) => ({ kind: "refused", error: { kind: "unavailable", code } });
  const unsupported = {
    body: Buffer.from(JSON.stringify({ model: "other-model", input: "hello", store: false })),
  };
  const paths = [
    // Before verification settles: the authentication budget.
    [
      "cancelled before verification",
      () => s.resolve("a", undefined, AbortSignal.abort()),
      { kind: "refused", error: { kind: "cancelled" } },
    ],
    ["unknown peer", () => s.resolve("a"), denied("identity")],
    [
      "verification throws",
      () => s.resolve("a").catch((error) => error.message),
      "synthetic verification failure",
    ],
    [
      "another Sandbox's ID",
      () => s.proxy.resolve("a", "other-sandbox", s.request(), new AbortController().signal),
      denied("identity"),
    ],
    // After verification: the Sandbox's share.
    [
      "deadline already passed",
      () => s.resolve("a", { deadlineAt: new Date(f.ports.now()).toISOString() }),
      { kind: "refused", error: { kind: "deadline_exceeded" } },
    ],
    [
      "installation missing",
      () => s.resolve("a"),
      { kind: "refused", error: { kind: "not_ready", code: "attachment_pending" } },
    ],
    ["unsupported route", () => s.resolve("a", unsupported), denied("unsupported_operation")],
    ["policy denies", () => s.resolve("a"), denied("withdrawn")],
    ["policy throws", () => s.resolve("a"), unavailable("authority")],
    ["Secret read throws", () => s.resolve("a"), unavailable("secret_store")],
  ];
  // Each path refuses more requests than the budget or a share holds, and all of them
  // together more than the installation-wide cap.
  for (const [name, attempt, refused] of paths) {
    mode = name;
    for (let i = 0; i <= OPERATION_SANDBOX_SHARE; i += 1) {
      assert.deepEqual(await attempt(), refused, name);
    }
    mode = undefined;
    const closed = new AbortController();
    assert.equal((await s.resolve("a", undefined, closed.signal)).kind, "ready", name);
    closed.abort();
  }
  // No slot was returned twice either: the share and the budget still hold exactly.
  const held = new AbortController();
  for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
    assert.equal((await s.resolve("a", undefined, held.signal)).kind, "ready");
  }
  assert.deepEqual(await s.resolve("a"), saturated, "the share still holds");
  held.abort();
  mode = "gated";
  gate = Promise.withResolvers();
  filled = Promise.withResolvers();
  const pending = Array.from({ length: OPERATION_AUTHENTICATION_BUDGET }, () => s.resolve("a"));
  await filled.promise;
  assert.deepEqual(await s.resolve("b"), saturated, "the budget still holds");
  mode = undefined;
  gate.resolve();
  assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
});

test("requests refused before capture leave the replay table to every Sandbox", async (t) => {
  const f = await syntheticDispatchFixture(t);
  const s = f.sandboxes();
  const unsupported = {
    body: Buffer.from(JSON.stringify({ model: "other-model", input: "hello", store: false })),
  };
  const refused = { kind: "refused", error: { kind: "denied", code: "unsupported_operation" } };
  for (let i = 0; i < REPLAY_TABLE_CAPACITY; i += 1) {
    assert.deepEqual(await s.resolve("a", unsupported), refused);
  }
  assert.equal((await s.resolve("b")).kind, "ready", "another Sandbox's first request");
  assert.equal((await s.resolve("a")).kind, "ready", "the refused Sandbox's next request");
  // Nothing used an ID refused before capture, so it remains the sender's to use.
  const id = requestId(f.ports.now());
  assert.deepEqual(await s.resolve("a", { ...unsupported, id }), refused);
  assert.equal((await s.resolve("a", { id })).kind, "ready");
  assert.equal(f.reads, 3);
});

test("one Sandbox's replay share bounds it without refusing other Sandboxes", async (t) => {
  const f = await syntheticDispatchFixture(t);
  let gate;
  let entered;
  const s = f.sandboxes((ports) => ({
    ...ports,
    async installation(peer) {
      entered?.resolve();
      await gate?.promise;
      return ports.installation(peer);
    },
  }));
  // Material was selected, so each ID stays reserved after its handle closes.
  const use = async (name) => {
    const closed = new AbortController();
    const decision = await s.resolve(name, undefined, closed.signal);
    closed.abort();
    return decision.kind === "ready" ? "ready" : decision;
  };
  for (let i = 0; i < REPLAY_SANDBOX_SHARE; i += 1) {
    assert.equal(await use("a"), "ready");
  }
  assert.deepEqual(await use("a"), saturated, "a Sandbox past its share is refused");
  assert.equal(await use("b"), "ready", "another Sandbox keeps its share");
  for (const name of ["b", "c", "d"]) {
    for (let i = name === "b" ? 1 : 0; i < REPLAY_SANDBOX_SHARE; i += 1) {
      assert.equal(await use(name), "ready");
    }
  }
  assert.equal(REPLAY_SANDBOX_SHARE * 4, REPLAY_TABLE_CAPACITY);
  assert.deepEqual(await use("e"), saturated, "the installation-wide bound still holds");
  // Fixed 30-second horizons return both the shares and the table, including
  // horizons that pass while a request's installation lookup is pending.
  f.advance(29_000);
  gate = Promise.withResolvers();
  entered = Promise.withResolvers();
  const crossing = use("a");
  await Promise.race([entered.promise, crossing]);
  f.advance(1_000);
  gate.resolve();
  assert.equal(await crossing, "ready");
  gate = undefined;
  entered = undefined;
  assert.equal(await use("e"), "ready");
});

test("a request ID stays reserved once policy or Secret work can start", async (t) => {
  const f = await syntheticDispatchFixture(t);
  let checks = 0;
  let lookups = 0;
  let gate;
  let entered;
  const s = f.sandboxes((ports) => ({
    ...ports,
    async installation(peer) {
      lookups += 1;
      entered?.resolve();
      await gate?.promise;
      return ports.installation(peer);
    },
    async check(use) {
      checks += 1;
      return checks === 1 ? { kind: "denied", code: "withdrawn" } : ports.check(use);
    },
  }));
  const replay = { kind: "refused", error: { kind: "denied", code: "invalid_handle" } };
  // A policy refusal is effectful: the ID cannot be used again in its window.
  const denied = s.request();
  assert.deepEqual(await s.resolve("a", denied), {
    kind: "refused",
    error: { kind: "denied", code: "withdrawn" },
  });
  assert.deepEqual(await s.resolve("a", denied), replay);
  assert.deepEqual([checks, lookups], [1, 1], "a known replay is refused before any lookup");
  const ready = s.request();
  assert.equal((await s.resolve("a", ready)).kind, "ready");
  assert.deepEqual(await s.resolve("a", ready), replay);
  // Concurrent duplicates both pass the early check; only one may reserve after the lookup.
  gate = Promise.withResolvers();
  const duplicate = s.request();
  const both = Promise.all([s.resolve("a", duplicate), s.resolve("a", duplicate)]);
  gate.resolve();
  const decisions = (await both).map((decision) => decision.kind);
  assert.deepEqual(decisions.toSorted(), ["ready", "refused"]);
  assert.equal(lookups, 4, "both duplicates passed the early check");
  assert.equal(f.reads, 2);
  // A lookup that outlasts the deadline reserves nothing and starts no policy work.
  gate = Promise.withResolvers();
  entered = Promise.withResolvers();
  const late = s.resolve("a");
  await Promise.race([entered.promise, late]);
  f.advance(30_000);
  gate.resolve();
  assert.deepEqual(await late, { kind: "refused", error: { kind: "deadline_exceeded" } });
  assert.equal(checks, 3);
});

test("cancelled and denied exchanges retain capacity until receipt work settles", async (t) => {
  for (const phase of ["begin", "authorize", "deny", "observe", "expiry"]) {
    await t.test(phase, async (t) => {
      const f = await syntheticDispatchFixture(t);
      const waiting = Promise.withResolvers();
      const entered = Promise.withResolvers();
      const fillerGate = Promise.withResolvers();
      const cancellation = new AbortController();
      const fillerCancellation = new AbortController();
      let now = f.ports.now();
      let filling = 0;
      const filled = Promise.withResolvers();
      const pause = async (name) => {
        if (phase === name || (phase === "expiry" && name === "authorize")) {
          entered.resolve();
          await waiting.promise;
        }
      };
      const proxy = new CredentialProxy({
        ...f.ports,
        now: () => now,
        exchangeOwner: {
          ...f.ports.exchangeOwner,
          // Fillers and the probe authenticate as the target's Sandbox, so they share its
          // slots, with a peer that outlives the target's deadline.
          async verify(authorization) {
            const peer = await f.ports.exchangeOwner.verify(authorization);
            return ["filler", "probe"].includes(authorization)
              ? { ...peer, expiresAt: new Date(now + 3_600_000).toISOString() }
              : peer;
          },
        },
        // The first requests hold the share's slots in their installation lookup.
        async installation(peer) {
          if (filling < OPERATION_SANDBOX_SHARE - 1) {
            if (++filling === OPERATION_SANDBOX_SHARE - 1) {
              filled.resolve();
            }
            await fillerGate.promise;
            return undefined;
          }
          return f.ports.installation(peer);
        },
        check: async (use, evidence) =>
          phase === "deny" && evidence
            ? { kind: "denied", code: "withdrawn" }
            : f.ports.check(use, evidence),
        receipts: {
          async begin() {
            await pause("begin");
            return { created: true };
          },
          async authorize(_sender, _attempt, authorization) {
            await pause("authorize");
            return { authorization };
          },
          async record() {
            await pause("deny");
          },
          async observe() {
            await pause("observe");
          },
        },
      });
      const sandboxId = f.association.installation.sandboxId;
      const resolve = (authorization, signal, request = f.request) =>
        proxy.resolve(authorization, sandboxId, request, signal);
      // The probe is refused at its deadline once it gets a slot.
      const probe = () =>
        resolve("probe", fillerCancellation.signal, {
          ...f.request,
          deadlineAt: new Date(0).toISOString(),
        });
      // Leave the Sandbox's share one slot.
      const fillers = Array.from({ length: OPERATION_SANDBOX_SHARE - 1 }, () =>
        resolve("filler", fillerCancellation.signal),
      );
      await filled.promise;
      const target = (async () => {
        const ready = await resolve("synthetic-peer", cancellation.signal);
        assert.equal(ready.kind, "ready");
        assert.deepEqual(await probe(), saturated);
        const decision = await proxy.authorizeSend(
          "synthetic-peer",
          sandboxId,
          f.request.id,
          ready.handle,
          ready.evidence,
          ready.injectionDigest,
          f.request.deadlineAt,
          cancellation.signal,
        );
        if (phase !== "observe") {
          assert.equal(decision.kind, "refused");
          return;
        }
        assert.equal(decision.kind, "allow");
        const handle = await proxy.beginResponse("synthetic-peer", sandboxId, f.request.id);
        assert.ok(handle);
        assert.equal(
          await proxy.protectResponse(
            handle,
            { status: 200, headers: [], body: new Uint8Array(), trailers: [] },
            cancellation.signal,
            false,
          ),
          undefined,
        );
      })();
      try {
        await Promise.race([
          entered.promise,
          target.then(() => {
            throw new Error("receipt work did not reach the expected phase");
          }),
        ]);
        if (phase === "expiry") {
          now = Date.parse(f.request.deadlineAt);
        } else if (phase !== "deny") {
          cancellation.abort();
        }
        assert.deepEqual(
          await probe(),
          saturated,
          "revoking the handle must not release pending receipt work",
        );
        waiting.resolve();
        await target;
        assert.deepEqual(
          await probe(),
          { kind: "refused", error: { kind: "deadline_exceeded" } },
          "capacity returns when the final outstanding work settles",
        );
        assert.equal(f.arrivals, 0);
      } finally {
        cancellation.abort();
        fillerCancellation.abort();
        waiting.resolve();
        fillerGate.resolve();
        await Promise.allSettled([target, ...fillers]);
      }
    });
  }
});

async function stageReceiptExchange(f) {
  const captured = f.capture();
  const { ready } = await f.resolve(captured);
  assert.ok(ready, "authority resolved the staged operation");
  const useId = captured.request.context.request_id;
  return {
    captured,
    ready,
    permit: f.permitRequest(captured, ready),
    input: {
      sender: f.egress.sourceControl.sender,
      instanceId: f.installation.enforcement.instanceId,
      useId,
      attemptId: useId,
      material: JSON.parse(ready.evidence.authority_evidence.toString()),
      deadlineAt: new Date(
        Number(captured.deadline.seconds) * 1000 + captured.deadline.nanos / 1e6,
      ).toISOString(),
    },
  };
}

const readReceipt = (f, input) =>
  f.controller.transact((unit) => unit.egressSendReceipts.find(input));

// Faults wrap the real state transaction owner: operations and rollback still run in the
// actual memory adapter. Lost acknowledgments here are scheduling proof, not real PG proof.
function receiptPersistenceFaults() {
  let armed;
  return {
    arm(method, kind = "pause") {
      const reached = Promise.withResolvers();
      const release = Promise.withResolvers();
      armed = { method, kind, reached, release };
      return { reached: reached.promise, release: () => release.resolve() };
    },
    appFactory: (t, options) => createConsoleAppFixture(t, { ...options, wrapState }),
  };

  function wrapState(state) {
    return {
      read: (work) => state.read(work),
      async transact(work) {
        let effect;
        const intercept = (repository) =>
          Object.fromEntries(
            Object.entries(repository).map(([name, method]) => [
              name,
              async (...args) => {
                if (armed?.method === name) {
                  effect = armed;
                  armed = undefined;
                  if (effect.kind === "reject") {
                    throw new Error("receipt persistence unavailable");
                  }
                }
                return method(...args);
              },
            ]),
          );
        const result = await state.transact((unit) =>
          work({
            ...unit,
            egressSendReceipts: intercept(unit.egressSendReceipts),
            credentialSources: intercept(unit.credentialSources),
          }),
        );
        if (effect) {
          effect.reached.resolve();
          await effect.release.promise;
          if (effect.kind === "lost_ack") {
            throw new Error("receipt commit acknowledgment unavailable");
          }
        }
        return result;
      },
    };
  }
}

for (const stage of ["policy check", "Kubernetes namespace verification"]) {
  test(`closing the accepted duplex during ${stage} prevents the Secret GET`, async (t) => {
    const fault = receiptPersistenceFaults();
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
  const f = await staticEgressFixture(t);
  const captured = f.capture();
  const before = f.secretReads;
  const placement = f.pauseNamespaceVerification();
  t.after(placement.release);
  const pending = f.resolve(captured);
  await placement.reached;

  // Advance only wall time. This separates the absolute deadline from a timeout callback
  // that may not have run yet, for example when an event-loop turn takes too long.
  const { seconds, nanos } = captured.deadline;
  const deadline = Number(seconds) * 1000 + nanos / 1e6;
  const clock = t.mock.method(Date, "now", () => deadline);
  placement.release();
  const result = await pending;
  clock.mock.restore();
  assert.ok(result.refused);
  assert.equal(f.secretReads, before, "no Secret GET reached Kubernetes after the deadline");
  assert.equal(f.providerRequests.length, 0);
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

// A permitted model stream outlives the 30-second operation deadline only through the
// renewable lease: progress renews it, idling and the ceiling end it, and current
// policy is checked on renewal and again before release. The test clock advances; nothing sleeps.
async function leasedStreamFixture(t, overrides = () => ({}), peerLifetimeMs = 3_600_000) {
  const receipts = new EgressSendReceipts(new InMemoryPlatformState());
  const f = await syntheticDispatchFixture(t, receipts);
  const peer = await f.ports.exchangeOwner.verify("synthetic-peer");
  const longLived = { ...peer, expiresAt: new Date(f.ports.now() + peerLifetimeMs).toISOString() };
  const proxy = new CredentialProxy({
    ...f.ports,
    exchangeOwner: { ...f.ports.exchangeOwner, verify: async () => longLived },
    ...overrides(f),
  });
  const sandboxId = f.association.installation.sandboxId;
  const controller = new AbortController();
  const { signal } = controller;
  const ready = await proxy.resolve("synthetic-peer", sandboxId, f.request, signal);
  assert.equal(ready.kind, "ready");
  const decision = await proxy.authorizeSend(
    "synthetic-peer",
    sandboxId,
    f.request.id,
    ready.handle,
    ready.evidence,
    ready.injectionDigest,
    f.request.deadlineAt,
    signal,
  );
  assert.equal(decision.kind, "allow");
  const safeBody = JSON.stringify({ output: "fixture answer" });
  return {
    f,
    receipts,
    createdAt: Date.parse(f.startedAt),
    deadline: Date.parse(f.request.deadlineAt),
    renew: (bodyBytes, headReceived = true) =>
      proxy.renewResponse("synthetic-peer", sandboxId, f.request.id, { headReceived, bodyBytes }),
    async complete() {
      const handle = await proxy.beginResponse("synthetic-peer", sandboxId, f.request.id);
      if (!handle) {
        return undefined;
      }
      const response = await proxy.protectResponse(
        handle,
        {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: Buffer.from(safeBody),
          trailers: [],
        },
        signal,
        true,
      );
      return response && Buffer.from(response.body).toString();
    },
    safeBody,
    abort: () => controller.abort(),
    async observation() {
      const stored = await receipts.recover(f.sender, {
        sender: f.sender,
        instanceId: peer.instanceId,
        useId: f.request.id,
        attemptId: f.request.id,
        material: ready.evidence,
        deadlineAt: f.request.deadlineAt,
      });
      return stored?.observation;
    },
  };
}

test("a renewed model stream completes after the operation deadline", async (t) => {
  const s = await leasedStreamFixture(t);
  s.f.advance(20_000);
  const first = await s.renew(0);
  assert.deepEqual(first, {
    renewBy: new Date(s.f.ports.now() + STREAM_LEASE_IDLE_MS).toISOString(),
    expiresAt: new Date(s.createdAt + STREAM_LEASE_CEILING_MS).toISOString(),
  });
  s.f.advance(40_000);
  assert.ok(s.f.ports.now() > s.deadline, "the stream is now past the original deadline");
  const second = await s.renew(1024);
  assert.equal(second.renewBy, new Date(s.f.ports.now() + STREAM_LEASE_IDLE_MS).toISOString());
  s.f.advance(100_000);
  assert.equal(await s.complete(), s.safeBody, "the complete stream is released after 160 s");
  assert.deepEqual(await s.observation(), { kind: "response", dispatch: "confirmed", status: 200 });
  assert.equal(await s.renew(2048), undefined, "a released operation has nothing to renew");
});

test("without progress the operation deadline still bounds the first response byte", async (t) => {
  const s = await leasedStreamFixture(t);
  s.f.advance(s.deadline - s.f.ports.now());
  assert.equal(await s.renew(0), undefined, "no renewal starts at the deadline");
  assert.equal(await s.complete(), undefined);
  assert.equal(await s.observation(), null);
  const headless = await leasedStreamFixture(t);
  headless.f.advance(10_000);
  assert.equal(await headless.renew(0, false), undefined, "progress needs the response head");
  assert.equal(await headless.complete(), undefined, "a head-less frame discards the operation");
});

test("a model stream idle past the lease horizon expires", async (t) => {
  const s = await leasedStreamFixture(t);
  s.f.advance(10_000);
  assert.ok(await s.renew(10));
  s.f.advance(STREAM_LEASE_IDLE_MS + 1);
  assert.equal(await s.renew(20), undefined);
  assert.equal(await s.complete(), undefined);
  assert.equal(await s.observation(), null, "expiry settles nothing; the attempt stays uncertain");
});

test("progress without new bytes keeps the lease but cannot extend it", async (t) => {
  const s = await leasedStreamFixture(t);
  s.f.advance(10_000);
  const lease = await s.renew(100);
  s.f.advance(200_000);
  assert.deepEqual(await s.renew(100), lease, "the same byte count returns the unchanged lease");
  assert.deepEqual(await s.renew(99), lease);
  s.f.advance(STREAM_LEASE_IDLE_MS - 200_000 + 1);
  assert.equal(await s.renew(200), undefined, "the unextended lease expired");
  assert.equal(await s.complete(), undefined);
});

test("the stream ceiling holds against continued progress", async (t) => {
  const s = await leasedStreamFixture(t);
  const ceiling = s.createdAt + STREAM_LEASE_CEILING_MS;
  let bytes = 0;
  let lease;
  s.f.advance(10_000);
  while (s.f.ports.now() < ceiling) {
    lease = await s.renew(++bytes);
    assert.ok(lease, `progress at ${(s.f.ports.now() - s.createdAt) / 1000} s renews`);
    assert.ok(Date.parse(lease.renewBy) <= ceiling);
    assert.equal(Date.parse(lease.expiresAt), ceiling);
    s.f.advance(Math.min(250_000, ceiling - s.f.ports.now()));
  }
  assert.equal(Date.parse(lease.renewBy), ceiling, "the last lease ends at the ceiling");
  assert.equal(await s.renew(bytes + 1), undefined, "no progress extends past the ceiling");
  assert.equal(await s.complete(), undefined);
});

test("the stream ceiling is also the peer's expiry", async (t) => {
  const s = await leasedStreamFixture(t, () => ({}), 120_000);
  s.f.advance(10_000);
  const lease = await s.renew(1);
  assert.equal(Date.parse(lease.renewBy), s.createdAt + 120_000);
  assert.equal(Date.parse(lease.expiresAt), s.createdAt + 120_000);
});

test("progress sooner than the recheck interval keeps the lease unchanged", async (t) => {
  let checks = 0;
  const s = await leasedStreamFixture(t, (f) => ({
    check: async (...args) => {
      checks += args[2] ? 1 : 0;
      return f.ports.check(...args);
    },
  }));
  s.f.advance(10_000);
  const lease = await s.renew(1);
  assert.equal(checks, 1);
  s.f.advance(STREAM_LEASE_RECHECK_MS - 1);
  assert.deepEqual(await s.renew(2), lease, "no second policy check inside the interval");
  assert.equal(checks, 1);
  s.f.advance(1);
  const extended = await s.renew(3);
  assert.equal(checks, 2);
  assert.ok(Date.parse(extended.renewBy) > Date.parse(lease.renewBy));
});

test("an unavailable authority leaves the lease unchanged instead of cutting the stream", async (t) => {
  let outage = false;
  const s = await leasedStreamFixture(t, (f) => ({
    check: async (...args) => {
      if (outage && args[2]) {
        throw new Error("synthetic policy outage");
      }
      return f.ports.check(...args);
    },
  }));
  s.f.advance(10_000);
  const lease = await s.renew(1);
  outage = true;
  s.f.advance(STREAM_LEASE_RECHECK_MS);
  assert.deepEqual(await s.renew(2), lease, "the bound stands; it is not extended");
  assert.equal(await s.observation(), null);
  outage = false;
  s.f.advance(STREAM_LEASE_RECHECK_MS);
  assert.ok(Date.parse((await s.renew(3)).renewBy) > Date.parse(lease.renewBy));
  assert.equal(await s.complete(), s.safeBody);
});

test("a withdrawal cuts a model stream at its next renewal", async (t) => {
  let withdrawn = false;
  const s = await leasedStreamFixture(t, (f) => ({
    check: async (use, evidence, stream) =>
      withdrawn && stream
        ? { kind: "denied", code: "withdrawn" }
        : f.ports.check(use, evidence, stream),
  }));
  s.f.advance(10_000);
  assert.ok(await s.renew(0));
  withdrawn = true;
  s.f.advance(20_000);
  assert.equal(await s.renew(100), undefined);
  assert.equal(await s.complete(), undefined, "the withdrawn stream releases no bytes");
  assert.deepEqual(await s.observation(), {
    kind: "response_blocked",
    dispatch: "confirmed",
    code: "response_policy",
  });
});

for (const policy of ["withdrawn", "source changed", "unavailable", "never available"]) {
  test(`a quiet stream cannot release bytes if policy is ${policy} during receipt persistence`, async (t) => {
    let persisting = false;
    let checkedUntil;
    const s = await leasedStreamFixture(t, (f) => ({
      check: async (use, evidence, stream) => {
        const source = await f.ports.check(use, evidence, stream);
        if (!stream || (!persisting && policy !== "never available")) {
          return source;
        }
        checkedUntil = stream.until;
        if (policy === "withdrawn") {
          return { kind: "denied", code: "withdrawn" };
        }
        if (policy === "source changed") {
          return { ...source, materialRefId: "replacement" };
        }
        throw new Error("synthetic policy outage");
      },
    }));
    const lease = await s.renew(s.safeBody.length);
    assert.ok(lease);
    const saving = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const observe = s.receipts.observe.bind(s.receipts);
    t.mock.method(s.receipts, "observe", async (...args) => {
      saving.resolve();
      await resume.promise;
      return observe(...args);
    });

    // No more progress. Finish inside the recheck interval, then change policy while
    // the observation is pending and the proxy still holds the complete response.
    s.f.advance(STREAM_LEASE_RECHECK_MS - 1);
    const response = s.complete();
    await saving.promise;
    persisting = true;
    resume.resolve();
    assert.equal(await response, undefined, "the upstream response must not be released");
    assert.equal(checkedUntil, lease.renewBy, "release uses the current lease deadline");
    assert.deepEqual(await s.observation(), {
      kind: "response",
      dispatch: "confirmed",
      status: 200,
    });
    assert.equal(await s.complete(), undefined, "the observed response cannot be claimed again");
  });
}

for (const loss of ["lease expires", "exchange closes", "owner changes"]) {
  test(`a final policy check cannot release the response after the ${loss}`, async (t) => {
    const checking = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let finishing = false;
    const s = await leasedStreamFixture(t, (f) => ({
      check: async (...args) => {
        if (finishing && args[2]) {
          checking.resolve();
          await resume.promise;
        }
        return f.ports.check(...args);
      },
    }));
    const lease = await s.renew(s.safeBody.length);
    finishing = true;
    const response = s.complete();
    await checking.promise;
    if (loss === "lease expires") {
      s.f.advance(Date.parse(lease.renewBy) - s.f.ports.now());
    }
    if (loss === "exchange closes") {
      s.abort();
    }
    if (loss === "owner changes") {
      s.f.replaceCustody();
    }
    resume.resolve();
    assert.equal(await response, undefined);
    assert.deepEqual(await s.observation(), {
      kind: "response",
      dispatch: "confirmed",
      status: 200,
    });
  });
}

test("stream progress beyond the response bound is refused", async (t) => {
  const s = await leasedStreamFixture(t);
  s.f.advance(10_000);
  assert.equal(await s.renew(4 * 1024 * 1024 + 1), undefined);
  assert.equal(await s.complete(), undefined);
});

test("authenticated sender receipts survive authority restart without replay permission and distinguish observations", async (t) => {
  const f = await staticEgressFixture(t);
  const { captured, ready, input, permit } = await stageReceiptExchange(f);
  assert.ok((await f.authorize(permit)).allowed);
  const possible = await readReceipt(f, input);
  assert.deepEqual(possible.outcome, { kind: "uncertain", dispatch: "possible" });
  assert.equal(possible.observation, null);
  const response = await f.send(captured, ready);
  const foreign = await f.beginExchange(
    f.metadata({ instance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  );
  foreign.stream.write({ response });
  await assert.rejects(
    foreign.next(),
    { code: 7 },
    "another response stream cannot claim the accepted reply",
  );
  assert.ok((await f.protect(captured, response)).body);
  const observed = await readReceipt(f, input);
  assert.deepEqual(observed.observation, { kind: "response", dispatch: "confirmed", status: 200 });
  assert.deepEqual(observed.outcome, possible.outcome);
  assert.deepEqual(observed.authorization, possible.authorization);
  assert.equal(
    observed.settled,
    false,
    "body decision bytes are not final supplier application proof",
  );
  assert.equal(observed.feedback, null);
  assert.deepEqual(
    Object.keys(observed).sort(),
    [
      "sender",
      "instanceId",
      "useId",
      "attemptId",
      "material",
      "deadlineAt",
      "authorization",
      "observation",
      "outcome",
      "settled",
      "feedback",
    ].sort(),
  );
  assert.ok(!JSON.stringify(observed).includes("synthetic-key-initial"));
  await f.restartAuthority();
  const replay = (await f.resolve(captured)).ready;
  assert.ok(replay, "restarted authority has no transient operation registry");
  assert.ok((await f.authorize(f.permitRequest(captured, replay))).refused);
  assert.deepEqual(await readReceipt(f, input), observed);
  assert.equal(f.providerRequests.length, 1, "recovery never dispatches another request");
});

test("receipt observation fences only positive credential rejection, including blocked provider responses", async (t) => {
  const f = await staticEgressFixture(t);
  async function exchange(status, body) {
    f.setResponse({ status, body });
    const { captured, ready, input, permit } = await stageReceiptExchange(f);
    assert.ok((await f.authorize(permit)).allowed);
    const result = await f.protect(captured, await f.send(captured, ready));
    return { result, receipt: await readReceipt(f, input) };
  }
  for (const [status, body] of [
    [401, { error: "invalid credential" }],
    [401, { error: { code: "insufficient_quota", type: "invalid_request_error" } }],
    [403, { error: { code: "invalid_api_key", type: "invalid_request_error" } }],
  ]) {
    const value = await exchange(status, body);
    assert.ok(value.result.body);
    assert.deepEqual(value.receipt.observation, {
      kind: "response",
      dispatch: "confirmed",
      status,
    });
    assert.equal(value.receipt.feedback, null, "HTTP failure alone is not credential rejection");
  }
  // Even recognizable bytes in an unfinished supplier unit do not establish a
  // complete provider rejection. Block the response without fencing the credential.
  f.setResponse({
    status: 401,
    body: { error: { code: "invalid_api_key", type: "invalid_request_error" } },
  });
  const partial = await stageReceiptExchange(f);
  assert.ok((await f.authorize(partial.permit)).allowed);
  const partialResponse = await f.send(partial.captured, partial.ready);
  const incomplete = await f.protect(partial.captured, {
    ...partialResponse,
    response_complete: false,
  });
  assert.equal(incomplete.blocked, true);
  const partialReceipt = await readReceipt(f, partial.input);
  assert.equal(partialReceipt.observation.kind, "response_blocked");
  assert.equal(partialReceipt.feedback, null);
  const acceptedRejection = await exchange(401, {
    error: { code: "invalid_api_key", type: "invalid_request_error" },
  });
  assert.ok(acceptedRejection.result.body);
  assert.deepEqual(acceptedRejection.receipt.observation, {
    kind: "provider_rejected",
    dispatch: "confirmed",
    status: 401,
  });
  assert.equal(acceptedRejection.receipt.feedback, "fenced");
  await f.rotateSecret("synthetic-key-next-version");
  const rejection = {
    error: {
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: "synthetic-key-next-version",
    },
  };
  const blocked = await exchange(401, rejection);
  assert.ok(blocked.result.blocked);
  assert.deepEqual(blocked.receipt.observation, {
    kind: "response_blocked",
    dispatch: "confirmed",
    code: "response_policy",
  });
  assert.equal(
    blocked.receipt.feedback,
    "fenced",
    "actual rejection fences even when response bytes cannot be returned",
  );
  assert.equal(blocked.receipt.settled, false);
  assert.ok(!JSON.stringify(blocked.receipt).includes("synthetic-key-next-version"));
  const next = f.capture();
  const ready = (await f.resolve(next)).ready;
  assert.ok((await f.authorize(f.permitRequest(next, ready))).refused);
  assert.equal(f.providerRequests.length, 6);
});

test("receipt persistence failure, lost acknowledgment and late authorization never grant send permission", async (t) => {
  for (const scenario of [
    "reject",
    "lost_ack",
    "revoke",
    "deny_lost_ack",
    "deadline",
    "check_deadline",
    "cancel",
  ]) {
    await t.test(scenario, async (t) => {
      let elapsed = 0;
      const fault = receiptPersistenceFaults();
      const f = await staticEgressFixture(t, {
        now: () => new Date(Date.now() + elapsed),
        appFactory: fault.appFactory,
      });
      const { captured, input, permit } = await stageReceiptExchange(f);
      const gate = fault.arm(
        scenario === "check_deadline"
          ? "isEgressMaterialRejected"
          : scenario === "lost_ack"
            ? "authorize"
            : "insert",
        ["reject", "lost_ack"].includes(scenario) ? scenario : "pause",
      );
      t.after(gate.release);
      const result = f.authorize(permit, {
        cancelAfterMs: scenario === "cancel" ? 50 : undefined,
      });
      if (scenario !== "reject") {
        const cancellation =
          scenario === "cancel" ? assert.rejects(result, { code: 1 }) : undefined;
        await gate.reached;
        if (scenario === "revoke" || scenario === "deny_lost_ack") {
          await f.revoke();
        }
        // The refused settlement commits but its acknowledgment is lost: the sender sees
        // unavailable, while the receipt records the committed refusal.
        const settlement = scenario === "deny_lost_ack" ? fault.arm("save", "lost_ack") : undefined;
        if (settlement) {
          t.after(settlement.release);
        }
        if (scenario === "deadline" || scenario === "check_deadline") {
          elapsed = 31_000;
        }
        if (scenario === "check_deadline") {
          // The actual successful final policy transaction has committed. A new
          // capture prunes the expired handle before that check returns to its owner.
          assert.ok((await f.resolve(f.capture())).ready);
        }
        if (cancellation) {
          await cancellation;
        }
        gate.release();
        if (settlement) {
          await settlement.reached;
          settlement.release();
        }
      }
      if (scenario !== "cancel") {
        const { refused } = await result;
        assert.ok(refused, scenario);
        if (scenario === "deny_lost_ack") {
          assert.equal(refused.code, f.refusalCode("UNAVAILABLE"));
        }
      }
      const stored = await readReceipt(f, input);
      if (scenario === "reject") {
        assert.equal(stored, undefined);
      }
      if (scenario === "lost_ack") {
        assert.ok(
          stored.authorization?.association.custodyId,
          "lost the exact authorized dispatch acknowledgment, not an earlier begin",
        );
        assert.equal(stored.settled, false);
        assert.deepEqual(stored.outcome, { kind: "uncertain", dispatch: "possible" });
        await f.restartAuthority();
        const replay = (await f.resolve(captured)).ready;
        assert.ok((await f.authorize(f.permitRequest(captured, replay))).refused);
      }
      if (["revoke", "deadline", "check_deadline"].includes(scenario)) {
        assert.equal(stored.outcome.kind, "refused");
        assert.equal(stored.outcome.dispatched, false);
      }
      if (scenario === "deny_lost_ack") {
        assert.equal(stored.settled, true, "refusal committed before its acknowledgment was lost");
        assert.equal(stored.authorization, null);
        assert.deepEqual(stored.outcome, {
          kind: "refused",
          dispatched: false,
          error: { kind: "denied", code: "unauthorized" },
        });
      }
      assert.equal(f.providerRequests.length, 0);
    });
  }
});

test("response persistence must commit its observation and fence before policy bytes are acknowledged", async (t) => {
  for (const scenario of ["reject", "lost_ack", "deadline"]) {
    await t.test(scenario, async (t) => {
      let elapsed = 0;
      const fault = receiptPersistenceFaults();
      const f = await staticEgressFixture(t, {
        now: () => new Date(Date.now() + elapsed),
        appFactory: fault.appFactory,
      });
      f.setResponse({
        status: 401,
        body: { error: { code: "invalid_api_key", type: "invalid_request_error" } },
      });
      const { captured, ready, input, permit } = await stageReceiptExchange(f);
      assert.ok((await f.authorize(permit)).allowed);
      const response = await f.send(captured, ready);
      const gate = fault.arm("save", scenario === "deadline" ? "pause" : scenario);
      t.after(gate.release);
      const pending = f.protect(captured, response);
      const failed = scenario === "deadline" ? undefined : assert.rejects(pending, { code: 14 });
      if (scenario !== "reject") {
        await gate.reached;
        if (scenario === "deadline") {
          elapsed = 31_000;
        }
        gate.release();
      }
      if (failed) {
        await failed;
      } else {
        assert.ok((await pending).blocked);
      }
      const receipt = await readReceipt(f, input);
      assert.deepEqual(receipt.outcome, { kind: "uncertain", dispatch: "possible" });
      assert.equal(receipt.settled, false);
      const fenced = await f.controller.transact((unit) =>
        unit.credentialSources.isEgressMaterialRejected(input.material),
      );
      assert.equal(
        fenced,
        scenario !== "reject",
        "observation and exact-version fence share one real state transaction",
      );
      assert.equal(receipt.feedback, fenced ? "fenced" : null);
      assert.equal(receipt.observation?.kind, fenced ? "provider_rejected" : undefined);
      assert.equal(f.providerRequests.length, 1);
    });
  }
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
  const { unprotected, refused } = admissionCases(f.revision);
  const cases = [
    ...refused,
    [f.revision, /Protected execution is unavailable/],
    [
      {
        ...f.revision,
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
    compute: { id: compute.id, implementation: compute.implementation },
  });

  // Protection comes from the selected execution policy, not the number of credentials.
  // Runtime-auth fixtures carry no credential source; their durable plan remains deny-all.
  const emptyAgent = await f.createAgent(
    f.namespace.id,
    "credential-free",
    f.revision.configuration,
    {
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
    },
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
