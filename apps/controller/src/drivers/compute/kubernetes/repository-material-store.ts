import type { CoreV1Api, V1ObjectMeta, V1Secret } from "@kubernetes/client-node";
import type {
  AgentRevision,
  RepositoryCredentialMaterialRef,
} from "@openclaw-enterprise/contracts";
import { numericErrorStatus } from "@openclaw-enterprise/utils";
import {
  REPOSITORY_MATERIAL_KEYS,
  REPOSITORY_MATERIAL_LABEL,
  repositoryMaterialCurrent,
  repositoryMaterialFromSecret,
  repositoryMaterialSecretName,
  type NewRepositoryMaterialBinding,
  type RepositoryMaterialBinding,
  type RepositoryMaterialSpec,
  type ResolvedRepositoryMaterialBinding,
  type ResolvedRepositoryMaterialSpec,
} from "./repository-material.ts";

export interface RepositoryMaterialOwner {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
}

type Request = <T>(
  operation: () => Promise<T>,
  options?: { readonly mutating?: boolean },
) => Promise<T>;

type RepositoryMaterialPreparation =
  | { readonly kind: "ready"; readonly spec: ResolvedRepositoryMaterialSpec }
  | { readonly kind: "missing"; readonly missing: readonly RepositoryCredentialMaterialRef[] };

const fields = {
  namespaceId: ["openclaw.dev/namespace", "openclaw.dev/namespace-id"],
  agentId: ["openclaw.dev/agent", "openclaw.dev/agent-id"],
  revisionId: ["openclaw.dev/revision", "openclaw.dev/revision-id"],
} as const;

export type RepositoryMaterialErrorCode =
  | "REPOSITORY_MATERIAL_OWNERSHIP_INVALID"
  | "REPOSITORY_MATERIAL_EXPIRED"
  | "REPOSITORY_MATERIAL_CREATE_UNCONFIRMED"
  | `REPOSITORY_MATERIAL_${"READ" | "CREATE" | "LIST" | "DELETE"}_${"FAILED" | "FORBIDDEN"}`;

/**
 * A repository material store failure. Its stable code is what callers log (for example the
 * worker's REPOSITORY_CLEANUP_STALLED cause); a Kubernetes response, which may carry a Secret
 * body, never reaches the message.
 */
export class RepositoryMaterialError extends Error {
  readonly code: RepositoryMaterialErrorCode;

  constructor(code: RepositoryMaterialErrorCode, message: string) {
    super(message);
    this.name = "RepositoryMaterialError";
    this.code = code;
  }
}

function invalid(): never {
  throw new RepositoryMaterialError(
    "REPOSITORY_MATERIAL_OWNERSHIP_INVALID",
    "Repository credential Kubernetes material ownership is invalid.",
  );
}

/** A Kubernetes request failure, named by operation and whether RBAC refused it. */
function requestFailure(
  error: unknown,
  operation: "READ" | "CREATE" | "LIST" | "DELETE",
  message: string,
): RepositoryMaterialError {
  const outcome = numericErrorStatus(error) === 403 ? "FORBIDDEN" : "FAILED";
  return new RepositoryMaterialError(`REPOSITORY_MATERIAL_${operation}_${outcome}`, message);
}

function requireCurrentMaterial(spec: RepositoryMaterialSpec): void {
  if (!repositoryMaterialCurrent(spec)) {
    throw new RepositoryMaterialError(
      "REPOSITORY_MATERIAL_EXPIRED",
      "Repository credential material has expired.",
    );
  }
}

function labels(owner: RepositoryMaterialOwner): Record<string, string> {
  const result: Record<string, string> = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    [REPOSITORY_MATERIAL_LABEL]: "session",
  };
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (owner[key] !== undefined) {
      result[fields[key][0]] = owner[key];
    }
  }
  return result;
}

function annotations(owner: RepositoryMaterialOwner): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (owner[key] !== undefined) {
      result[fields[key][1]] = owner[key];
    }
  }
  return result;
}

