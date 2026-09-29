import type {
  AgentRevision,
  RepositoryCredentialRuntimeBinding,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import { types } from "node:util";
import { REPOSITORY_MATERIAL_ROOT, repositoryMaterialSpec } from "./repository-material.ts";

/** Proposed internal receiving data, not a released Sandbox provider API. */
export interface SandboxRepositoryMaterialExpectation {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly sandbox: SandboxResourceRef;
  readonly generation: string;
  readonly deadlineWallMs: number;
  readonly bindings: readonly {
    readonly repositoryRef: string;
    readonly sessionId: string;
    readonly deadlineWallMs: number;
    readonly secretName: string;
    readonly directory: string;
  }[];
}

export interface SandboxRepositoryMaterialRecipient {
  readonly sandbox: SandboxResourceRef;
  readonly pod: {
    readonly namespaceName: string;
    readonly resourceName: string;
    readonly uid: string;
    readonly role: "agent";
  };
}

/**
 * Proposed owner-normalized inspection, never a raw Ready Pod or label receipt.
 * The real producer must authenticate the Sandbox-to-Pod relationship and prove
 * these facts from private material produced by the existing initialization path.
 */
export interface SandboxRepositoryMaterialObservation {
  readonly recipient: SandboxRepositoryMaterialRecipient;
  readonly podReady: boolean;
  readonly material:
    | {
        readonly namespaceId: string;
        readonly agentId: string;
        readonly revisionId: string;
        readonly generation: string;
        readonly bindings: readonly {
          readonly repositoryRef: string;
          readonly sessionId: string;
          readonly deadlineWallMs: number;
        }[];
        readonly storage: {
          readonly medium: "Memory";
          readonly sizeLimit: "4Mi";
          readonly mountPath: typeof REPOSITORY_MATERIAL_ROOT;
          readonly readOnly: true;
        };
        readonly completedStages: readonly ["validated", "published", "native-git-prepared"];
      }
    | undefined;
}

export interface SandboxRepositoryMaterialSelection {
  readonly recipient: SandboxRepositoryMaterialRecipient;
  readonly generation: string;
  readonly deadlineWallMs: number;
}

/**
 * Provisional original Compute/material owner port, never caller DATA. It joins
 * the authentic provider recipient with the existing selected material; it does
 * not delegate repository authorization to the Sandbox provider.
 * Stop, withdrawal or unusable sessions returns undefined.
 */
export interface SandboxRepositoryMaterialObserver {
  currentSelection(): SandboxRepositoryMaterialSelection | undefined;
  inspect(
    recipient: SandboxRepositoryMaterialRecipient,
    generation: string,
    bounds: { readonly signal: AbortSignal; readonly deadlineWallMs: number },
  ): Promise<SandboxRepositoryMaterialObservation | undefined>;
}

const sandboxKeys = ["namespaceName", "resourceName", "agentId", "revisionId"] as const;
const podKeys = ["namespaceName", "resourceName", "uid", "role"] as const;
const isAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;

function invalid(): never {
  throw new Error("Sandbox repository material data is invalid.");
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) {
    return invalid();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, "value")) {
      return invalid();
    }
    result[key] = descriptors[key]!.value;
  }
  return result;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return invalid();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return invalid();
    }
  }
  return value;
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum) {
    return invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    return invalid();
  }
  return Array.from({ length: value.length }, (_, index) => {
    const entry = descriptors[String(index)];
    if (!entry || !Object.hasOwn(entry, "value")) {
      return invalid();
    }
    return entry.value;
  });
}

function sandboxReference(value: unknown): SandboxResourceRef {
  const source = fields(value, sandboxKeys);
  return Object.freeze({
    namespaceName: identity(source.namespaceName),
    resourceName: identity(source.resourceName),
    agentId: identity(source.agentId),
    revisionId: identity(source.revisionId),
  });
}

function sameSandbox(left: SandboxResourceRef, right: SandboxResourceRef): boolean {
  return sandboxKeys.every((key) => left[key] === right[key]);
}

function recipient(value: unknown): SandboxRepositoryMaterialRecipient {
  const source = fields(value, ["sandbox", "pod"]);
  const sandbox = sandboxReference(source.sandbox);
  const pod = fields(source.pod, podKeys);
  if (pod.role !== "agent" || pod.namespaceName !== sandbox.namespaceName) {
    return invalid();
  }
  return Object.freeze({
    sandbox,
    pod: Object.freeze({
      namespaceName: identity(pod.namespaceName),
      resourceName: identity(pod.resourceName),
      uid: identity(pod.uid),
      role: "agent" as const,
    }),
  });
}

