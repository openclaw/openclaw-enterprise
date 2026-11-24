import { isIPv4 } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type {
  KubernetesObjectApi,
  V1NetworkPolicy,
  V1ObjectMeta,
  V1Pod,
  V1PodTemplateSpec,
} from "@kubernetes/client-node";
import type {
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  SandboxRevisionUnsupportedError,
} from "@openclaw-enterprise/occ";
import { asRecord, numericErrorStatus } from "@openclaw-enterprise/utils";

type Batch = {
  apiVersion: string;
  kind: "BatchSandbox";
  metadata: V1ObjectMeta & { name: string; labels: Record<string, string> };
  spec: { template: V1PodTemplateSpec };
};
type Context = SandboxNamespaceContext & Pick<SandboxHarnessContext, "revision">;
const VERSION = "networking.k8s.io/v1";
const KIND = "NetworkPolicy";
const POD_UID = "openclaw.dev/opensandbox-pod";

function conflict(): never {
  throw new SandboxRevisionUnsupportedError(
    "SANDBOX_WORKLOAD_IMMUTABLE",
    "OpenSandbox refused a conflicting Pod or egress policy.",
  );
}

function parse(text: string) {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    conflict();
  }
}

function endpoint(manifest: unknown) {
  if (typeof manifest === "string") {
    const input = asRecord(parse(manifest)?.modelEndpoint);
    if (input?.modelProvider === "openai-compatible" && typeof input.baseUrl === "string") {
      const match = /^https:\/\/([\d.]+)(?::([1-9]\d{0,4}))?\/v1$/u.exec(input.baseUrl);
      const address = match?.[1];
      const port = Number(match?.[2] ?? 443);
      if (
        address &&
        isIPv4(address) &&
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/u.test(address) &&
        port <= 65535
      ) {
        return { cidr: address + "/32", port };
      }
    }
  }
  throw new SandboxRevisionUnsupportedError(
    "SANDBOX_WORKLOAD_IMMUTABLE",
    "OpenSandbox requires a private IPv4 HTTPS model endpoint with path /v1.",
  );
}

export function modelEgress(context: SandboxHarnessContext) {
  if (POD_UID in context.requirements.labels) {
    conflict();
  }
  return endpoint(context.requirements.files.find((file) => file.name === "runtime.json")?.content);
}

function client(context: SandboxNamespaceContext) {
  context.signal.throwIfAborted();
  return context.kubernetes as KubernetesObjectApi;
}

function ref(context: SandboxNamespaceContext, name: string) {
  return { apiVersion: VERSION, kind: KIND, metadata: { namespace: context.namespace.name, name } };
}

async function read(context: SandboxNamespaceContext, name: string) {
  try {
    const policy = await client(context).read<V1NetworkPolicy>(ref(context, name));
    context.signal.throwIfAborted();
    return policy;
  } catch (error) {
    context.signal.throwIfAborted();
    if (numericErrorStatus(error) !== 404) {
      throw error;
    }
    return undefined;
  }
}

function owner(batch: Batch) {
  const { name, uid } = batch.metadata;
  if (!uid) {
    conflict();
  }
  return { apiVersion: batch.apiVersion, kind: batch.kind, name, uid, controller: true };
}

function owned(context: SandboxNamespaceContext, batch: Batch, policy: V1NetworkPolicy) {
  const meta = policy.metadata;
  const expected = owner(batch);
  const controller = meta?.ownerReferences?.[0];
  if (
    policy.apiVersion !== VERSION ||
    policy.kind !== KIND ||
    !meta?.uid ||
    !meta.resourceVersion ||
    meta.namespace !== context.namespace.name ||
    meta.name !== expected.name ||
    meta.ownerReferences?.length !== 1 ||
    !controller?.controller ||
    controller.apiVersion !== expected.apiVersion ||
    controller.kind !== expected.kind ||
    controller.name !== expected.name ||
    controller.uid !== expected.uid ||
    !isDeepStrictEqual(meta.labels, batch.metadata.labels)
  ) {
    conflict();
  }
  return { uid: meta.uid, resourceVersion: meta.resourceVersion };
}

