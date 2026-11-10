import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_FAILURE_STEPS } from "../../packages/occ/src/deployment-failure-steps.ts";
import {
  observeConnectedOperation,
  summarizeGatewayTurnResult,
} from "./egress-connected-failure.mjs";
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
    if (ledger.pendingDeploy) {
      failures.push("unreconciled deployment; inspect exact Agent operation in ledger");
    }
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

const gatewayContainer = "gateway";

function ownsGateway(pod, agentId) {
  const labels = pod.metadata?.labels;
  return (
    labels?.["openclaw.dev/agent"] === agentId &&
    labels?.["openclaw.dev/workload-role"] === "gateway"
  );
}

function matchesGatewayRevision(pod, revisionId) {
  return pod.metadata?.labels?.["openclaw.dev/revision"] === revisionId;
}

function gatewayImageMatches(pod, image) {
  return pod.spec?.containers?.find(({ name }) => name === gatewayContainer)?.image === image;
}

function gatewayRunningAndReady(pod) {
  const status = pod.status;
  const container = status?.containerStatuses?.find(({ name }) => name === gatewayContainer);
  return (
    status?.phase === "Running" &&
    container?.state?.running != null &&
    container.ready === true &&
    status.conditions?.some(({ type, status }) => type === "Ready" && status === "True")
  );
}

const deploymentStatuses = new Set(["queued", "running", "succeeded", "failed"]);
const deploymentProgressCodes = new Set([
  "RECONCILIATION_PENDING",
  "REVISION_INCOMPLETE",
  "REVISION_FINALIZATION_INCOMPLETE",
  "ACTIVE_REVISION_RECOVERY",
  "WORKSPACE_NODE_PENDING",
  "AGENT_GATEWAY_UNAVAILABLE",
  "SANDBOX_GATEWAY_UNAVAILABLE",
]);

export async function waitForProtectedAgentActivation(
  waitFor,
  { api, checkpoint },
  { agentPath, deploymentPath, revisionId },
) {
  let last = null;
  let outcome = "timeout";
  let reading = null;
  let lastPending;
  let pendingCheckpoints = 0;
  try {
    return await waitFor(
      "protected Agent activation with genuine installed evidence",
      async () => {
        reading = "deployment";
        const deployment = await api("GET", deploymentPath);
        const status = deploymentStatuses.has(deployment.status) ? deployment.status : "unknown";
        const progressCode = deployment.progress?.lastAttempt?.code;
        last = {
          status,
          progressCode: deploymentProgressCodes.has(progressCode) ? progressCode : null,
          activeRevisionMatches: null,
        };
        if (status === "failed") {
          reading = null;
          outcome = "failed";
          const code = deployment.error?.code;
          last.errorCode =
            typeof code === "string" && Object.hasOwn(DEPLOYMENT_FAILURE_STEPS, code)
              ? code
              : "UNKNOWN";
          assert.fail("The protected Agent deployment failed; inspect the safe checkpoint");
        }
        reading = "agent";
        const current = await api("GET", agentPath);
        last.activeRevisionMatches = current.activeRevisionId === revisionId;
        reading = null;
        // The worker publishes the active pointer before finishing activation.
        if (status === "succeeded" && last.activeRevisionMatches) {
          return current;
        }
        // Record the first observation and changes, with a cap even if the pointer
        // oscillates. The failure checkpoint always retains the last observation.
        const pending = JSON.stringify(last);
        if (pendingCheckpoints < 6 && pending !== lastPending) {
          pendingCheckpoints += 1;
          lastPending = pending;
          await checkpoint("activation-pending", { last }).catch(() => {});
        }
        return undefined;
      },
      12 * 60_000,
    );
  } catch (error) {
    await checkpoint("activation-failed", {
      outcome: reading === null ? outcome : "read-error",
      ...(reading !== null && { reading }),
      last,
    }).catch(() => {});
    throw error;
  }
}