function sameRecipient(
  left: SandboxRepositoryMaterialRecipient,
  right: SandboxRepositoryMaterialRecipient,
): boolean {
  return (
    sameSandbox(left.sandbox, right.sandbox) &&
    podKeys.every((key) => left.pod[key] === right.pod[key])
  );
}

function selection(value: unknown): SandboxRepositoryMaterialSelection {
  const source = fields(value, ["recipient", "generation", "deadlineWallMs"]);
  if (
    typeof source.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.generation) ||
    !Number.isSafeInteger(source.deadlineWallMs)
  ) {
    return invalid();
  }
  return Object.freeze({
    recipient: recipient(source.recipient),
    generation: source.generation,
    deadlineWallMs: source.deadlineWallMs as number,
  });
}

function sameSelection(
  left: SandboxRepositoryMaterialSelection,
  right: SandboxRepositoryMaterialSelection,
): boolean {
  return (
    left.generation === right.generation &&
    left.deadlineWallMs === right.deadlineWallMs &&
    sameRecipient(left.recipient, right.recipient)
  );
}

function expectationSnapshot(
  value: SandboxRepositoryMaterialExpectation,
): SandboxRepositoryMaterialExpectation {
  const source = fields(value, [
    "namespaceId",
    "agentId",
    "revisionId",
    "sandbox",
    "generation",
    "deadlineWallMs",
    "bindings",
  ]);
  const bindings = array(source.bindings, 16).map((value) => {
    const binding = fields(value, [
      "repositoryRef",
      "sessionId",
      "deadlineWallMs",
      "secretName",
      "directory",
    ]);
    if (!Number.isSafeInteger(binding.deadlineWallMs)) {
      return invalid();
    }
    return Object.freeze({
      repositoryRef: identity(binding.repositoryRef),
      sessionId: identity(binding.sessionId),
      deadlineWallMs: binding.deadlineWallMs as number,
      secretName: identity(binding.secretName),
      directory: identity(binding.directory),
    });
  });
  const sandbox = sandboxReference(source.sandbox);
  if (
    bindings.length === 0 ||
    new Set(bindings.map((binding) => binding.repositoryRef)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.sessionId)).size !== bindings.length ||
    typeof source.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.generation) ||
    source.deadlineWallMs !== Math.min(...bindings.map((binding) => binding.deadlineWallMs)) ||
    sandbox.agentId !== source.agentId ||
    sandbox.revisionId !== source.revisionId
  ) {
    return invalid();
  }
  return Object.freeze({
    namespaceId: identity(source.namespaceId),
    agentId: identity(source.agentId),
    revisionId: identity(source.revisionId),
    sandbox,
    generation: source.generation,
    deadlineWallMs: source.deadlineWallMs as number,
    bindings: Object.freeze(bindings),
  });
}

/**
 * Reuse the original session validation, Secret naming and generation producer.
 * This projection deliberately omits bearer/client-file contents and adds no
 * transport, volume passthrough, provider credential or new authority.
 */
export function sandboxRepositoryMaterialExpectation(
  revision: AgentRevision,
  bindings: readonly RepositoryCredentialRuntimeBinding[] | undefined,
  sandbox: SandboxResourceRef,
): SandboxRepositoryMaterialExpectation | undefined {
  const material = repositoryMaterialSpec(revision, bindings);
  if (material === undefined) {
    return undefined;
  }
  const target = sandboxReference(sandbox);
  if (
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    target.agentId !== revision.agentId ||
    target.revisionId !== revision.id
  ) {
    return invalid();
  }
  return Object.freeze({
    namespaceId: identity(revision.namespaceId),
    agentId: identity(revision.agentId),
    revisionId: identity(revision.id),
    sandbox: target,
    generation: material.generation,
    deadlineWallMs: Math.min(...material.bindings.map((binding) => binding.deadlineWallMs)),
    bindings: Object.freeze(
      material.bindings.map((binding) =>
        Object.freeze({
          repositoryRef: binding.repositoryRef,
          sessionId: binding.sessionId,
          deadlineWallMs: binding.deadlineWallMs,
          secretName: binding.secretName,
          directory: binding.directory,
        }),
      ),
    ),
  });
}

