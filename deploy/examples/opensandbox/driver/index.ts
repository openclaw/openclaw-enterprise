import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  KubernetesObjectApi,
  V1ConfigMap,
  V1ObjectMeta,
  V1Pod,
  V1PodTemplateSpec,
} from "@kubernetes/client-node";
import type {
  AgentRevision,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  SandboxRevisionUnsupportedError,
} from "@openclaw-enterprise/occ";
import { asRecord, numericErrorStatus } from "@openclaw-enterprise/utils";
import { BINDING, forget, pin, readBinding, reserve } from "./binding.ts";
import {
  modelEgress,
  ensureEgress,
  checkEgress,
  removeEgress,
  requireNoEgress,
  requireNoNamespaceEgress,
} from "./network.ts";
import { harnessTemplate, validateConfiguration, type DriverConfiguration } from "./workload.ts";

export { configurationSchema, validateConfiguration } from "./workload.ts";

const API_VERSION = "sandbox.opensandbox.io/v1alpha1";
const OWNER = "openclaw.dev/opensandbox-driver";
const NAMESPACE = "openclaw.dev/namespace";
const AGENT = "openclaw.dev/agent";
const REVISION = "openclaw.dev/revision";
const ROLE = "openclaw.dev/workload-role";

interface BatchSandbox {
  apiVersion: typeof API_VERSION;
  kind: "BatchSandbox";
  metadata: V1ObjectMeta & { name: string; namespace: string; labels: Record<string, string> };
  spec: { replicas: 1; template: V1PodTemplateSpec; taskResourcePolicyWhenCompleted: "Retain" };
}

type ObjectApi = Pick<KubernetesObjectApi, "read" | "list" | "create" | "delete">;
type RevisionContext = SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> };

