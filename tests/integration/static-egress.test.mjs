import assert from "node:assert/strict";
import test from "node:test";
import { registerStreamReceiptPersistenceCases } from "./credential-proxy-stream-lease-cases.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { PROXY_REGISTRATION_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import { OpenShellEgressIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-identity.ts";
import { CredentialProxy, egressInjectionDigest } from "../../packages/occ/src/credential-proxy.ts";
import { deploymentErrorForWork } from "../../packages/occ/src/deployment-work-status.ts";
import { reconcileSandboxPolicy } from "../../apps/controller/src/worker/sandbox-policy.ts";
import {} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import {
  protectedMetadataFixture,
  loadGatewayDefinition,
  supervisorBearer,
  unary,
} from "../helpers/static-egress.mjs";

import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";
import {
  createStaticEgressAdmissionCases,
  registerStaticEgressRequestCapacityCases,
  runStaticEgressReceiptCapacityCase,
} from "./static-egress-request-capacity-cases.ts";

const staticEgressAdmissionCases = createStaticEgressAdmissionCases({
  admissionCases,
  networkPolicyGrant,
});
staticEgressAdmissionCases.registerStartupCases();

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

test("protected admission requires the actual counterpart and exact loaded policy; revision removal deletes only its owned Sandbox", async (t) => {
  const f = await protectedMetadataFixture(t);
  // Inspect the production attachment before protobuf can erase an explicit zero.
  // OpenShell requires omission for automatic TLS termination, not TERMINATE or SKIP.
  for (const [index, route] of f.context.plan.routes.entries()) {
    const { endpoints } = f.attachment.configuration.network_policies[`oce-egress-${index}`];
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
  // A wider route cannot stand in for the canonical attachment or establish a new installation.
  const widerConfiguration = structuredClone(f.attachment.configuration);
  delete widerConfiguration.network_policies["oce-egress-0"].endpoints[0].path;
  await assert.rejects(
    f.egress.wiringStatus(f.context, { ...f.attachment, configuration: widerConfiguration }),
    /changed protected egress routes/,
  );
  delete f.observed.policy.network_policies["oce-egress-0"].endpoints[0].path;
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

test("current supplier evidence is required at access and send; stored receipts cannot authorize a replacement", async (t) => {
  const f = await protectedMetadataFixture(t);
  const original = structuredClone(f.observed.evidence);
  const observation = f.observed.observation;
  const beforeLegacy = f.secretReads;
  delete f.observed.observation;
  // LOADED and valid legacy field 3 remain present; neither substitutes for V1.
  assert.equal(await f.egress.wiringStatus(f.context, f.attachment), undefined);
  assert.ok((await f.resolve(captureMetadata(f))).refused);
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
    assert.ok((await f.resolve(captureMetadata(f))).refused);
    assert.equal(f.secretReads, reads, "historical installation must not permit credential access");
  }
  f.observed.evidence = original;
  const captured = captureMetadata(f);
  const ready = (await f.resolve(captured)).ready_without_material;
  assert.ok(ready, "restoring the original current observation permits a new operation");
  // Replacement happens after resolution, while the operation still holds the old receipt.
  f.observed.evidence = { ...original, instance_id: "10000000-0000-4000-8000-000000000001" };
  assert.ok((await f.authorize(f.permitRequest(captured, ready, { noMaterial: true }))).refused);
  assert.equal(f.providerRequests.length, 0);
  const replacement = await f.egress.wiringStatus(f.context, f.attachment);
  assert.ok(replacement);
  await assert.rejects(
    f.controller.transact((unit) => unit.credentialSources.recordEgressInstallation(replacement)),
    /already bound/,
  );
});

staticEgressAdmissionCases.registerPolicyVersionCases();
registerStaticEgressRequestCapacityCases();

test("cancelled and denied exchanges retain capacity until receipt work settles", async (t) => {
  await runStaticEgressReceiptCapacityCase(t);
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

/** @param {Partial<import("../../packages/contracts/src/index.ts").AgentRevision>} revision */
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

staticEgressAdmissionCases.registerComputeCase();

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
  const f = await protectedMetadataFixture(t, {
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
  const savePolicy = (additions, repositoryNetworkPolicy) =>
    f.controller.transact(async (unit) => {
      const policy = await unit.sandboxPolicies.find(f.namespace.id, f.agent.id);
      assert.ok(policy, "every Agent owns a sandbox policy");
      const saved = await unit.sandboxPolicies.save(
        {
          ...policy,
          additions,
          version: policy.version + 1,
          ...(repositoryNetworkPolicy === undefined ? {} : { repositoryNetworkPolicy }),
        },
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
  // Omission permits the existing protected execution path.
  await savePolicy([]);
  const metadata = await f.deployAgent(f.namespace.id, f.agent.id);
  const revision = await f.controller.transact((unit) =>
    unit.revisions.findRevision(f.namespace.id, f.agent.id, metadata.id),
  );
  assert.equal(revision.executionAdmission.mode, "protected");
  assert.ok(revision.egressPlan);
  assert.equal(revision.sandboxPolicy, undefined);
  // Saving explicit deny-all must refuse a subsequent protected deployment.
  await savePolicy([], []);
  const deniedRepositoryPolicy = await f.request(
    "POST",
    `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`,
  );
  assert.equal(deniedRepositoryPolicy.status, 409, JSON.stringify(deniedRepositoryPolicy.body));
  assert.match(
    deniedRepositoryPolicy.body.error.message,
    /Protected execution cannot enforce the saved repository network policy/,
  );
  assert.deepEqual(
    await f.controller.transact((unit) => unit.revisions.listRevisions(f.namespace.id, f.agent.id)),
    [revision],
  );
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

staticEgressAdmissionCases.registerDriverCase();

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
  // Exercise the actual Installation state ports for the saved ceiling. The remaining
  // controlled provider/queue observations isolate failure classification, not runtime proof.
  const installationId = `ins_${randomUUID()}`;
  const ceilingState = new InMemoryPlatformState();
  const ceilingOwner = new OpenClawController(
    { id: installationId, name: "Protected policy refusal", createdAt: new Date().toISOString() },
    { state: ceilingState, sandboxNetworkPolicyCeiling: [grant] },
  );
  await ceilingOwner.initializeSandboxNetworkPolicyCeiling("principal");
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
      state: {
        transactWithQueue: (operation) =>
          ceilingState.transact((actual) => operation({ ...actual, ...unit }, queue)),
      },
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
      installationId,
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