function materialMatches(
  expected: SandboxRepositoryMaterialExpectation,
  captured: SandboxRepositoryMaterialRecipient,
  value: unknown,
): boolean {
  const observation = fields(value, ["recipient", "podReady", "material"]);
  if (observation.podReady !== true || !sameRecipient(captured, recipient(observation.recipient))) {
    return false;
  }
  const material = fields(observation.material, [
    "namespaceId",
    "agentId",
    "revisionId",
    "generation",
    "bindings",
    "storage",
    "completedStages",
  ]);
  const storage = fields(material.storage, ["medium", "sizeLimit", "mountPath", "readOnly"]);
  const stages = array(material.completedStages, 3);
  if (
    material.namespaceId !== expected.namespaceId ||
    material.agentId !== expected.agentId ||
    material.revisionId !== expected.revisionId ||
    material.generation !== expected.generation ||
    storage.medium !== "Memory" ||
    storage.sizeLimit !== "4Mi" ||
    storage.mountPath !== REPOSITORY_MATERIAL_ROOT ||
    storage.readOnly !== true ||
    stages.length !== 3 ||
    stages[0] !== "validated" ||
    stages[1] !== "published" ||
    stages[2] !== "native-git-prepared"
  ) {
    return false;
  }
  const observed = array(material.bindings, 16);
  if (observed.length !== expected.bindings.length) {
    return false;
  }
  const remaining = new Map(expected.bindings.map((binding) => [binding.repositoryRef, binding]));
  for (const value of observed) {
    const binding = fields(value, ["repositoryRef", "sessionId", "deadlineWallMs"]);
    const retained = remaining.get(identity(binding.repositoryRef));
    if (
      retained === undefined ||
      retained.sessionId !== binding.sessionId ||
      retained.deadlineWallMs !== binding.deadlineWallMs
    ) {
      return false;
    }
    remaining.delete(retained.repositoryRef);
  }
  return remaining.size === 0;
}

/**
 * Consumer preparation only. A true result compares owner-supplied facts; it does
 * not authenticate a JSON receipt or establish an installed material mechanism.
 * TODO(sandbox-repository-material): connect an accepted original provider
 * delivery/inspection mechanism before enabling Sandbox repository admission.
 */
export async function sandboxRepositoryMaterialReady(
  expected: SandboxRepositoryMaterialExpectation,
  observer: SandboxRepositoryMaterialObserver | undefined,
  bounds: { readonly signal: AbortSignal; readonly deadlineWallMs: number },
  now: () => number = Date.now,
): Promise<boolean> {
  if (observer === undefined) {
    return false;
  }
  try {
    const original = expectationSnapshot(expected);
    const deadline = bounds.deadlineWallMs;
    const signal = bounds.signal;
    const startedAt = now();
    const currentSelection = observer.currentSelection;
    const inspect = observer.inspect;
    const inTime = () => {
      const time = now();
      return (
        Number.isSafeInteger(time) &&
        Number.isSafeInteger(startedAt) &&
        Number.isSafeInteger(deadline) &&
        startedAt >= 0 &&
        time >= startedAt &&
        time < deadline &&
        time < original.deadlineWallMs &&
        bounds.deadlineWallMs === deadline &&
        bounds.signal === signal &&
        observer.currentSelection === currentSelection &&
        observer.inspect === inspect &&
        !isAborted.call(signal)
      );
    };
    if (!inTime()) {
      return false;
    }
    const captured = selection(currentSelection.call(observer));
    if (
      !sameSandbox(original.sandbox, captured.recipient.sandbox) ||
      captured.generation !== original.generation ||
      captured.deadlineWallMs !== original.deadlineWallMs
    ) {
      return false;
    }
    // The eventual inspection implementation must honor these original bounds;
    // this comparison cannot establish cancellation/settlement of a remote read.
    const observation = await inspect.call(
      observer,
      captured.recipient,
      original.generation,
      Object.freeze({ signal, deadlineWallMs: Math.min(deadline, original.deadlineWallMs) }),
    );
    // Read-only inspection has no automatic retry, and a replacement cannot adopt
    // the old observation merely because the Pod name or labels stayed the same.
    return (
      materialMatches(original, captured.recipient, observation) &&
      inTime() &&
      sameSelection(captured, selection(currentSelection.call(observer))) &&
      inTime()
    );
  } catch {
    return false;
  }
}
