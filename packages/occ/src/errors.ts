import type {
  AuthorizationEvidence,
  AuthorizationRequest,
  ResourceRef,
} from "@openclaw-enterprise/contracts";

export class AuthorizationDeniedError extends Error {
  readonly evidence?: AuthorizationEvidence;
  readonly authorization?: {
    readonly action: AuthorizationRequest["action"];
    readonly resource: ResourceRef;
  };

  constructor(
    message = "The exact platform operation was not authorized.",
    evidence?: AuthorizationEvidence,
    authorization?: {
      readonly action: AuthorizationRequest["action"];
      readonly resource: ResourceRef;
    },
  ) {
    super(message);
    this.name = "AuthorizationDeniedError";
    if (evidence !== undefined) {
      this.evidence = evidence;
    }
    if (authorization !== undefined) {
      this.authorization = Object.freeze({
        action: authorization.action,
        resource: Object.freeze({ ...authorization.resource }),
      });
    }
  }
}

/**
 * The Agent's own service principal, not the caller, lacks a grant that deployment needs.
 * The caller is already authorized for the Agent, so naming the principal and the missing
 * grant tells an operator exactly what to bind without disclosing anything new.
 */
export class AgentPrincipalAuthorizationError extends AuthorizationDeniedError {
  readonly principalId: string;
  declare readonly authorization: {
    readonly action: AuthorizationRequest["action"];
    readonly resource: ResourceRef;
  };

  constructor(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
    evidence?: AuthorizationEvidence,
  ) {
    super(
      `The Agent service principal ${principalId} is not authorized to ${action} ${resource.kind} ${resource.id}. Grant that principal ${action} on the ${resource.kind}, then deploy again.`,
      evidence,
      { action, resource },
    );
    this.name = "AgentPrincipalAuthorizationError";
    this.principalId = principalId;
  }
}

/**
 * Authority and audit outages fail closed as authorization failures while
 * remaining distinguishable from explicit denials for HTTP and audit handling.
 */
export class DependencyUnavailableError extends AuthorizationDeniedError {
  constructor(message = "A required platform dependency is unavailable.") {
    super(message);
    this.name = "DependencyUnavailableError";
  }
}

export class RepositoryOptionsUnavailableError extends Error {
  constructor(message = "Repository options are unavailable.") {
    super(message);
    this.name = "RepositoryOptionsUnavailableError";
  }
}

/** Safe discovery outcomes carry no upstream response, credential, or error cause. */
export class ModelDiscoveryError extends Error {
  readonly reason: "credentials_rejected" | "rate_limited" | "unavailable" | "invalid_response";

  constructor(reason: ModelDiscoveryError["reason"]) {
    super("Model discovery failed.");
    this.name = "ModelDiscoveryError";
    this.reason = reason;
  }
}

/** Safe discovery outcomes carry no upstream response, credential, or error cause. */
export class PluginDiscoveryError extends Error {
  readonly reason: "credentials_rejected" | "rate_limited" | "unavailable" | "invalid_response";

  constructor(reason: PluginDiscoveryError["reason"]) {
    super("Plugin discovery failed.");
    this.name = "PluginDiscoveryError";
    this.reason = reason;
  }
}

/** Safe channel-directory outcomes contain no upstream response or token. */
export class ChannelDirectoryError extends Error {
  readonly reason:
    "credentials_rejected" | "missing_scope" | "rate_limited" | "invalid_response" | "unavailable";

  constructor(reason: ChannelDirectoryError["reason"]) {
    super("Channel directory lookup failed.");
    this.name = "ChannelDirectoryError";
    this.reason = reason;
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

/**
 * Admitted Configuration content cannot select a supported Harness runtime. The
 * caller can already see the Configuration, so HTTP reports the static message as
 * an invalid request instead of hiding it as a scope miss.
 */
export class ConfigurationHarnessError extends ScopeViolationError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationHarnessError";
  }
}

export class ResourceConflictError extends ScopeViolationError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceConflictError";
  }
}

export class AgentDeletingError extends ResourceConflictError {
  constructor(message = "The Agent is being deleted.") {
    super(message);
    this.name = "AgentDeletingError";
  }
}

export class WorkspaceDefaultsChangedError extends ResourceConflictError {
  constructor() {
    super("Workspace defaults changed. Reload the create form before submitting.");
    this.name = "WorkspaceDefaultsChangedError";
  }
}

export class NamespaceNotEmptyError extends ResourceConflictError {
  /** Public resource kinds that still occupy the Namespace, such as "Presets". */
  readonly contents: readonly string[];

