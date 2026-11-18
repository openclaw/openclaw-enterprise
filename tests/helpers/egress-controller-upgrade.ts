import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import { CredentialSourceId } from "../../packages/contracts/src/index.ts";
import { assertSecretReference, protectedSourceBody } from "./egress-connected-inputs.mjs";
import {
  controllerComponents,
  controllerContainers,
  observeControllerIdentities,
  supplierIdentities,
} from "./egress-controller-processes.ts";
import { retainedState } from "./egress-controller-retained-state.ts";
import { verifyRetirementRefusals } from "./egress-controller-retirement.ts";
import { selectLiveControllerPods } from "./egress-installed-stack.mjs";
import {
  parseJson,
  isArray,
  entries,
  isChoice,
  readString,
  record,
} from "./egress-observation-values.ts";
import type {
  ProviderCounters,
  RetirementEvidence,
  UpgradeDeployment,
  UpgradeEvidence,
  UpgradeResources,
  UpgradeSetup,
  UpgradeStack,
} from "./egress-upgrade-contracts.ts";
import { waitFor } from "./wait-for.ts";

function readPodItems(raw: string) {
  const { items } = record(parseJson(raw));
  assert.ok(isArray(items), "expected Kubernetes Pod list");
  return entries(items);
}

export async function prepareControllerUpgrade(
  setup: UpgradeSetup,
  stack: UpgradeStack,
  evidence: UpgradeEvidence,
  owned: UpgradeResources,
  deployment: UpgradeDeployment,
  installed: { gatewayPods: readonly unknown[] },
) {
  const { input, controller } = setup;
  const { api, runId, credentials, checkpoint } = evidence;
  const { namespacePath, pool, namespace } = stack;
  assert.equal(
    namespacePath,
    `/namespaces/${namespace.id}`,
    "upgrade Namespace must match the bound path",
  );
  const replacement = record(
    await owned.create("secrets", {
      name: `egress-upgrade-${runId}`,
      value: credentials.initial,
    }),
  );
  const replacementId = replacement.id;
  assertSecretReference(replacement);
  assert.equal(replacement.ref.id, replacementId, "reference must identify the created Secret");
  assert.equal(replacement.ref.namespaceId, namespace.id, "reference must select this Namespace");
  const created = record(
    await owned.create(
      "credential-sources",
      protectedSourceBody(
        `egress-unbound-${runId}`,
        deployment.secret.ref,
        controller.providerOrigin,
      ),
    ),
  );
  const unboundId = created.id;
  assert.ok(Check(CredentialSourceId, unboundId), "upgrade requires a valid created source ID");
  const unbound = record(
    await api("PATCH", `${namespacePath}/credential-sources/${unboundId}`, {
      adoption: "live",
      authorityScope: "execution",
    }),
  );
  assert.equal(unbound.id, unboundId, "adoption must identify the created source");
  assert.equal(unbound.state, "ready");
  assert.deepEqual(unbound.egress, { adoption: "live", retention: "none" });
  // Do not stop a Worker with an in-flight operation or manufacture an unfinished
  // deployment. Completed work is retained; withdrawal later exercises B's Worker.
  await waitFor(
    "settled baseline controller work",
    async () => {
      const pending = await pool.query(
        "SELECT count(*)::int AS pending FROM occ.controller_work WHERE namespace_id = $1 AND state IN ('queued', 'claimed')",
        [namespace.id],
      );
      return pending.rows[0]?.pending === 0 ? true : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  const initialSetup = {
    ...setup,
    input: { ...input, images: { ...input.images, controller: input.controllerUpgrade.fromImage } },
  };
  const controllers = await observeControllerIdentities(
    setup,
    await selectLiveControllerPods(initialSetup),
    input.controllerUpgrade.fromImage,
  );
  const suppliers = supplierIdentities(stack.supplierPods);
  const gateways = supplierIdentities(installed.gatewayPods);
  const state = await retainedState(stack, deployment);
  assert.equal(state.revisions?.length, 1);
  assert.equal(state.revisions?.[0]?.id, deployment.revision.id);
  assert.equal(state.installations?.length, 1);
  const deploymentWork = (state.work ?? []).filter(
    (work) => work.idempotency_key === `agent_revision:${deployment.revision.id}:reconcile`,
  );
  assert.equal(deploymentWork.length, 1, "retain the original deployment work row");
  const work = deploymentWork[0];
  assert.ok(work);
  assert.equal(work.agent_id, deployment.agent.id);
  assert.equal(work.revision_id, deployment.revision.id);
  assert.equal(work.agent_target, null);
  assert.equal(work.state, "succeeded");
  assert.ok(isChoice(["REVISION_ACTIVATED", "REVISION_ALREADY_ACTIVE"], work.reason_code));
  const grants = await api("GET", `${namespacePath}/iam/access-bindings`);
  // Start the quiet window before readiness lets the operator begin replacement.
  const providerBaseline = {
    httpRequests: owned.provider.observations.length,
    tcpConnections: owned.provider.tcpConnections,
  };
  await checkpoint(
    "controller-upgrade-ready",
    {
      componentCount: controllers.length,
      timeoutMs: input.controllerUpgrade.timeoutMs,
      providerBaseline,
    },
    {
      fromCommit: input.controllerUpgrade.fromCommit,
      toCommit: input.oceCommit,
      fromImage: input.controllerUpgrade.fromImage,
      toImage: input.images.controller,
      controllers,
      retainedStateSha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    },
  );
  return {
    replacement,
    unbound: { ...unbound, id: unboundId },
    controllers,
    suppliers,
    gateways,
    state,
    grants,
    providerBaseline,
  };
}

export async function observeControllerUpgrade(
  setup: UpgradeSetup & {
    f: { resource(kind: string, name: string, namespace: string): Promise<unknown> };
  },
  stack: UpgradeStack & { placement: string; controllerPods?: readonly unknown[] },
  evidence: RetirementEvidence,
  owned: { provider: ProviderCounters },
  deployment: UpgradeDeployment,
  retained: Awaited<ReturnType<typeof prepareControllerUpgrade>>,
) {
  const { input, f } = setup;
  const { api, checkpoint } = evidence;
  const { namespacePath } = stack;
  const beforeIngress = retained.providerBaseline.httpRequests;
  const beforeConnections = retained.providerBaseline.tcpConnections;
  const deadline = Date.now() + input.controllerUpgrade.timeoutMs;
  const withinDeadline = () =>
    assert.ok(Date.now() < deadline, "controller upgrade checkpoint expired");
  // This is an operator checkpoint, not an arbitrary shell hook. Only Kubernetes
  // observations run while the operator replaces both application components.
  // Old and new processes may overlap during rollout; no model/API test call does.
  const pods = await waitFor(
    "both replacement controller components",
    async () => {
      withinDeadline();
      const result = readPodItems(
        await f.kubectl(
          `--request-timeout=${Math.max(1, deadline - Date.now())}ms`,
          "get",
          "pods",
          "--namespace",
          input.controllerNamespace,
          "--selector",
          input.controllerSelector,
          "-o",
          "json",
        ),
      );
      withinDeadline();
      if (
        result.length !== 2 ||
        result.some(
          (pod) =>
            record(pod.metadata).deletionTimestamp ||
            retained.controllers.some(({ uid }) => uid === record(pod.metadata).uid) ||
            !entries(record(pod.status).conditions).some(
              ({ type, status }) => type === "Ready" && status === "True",
            ),
        )
      ) {
        return undefined;
      }
      if (
        controllerComponents.some(
          (component) =>
            result.filter(
              (pod) =>
                record(record(pod.metadata).labels)["app.kubernetes.io/component"] === component &&
                controllerContainers(pod).some(
                  ({ name, image }) => name === component && image === input.images.controller,
                ),
            ).length !== 1,
        )
      ) {
        return undefined;
      }
      return result;
    },
    { timeoutMs: input.controllerUpgrade.timeoutMs, intervalMs: 1000 },
  );
  const controllers = await observeControllerIdentities(setup, pods, input.images.controller);
  for (const current of controllers) {
    const prior = retained.controllers.find(({ component }) => component === current.component);
    assert.ok(prior);
    assert.notEqual(current.containerID, prior.containerID);
    assert.equal(
      current.installationSha256,
      prior.installationSha256,
      "keep the actual mounted Installation contents unchanged",
    );
    assert.equal(
      current.configurationSha256,
      prior.configurationSha256,
      "keep the controller's installation inputs unchanged",
    );
  }
  await selectLiveControllerPods(setup);
  for (const prior of retained.controllers) {
    const raw = await f.kubectl(
      "get",
      "pod",
      prior.name,
      "--namespace",
      input.controllerNamespace,
      "--ignore-not-found",
      "-o",
      "json",
    );
    const uid = raw.trim() ? readString(record(record(parseJson(raw)).metadata).uid) : undefined;
    assert.ok(
      uid !== prior.uid,
      "the original controller Pod must be gone, not merely absent from the selector",
    );
  }
  const suppliers = readPodItems(
    await f.kubectl(
      "get",
      "pods",
      "--namespace",
      input.openShellGatewayNamespace,
      "--selector",
      input.openShellGatewaySelector,
      "-o",
      "json",
    ),
  );
  assert.deepEqual(
    supplierIdentities(suppliers),
    retained.suppliers,
    "retain the supplier processes",
  );
  const gateways = await Promise.all(
    retained.gateways.map(({ name }) => f.resource("pod", name, stack.placement)),
  );
  assert.deepEqual(
    supplierIdentities(gateways),
    retained.gateways,
    "retain the Agent Gateway processes as well as its Harness",
  );
  assert.equal(record(await api("GET", "/installation")).id, stack.installation.id);
  assert.deepEqual(await api("GET", `${namespacePath}/iam/access-bindings`), retained.grants);
  assert.deepEqual(
    await retainedState(stack, deployment),
    retained.state,
    "retain the original source, revision, installation and settled work",
  );
  assert.equal(
    owned.provider.observations.length,
    beforeIngress,
    "controller replacement must not send provider traffic",
  );
  assert.equal(
    owned.provider.tcpConnections,
    beforeConnections,
    "controller replacement must not open provider connections",
  );
  withinDeadline();
  await checkpoint(
    "controller-upgrade-observed",
    { componentCount: controllers.length, retainedStateUnchanged: true, providerSends: 0 },
    { controllers },
  );

  await verifyRetirementRefusals(setup, stack, evidence, owned.provider, deployment, retained);
  stack.controllerPods = pods;
}
