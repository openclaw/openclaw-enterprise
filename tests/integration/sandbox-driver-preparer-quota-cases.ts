import assert from "node:assert/strict";
import test from "node:test";
import { SandboxPodQuotaExceededError } from "../../packages/occ/src/index.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import type { createOrphanedNativePreparation } from "./sandbox-driver-preparation-cases.ts";
import type { KubernetesObject } from "./sandbox-driver-startup-orchestration.ts";

type OrphanedNativePreparation = ReturnType<typeof createOrphanedNativePreparation>;

const QUOTA = "namespace-pods";

function quotaRefusal(workload: string, used: number, limited: number): string {
  return `pods "${workload}-5d8f7c9b4-x2k9q" is forbidden: exceeded quota: ${QUOTA}, requested: pods=1, used: pods=${used}, limited: pods=${limited}`;
}

function failedCreate(message: string) {
  return { type: "ReplicaFailure", status: "True", reason: "FailedCreate", message };
}

// Stage the production Driver over a preparation Deployment whose Pod the Deployment
// controller could not create. The next Deployment poll after the first decision throws
// `stop`, which proves the loop kept waiting without spending the 120 s deadline.
async function stalledPreparation(
  orphanedNativePreparation: OrphanedNativePreparation,
  {
    conditions,
    quota,
    stop,
  }: {
    conditions: readonly Record<string, unknown>[];
    quota?: { readonly status: unknown };
    stop?: Error;
  },
) {
  const { driver, gateway, api, deployment, context, requirements } =
    await orphanedNativePreparation();
  let prepared = {
    ...structuredClone(deployment),
    status: { availableReplicas: 0, observedGeneration: 1, conditions: [...conditions] },
  };
  const remove = api.delete;
  const read = api.read;
  let present = true;
  let deploymentReads = 0;
  let deletions = 0;
  let pendingStop = stop;
  let currentQuota = quota;
  let sandboxCreates = 0;
  const quotaReads: string[] = [];
  gateway.createSandbox = async (request) => {
    sandboxCreates++;
    return storedSandbox(request, { serviceUrls: {} });
  };
  let admitted = false;
  // After `admitPod`, the same revision's preparation Deployment is created again and its
  // Pod starts: the next read finds it available with no refusal.
  api.create = async () => {
    assert.ok(admitted, "the existing preparation Deployment must be adopted");
    prepared = {
      ...prepared,
      status: { availableReplicas: 1, observedGeneration: 1, conditions: [] },
    };
    present = true;
    return structuredClone(prepared);
  };
  api.delete = async (...args) => {
    deletions++;
    await remove(...args);
    present = false;
  };
  api.read = async (target) => {
    if (target.kind === "Deployment") {
      if (!present) {
        throw { code: 404 };
      }
      if (++deploymentReads > 1 && pendingStop !== undefined) {
        const failure = pendingStop;
        pendingStop = undefined;
        throw failure;
      }
      return structuredClone(prepared);
    }
    if (target.kind !== "ResourceQuota") {
      return read(target);
    }
    const name = target.metadata?.name;
    assert.equal(typeof name, "string");
    quotaReads.push(name);
    assert.equal(target.metadata?.namespace, context.namespace.name);
    assert.ok(currentQuota !== undefined);
    return structuredClone(currentQuota) as unknown as KubernetesObject;
  };
  return {
    driver,
    gateway,
    context,
    requirements,
    quotaReads,
    admitPod(nextQuota: { readonly status: unknown }) {
      currentQuota = nextQuota;
      admitted = true;
    },
    deletions: () => deletions,
    deploymentReads: () => deploymentReads,
    sandboxCreates: () => sandboxCreates,
  };
}

export function registerSandboxDriverPreparerQuotaCases(
  orphanedNativePreparation: OrphanedNativePreparation,
): void {
  test("OpenShell stops waiting for a preparation Pod a full Namespace Pod quota refuses", async () => {
    const staged = await stalledPreparation(orphanedNativePreparation, {
      conditions: [failedCreate(quotaRefusal("agent", 3, 3))],
      quota: { status: { hard: { pods: "3" }, used: { pods: "3" } } },
    });
    await assert.rejects(
      staged.driver.provisionHarness({ ...staged.context, requirements: staged.requirements }),
      SandboxPodQuotaExceededError,
    );
    // The adoption read saw the refusal and the full quota, so the wait stopped without a
    // second poll; the other read is the cleanup's ownership check before its delete.
    assert.equal(staged.deploymentReads(), 2);
    assert.deepEqual(staged.quotaReads, [QUOTA]);
    assert.equal(staged.deletions(), 1, "the preparation Deployment must be cleaned up");
    assert.equal(staged.gateway.providers.size, 1);
    assert.equal(staged.sandboxCreates(), 0, "no Sandbox is created after a refused preparation");

    // A Pod is freed. The worker's next pass prepares again with no user action: a new
    // preparation Deployment gets its Pod, is removed, and the Sandbox is created over the
    // provider the refused pass registered.
    staged.admitPod({ status: { hard: { pods: "3" }, used: { pods: "2" } } });
    const sandbox = await staged.driver.provisionHarness({
      ...staged.context,
      requirements: staged.requirements,
    });
    assert.equal(sandbox.revisionId, staged.context.revision.id);
    assert.equal(staged.sandboxCreates(), 1);
    assert.equal(staged.deletions(), 2);
    assert.equal(staged.gateway.providers.size, 1);
    assert.deepEqual(staged.quotaReads, [QUOTA]);
  });

  test("OpenShell keeps waiting on a FailedCreate that does not name a Pod quota", async () => {
    const stop = new Error("still polling");
    const staged = await stalledPreparation(orphanedNativePreparation, {
      conditions: [
        failedCreate('pods "agent-5d8f7c9b4-x2k9q" is forbidden: admission webhook denied it'),
      ],
      stop,
    });
    await assert.rejects(
      staged.driver.provisionHarness({ ...staged.context, requirements: staged.requirements }),
      (error) => error === stop,
    );
    // A second poll, then the cleanup's ownership read: the loop kept waiting.
    assert.equal(staged.deploymentReads(), 3);
    assert.deepEqual(staged.quotaReads, []);
    assert.equal(staged.deletions(), 1);
  });

  test("OpenShell keeps waiting when the named Pod quota is no longer full", async () => {
    const stop = new Error("still polling");
    const staged = await stalledPreparation(orphanedNativePreparation, {
      conditions: [failedCreate(quotaRefusal("agent", 2, 5))],
      quota: { status: { hard: { pods: "5" }, used: { pods: "2" } } },
      stop,
    });
    await assert.rejects(
      staged.driver.provisionHarness({ ...staged.context, requirements: staged.requirements }),
      (error) => error === stop,
    );
    assert.equal(staged.deploymentReads(), 3, "the loop kept waiting");
    assert.deepEqual(staged.quotaReads, [QUOTA]);
    assert.equal(staged.deletions(), 1);
  });
}