export async function waitForInstalledGateway(f, evidence, placement, agentId, revisionId, image) {
  let last = null;
  let listing = false;
  let gateway;
  try {
    gateway = await f.waitFor(
      "one ready Gateway Pod for the installed Agent revision",
      async () => {
        listing = true;
        const pods = await observeConnectedOperation("gateway-selection-list", () =>
          f.resources(
            "pods",
            placement,
            "--selector",
            `openclaw.dev/agent=${agentId},openclaw.dev/workload-role=gateway`,
          ),
        );
        const owned = pods.filter((pod) => ownsGateway(pod, agentId));
        const live = owned.filter(({ metadata }) => !metadata.deletionTimestamp);
        const current = live.filter((pod) => matchesGatewayRevision(pod, revisionId));
        const matchingImage = current.filter((pod) => gatewayImageMatches(pod, image));
        const ready = matchingImage.filter(gatewayRunningAndReady);
        last = {
          owned: owned.length,
          deleting: owned.length - live.length,
          stale: live.length - current.length,
          current: current.length,
          wrongImage: current.length - matchingImage.length,
          pending: current.filter(({ status }) => status?.phase === "Pending").length,
          ready: ready.length,
        };
        listing = false;
        if (
          current.length === 1 &&
          ready.length === 1 &&
          ready[0].metadata.uid &&
          ready[0].metadata.name
        ) {
          return ready[0];
        }
        return undefined;
      },
      120_000,
    );
  } catch (error) {
    // The outer failure formatter intentionally drops assertion text. Keep the
    // last successful list summary separately, including when the next read fails.
    await evidence
      .checkpoint("gateway-selection-failed", {
        outcome: listing ? "read-error" : "timeout",
        last,
      })
      .catch(() => {});
    throw error;
  }
  await evidence.checkpoint("gateway-selected", { last }, { gatewayUid: gateway.metadata.uid });
  return gateway;
}

export async function requestInstalledGatewayTurn(
  f,
  evidence,
  { placement, agentId, revisionId, image, gateway, phase, custodyTransitions, expected },
  turn,
) {
  const before = await custodyTransitions.snapshot();
  const { name, uid } = gateway.metadata;
  const observation = { phase, outcome: "read-error" };
  evidence.ledger.gatewayExecTarget = observation;
  const current = await observeConnectedOperation("gateway-exec-target-get", () =>
    f.maybeResource("pod", name, placement),
  );
  if (!current) {
    observation.outcome = "absent";
  } else if (current.metadata?.uid !== uid) {
    observation.outcome = "replaced";
  } else if (
    !ownsGateway(current, agentId) ||
    !matchesGatewayRevision(current, revisionId) ||
    current.metadata.deletionTimestamp ||
    !gatewayImageMatches(current, image) ||
    !gatewayRunningAndReady(current)
  ) {
    observation.outcome = "ineligible";
  } else {
    observation.outcome = "eligible";
  }
  if (observation.outcome !== "eligible") {
    await evidence
      .checkpoint("gateway-exec-blocked", { outcome: observation.outcome })
      .catch(() => {});
    assert.fail("the selected Gateway Pod changed or stopped serving before exec");
  }
  // Kubernetes exec addresses the Pod by name. This read narrows the race but
  // cannot bind exec to a UID atomically. Propagate uncertainty without replay.
  const result = await f.requestCodexTurnFromGatewayPod({
    ...turn,
    namespace: placement,
    gatewayPod: name,
    container: gatewayContainer,
  });
  const nativeTurnResult = summarizeGatewayTurnResult(expected, result);
  // checkpoint retains the summary in memory before attempting the durable write.
  await evidence
    .checkpoint("gateway-turn-result", { turnPhase: phase, nativeTurnResult })
    .catch(() => {});
  return { before, result, nativeTurnResult };
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
      const policies = Object.fromEntries(
        Object.entries(observation.effective_policy.network_policies)
          .filter(([name]) => name.startsWith("oce-egress-"))
          .map(([name, policy]) => [name, policy.binaries ?? []]),
      );
      assert.deepEqual(
        policies,
        Object.fromEntries(
          installed.plan.routes.map((route, index) => [
            `oce-egress-${index}`,
            route.binding.grant.kind === "inference" ? [{ path: "/**" }] : [],
          ]),
        ),
        "loaded managed routes must match the admitted routes and their binary scopes",
      );
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
  const gateway = await waitForInstalledGateway(
    f,
    evidence,
    placement,
    agent.id,
    revision.id,
    input.images.gateway,
  );
  const gatewayPods = [gateway];
  const pods = await resources("pods", placement);
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
