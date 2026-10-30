import type { CredentialRefreshStatus } from "../credential-refresh/index.ts";
import type { Driver } from "../index.ts";
import type {
  AgentRevision,
  CredentialSource,
  CredentialSourceType,
  Namespace,
} from "../../index.ts";
import type { SandboxResourceRef } from "../sandbox/index.ts";

export interface CredentialGatewayContext {
  readonly signal: AbortSignal;
}

export interface CredentialSourceContext extends CredentialGatewayContext {
  /** Resolved by Compute: `name` is the runtime placement shared with the paired Sandbox. */
  readonly namespace: Readonly<Namespace>;
  readonly source: Readonly<CredentialSource>;
}

export interface CredentialSourceInput {
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  /** Resolved secret values keyed by catalog field; never persisted by OCC. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface CredentialSourceStatus {
  readonly state: "ready" | "pending" | "failed" | "absent";
  readonly reason?: string;
  /** Present for a `refresh` type: the Credential Refresh Driver's view of its tokens. */
  readonly refresh?: CredentialRefreshStatus;
}

export interface CredentialRevisionContext extends CredentialGatewayContext {
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  readonly sources: readonly Readonly<CredentialSource>[];
  /** The paired Sandbox's workload, once provisioned; required for attachment status. */
  readonly sandbox?: SandboxResourceRef;
}

/** Names the one source to revoke from one provisioned revision Sandbox. */
export interface CredentialWithdrawalContext extends CredentialGatewayContext {
  /** Resolved by Compute: `name` is the runtime placement shared with the paired Sandbox. */
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  /** The Sandbox provisioning created for `revision`. */
  readonly sandbox: SandboxResourceRef;
  readonly sourceId: string;
  /**
   * Re-checks a withdrawal already recorded `revoked`: the gateway detaches again only when
   * the Sandbox still lists the source, and otherwise reports `revoked` without a mutation.
   */
  readonly recheck?: boolean;
}

/** Selected identity metadata owned by the trusted Credential Gateway, never caller claims. */
export interface ExternalChatgptAuth {
  /** Placeholder only: copy unchanged for the paired Sandbox to resolve; never a real token. */
  readonly accessTokenPlaceholder: string;
  readonly accountId: string;
  readonly planType: string;
  readonly userId?: string;
  /** Membership identity from the access token, distinct from the global user ID. */
  readonly accountUserId?: string;
  readonly email?: string;
  readonly isFedramp?: boolean;
}

/** Gateway attachment whose opaque grant ref only the paired SandboxDriver consumes. */
export interface CredentialSourceAttachment {
  readonly sourceId: string;
  readonly ref: string;
  /** Non-secret limits of the attached OAuth provider for a Sandbox request guard. */
  readonly requestScope?: {
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly scopes: readonly string[];
  };
  /** External Codex authentication carries no refresh token into the workload. */
  readonly externalChatgptAuth?: ExternalChatgptAuth;
}

export interface CredentialAttachmentStatus {
  readonly sourceId: string;
  readonly state: "ready" | "pending" | "withheld" | "failed" | "revoked" | "absent";
  readonly reason?: string;
}

/** Holds credential sources and applies them outside the Agent workload. */
export interface CredentialGatewayDriver extends Driver {
  readonly capability: "credential_gateway";
  /** The token service may refresh to ensure usability; refresh material stays there. Tokens exist only during the callback. */
  withSourceToken?<T>(
    context: CredentialSourceContext,
    use: (token: CredentialSourceToken) => Promise<T>,
  ): Promise<T>;
  listSourceTypes(context: CredentialGatewayContext): Promise<readonly CredentialSourceType[]>;
  /**
   * Validate nonsecret configuration without I/O, before OCC reads Secrets or stores a record.
   * A returned configuration, with the same fields, is what OCC stores and registers instead of
   * the written one, such as a URL in the normalized form the gateway uses.
   */
  validateSourceConfig(
    input: Pick<CredentialSourceInput, "type" | "config">,
  ): Readonly<Record<string, string>> | void;
  registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus>;
  /** Idempotent; an already-absent source counts as removed. */
  removeSource(context: CredentialSourceContext): Promise<void>;
  /** Returns exactly one attachment per bound source, or throws. */
  attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]>;
  attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]>;
  /**
   * Returns `revoked` only on gateway evidence that the revision's placeholders no longer
   * resolve, `absent` when the Sandbox no longer exists, and `pending` otherwise.
   */
  withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus>;
}

/** Short-lived source authentication for an authorized control-plane operation. */
export interface CredentialSourceToken {
  readonly accessToken: string;
  /** Trusted provider identity, never browser-supplied metadata. */
  readonly accountId?: string;
  readonly isFedramp?: boolean;
}
