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
