import { generateKeyPairSync, randomUUID } from "node:crypto";
import { networkPolicyToSdk } from "../kubernetes/network-policy.ts";
import { unsentManifestFields } from "../kubernetes/manifest-fields.ts";
import { KubernetesObjectApi, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import type {
  KubernetesNamespacedResource,
  SandboxNamespaceContext,
} from "@openclaw-enterprise/contracts";
import { SandboxNamespaceRefusedError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

const versions: Readonly<Record<string, string>> = {
  Service: "v1",
  ServiceAccount: "v1",
  ConfigMap: "v1",
  Secret: "v1",
  PersistentVolumeClaim: "v1",
  Deployment: "apps/v1",
  StatefulSet: "apps/v1",
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
};
const ownerLabel = "openclaw.dev/namespace";
const ownerAnnotation = "openclaw.dev/namespace-id";

export function validateNamespaceGatewayResources(
  value: unknown,
): asserts value is readonly KubernetesNamespacedResource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new SandboxNamespaceRefusedError(
      "Namespace gateway resources require 1 to 64 manifests.",
    );
  }
  const keys = new Set<string>();
  for (const item of value) {
    const resource = asRecord(item);
    const metadata = asRecord(resource?.metadata);
    const kind = resource?.kind;
    const name = metadata?.name;
    if (
      typeof kind !== "string" ||
      versions[kind] !== resource?.apiVersion ||
      typeof name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(
        name.replaceAll("${OCE_NAMESPACE}", "namespace"),
      ) ||
      resource?.status !== undefined ||
      metadata?.ownerReferences !== undefined ||
      metadata?.uid !== undefined ||
      metadata?.resourceVersion !== undefined ||
      (metadata?.namespace !== undefined && metadata.namespace !== "${OCE_NAMESPACE}")
    ) {
      throw new SandboxNamespaceRefusedError(
        "Namespace gateway manifest has unsupported kind, metadata, or namespace.",
      );
    }
    if (unsentManifestFields(resource as KubernetesNamespacedResource).length > 0) {
      throw new SandboxNamespaceRefusedError(
        "Namespace gateway manifest contains fields the Kubernetes client cannot send.",
      );
    }
    const key = `${kind}/${name}`;
    if (keys.has(key)) {
      throw new SandboxNamespaceRefusedError(
        "Namespace gateway resource names must be distinct per kind.",
      );
    }
    keys.add(key);
    if (kind === "RoleBinding") {
      const roleRef = asRecord(resource?.roleRef);
      if (roleRef?.kind !== "Role" || roleRef.apiGroup !== "rbac.authorization.k8s.io") {
        throw new SandboxNamespaceRefusedError(
          "Namespace gateway bindings may reference only a namespace-local Role.",
        );
      }
      const subjects = resource?.subjects;
      if (
        !Array.isArray(subjects) ||
        subjects.some((subject) => {
          const entry = asRecord(subject);
          return entry?.kind !== "ServiceAccount" || entry.namespace !== "${OCE_NAMESPACE}";
        })
      ) {
        throw new SandboxNamespaceRefusedError(
          "Namespace gateway bindings require namespace-local ServiceAccounts.",
        );
      }
    }
  }
  if (
    !value.some((resource) => resource.kind === "Service") ||
    !value.some((resource) => resource.kind === "Deployment" || resource.kind === "StatefulSet")
  ) {
    throw new SandboxNamespaceRefusedError(
      "Namespace gateway resources require a Service and a gateway workload.",
    );
  }
}

