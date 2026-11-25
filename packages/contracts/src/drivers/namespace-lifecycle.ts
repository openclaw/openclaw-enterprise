import type { Namespace, Scope } from "../index.ts";

export type NamespaceLifecycleFailure = "retryable" | "permanent";

export interface NamespaceEnsureResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceReady: boolean;
  readonly failure?: NamespaceLifecycleFailure;
  /** Sanitized operator explanation, at most 256 printable characters, scoped to this Namespace. */
  readonly reason?: string;
}

export interface NamespaceDeleteResult extends Scope {
  readonly namespaceId: string;
  readonly namespaceDeleted: boolean;
  readonly failure?: NamespaceLifecycleFailure;
}

export interface NamespaceLifecycleContext {
  readonly namespace: Readonly<Namespace>;
  readonly signal: AbortSignal;
}

export interface NamespaceLifecycleHooks {
  ensureNamespace(context: NamespaceLifecycleContext): Promise<NamespaceEnsureResult>;
  deleteNamespace?(context: NamespaceLifecycleContext): Promise<NamespaceDeleteResult>;
}

export interface NamespaceLifecycleParticipant {
  readonly id: string;
  readonly hooks: NamespaceLifecycleHooks;
}

export interface NamespaceDeletionEligibility {
  readonly namespaceId: string;
  readonly deletionAllowed: boolean;
  /** No participant may own this unclaimed backing namespace; retain it during Compute teardown. */
  readonly skipParticipantCleanup?: true;
  readonly failure?: NamespaceLifecycleFailure;
}