function api(context: SandboxNamespaceContext): ObjectApi {
  context.signal.throwIfAborted();
  const client = asRecord(context.kubernetes);
  if (
    !client ||
    typeof client.read !== "function" ||
    typeof client.list !== "function" ||
    typeof client.create !== "function" ||
    typeof client.patch !== "function" ||
    typeof client.delete !== "function"
  ) {
    throw new DependencyUnavailableError(
      "OpenSandbox requires the Kubernetes object client supplied by Compute.",
    );
  }
  return client as ObjectApi;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

// Hash the representation returned by the same Kubernetes API on create and read.
function specHash(batch: BatchSandbox) {
  return createHash("sha256").update(JSON.stringify(batch.spec)).digest("hex");
}

function resourceName(namespaceId: string, agentId: string, revisionId: string) {
  return `opensandbox-${digest(JSON.stringify([namespaceId, agentId, revisionId]))}`;
}

function batchRef(namespace: string, name: string) {
  return { apiVersion: API_VERSION, kind: "BatchSandbox", metadata: { namespace, name } } as const;
}

function immutableFailure(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_WORKLOAD_IMMUTABLE", message);
}

async function read<T extends BatchSandbox | V1Pod>(
  context: SandboxNamespaceContext,
  ref: { apiVersion: string; kind: string; metadata: { name: string; namespace: string } },
): Promise<T | undefined> {
  const client = api(context);
  try {
    const result = await client.read<T>(ref);
    context.signal.throwIfAborted();
    return result;
  } catch (error) {
    context.signal.throwIfAborted();
    if (numericErrorStatus(error) !== 404) {
      throw error;
    }
    return undefined;
  }
}

class OpenSandboxDriver implements SandboxDriver {
  readonly capability = "sandbox";
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  readonly supportsHarnessExecutionMode = Object.freeze({
    openclaw: Object.freeze({
      embedded: Object.freeze({ supported: false }),
      dedicated: Object.freeze({ supported: false }),
    }),
  });

  readonly id: string;
  readonly implementation: string;
  private readonly marker: string;
  private readonly configuration: Readonly<DriverConfiguration>;

  constructor(id: string, implementation: string, configuration: Readonly<DriverConfiguration>) {
    this.id = id;
    this.implementation = implementation;
    this.marker = digest(id);
    this.configuration = Object.freeze({ ...configuration });
  }

  private labels(context: RevisionContext): Record<string, string> {
    const { namespace, revision } = context;
    if (revision.namespaceId !== namespace.id || revision.sandboxDriverId !== this.id) {
      immutableFailure("OpenSandbox revision ownership does not match the selected Driver.");
    }
    return {
      [OWNER]: this.marker,
      [NAMESPACE]: namespace.id,
      [AGENT]: revision.agentId,
      [REVISION]: revision.id,
      [ROLE]: "agent",
    };
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    const expected = this.labels(context);
    const admitted = context.requirements.labels;
    if (
      Object.entries(expected).some(([key, value]) => key !== OWNER && admitted[key] !== value) ||
      admitted["openclaw.dev/service-principal"] !== context.revision.servicePrincipalId ||
      admitted["openclaw.dev/network-profile"] !== "provider-fenced-v1" ||
      Object.hasOwn(admitted, OWNER)
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_POD_LABELS_NOT_PERMITTED",
        "OpenSandbox requires Compute's exact Agent, revision and network profile labels.",
      );
    }
    const { namespace, revision } = context;
    const name = resourceName(namespace.id, revision.agentId, revision.id);
    const ref = batchRef(namespace.name, name);
    modelEgress(context);
    const template = harnessTemplate(context, { ...admitted, ...expected }, this.configuration);
    let binding = await readBinding(context, name, expected);
    if (!binding) {
      if (
        context.existingHarnessOnly ||
        (await read<BatchSandbox>(context, ref)) ||
        (await this.readPod(context, name))
      ) {
        immutableFailure(
          "OpenSandbox refused a missing allocation record or an occupied workload name.",
        );
      }
      await requireNoEgress(context, name);
      binding = await reserve(context, name, expected);
    }
    const desired: BatchSandbox = {
      ...ref,
      metadata: { ...ref.metadata, labels: expected, annotations: { [BINDING]: binding.uid } },
      spec: {
        replicas: 1,
        template,
        taskResourcePolicyWhenCompleted: "Retain",
      },
    };

    let current = await read<BatchSandbox>(context, ref);
    if (current === undefined) {
      // The controller uses a deterministic child name. An orphan or foreign Pod
      // occupying it may still have the workspace mounted.
      if (await this.readPod(context, name)) {
        immutableFailure(
          "OpenSandbox cannot create a workload while the child Pod name is occupied.",
        );
      }
      if (context.existingHarnessOnly || binding.batchUid !== undefined) {
        throw new DependencyUnavailableError(
          "OpenSandbox cannot recreate a missing Harness during maintenance.",
        );
      }
      try {
        current = await api(context).create(desired);
      } catch (error) {
        // Read back an unknown create or conflict. The API's unique name fences
        // concurrent attempts, and adoption checks the full immutable template.
        current = await read<BatchSandbox>(context, ref);
        if (current === undefined) {
          throw error;
        }
      }
    }
    if (current === undefined) {
      throw new DependencyUnavailableError(
        "OpenSandbox could not confirm the BatchSandbox create.",
      );
    }
    const batchUid = this.verifyBatch(context, current, expected);
    if (
      current.metadata.annotations?.[BINDING] !== binding.uid ||
      current.metadata.deletionTimestamp ||
      !isDeepStrictEqual(current.spec, desired.spec)
    ) {
      immutableFailure(
        "OpenSandbox refused an existing BatchSandbox with different or deleting inputs.",
      );
    }
    if (context.existingHarnessOnly && (!binding.batchUid || !binding.podUid)) {
      immutableFailure("OpenSandbox maintenance requires the original Harness identity.");
    }
    binding = await pin(context, name, expected, binding, batchUid);
    const deadline = Date.now() + 35_000;
    let pod = await this.ownedPod(context, current);
    while (!pod && !context.existingHarnessOnly && Date.now() < deadline) {
      await delay(250, undefined, { signal: context.signal });
      pod = await this.ownedPod(context, current);
    }
    if (!pod?.metadata?.uid || pod.metadata.deletionTimestamp) {
      throw new DependencyUnavailableError("OpenSandbox could not confirm a live Harness Pod.");
    }
    await pin(context, name, expected, binding, batchUid, {
      uid: pod.metadata.uid,
      specHash: specHash(current),
    });
    await ensureEgress(context, current, pod);
    if (
      !(await this.confirmHarnessPod({
        ...context,
        podName: name + "-0",
        podUid: pod.metadata.uid,
      }))
    ) {
      throw new DependencyUnavailableError(
        "OpenSandbox could not confirm the provisioned Harness identity.",
      );
    }
    return {
      namespaceName: namespace.name,
      resourceName: name,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
  }

  async confirmHarnessPod(
    context: RevisionContext & { readonly podName: string; readonly podUid: string },
  ): Promise<boolean> {
    const labels = this.labels(context);
    const name = resourceName(context.namespace.id, context.revision.agentId, context.revision.id);
    if (context.podName !== name + "-0" || !context.podUid) {
      return false;
    }
    const binding = await readBinding(context, name, labels);
    if (!binding?.batchUid || binding.podUid !== context.podUid) {
      return false;
    }
    const batch = await read<BatchSandbox>(context, batchRef(context.namespace.name, name));
    if (
      !batch ||
      batch.metadata.deletionTimestamp ||
      this.verifyBatch(context, batch, labels) !== binding.batchUid ||
      specHash(batch) !== binding.specHash ||
      batch.metadata.annotations?.[BINDING] !== binding.uid
    ) {
      return false;
    }
    const pod = await this.ownedPod(context, batch);
    if (!pod?.metadata || pod.metadata.deletionTimestamp || pod.metadata.uid !== context.podUid) {
      return false;
    }
    await checkEgress(context, batch, pod);
    context.signal.throwIfAborted();
    return true;
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    if (context.revision !== undefined) {
      const { revision } = context;
      const labels = this.labels({ ...context, revision });
      const name = resourceName(context.namespace.id, revision.agentId, revision.id);
      await this.deleteBatch(context, name, labels);
      return;
    }

    const selector = `${OWNER}=${this.marker},${NAMESPACE}=${context.namespace.id}`;
    const batches = await api(context).list<BatchSandbox>(
      API_VERSION,
      "BatchSandbox",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    context.signal.throwIfAborted();
    if (
      !Array.isArray(batches.items) ||
      Boolean(batches.metadata?._continue) ||
      Boolean(asRecord(batches.metadata)?.continue) ||
      (batches.metadata?.remainingItemCount ?? 0) !== 0
    ) {
      throw new DependencyUnavailableError(
        "OpenSandbox namespace cleanup requires a complete BatchSandbox listing.",
      );
    }
    for (const batch of batches.items) {
      const listedUid = this.verifyBatch(context, batch, {
        [OWNER]: this.marker,
        [NAMESPACE]: context.namespace.id,
        [ROLE]: "agent",
      });
      await this.deleteBatch(context, batch.metadata.name, batch.metadata.labels, listedUid);
    }

    // A crash may leave only the reservation. Verify its listed UID before
    // cleanup, including when another worker has already removed the batch.
    const bindings = await this.listBindings(context, selector);
    for (const record of bindings) {
      const name = record.metadata?.name;
      const uid = record.metadata?.uid;
      const agent = record.data?.agentId;
      const revision = record.data?.revisionId;
      if (
        !agent ||
        !revision ||
        !uid ||
        !name ||
        name !== resourceName(context.namespace.id, agent, revision)
      ) {
        immutableFailure("OpenSandbox refused an invalid Namespace allocation record.");
      }
      await this.deleteBatch(
        context,
        name,
        {
          [OWNER]: this.marker,
          [NAMESPACE]: context.namespace.id,
          [AGENT]: agent,
          [REVISION]: revision,
          [ROLE]: "agent",
        },
        undefined,
        uid,
      );
    }
    if ((await this.listBindings(context, selector)).length) {
      throw new DependencyUnavailableError(
        "OpenSandbox allocation records remain in the Namespace.",
      );
    }
    await requireNoNamespaceEgress(context, selector);
    const pods = await api(context).list<V1Pod>(
      "v1",
      "Pod",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    context.signal.throwIfAborted();
    if (
      !Array.isArray(pods.items) ||
      pods.items.length !== 0 ||
      Boolean(pods.metadata?._continue) ||
      Boolean(asRecord(pods.metadata)?.continue) ||
      (pods.metadata?.remainingItemCount ?? 0) !== 0
    ) {
      throw new DependencyUnavailableError(
        "OpenSandbox namespace cleanup could not verify that all Harness Pods stopped.",
      );
    }
  }

  private async listBindings(context: SandboxNamespaceContext, selector: string) {
    const listed = await api(context).list<V1ConfigMap>(
      "v1",
      "ConfigMap",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    context.signal.throwIfAborted();
    if (
      !Array.isArray(listed.items) ||
      listed.metadata?._continue ||
      asRecord(listed.metadata)?.continue ||
      (listed.metadata?.remainingItemCount ?? 0) !== 0
    ) {
      throw new DependencyUnavailableError(
        "OpenSandbox requires a complete allocation record listing.",
      );
    }
    return listed.items;
  }

  private verifyBatch(
    context: SandboxNamespaceContext,
    batch: BatchSandbox,
    expected: Readonly<Record<string, string>>,
  ): string {
    const metadata = batch.metadata;
    const labels = metadata?.labels;
    const agent = labels?.[AGENT];
    const revision = labels?.[REVISION];
    if (
      batch.apiVersion !== API_VERSION ||
      batch.kind !== "BatchSandbox" ||
      metadata?.namespace !== context.namespace.name ||
      !agent ||
      !revision ||
      metadata.name !== resourceName(context.namespace.id, agent, revision) ||
      !metadata.uid ||
      (metadata.ownerReferences?.length ?? 0) !== 0 ||
      Object.entries(expected).some(([key, value]) => labels?.[key] !== value)
    ) {
      immutableFailure("OpenSandbox refused a BatchSandbox with conflicting ownership.");
    }
    return metadata.uid;
  }

  private readPod(context: SandboxNamespaceContext, name: string) {
    return read<V1Pod>(context, {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { namespace: context.namespace.name, name: `${name}-0` },
    });
  }

  private async ownedPod(
    context: SandboxNamespaceContext,
    batch: BatchSandbox,
  ): Promise<V1Pod | undefined> {
    const pod = await this.readPod(context, batch.metadata.name);
    if (
      pod !== undefined &&
      (pod.metadata?.namespace !== context.namespace.name ||
        pod.metadata.name !== `${batch.metadata.name}-0` ||
        !pod.metadata.uid ||
        pod.metadata.ownerReferences?.length !== 1 ||
        !(pod.metadata.ownerReferences ?? []).some(
          (owner) =>
            owner.controller === true &&
            owner.apiVersion === API_VERSION &&
            owner.kind === "BatchSandbox" &&
            owner.name === batch.metadata.name &&
            owner.uid === batch.metadata.uid,
        ) ||
        Object.entries(batch.metadata.labels).some(
          ([key, value]) => pod.metadata?.labels?.[key] !== value,
        ))
    ) {
      immutableFailure("OpenSandbox refused a Harness Pod with conflicting ownership.");
    }
    return pod;
  }

  private async deleteBatch(
    context: SandboxNamespaceContext,
    name: string,
    labels: Readonly<Record<string, string>>,
    listedUid?: string,
    listedBindingUid?: string,
  ): Promise<void> {
    const deadline = Date.now() + 35_000;
    const ref = batchRef(context.namespace.name, name);
    const binding = await readBinding(context, name, labels);
    if (listedBindingUid !== undefined && binding?.uid !== listedBindingUid) {
      immutableFailure(
        "OpenSandbox refused a replacement allocation record during Namespace cleanup.",
      );
    }
    const current = await read<BatchSandbox>(context, ref);
    if (!current) {
      if (await this.readPod(context, name)) {
        throw new DependencyUnavailableError(
          "OpenSandbox could not establish ownership of a remaining Harness Pod.",
        );
      }
      await requireNoEgress(context, name);
      if (binding) {
        await forget(context, name, labels, binding);
      }
      return;
    }
    const uid = this.verifyBatch(context, current, labels);
    if (listedUid !== undefined && uid !== listedUid) {
      immutableFailure("OpenSandbox refused to delete a replacement after listing the Namespace.");
    }
    if (
      !binding ||
      current.metadata.annotations?.[BINDING] !== binding.uid ||
      binding.batchUid !== uid
    ) {
      immutableFailure("OpenSandbox refused to delete a workload without its original allocation.");
    }

    const child = await this.ownedPod(context, current);
    if (child && binding.podUid !== undefined && child.metadata?.uid !== binding.podUid) {
      immutableFailure("OpenSandbox refused to delete a replacement Harness Pod.");
    }
    const resourceVersion = current.metadata.resourceVersion;
    if (!resourceVersion) {
      immutableFailure("OpenSandbox requires the observed BatchSandbox resource version.");
    }
    await removeEgress(context, current);
    let uncertainDelete: unknown;
    if (!current.metadata.deletionTimestamp) {
      try {
        // Kubernetes reads delete options from the body when it contains the UID precondition.
        await api(context).delete(ref, undefined, undefined, undefined, undefined, undefined, {
          preconditions: { uid, resourceVersion },
          propagationPolicy: "Foreground",
        });
      } catch (error) {
        context.signal.throwIfAborted();
        const status = numericErrorStatus(error);
        if (status !== undefined && status >= 400 && status < 500 && status !== 404) {
          throw error;
        }
        // A lost reply can hide an accepted deletion. Read the same UID before any retry.
        uncertainDelete = error;
      }
    }

    let observed = await read<BatchSandbox>(context, ref);
    while (observed !== undefined) {
      if (this.verifyBatch(context, observed, labels) !== uid) {
        immutableFailure(
          "OpenSandbox refused a BatchSandbox replacement while deleting its predecessor.",
        );
      }
      if (uncertainDelete !== undefined && !observed.metadata.deletionTimestamp) {
        throw uncertainDelete;
      }
      if (Date.now() >= deadline) {
        throw new DependencyUnavailableError(
          "OpenSandbox could not confirm BatchSandbox deletion.",
        );
      }
      await delay(250, undefined, { signal: context.signal });
      observed = await read<BatchSandbox>(context, ref);
    }
    if (await this.readPod(context, name)) {
      throw new DependencyUnavailableError(
        "OpenSandbox could not confirm that the Harness Pod stopped.",
      );
    }
    await requireNoEgress(context, name);
    await forget(context, name, labels, binding);
  }
}

export function createDriver(input: {
  readonly id: string;
  readonly implementation: string;
  readonly configuration: Readonly<DriverConfiguration>;
}): SandboxDriver {
  if (validateConfiguration(input.configuration).length !== 0) {
    throw new Error("The OpenSandbox configuration is invalid.");
  }
  return new OpenSandboxDriver(input.id, input.implementation, input.configuration);
}