function manifest(
  resource: KubernetesNamespacedResource,
  context: SandboxNamespaceContext,
): KubernetesObject {
  // Only the backing namespace is substituted; no caller values or credentials are resolved.
  const desired = JSON.parse(
    JSON.stringify(resource).replaceAll("${OCE_NAMESPACE}", context.namespace.name),
  ) as KubernetesObject;
  desired.metadata = {
    ...desired.metadata,
    namespace: context.namespace.name,
    labels: {
      ...desired.metadata?.labels,
      [ownerLabel]: context.namespace.id,
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
    },
    annotations: { ...desired.metadata?.annotations, [ownerAnnotation]: context.namespace.id },
  };
  desired.metadata.labels!["openclaw.dev/namespace-gateway"] = "true";
  const spec = asRecord((desired as KubernetesObject & { spec?: unknown }).spec);
  if (desired.kind === "Deployment" || desired.kind === "StatefulSet") {
    const children = [
      asRecord(spec?.template),
      ...(Array.isArray(spec?.volumeClaimTemplates) ? spec.volumeClaimTemplates.map(asRecord) : []),
    ];
    for (const child of children) {
      if (child === undefined) {
        continue;
      }
      const metadata = asRecord(child.metadata) ?? {};
      child.metadata = {
        ...metadata,
        labels: { ...asRecord(metadata.labels), ...desired.metadata.labels },
        annotations: { ...asRecord(metadata.annotations), ...desired.metadata.annotations },
      };
    }
  }
  return networkPolicyToSdk(desired);
}

function verifyOwnership(observed: KubernetesObject, context: SandboxNamespaceContext): void {
  if (
    typeof observed.metadata?.uid !== "string" ||
    typeof observed.metadata.resourceVersion !== "string" ||
    observed.metadata?.namespace !== context.namespace.name ||
    observed.metadata?.labels?.[ownerLabel] !== context.namespace.id ||
    observed.metadata?.annotations?.[ownerAnnotation] !== context.namespace.id ||
    observed.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
    observed.metadata?.labels?.["openclaw.dev/namespace-gateway"] !== "true"
  ) {
    throw new SandboxNamespaceRefusedError(
      "The Namespace gateway resource is not owned by this Namespace.",
    );
  }
}

