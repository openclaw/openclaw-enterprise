import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteInstalledResource } from "./egress-installed-resource-cleanup.mjs";
import { createCustodyTransitions } from "./egress-supplier-custody-transitions.mjs";
import { createOpenShellKubernetesFixture } from "./openshell-kubernetes-real.mjs";
import { connectedReceiptRevision, assertConnectedResponse } from "./egress-connected-inputs.mjs";
import { startSyntheticEgressProvider } from "../fixtures/synthetic-egress-provider.mjs";

export function enforcementCapabilities(input) {
  const fresh = input.authorityProfile === "fresh-whole-execution";
  return [
    "http-credential-access",
    ...(fresh
      ? [
          "installation-exchange",
          "response-custody",
          "execution-authority",
          "protected-no-material",
        ]
      : ["http-credential-verified-connector"]),
  ].map((name) => "openshell.supervisor-middleware." + name + ".v1");
}

/**
 * Owns only confirmed resource IDs; an uncertain create remains in the ledger.
 */
export async function registerCleanupAndStartProvider(
  t,
  setup,
  stack,
  evidence,
  startProvider = startSyntheticEgressProvider,
) {
  const {
    input,
    controller,
    selection,
    f: { waitFor },
  } = setup;
  const { namespacePath, placement, controllerPods } = stack;
  const { ledger, directory, credentials, request, api, checkpoint } = evidence;
  const providerCleanup = [];
  let provider;
  const ownedSandboxes = [];
  const podUids = new Set();
  // Register cleanup before the first creation request. An unknown create outcome
  // remains in the ledger for the parent; never replay a mutation to hide it.
  t.after(async () => {
    const failures = ledger.pendingCreate ? ["unconfirmed create; reconcile ledger"] : [];
    const clean = async (name, action) => {
      try {
        await action();
      } catch {
        failures.push(name);
      }
    };
    const ownedAgents = ledger.resources.filter(({ kind }) => kind === "agents");
    for (const ownedAgent of ownedAgents) {
      await clean("Agent/" + ownedAgent.id, async () => {
        const deleted = await request(
          "DELETE",
          `${namespacePath}/agents/${ownedAgent.id}`,
          undefined,
          true,
        );
        assert.ok([202, 404].includes(deleted.status));
        assertConnectedResponse(deleted, deleted.status);
        await waitFor(
          "owned Agent deletion",
          async () => {
            const observed = await request(
              "GET",
              `${namespacePath}/agents/${ownedAgent.id}`,
              undefined,
              true,
            );
            if (observed.status === 404) {
              assertConnectedResponse(observed, 404);
              return true;
            }
            assertConnectedResponse(observed, 200);
            return undefined;
          },
          180_000,
        );
      });
    }
    // Check every observed identity after deleting only Agents we created. Earlier
    // revisions and both simultaneous executions count even if their API rows are gone.
    if (ownedAgents.length) {
      await clean("owned Kubernetes workloads", async () => {
        const agentIds = ownedAgents.map(({ id }) => id);
        const cleanup = createOpenShellKubernetesFixture({
          ...selection,
          commandTimeoutMs: 20_000,
        });
        await cleanup.waitFor(
          "all observed owned Sandbox and Pod identities gone",
          async () => {
            const pods = await cleanup.resources("pods", placement);
            const sandboxes = await cleanup.customResources("sandboxes.agents.x-k8s.io", placement);
            const owned = ({ metadata: m }) =>
              podUids.has(m.uid) ||
              agentIds.includes(m.labels?.["openclaw.dev/agent"]) ||
              ownedSandboxes.some(
                ({ name, uid, id }) =>
                  m.uid === uid || m.name === name || m.labels?.["openshell.ai/sandbox-id"] === id,
              );
            return !pods.some(owned) && !sandboxes.some(owned);
          },
          180_000,
        );
        const deployments = ledger.phases.filter(({ phase }) => phase === "deploy-request");
        if (ownedSandboxes.length < deployments.length) {
          failures.push(
            "Sandbox identity not observed for every deploy; parent reconciliation required",
          );
        }
      });
    }
    for (const kind of [
      "iam/access-bindings",
      "credential-sources",
      "iam/roles",
      "secrets",
      "configurations",
    ]) {
      for (const owned of ledger.resources.filter((entry) => entry.kind === kind)) {
        const ordinal = ledger.resources.indexOf(owned) + 1;
        const label = `${kind} resource #${ordinal}; see cleanup-resource observations`;
        await clean(label, async () => {
          const repository = kind === "credential-sources" && provider?.retirementEvidence;
          const removed = await deleteInstalledResource({
            remove: () =>
              request("DELETE", `${namespacePath}/${kind}/${owned.id}`, undefined, true),
            record: (details) =>
              checkpoint("cleanup-resource", {
                kind,
                ordinal,
                ...details,
                ...(repository && { issuer: provider.retirementEvidence() }),
              }),
            prepared: repository && {
              databaseUrl: setup.databaseUrl,
              namespaceId: stack.namespace.id,
              sourceId: owned.id,
            },
          });
          if (!removed) {
            failures.push(label);
          }
        });
      }
    }
    await clean("provider observations", () =>
      writeFile(
        join(directory, "upstream.json"),
        JSON.stringify(provider?.observations ?? [], null, 2) + "\n",
        { mode: 0o600 },
      ),
    );
    for (const close of providerCleanup) {
      await clean("synthetic HTTPS listener", close);
    }
    ledger.cleanup = failures.length ? "incomplete" : "complete";
    await checkpoint("cleanup", { failures });
    assert.deepEqual(failures, [], "owned resources remain; use the preserved ledger");
  });
  // Custody is registered before listen: failed setup must also close the
  // listener, and bind failures must not leave a pending cleanup unobserved.
  provider = await startProvider(
    { after: (close) => providerCleanup.push(close) },
    { ...input.provider, model: controller.model, protect: evidence.protect },
    credentials,
  );
  const create = async (kind, body) => {
    t.signal.throwIfAborted();
    ledger.pendingCreate = { kind, name: body.name };
    await checkpoint("create-request", { kind, name: body.name });
    const value = await api("POST", `${namespacePath}/${kind}`, body, 201);
    ledger.resources.push({ kind, id: value.id, name: body.name });
    delete ledger.pendingCreate;
    await checkpoint("created", { kind, id: value.id });
    return value;
  };
  await checkpoint("prepared-stack-observed", {
    placement,
    controllerPods: controllerPods.map(({ metadata }) => metadata.uid),
  });
  const recordSandbox = async (sandbox) => {
    const { name, uid, labels } = sandbox.metadata;
    const id = labels?.["openshell.ai/sandbox-id"];
    assert.ok(uid && id, "the Sandbox must identify its Kubernetes UID and supplier owner");
    assert.ok(!ownedSandboxes.some((entry) => entry.uid === uid), "fresh owned Sandbox identity");
    ownedSandboxes.push({ name, uid, id });
    await checkpoint("sandbox-observed", { sandboxName: name, sandboxUid: uid, sandboxId: id });
    return id;
  };
  const recordPods = async (...pods) => {
    const uids = pods.map(({ metadata }) => metadata.uid);
    assert.ok(uids.every(Boolean));
    for (const uid of uids) {
      podUids.add(uid);
    }
    await checkpoint("pods-observed", { uids });
  };
  return { provider, create, recordSandbox, recordPods };
}

