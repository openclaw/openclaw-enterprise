import type { KubernetesObjectApi, V1ConfigMap } from "@kubernetes/client-node";
import type { SandboxNamespaceContext } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  SandboxRevisionUnsupportedError,
} from "@openclaw-enterprise/occ";
import { numericErrorStatus } from "@openclaw-enterprise/utils";

const OWNER = "openclaw.dev/opensandbox-driver";
const NAMESPACE = "openclaw.dev/namespace";
export const BINDING = "openclaw.dev/opensandbox-binding";

type Labels = Readonly<Record<string, string>>;
type Binding = {
  uid: string;
  resourceVersion: string;
  batchUid: string | undefined;
  podUid: string | undefined;
  specHash: string | undefined;
};

function conflict(): never {
  throw new SandboxRevisionUnsupportedError(
    "SANDBOX_WORKLOAD_IMMUTABLE",
    "OpenSandbox could not verify the original Harness allocation.",
  );
}

function client(context: SandboxNamespaceContext) {
  context.signal.throwIfAborted();
  return context.kubernetes as KubernetesObjectApi;
}

function ref(context: SandboxNamespaceContext, name: string) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { namespace: context.namespace.name, name },
  };
}

function verify(
  context: SandboxNamespaceContext,
  name: string,
  labels: Labels,
  record: V1ConfigMap,
): Binding {
  const meta = record.metadata;
  const data = record.data;
  if (
    record.apiVersion !== "v1" ||
    record.kind !== "ConfigMap" ||
    !meta?.uid ||
    !meta.resourceVersion ||
    meta.deletionTimestamp ||
    meta.name !== name ||
    meta.namespace !== context.namespace.name ||
    (meta.ownerReferences?.length ?? 0) !== 0 ||
    meta.labels?.[OWNER] !== labels[OWNER] ||
    meta.labels?.[NAMESPACE] !== context.namespace.id ||
    !data?.agentId ||
    data.agentId !== labels["openclaw.dev/agent"] ||
    !data.revisionId ||
    data.revisionId !== labels["openclaw.dev/revision"] ||
    (data.batchUid !== undefined && !data.batchUid) ||
    (data.podUid !== undefined && (!data.batchUid || !data.podUid)) ||
    (data.podUid !== undefined && !/^[a-f0-9]{64}$/u.test(data.specHash ?? "")) ||
    Boolean(data.podUid) !== Boolean(record.immutable)
  ) {
    conflict();
  }
  return {
    uid: meta.uid,
    resourceVersion: meta.resourceVersion,
    batchUid: data.batchUid,
    podUid: data.podUid,
    specHash: data.specHash,
  };
}

export async function readBinding(context: SandboxNamespaceContext, name: string, labels: Labels) {
  try {
    const record = await client(context).read<V1ConfigMap>(ref(context, name));
    context.signal.throwIfAborted();
    return verify(context, name, labels, record);
  } catch (error) {
    context.signal.throwIfAborted();
    if (numericErrorStatus(error) !== 404) {
      throw error;
    }
    return undefined;
  }
}

// Reserve the revision name before creating the BatchSandbox. Its annotation
// must identify this exact reservation, including after a lost create reply.
export async function reserve(context: SandboxNamespaceContext, name: string, labels: Labels) {
  const identity = ref(context, name);
  try {
    const record = await client(context).create<V1ConfigMap>({
      ...identity,
      metadata: {
        ...identity.metadata,
        labels: { [OWNER]: labels[OWNER]!, [NAMESPACE]: context.namespace.id },
      },
      data: {
        agentId: labels["openclaw.dev/agent"]!,
        revisionId: labels["openclaw.dev/revision"]!,
      },
    });
    context.signal.throwIfAborted();
    return verify(context, name, labels, record);
  } catch (error) {
    const existing = await readBinding(context, name, labels);
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

// Each conditional update advances the same reservation. Freeze the data as
// soon as the operator has assigned a Pod. Never retarget a running revision.
export async function pin(
  context: SandboxNamespaceContext,
  name: string,
  labels: Labels,
  binding: Binding,
  batchUid: string,
  pod?: { uid: string; specHash: string },
) {
  const podUid = pod?.uid;
  if (
    !batchUid ||
    (binding.batchUid !== undefined && binding.batchUid !== batchUid) ||
    (pod !== undefined &&
      binding.podUid !== undefined &&
      (binding.podUid !== pod.uid || binding.specHash !== pod.specHash))
  ) {
    conflict();
  }
  if (binding.batchUid === batchUid && (podUid === undefined || binding.podUid === podUid)) {
    return binding;
  }
  const identity = ref(context, name);
  const matches = (observed: Binding | undefined) =>
    observed?.uid === binding.uid &&
    observed.batchUid === batchUid &&
    (pod === undefined || (observed.podUid === pod.uid && observed.specHash === pod.specHash));
  let observed: Binding | undefined;
  try {
    const result = await client(context).patch<V1ConfigMap>({
      ...identity,
      metadata: {
        ...identity.metadata,
        uid: binding.uid,
        resourceVersion: binding.resourceVersion,
      },
      data: { batchUid, ...(pod === undefined ? {} : { podUid: pod.uid, specHash: pod.specHash }) },
      ...(podUid === undefined ? {} : { immutable: true }),
    });
    context.signal.throwIfAborted();
    observed = verify(context, name, labels, result);
  } catch (error) {
    observed = await readBinding(context, name, labels);
    if (!matches(observed)) {
      throw error;
    }
  }
  if (!observed || !matches(observed)) {
    conflict();
  }
  return observed;
}

export async function forget(
  context: SandboxNamespaceContext,
  name: string,
  labels: Labels,
  binding: Binding,
) {
  try {
    await client(context).delete(
      ref(context, name),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        preconditions: { uid: binding.uid, resourceVersion: binding.resourceVersion },
      },
    );
  } catch (error) {
    if (await readBinding(context, name, labels)) {
      throw error;
    }
    return;
  }
  if (await readBinding(context, name, labels)) {
    throw new DependencyUnavailableError(
      "OpenSandbox could not confirm removal of the Harness allocation record.",
    );
  }
}