async function read(
  api: KubernetesObjectApi,
  resource: KubernetesObject,
): Promise<KubernetesObject | undefined> {
  try {
    return await api.read({
      ...resource,
      metadata: { ...resource.metadata, name: resource.metadata!.name! },
    });
  } catch (error) {
    const candidate = asRecord(error);
    if (candidate?.code === 404 || candidate?.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Per-Namespace gateway authentication keys; no Agent or model credentials are created. */
export async function ensureNamespaceGatewayIdentity(
  context: SandboxNamespaceContext,
  name: string,
): Promise<void> {
  const api = context.kubernetes as KubernetesObjectApi;
  const reference = manifest({ apiVersion: "v1", kind: "Secret", metadata: { name } }, context);
  context.signal.throwIfAborted();
  const existing = await read(api, reference);
  context.signal.throwIfAborted();
  if (existing !== undefined) {
    verifyOwnership(existing, context);
    return;
  }
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await api.create({
    ...reference,
    type: "Opaque",
    data: {
      "signing.pem": Buffer.from(keys.privateKey).toString("base64"),
      "public.pem": Buffer.from(keys.publicKey).toString("base64"),
      kid: Buffer.from(randomUUID()).toString("base64"),
    },
  } as KubernetesObject);
  context.signal.throwIfAborted();
}

export async function managedGatewayNamespaceExists(
  context: SandboxNamespaceContext,
): Promise<boolean> {
  context.signal.throwIfAborted();
  const namespace = await read(context.kubernetes as KubernetesObjectApi, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: context.namespace.name },
  });
  context.signal.throwIfAborted();
  return namespace !== undefined;
}

export async function namespaceGatewayExists(
  context: SandboxNamespaceContext,
  serviceName: string,
): Promise<boolean> {
  const service = await read(
    context.kubernetes as KubernetesObjectApi,
    manifest({ apiVersion: "v1", kind: "Service", metadata: { name: serviceName } }, context),
  );
  context.signal.throwIfAborted();
  if (service === undefined) {
    return false;
  }
  verifyOwnership(service, context);
  return service.metadata?.deletionTimestamp === undefined;
}

export async function reconcileNamespaceGateway(
  context: SandboxNamespaceContext,
  resources: readonly KubernetesNamespacedResource[],
  deleting = false,
): Promise<boolean> {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new SandboxNamespaceRefusedError(
      "Namespace gateway setup requires the selected Kubernetes object client.",
    );
  }
  const api = context.kubernetes;
  let absent = true;
  for (const resource of deleting
    ? [...resources]
        .reverse()
        .sort((a, b) => Number(b.kind === "Service") - Number(a.kind === "Service"))
    : resources) {
    context.signal.throwIfAborted();
    const desired = manifest(resource, context);
    const observed = await read(api, desired);
    context.signal.throwIfAborted();
    if (observed !== undefined) {
      verifyOwnership(observed, context);
    }
    if (deleting) {
      if (observed === undefined) {
        continue;
      }
      if (observed.metadata?.deletionTimestamp === undefined) {
        await api.delete(desired, undefined, undefined, undefined, undefined, undefined, {
          preconditions: {
            uid: observed.metadata!.uid!,
            resourceVersion: observed.metadata!.resourceVersion!,
          },
        });
      }
      absent = false;
      continue;
    }
    if (observed === undefined) {
      await api.create(desired, undefined, undefined, "openclaw-namespace-gateway");
    } else {
      if (observed.metadata?.deletionTimestamp !== undefined) {
        return false;
      }
      if (desired.kind === "Secret") {
        // OpenShell renews supervisor tokens itself. Reconciliation must neither erase those
        // values nor rotate an existing encryption key when initialization is retried.
        const expected = asRecord(desired)!;
        const actual = asRecord(observed)!;
        const initialData = { ...asRecord(expected.data) };
        for (const [key, value] of Object.entries(asRecord(expected.stringData) ?? {})) {
          if (typeof value !== "string") {
            throw new SandboxNamespaceRefusedError(
              "Namespace gateway Secret stringData must contain strings.",
            );
          }
          initialData[key] = Buffer.from(value).toString("base64");
        }
        if (
          (expected.type !== undefined && expected.type !== actual.type) ||
          Object.entries(initialData).some(
            ([key, value]) => asRecord(actual.data)?.[key] !== value,
          ) ||
          (["labels", "annotations"] as const).some((field) =>
            Object.entries(desired.metadata?.[field] ?? {}).some(
              ([key, value]) => observed.metadata?.[field]?.[key] !== value,
            ),
          )
        ) {
          throw new SandboxNamespaceRefusedError(
            "Namespace gateway Secret initialization differs from its existing owned configuration.",
          );
        }
      } else {
        // The owner markers and this exact UID/version fence field ownership transfer from
        // the initial create. It cannot adopt another component's or tenant's resource.
        desired.metadata!.uid = observed.metadata!.uid!;
        desired.metadata!.resourceVersion = observed.metadata!.resourceVersion!;
        await api.patch(
          desired,
          undefined,
          undefined,
          "openclaw-namespace-gateway",
          true,
          PatchStrategy.ServerSideApply,
        );
      }
    }
    context.signal.throwIfAborted();
  }
  if (deleting && resources.some((resource) => resource.kind === "StatefulSet")) {
    context.signal.throwIfAborted();
    const claims = await api.list(
      "v1",
      "PersistentVolumeClaim",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      `openclaw.dev/namespace=${context.namespace.id},openclaw.dev/namespace-gateway=true`,
    );
    for (const claim of claims.items) {
      verifyOwnership(claim, context);
      context.signal.throwIfAborted();
      if (claim.metadata?.deletionTimestamp === undefined) {
        // List entries omit kind/apiVersion. Supply the exact PVC identity for the generic
        // client while retaining UID/version preconditions from the owned observation.
        await api.delete(
          {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
              name: claim.metadata!.name!,
              namespace: context.namespace.name,
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            preconditions: {
              uid: claim.metadata!.uid!,
              resourceVersion: claim.metadata!.resourceVersion!,
            },
          },
        );
      }
      absent = false;
    }
  }
  return absent;
}
