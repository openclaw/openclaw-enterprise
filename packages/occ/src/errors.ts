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

export class NamespaceNotEmptyError extends ResourceConflictError {
  constructor(message = "The Namespace must be empty before deletion.") {
    super(message);
    this.name = "NamespaceNotEmptyError";
  }
}

export class NamespaceNotReadyError extends ResourceConflictError {
  constructor(message = "The Namespace is not ready for deployment.") {
    super(message);
    this.name = "NamespaceNotReadyError";
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

export class PluginPolicyValidationError extends Error {
  constructor(field?: "toolDefaults.reviewer" | "tools[id].reviewer") {
    let message = "The supplied plugin policies are invalid.";
    if (field === "toolDefaults.reviewer") {
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
