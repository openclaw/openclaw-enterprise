import { isDeepStrictEqual } from "node:util";
import type {
  NamespaceLifecycleContext,
  SandboxDriver,
  SandboxNamespaceCleanupResult,
  SandboxNamespaceCleanupResource,
} from "@openclaw-enterprise/contracts";

export class KubernetesNamespaceLifecycleRefused extends Error {}

interface NamespaceAttempt {
  readonly nonce: string;
  readonly uid?: string;
  readonly creationRefused?: true;
  readonly claim?: "attempted" | "complete" | "refused";
}

export interface KubernetesNamespaceLifecycleBinding {
  readonly execution: { readonly server: string; readonly trust: string };
  readonly control: { readonly server: string; readonly trust: string };
  readonly placement: {
    readonly name: string;
    readonly plane: "execution" | "control";
    readonly external: boolean;
  };
  readonly sandbox?: { readonly id: string; readonly implementation: string };
}

export interface NamespaceInfrastructureResource {
  readonly kind: "ResourceQuota" | "LimitRange" | "NetworkPolicy";
  readonly name: string;
  readonly uid?: string;
  readonly creationRefused?: true;
}

interface NamespaceJournalData extends Record<string, unknown> {
  readonly version: 1;
  readonly binding: KubernetesNamespaceLifecycleBinding;
  readonly namespace?: NamespaceAttempt;
  readonly gateway?: NamespaceAttempt;
  readonly sandbox: Readonly<Record<string, unknown>>;
  readonly release?: "attempted" | "complete";
  readonly infrastructure?: readonly NamespaceInfrastructureResource[];
  readonly cleanup?: SandboxNamespaceCleanupResult;
  readonly latePolicy?:
    { readonly state: "absent" } | { readonly state: "bound"; readonly uid: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attempt(value: unknown): value is NamespaceAttempt | undefined {
  return (
    value === undefined ||
    (record(value) &&
      typeof value.nonce === "string" &&
      value.nonce.length > 0 &&
      (value.uid === undefined || (typeof value.uid === "string" && value.uid.length > 0)) &&
      (value.creationRefused === undefined ||
        (value.creationRefused === true && value.uid === undefined)) &&
      (value.claim === undefined ||
        value.claim === "attempted" ||
        value.claim === "complete" ||
        value.claim === "refused"))
  );
}

const namespaceResourceVersions: Readonly<Record<string, string>> = {
  ConfigMap: "v1",
  Secret: "v1",
  ServiceAccount: "v1",
  Service: "v1",
  ResourceQuota: "v1",
  LimitRange: "v1",
  PersistentVolumeClaim: "v1",
  Pod: "v1",
  Deployment: "apps/v1",
  Job: "batch/v1",
  NetworkPolicy: "networking.k8s.io/v1",
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  HTTPRoute: "gateway.networking.k8s.io/v1",
  SecurityPolicy: "gateway.envoyproxy.io/v1alpha1",
};

export function namespaceCleanupResult(
  value: unknown,
  namespace: string,
): SandboxNamespaceCleanupResult {
  if (!record(value) || !Array.isArray(value.kubernetesResources)) {
    throw new KubernetesNamespaceLifecycleRefused(
      "Namespace Sandbox cleanup did not return resource ownership.",
    );
  }
  const seen = new Set<string>();
  const kubernetesResources: SandboxNamespaceCleanupResource[] = value.kubernetesResources.map(
    (item) => {
      if (
        !record(item) ||
        typeof item.kind !== "string" ||
        typeof item.apiVersion !== "string" ||
        !Object.hasOwn(namespaceResourceVersions, item.kind) ||
        namespaceResourceVersions[item.kind] !== item.apiVersion ||
        item.namespace !== namespace ||
        typeof item.name !== "string" ||
        item.name.length > 253 ||
        item.name.trim().length === 0 ||
        item.name === "." ||
        item.name === ".." ||
        /[/%]/.test(item.name) ||
        [...item.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        (item.state !== "absent" && item.state !== "retained") ||
        (item.state === "retained" &&
          (typeof item.uid !== "string" ||
            item.uid.length === 0 ||
            item.uid.length > 200 ||
            item.uid.trim() !== item.uid))
      ) {
        throw new KubernetesNamespaceLifecycleRefused(
          "Namespace Sandbox cleanup returned an invalid resource reference.",
        );
      }
      const reference = {
        apiVersion: String(item.apiVersion),
        kind: item.kind,
        namespace,
        name: item.name,
      };
      const key = JSON.stringify(reference);
      if (seen.has(key)) {
        throw new KubernetesNamespaceLifecycleRefused(
          "Namespace Sandbox cleanup returned duplicate resource references.",
        );
      }
      seen.add(key);
      return item.state === "absent"
        ? { ...reference, state: "absent" }
        : { ...reference, state: "retained", uid: String(item.uid) };
    },
  );
  kubernetesResources.sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0,
  );
  return { kubernetesResources };
}

/** Compute owns the envelope; Sandbox callbacks see only its delegated child. */
export class KubernetesNamespaceJournal {
  readonly lifecycle: NamespaceLifecycleContext;
  private readonly binding: KubernetesNamespaceLifecycleBinding;

  private constructor(
    lifecycle: NamespaceLifecycleContext,
    binding: KubernetesNamespaceLifecycleBinding,
  ) {
    this.lifecycle = lifecycle;
    this.binding = binding;
  }

  static async open(
    lifecycle: NamespaceLifecycleContext,
    binding: KubernetesNamespaceLifecycleBinding,
  ): Promise<KubernetesNamespaceJournal> {
    if (
      lifecycle === undefined ||
      typeof lifecycle.read !== "function" ||
      typeof lifecycle.checkpoint !== "function"
    ) {
      throw new KubernetesNamespaceLifecycleRefused("Namespace lifecycle authority is required.");
    }
    const journal = new KubernetesNamespaceJournal(lifecycle, binding);
    const current = await lifecycle.read();
    if (Object.keys(current.data).length === 0) {
      if (current.revision !== 0) {
        throw new KubernetesNamespaceLifecycleRefused("The Namespace lifecycle intent is missing.");
      }
      await lifecycle.checkpoint(current.revision, { version: 1, binding, sandbox: {} });
    }
    await journal.read();
    return journal;
  }

  async read(): Promise<{ readonly revision: number; readonly data: NamespaceJournalData }> {
    this.lifecycle.signal.throwIfAborted();
    const current = await this.lifecycle.read();
    const data = current.data;
    if (
      data.version !== 1 ||
      !isDeepStrictEqual(data.binding, this.binding) ||
      !record(data.sandbox) ||
      (data.cleanup !== undefined &&
        !isDeepStrictEqual(
          namespaceCleanupResult(data.cleanup, this.binding.placement.name),
          data.cleanup,
        )) ||
      (data.latePolicy !== undefined &&
        (!record(data.latePolicy) ||
          (data.latePolicy.state !== "absent" &&
            !(
              data.latePolicy.state === "bound" &&
              typeof data.latePolicy.uid === "string" &&
              data.latePolicy.uid.length > 0
            )))) ||
      !attempt(data.namespace) ||
      !attempt(data.gateway) ||
      (data.infrastructure !== undefined &&
        (!Array.isArray(data.infrastructure) ||
          data.infrastructure.some(
            (value) =>
              !record(value) ||
              !["ResourceQuota", "LimitRange", "NetworkPolicy"].includes(String(value.kind)) ||
              typeof value.name !== "string" ||
              value.name.length === 0 ||
              (value.uid !== undefined &&
                (typeof value.uid !== "string" || value.uid.length === 0)) ||
              (value.creationRefused !== undefined &&
                (value.creationRefused !== true || value.uid !== undefined)),
          ))) ||
      (data.release !== undefined && data.release !== "attempted" && data.release !== "complete")
    ) {
      throw new KubernetesNamespaceLifecycleRefused(
        "The Kubernetes Namespace lifecycle binding is unsupported or changed.",
      );
    }
    return { revision: current.revision, data: data as NamespaceJournalData };
  }

  async save(
    change: Partial<
      Pick<
        NamespaceJournalData,
        "namespace" | "gateway" | "release" | "infrastructure" | "cleanup" | "latePolicy"
      >
    >,
  ): Promise<void> {
    const current = await this.read();
    await this.lifecycle.checkpoint(current.revision, { ...current.data, ...change });
  }

  sandboxContext(driver: SandboxDriver): NamespaceLifecycleContext {
    if (
      !isDeepStrictEqual(this.binding.sandbox, {
        id: driver.id,
        implementation: driver.implementation,
      })
    ) {
      throw new KubernetesNamespaceLifecycleRefused(
        "The selected Sandbox Driver differs from the Namespace lifecycle binding.",
      );
    }
    return Object.freeze({
      lifecycleId: this.lifecycle.lifecycleId,
      target: this.lifecycle.target,
      signal: this.lifecycle.signal,
      read: async () => {
        const current = await this.read();
        return { revision: current.revision, data: current.data.sandbox };
      },
      checkpoint: async (expectedRevision: number, data: Readonly<Record<string, unknown>>) => {
        const current = await this.read();
        if (current.revision !== expectedRevision) {
          throw new KubernetesNamespaceLifecycleRefused(
            "The Sandbox Namespace checkpoint revision changed.",
          );
        }
        const saved = await this.lifecycle.checkpoint(expectedRevision, {
          ...current.data,
          sandbox: data,
        });
        if (!record(saved.data.sandbox)) {
          throw new KubernetesNamespaceLifecycleRefused(
            "The committed Sandbox checkpoint is invalid.",
          );
        }
        return { revision: saved.revision, data: saved.data.sandbox };
      },
    });
  }
}