function grant(
  context: Context,
  batch: Batch,
  pod: V1Pod,
  admitted?: ReturnType<typeof modelEgress>,
) {
  const { name, labels } = batch.metadata;
  const required = {
    ...labels,
    "openclaw.dev/service-principal": context.revision.servicePrincipalId,
    "openclaw.dev/network-profile": "provider-fenced-v1",
  };
  const meta = pod.metadata;
  const uid = meta?.uid;
  const pin = meta?.labels?.[POD_UID];
  if (
    !uid ||
    !meta.resourceVersion ||
    meta.deletionTimestamp ||
    batch.metadata.deletionTimestamp ||
    Object.entries(required).some(([key, value]) => meta.labels?.[key] !== value) ||
    (pin !== undefined && pin !== uid)
  ) {
    conflict();
  }
  // Readiness has no runtime files. Recover them from the immutable template
  // that provisionHarness compared with Compute's complete admitted inputs.
  const prepare = batch.spec.template.spec?.initContainers?.find(
    (c) => c.name === "prepare-workspace",
  );
  const inputs = parse(prepare?.args?.[1] ?? "null");
  const target = endpoint(asRecord(inputs?.files)?.["runtime.json"]);
  if (admitted && !isDeepStrictEqual(admitted, target)) {
    conflict();
  }
  const policy: V1NetworkPolicy = {
    ...ref(context, name),
    metadata: { name, namespace: context.namespace.name, labels, ownerReferences: [owner(batch)] },
    spec: {
      podSelector: { matchLabels: { ...required, [POD_UID]: uid } },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [{ ipBlock: { cidr: target.cidr } }],
          ports: [{ protocol: "TCP", port: target.port }],
        },
        // The workspace node resolves its Gateway. The sender uses an IP literal.
        ...(inputs?.enrollNode === true
          ? [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                    },
                    podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
                  },
                ],
                ports: [
                  { protocol: "UDP", port: 53 },
                  { protocol: "TCP", port: 53 },
                ],
              },
            ]
          : []),
      ],
    },
  };
  return { policy, pin, uid, resourceVersion: meta.resourceVersion };
}

function verify(
  context: Context,
  batch: Batch,
  current: V1NetworkPolicy | undefined,
  desired: V1NetworkPolicy,
) {
  if (!current) {
    throw new DependencyUnavailableError(
      "OpenSandbox could not confirm the Harness egress policy.",
    );
  }
  owned(context, batch, current);
  // The Kubernetes SDK materializes built-in resource specs as classes.
  if (
    current.metadata?.deletionTimestamp ||
    !isDeepStrictEqual(structuredClone(current.spec), desired.spec)
  ) {
    conflict();
  }
}

export async function ensureEgress(context: SandboxHarnessContext, batch: Batch, pod: V1Pod) {
  const { policy, pin, uid, resourceVersion } = grant(context, batch, pod, modelEgress(context));
  const name = batch.metadata.name;
  let current = await read(context, name);
  if (!current && !context.existingHarnessOnly) {
    try {
      current = await client(context).create(policy);
      context.signal.throwIfAborted();
    } catch (error) {
      current = await read(context, name);
      if (!current) {
        throw error;
      }
    }
  }
  verify(context, batch, current, policy);
  if (!pin) {
    if (context.existingHarnessOnly) {
      conflict();
    }
    // OpenSandbox may recreate a child under the same name. Grant access
    // only after the conditional patch binds this selector to the observed UID.
    const patched = await client(context).patch<V1Pod>({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        namespace: context.namespace.name,
        name: name + "-0",
        uid,
        resourceVersion,
        labels: { [POD_UID]: uid },
      },
    });
    context.signal.throwIfAborted();
    if (patched.metadata?.uid !== uid || patched.metadata.labels?.[POD_UID] !== uid) {
      conflict();
    }
  }
}

export async function checkEgress(
  context: Context,
  batch: Batch,
  pod: V1Pod,
  admitted?: ReturnType<typeof modelEgress>,
) {
  const { policy, pin } = grant(context, batch, pod, admitted);
  if (!pin) {
    conflict();
  }
  verify(context, batch, await read(context, batch.metadata.name), policy);
}

export async function requireNoEgress(context: SandboxNamespaceContext, name: string) {
  if (await read(context, name)) {
    throw new DependencyUnavailableError(
      "OpenSandbox could not confirm removal of the Harness egress policy.",
    );
  }
}

export async function removeEgress(context: SandboxNamespaceContext, batch: Batch) {
  const name = batch.metadata.name;
  const current = await read(context, name);
  if (!current) {
    return;
  }
  const preconditions = owned(context, batch, current);
  if (!current.metadata?.deletionTimestamp) {
    try {
      await client(context).delete(
        ref(context, name),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { preconditions },
      );
    } catch (error) {
      // A lost reply can hide a successful delete. Never replay against a
      // same-name replacement or delete the batch while a grant still exists.
      if (await read(context, name)) {
        throw error;
      }
      return;
    }
  }
  await requireNoEgress(context, name);
}

export async function requireNoNamespaceEgress(context: SandboxNamespaceContext, selector: string) {
  const list = await client(context).list<V1NetworkPolicy>(
    VERSION,
    KIND,
    context.namespace.name,
    undefined,
    undefined,
    undefined,
    undefined,
    selector,
  );
  context.signal.throwIfAborted();
  if (
    !Array.isArray(list.items) ||
    list.items.length > 0 ||
    list.metadata?._continue ||
    asRecord(list.metadata)?.continue ||
    (list.metadata?.remainingItemCount ?? 0) !== 0
  ) {
    throw new DependencyUnavailableError(
      "OpenSandbox could not confirm removal of all Harness egress policies.",
    );
  }
}