  constructor(contents: readonly string[] = []) {
    super("The Namespace must be empty before deletion.");
    this.name = "NamespaceNotEmptyError";
    this.contents = Object.freeze([...contents]);
  }
}

export class NamespaceNotReadyError extends ResourceConflictError {
  constructor(message = "The Namespace is not ready for deployment.") {
    super(message);
    this.name = "NamespaceNotReadyError";
  }
}

/** Dedicated native OpenClaw needs OpenClaw support that the selected runtime image lacks. */
export class NativeWorkerSupportError extends Error {
  constructor() {
    super(
      "Dedicated native OpenClaw is unavailable: the pinned OpenClaw runtime does not support required worker placement (cloudWorkers.requiredProfile) or native worker inference. See docs/reference/harness-execution.md#native-worker-support.",
    );
    this.name = "NativeWorkerSupportError";
  }
}

/**
 * A Sandbox Driver cannot run this exact AgentRevision with the installed
 * driver. Retrying cannot change the outcome, so the worker fails the deployment
 * with `code`. The message stays in the controller; status shows a fixed text.
 */
export class SandboxRevisionUnsupportedError extends Error {
  readonly code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED" | "SANDBOX_HARNESS_UNSUPPORTED";

  constructor(code: SandboxRevisionUnsupportedError["code"], message: string) {
    super(message);
    this.name = "SandboxRevisionUnsupportedError";
    this.code = code;
  }
}

export class DriverSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverSelectionError";
  }
}

export class NotImplementedError extends Error {
  readonly operation: string;

  constructor(operation: string, message = "The requested platform operation is not implemented.") {
    super(message);
    this.name = "NotImplementedError";
    this.operation = operation;
  }
}

/** The cluster denied `pods/log` or `events`: an operator must grant the documented roles. */
export class RuntimeLogsForbiddenByClusterError extends Error {
  constructor() {
    super("The cluster denied a runtime log or Event read.");
    this.name = "RuntimeLogsForbiddenByClusterError";
  }
}

/**
 * OpenShell answered NOT_FOUND for the revision's Sandbox. It gives the same answer when
 * the Sandbox is not provisioned (yet) and when OCC's identity is not a member of its
 * Workspace, so the two cannot be told apart and neither is reported as "no lines".
 */
export class RuntimeLogsSandboxNotFoundError extends Error {
  constructor() {
    super("OpenShell reported the Sandbox as not found.");
    this.name = "RuntimeLogsSandboxNotFoundError";
  }
}

export type RuntimeLogsErrorCode =
  | "RUNTIME_LOGS_CURSOR_INVALID"
  | "RUNTIME_LOGS_POD_INVALID"
  | "RUNTIME_LOGS_SOURCE_UNAVAILABLE"
  | "RUNTIME_LOGS_RATE_LIMITED"
  | "RUNTIME_LOGS_CLUSTER_RBAC"
  | "RUNTIME_LOGS_SANDBOX_NOT_FOUND"
  | "RUNTIME_LOGS_UNAVAILABLE"
  | "RUNTIME_LOGS_AUDIT_UNAVAILABLE"
  | "RUNTIME_LOGS_TIMEOUT";

/** A fixed-message runtime log failure; Driver and cluster error text never reaches it. */
export class RuntimeLogsError extends Error {
  readonly code: RuntimeLogsErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: RuntimeLogsErrorCode, retryAfterSeconds?: number) {
    super(`Runtime log request failed: ${code}.`);
    this.name = "RuntimeLogsError";
    this.code = code;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export class PluginPolicyValidationError extends Error {
  constructor(field?: "toolDefaults.reviewer" | "tools[id].reviewer" | "approvers") {
    let message = "The supplied plugin policies are invalid.";
    if (field === "approvers") {
      message =
        "This Plugin Driver does not support plugin or tool approvers. Omit approvers from plugin selections and set Agent-wide pluginApprovers instead.";
    } else if (field === "toolDefaults.reviewer") {
      message =
        "This Plugin Driver does not support toolDefaults.reviewer. Omit the reviewer to inherit the Harness setting.";
    } else if (field === "tools[id].reviewer") {
      message =
        "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.";
    }
    super(message);
    this.name = "PluginPolicyValidationError";
  }
}

/** Sanitized admission outcome. The path identifies configuration, never Secret contents. */
export class ChannelCredentialError extends Error {
  readonly reason: "role_mismatch" | "credentials_rejected" | "unavailable" | "binding_required";
  readonly path: string;

  constructor(reason: ChannelCredentialError["reason"], path: string) {
    super("Channel credential validation failed.");
    this.name = "ChannelCredentialError";
    this.reason = reason;
    this.path = path;
  }
}