function selector(owner: RepositoryMaterialOwner): string {
  return Object.entries(labels(owner))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export function completeKubernetesList<T>(value: {
  readonly items?: readonly T[];
  readonly metadata?: {
    readonly _continue?: string;
    readonly continue?: string;
    readonly remainingItemCount?: number;
  };
}): readonly T[] {
  if (
    !Array.isArray(value?.items) ||
    (value.metadata?._continue !== undefined && value.metadata._continue !== "") ||
    (value.metadata?.continue !== undefined && value.metadata.continue !== "") ||
    (value.metadata?.remainingItemCount !== undefined && value.metadata.remainingItemCount !== 0)
  ) {
    throw new Error("The Kubernetes material resource list is incomplete.");
  }
  return value.items;
}

export class RepositoryMaterialStore {
  private readonly namespace: string;
  private readonly core: CoreV1Api;
  private readonly request: Request;

  constructor(namespace: string, core: CoreV1Api, request: Request) {
    this.namespace = namespace;
    this.core = core;
    this.request = request;
  }

  private verify(
    secret: V1Secret,
    owner: RepositoryMaterialOwner,
    binding?: RepositoryMaterialBinding,
  ): void {
    const metadata = secret.metadata;
    if (
      metadata?.namespace !== this.namespace ||
      (secret.kind !== undefined && secret.kind !== "Secret") ||
      (secret.apiVersion !== undefined && secret.apiVersion !== "v1") ||
      typeof metadata.name !== "string" ||
      Object.entries(labels(owner)).some(([key, value]) => metadata.labels?.[key] !== value) ||
      Object.entries(annotations(owner)).some(
        ([key, value]) => metadata.annotations?.[key] !== value,
      )
    ) {
      return invalid();
    }
    const namespaceId = metadata.annotations?.["openclaw.dev/namespace-id"];
    const agentId = metadata.annotations?.["openclaw.dev/agent-id"];
    const revisionId = metadata.annotations?.["openclaw.dev/revision-id"];
    const repositoryRef = metadata.annotations?.["openclaw.dev/repository-ref"];
    const sessionId = metadata.annotations?.["openclaw.dev/repository-session-id"];
    const deadline = metadata.annotations?.["openclaw.dev/repository-deadline"];
    if (
      !namespaceId ||
      !agentId ||
      !revisionId ||
      !repositoryRef ||
      !sessionId ||
      !deadline ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repositoryRef) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !Number.isSafeInteger(Number(deadline)) ||
      Number(deadline) <= 0 ||
      String(Number(deadline)) !== deadline ||
      Object.entries(labels({ namespaceId, agentId, revisionId })).some(
        ([key, value]) => metadata.labels?.[key] !== value,
      ) ||
      metadata.name !==
        repositoryMaterialSecretName(
          { namespaceId, agentId, id: revisionId },
          { repositoryRef, sessionId },
        ) ||
      (binding !== undefined &&
        (repositoryRef !== binding.repositoryRef ||
          sessionId !== binding.sessionId ||
          deadline !== String(binding.deadlineWallMs)))
    ) {
      return invalid();
    }
  }

  private async read(name: string): Promise<V1Secret | undefined> {
    try {
      return await this.request(() =>
        this.core.readNamespacedSecret({ namespace: this.namespace, name }),
      );
    } catch (error) {
      if (numericErrorStatus(error) === 404) {
        return undefined;
      }
      // No cause: Kubernetes API errors may carry Secret bodies.
      throw requestFailure(error, "READ", "Repository credential material could not be read.");
    }
  }

  async prepare(
    revision: AgentRevision,
    spec: RepositoryMaterialSpec,
  ): Promise<RepositoryMaterialPreparation> {
    const owner = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    const resolved: ResolvedRepositoryMaterialBinding[] = [];
    const pending: NewRepositoryMaterialBinding[] = [];
    const missing: RepositoryCredentialMaterialRef[] = [];
    requireCurrentMaterial(spec);
    // Read and validate the complete set before creating any Secret or workload.
    for (const binding of spec.bindings) {
      const existing = await this.read(binding.secretName);
      requireCurrentMaterial(spec);
      if (existing === undefined) {
        if (binding.kind === "new") {
          pending.push(binding);
          resolved.push(binding);
        } else {
          missing.push({ repositoryRef: binding.repositoryRef, sessionId: binding.sessionId });
        }
        continue;
      }
      try {
        this.verify(existing, owner, binding);
        resolved.push(repositoryMaterialFromSecret(binding, existing));
      } catch {
        requireCurrentMaterial(spec);
        missing.push({ repositoryRef: binding.repositoryRef, sessionId: binding.sessionId });
      }
    }
    if (missing.length !== 0) {
      requireCurrentMaterial(spec);
      return { kind: "missing", missing };
    }
    for (const binding of pending) {
      requireCurrentMaterial(spec);
      const data = Object.fromEntries(
        Object.entries(binding.files).map(([file, content]) => [
          REPOSITORY_MATERIAL_KEYS[file as keyof typeof REPOSITORY_MATERIAL_KEYS],
          Buffer.from(content, "utf8").toString("base64"),
        ]),
      );
      const body: V1Secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: binding.secretName,
          namespace: this.namespace,
          labels: labels(owner),
          annotations: {
            ...annotations(owner),
            "openclaw.dev/repository-ref": binding.repositoryRef,
            "openclaw.dev/repository-session-id": binding.sessionId,
            "openclaw.dev/repository-deadline": String(binding.deadlineWallMs),
          },
        },
        immutable: true,
        type: "Opaque",
        data,
      };
      let observed: V1Secret | undefined;
      requireCurrentMaterial(spec);
      try {
        observed = await this.request(
          () => this.core.createNamespacedSecret({ namespace: this.namespace, body }),
          { mutating: true },
        );
      } catch (error) {
        if (numericErrorStatus(error) !== 409) {
          // No cause: Kubernetes API errors may carry Secret bodies.
          throw requestFailure(
            error,
            "CREATE",
            "Repository credential material could not be created.",
          );
        }
        observed = await this.read(binding.secretName);
      }
      requireCurrentMaterial(spec);
      if (observed === undefined) {
        throw new RepositoryMaterialError(
          "REPOSITORY_MATERIAL_CREATE_UNCONFIRMED",
          "Repository credential material creation could not be confirmed.",
        );
      }
      try {
        this.verify(observed, owner, binding);
        repositoryMaterialFromSecret(binding, observed);
      } catch {
        requireCurrentMaterial(spec);
        return {
          kind: "missing",
          missing: [{ repositoryRef: binding.repositoryRef, sessionId: binding.sessionId }],
        };
      }
    }
    requireCurrentMaterial(spec);
    return { kind: "ready", spec: { ...spec, bindings: resolved } };
  }

  async cleanup(owner: RepositoryMaterialOwner, keep: ReadonlySet<string>): Promise<boolean> {
    let listed;
    try {
      listed = await this.request(() =>
        this.core.listNamespacedSecret({
          namespace: this.namespace,
          labelSelector: selector(owner),
        }),
      );
    } catch (error) {
      // No cause: Kubernetes API errors may carry Secret bodies.
      throw requestFailure(
        error,
        "LIST",
        "Repository credential material cleanup could not list owned objects.",
      );
    }
    const candidates = completeKubernetesList(listed);
    // Validate every object before deleting one; a partial or foreign response fails closed.
    for (const candidate of candidates) {
      this.verify(candidate, owner);
      if (!candidate.metadata?.uid) {
        return invalid();
      }
    }
    let complete = true;
    for (const candidate of candidates) {
      const metadata = candidate.metadata as V1ObjectMeta & { name: string; uid: string };
      if (keep.has(metadata.name)) {
        complete = false;
        continue;
      }
      try {
        await this.request(
          () =>
            this.core.deleteNamespacedSecret({
              namespace: this.namespace,
              name: metadata.name,
              body: { preconditions: { uid: metadata.uid } },
            }),
          { mutating: true },
        );
      } catch (error) {
        if (numericErrorStatus(error) !== 404) {
          // No cause: Kubernetes API errors may carry Secret bodies.
          throw requestFailure(
            error,
            "DELETE",
            "Repository credential material could not be removed.",
          );
        }
      }
      const remaining = await this.read(metadata.name);
      if (remaining !== undefined) {
        this.verify(remaining, owner);
        complete = false;
      }
    }
    return complete;
  }
}