export async function observeInstalledProtection(
  setup,
  stack,
  evidence,
  deployment,
  checkGrant = (binding) => binding.grant.providerTools === "none",
) {
  const { input, f } = setup;
  const { resources } = f;
  const { placement, gatewayClient, pool, namespace, installation } = stack;
  const { checkpoint } = evidence;
  const { agent, source, revision, sandbox, sandboxId } = deployment;
  const harness = await f.waitForProviderHarnessPod(placement, revision);
  await f.assertProviderOwnedHarness(placement, revision, sandbox, harness, "maintainedLauncher");
  f.assertWorkspaceMounts(harness);
  f.assertApprovedOpenShellPrivileges(harness);
  await f.assertGatewayBootstrapPolicies(placement);
  assert.equal(
    harness.spec.containers.find(({ name }) => name === "agent").image,
    input.images.agent,
  );
  assert.equal(
    harness.spec.initContainers.find(({ name }) => name === "openshell-sandbox-bootstrap")?.image,
    input.images.sandbox,
    "the actual trusted bootstrap must use the selected supplier runtime",
  );
  const sandboxName = sandbox.metadata.labels["openshell.ai/sandbox-name"];
  const observedSandbox = await gatewayClient.getSandbox(
    { workspace: placement, name: sandboxName },
    AbortSignal.timeout(10_000),
  );
  assert.ok(observedSandbox?.id, "read the immutable Sandbox ID from the actual gateway");
  assert.equal(observedSandbox.id, sandboxId);
  const installations = await pool.query(
    "SELECT installation FROM occ.egress_installations WHERE namespace_id = $1 AND revision_id = $2 AND agent_id = $3",
    [namespace.id, revision.id, agent.id],
  );
  assert.equal(
    installations.rowCount,
    1,
    "the real worker must record exactly one installed mapping",
  );
  const installed = installations.rows[0].installation;
  assert.equal(installed.sandboxId, observedSandbox.id);
  assert.equal(installed.plan.execution.installationId, installation.id);
  assert.equal(installed.plan.execution.servicePrincipalId, agent.servicePrincipalId);
  assert.ok(installed.plan.routes.length > 0, "an empty plan cannot prove protected routing");
  assert.ok(
    installed.plan.routes.every(
      ({ binding: routeBinding }) =>
        routeBinding.source.source.id === source.id && checkGrant(routeBinding),
    ),
  );
  const custodyCapabilities = enforcementCapabilities(input);
  const readReceipt = async () => {
    const status = await gatewayClient.getSandboxPolicyStatus(
      placement,
      sandboxName,
      AbortSignal.timeout(10_000),
    );
    const observation = status.loaded_policy_observation;
    assert.ok(observation, "LOADED or legacy field 3 cannot substitute for a V1 observation");
    const receipt = observation.enforcement;
    assert.ok(receipt, "V1 requires current supervisor enforcement evidence");
    assert.equal(receipt.sandbox_id, observedSandbox.id);
    assert.equal(receipt.instance_id, installed.enforcement?.instanceId);
    assert.equal(receipt.policy_version, installed.plan.generation);
    assert.equal(status.active_version, receipt.policy_version);
    assert.equal(status.revision.policy_hash, observation.source_policy_hash);
    assert.match(observation.source_policy_hash, /^[a-f0-9]{64}$/);
    assert.ok(observation.effective_policy);
    const middleware = observation.effective_policy.network_middlewares["oce-egress"];
    assert.deepEqual(
      middleware.credential_connectors ?? [],
      input.credentialConnector
        ? [{ path: input.credentialConnector.path, sha256: input.credentialConnector.sha256 }]
        : [],
    );
    if (!input.credentialConnector) {
      assert.equal(middleware.execution_authority, true);
      assert.equal(middleware.credential_authority, true);
      const policies = Object.entries(observation.effective_policy.network_policies).filter(
        ([name]) => name.startsWith("oce-egress-"),
      );
      assert.ok(policies.length > 0, "fresh operation must have an actual managed route");
      for (const [, policy] of policies) {
        assert.deepEqual(policy.binaries ?? [], [], "no caller executable allowlist");
      }
    }
    assert.equal(installed.enforcement.policyHash, receipt.policy_hash);
    const effective = structuredClone(observation.effective_policy);
    const name = `_provider_oce_runtime_${createHash("sha256").update(revision.id).digest("hex").slice(0, 16)}`;
    if (!input.credentialConnector && !observation.inert_provider_rule) {
      assert.equal(observation.source_policy_hash, receipt.policy_hash);
    } else {
      assert.equal(observation.inert_provider_rule, name);
      assert.equal(Object.hasOwn(status.revision.policy.network_policies, name), false);
      assert.deepEqual(effective.network_policies[name], { name });
      delete effective.network_policies[name];
      assert.notEqual(observation.source_policy_hash, receipt.policy_hash);
    }
    assert.equal(status.loaded_enforcement, undefined);
    assert.deepEqual(effective, status.revision.policy);
    assert.ok([2, "POLICY_STATUS_LOADED"].includes(status.revision.status));
    assert.match(
      receipt.instance_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.match(receipt.policy_hash, /^[a-f0-9]{64}$/);
    connectedReceiptRevision(receipt.config_revision);
    connectedReceiptRevision(receipt.provider_env_revision);
    assert.deepEqual(receipt.enforced_capabilities, custodyCapabilities);
    // Retain both supplier identities and policies for the subsequent turn's
    // freshness comparison; enforcement.policy_hash identifies the effective policy.
    return observation;
  };
  const receipt = await readReceipt();
  await checkpoint("installed", {
    sourcePolicyHash: receipt.source_policy_hash,
    effectivePolicyHash: receipt.enforcement.policy_hash,
    policyVersion: String(receipt.enforcement.policy_version),
    configRevision: connectedReceiptRevision(receipt.enforcement.config_revision),
    providerEnvRevision: connectedReceiptRevision(receipt.enforcement.provider_env_revision),
    capabilities: custodyCapabilities,
    derivation: receipt.inert_provider_rule
      ? "inert_runtime_provider_rule"
      : "source_equals_effective",
  });
  const pods = await resources("pods", placement);
  const gatewayPods = pods.filter(
    ({ metadata }) =>
      metadata.labels?.["openclaw.dev/agent"] === agent.id &&
      metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
  );
  assert.equal(gatewayPods.length, 1);
  assert.ok(gatewayPods[0].spec.containers.some(({ image }) => image === input.images.gateway));
  const supervisors = pods.filter(
    ({ metadata }) =>
      metadata.labels?.["openshell.ai/sandbox-id"] === installed.sandboxId &&
      metadata.labels?.["openshell.ai/boundary-role"] === "supervisor",
  );
  assert.equal(supervisors.length, 1, "a separate selected supervisor must own forwarding");
  assert.ok(supervisors[0].spec.containers.some(({ image }) => image === input.images.supervisor));
  const [supervisor] = supervisors;
  const custodyTransitions = createCustodyTransitions({
    gatewayClient,
    workspace: placement,
    sandbox: sandboxName,
    sandboxId: observedSandbox.id,
    supervisor,
    readSupervisor: () => f.resource("pod", supervisor.metadata.name, placement),
  });
  return {
    harness,
    sandboxName,
    custodyTransitions,
    inAgent: async (...command) => {
      const { stdout } = await stack.execWorkload({ sandboxName, sandboxId }, command);
      return stdout.toString("utf8");
    },
    readReceipt,
    receipt,
    gatewayPods,
    installation: installed,
    supervisor,
  };
}
