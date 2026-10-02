import type { FastifyError, FastifyReply } from "fastify";
import { PresetValidationError } from "@openclaw-enterprise/contracts";
import {
  AgentDeletingError,
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  DeletionRetryOwnedError,
  ChannelDirectoryError,
  ChannelCredentialError,
  ConfigurationHarnessError,
  CredentialGatewayNotConfiguredError,
  DependencyUnavailableError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  ModelDiscoveryError,
  PluginDiscoveryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  NativeWorkerSupportError,
  PluginPolicyValidationError,
  PostgresCommitOutcomeUnknownError,
  ResourceConflictError,
  ResourceStateConflictError,
  RuntimeLogsError,
  ScopeViolationError,
  type RuntimeLogsErrorCode,
} from "@openclaw-enterprise/occ";
import {
  ConfigurationOwnershipError,
  ConfigurationValidationError,
} from "../drivers/configuration/kubernetes/index.ts";

export interface ErrorDetail {
  readonly path: string;
  readonly code:
    | "REQUIRED"
    | "UNKNOWN_FIELD"
    | "INVALID_TYPE"
    | "INVALID_FORMAT"
    | "INVALID_VALUE"
    | "TOO_LONG"
    | "TOO_DEEP";
}

export class RequestFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: readonly ErrorDetail[];

  constructor(status: number, code: string, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.name = "RequestFailure";
    this.status = status;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function failure(
  status: number,
  code: string,
  message: string,
  details?: readonly ErrorDetail[],
): RequestFailure {
  return new RequestFailure(status, code, message, details);
}

export function dependencyUnavailable(): RequestFailure {
  return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
}

export function jsonPointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function responseHeaders(reply: FastifyReply, requestId: string): void {
  reply.header("cache-control", "no-store");
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-request-id", requestId);
}

export function canonicalFailure(reply: FastifyReply, error: RequestFailure): void {
  responseHeaders(reply, reply.request.id);
  reply.status(error.status).send({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    meta: { requestId: reply.request.id },
  });
}

function validationCode(keyword: string): ErrorDetail["code"] {
  switch (keyword) {
    case "required":
      return "REQUIRED";
    case "additionalProperties":
      return "UNKNOWN_FIELD";
    case "type":
      return "INVALID_TYPE";
    case "format":
    case "pattern":
      return "INVALID_FORMAT";
    case "maxLength":
      return "TOO_LONG";
    default:
      return "INVALID_VALUE";
  }
}

function validationDetails(error: FastifyError): readonly ErrorDetail[] {
  if (!Array.isArray(error.validation)) {
    return [];
  }
  return error.validation.slice(0, 32).map((detail): ErrorDetail => {
    const parameters = detail.params as Record<string, unknown>;
    let path = typeof detail.instancePath === "string" ? detail.instancePath : "";
    if (detail.keyword === "required" && typeof parameters.missingProperty === "string") {
      path += `/${jsonPointer(parameters.missingProperty)}`;
    }
    if (
      detail.keyword === "additionalProperties" &&
      typeof parameters.additionalProperty === "string"
    ) {
      path += `/${jsonPointer(parameters.additionalProperty)}`;
    }
    return { path, code: validationCode(detail.keyword) };
  });
}

const DETAIL_PROBLEMS: Readonly<Record<ErrorDetail["code"], string>> = Object.freeze({
  REQUIRED: "is required",
  UNKNOWN_FIELD: "is not an accepted field",
  INVALID_TYPE: "has the wrong type",
  INVALID_FORMAT: "has an invalid format",
  INVALID_VALUE: "has an unsupported value",
  TOO_LONG: "is too long",
  TOO_DEEP: "is nested too deeply",
});

// Names the first few offending fields so clients that print only the message, such as
// occ, still show which field to fix. The full list stays in `details`.
function contractMessage(error: FastifyError, details: readonly ErrorDetail[]): string {
  if (details.length === 0) {
    return "The request does not match the operation contract.";
  }
  const context =
    typeof error.validationContext === "string" && error.validationContext.length > 0
      ? `${error.validationContext} `
      : "";
  const problems = [
    ...new Set(
      details.map((detail) => `${context}${detail.path || "/"} ${DETAIL_PROBLEMS[detail.code]}`),
    ),
  ];
  const shown = problems.slice(0, 3).join("; ");
  const more = problems.length > 3 ? `; and ${problems.length - 3} more` : "";
  const message = `The request does not match the operation contract: ${shown}${more}.`;
  // The error contract caps messages at 256 characters; long JSON Pointer paths are cut.
  return message.length <= 256 ? message : `${message.slice(0, 255)}…`;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export function isAuthorizationDenied(error: unknown): error is AuthorizationDeniedError {
  return (
    error instanceof AuthorizationDeniedError || errorName(error) === "AuthorizationDeniedError"
  );
}

export function isDependencyUnavailable(error: unknown): boolean {
  return (
    error instanceof DependencyUnavailableError || errorName(error) === "DependencyUnavailableError"
  );
}

const RUNTIME_LOG_FAILURES: Readonly<
  Record<RuntimeLogsErrorCode, { readonly status: number; readonly message: string }>
> = Object.freeze({
  RUNTIME_LOGS_CURSOR_INVALID: {
    status: 400,
    message: "The runtime log cursor is invalid for this caller and view. Start a new view.",
  },
  RUNTIME_LOGS_POD_INVALID: {
    status: 400,
    message: "The requested Pod is not a current Pod of this Agent version and source.",
  },
  RUNTIME_LOGS_SOURCE_UNAVAILABLE: {
    status: 400,
    message: "This Agent version has no such runtime log source.",
  },
  RUNTIME_LOGS_RATE_LIMITED: {
    status: 429,
    message: "Too many runtime log requests. Wait for Retry-After and try again.",
  },
  RUNTIME_LOGS_CLUSTER_RBAC: {
    status: 503,
    message:
      "The cluster denied the runtime log read. Ask a platform operator to enable agentRuntimeLogs and the documented roles.",
  },
  RUNTIME_LOGS_SANDBOX_NOT_FOUND: {
    status: 503,
    message:
      "OpenShell reports no such sandbox for OpenClaw Enterprise: it is not provisioned yet or was removed, or the gateway identity is not a member of its Workspace.",
  },
  RUNTIME_LOGS_UNAVAILABLE: {
    status: 503,
    message: "Runtime status or logs are unavailable. Retry later.",
  },
  RUNTIME_LOGS_AUDIT_UNAVAILABLE: {
    status: 503,
    message: "The runtime log view could not be audited, so no output was read.",
  },
  RUNTIME_LOGS_TIMEOUT: {
    status: 504,
    message: "The runtime status or log read timed out.",
  },
});

export function requestFailure(error: unknown): RequestFailure {
  if (error instanceof RequestFailure) {
    return error;
  }
  if (error instanceof RuntimeLogsError) {
    const mapped = RUNTIME_LOG_FAILURES[error.code];
    return failure(mapped.status, error.code, mapped.message);
  }
  if (error instanceof ChannelCredentialError) {
    const messages = {
      role_mismatch: "The selected Secret has the wrong token role for this field.",
      credentials_rejected:
        "The channel provider rejected this credential. Check the selected Secret.",
      unavailable:
        "Channel credential validation is temporarily unavailable. Retry before deploying.",
      binding_required: "Select an environment-backed Secret for this channel credential.",
    };
    return failure(
      error.reason === "unavailable" ? 503 : 400,
      `CHANNEL_CREDENTIAL_${error.reason.toUpperCase()}`,
      messages[error.reason],
      [{ path: error.path, code: "INVALID_VALUE" }],
    );
  }
  if (error instanceof ChannelDirectoryError) {
    switch (error.reason) {
      case "credentials_rejected":
        return failure(
          400,
          "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED",
          "The channel provider rejected the selected credential. Check the Secret and retry.",
        );
      case "missing_scope":
        return failure(
          400,
          "CHANNEL_DIRECTORY_MISSING_SCOPE",
          "The channel credential lacks directory permissions. Update its provider scopes and retry.",
        );
      case "rate_limited":
        return failure(
          429,
          "CHANNEL_DIRECTORY_RATE_LIMITED",
          "The channel provider rate-limited directory lookup. Wait and retry.",
        );
      case "invalid_response":
        return failure(
          503,
          "CHANNEL_DIRECTORY_INVALID_RESPONSE",
          "The channel provider returned an invalid directory response. Retry or enter an exact ID.",
        );
      case "unavailable":
        return failure(
          503,
          "CHANNEL_DIRECTORY_UNAVAILABLE",
          "Channel directory lookup is unavailable. Retry or enter an exact ID.",
        );
    }
  }
  if (error instanceof ModelDiscoveryError) {
    switch (error.reason) {
      case "credentials_rejected":
        return failure(
          400,
          "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
          "The provider rejected model discovery. Check the selected credential and its permission to list models, then retry or enter a model ID manually.",
        );
      case "rate_limited":
        return failure(
          429,
          "MODEL_DISCOVERY_RATE_LIMITED",
          "The provider rate-limited model discovery. Wait and retry, or enter a model ID manually.",
        );
      case "invalid_response":
        return failure(
          503,
          "MODEL_DISCOVERY_INVALID_RESPONSE",
          "The provider returned an invalid model list. Retry or enter a model ID manually.",
        );
      case "unavailable":
        return failure(
          503,
          "MODEL_DISCOVERY_UNAVAILABLE",
          "The provider model service is unavailable. Retry or enter a model ID manually.",
        );
    }
  }
  if (error instanceof PluginDiscoveryError) {
    switch (error.reason) {
      case "credentials_rejected":
        return failure(
          400,
          "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
          "The plugin service rejected this credential. Check its permission to list plugins, then retry.",
        );
      case "rate_limited":
        return failure(
          429,
          "PLUGIN_DISCOVERY_RATE_LIMITED",
          "The plugin service rate-limited discovery. Wait and retry.",
        );
      case "invalid_response":
        return failure(
          503,
          "PLUGIN_DISCOVERY_INVALID_RESPONSE",
          "The plugin service returned an invalid response. Retry discovery.",
        );
      case "unavailable":
        return failure(
          503,
          "PLUGIN_DISCOVERY_UNAVAILABLE",
          "The plugin service is unavailable. Retry discovery.",
        );
    }
  }
  if (error instanceof IAMAccessBindingRoleError) {
    return failure(400, "INVALID_REQUEST", error.message, [
      { path: "/roleId", code: "INVALID_VALUE" },
    ]);
  }
  if (error instanceof IAMPolicyValidationError) {
    return failure(400, "INVALID_REQUEST", error.message, [
      { path: error.path, code: "INVALID_VALUE" },
    ]);
  }
  if (error instanceof IAMRoleInUseError) {
    return failure(409, "RESOURCE_CONFLICT", error.message);
  }
  if (error instanceof CredentialGatewayNotConfiguredError) {
    return failure(409, "CREDENTIAL_GATEWAY_NOT_CONFIGURED", error.message);
  }
  if (error instanceof ConfigurationHarnessError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof NativeWorkerSupportError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof PluginPolicyValidationError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof PresetValidationError) {
    return failure(400, "INVALID_REQUEST", "The supplied Preset template is invalid.");
  }
  if (error instanceof ConfigurationValidationError) {
    return failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.");
  }
  if (error instanceof ConfigurationOwnershipError) {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }
  if (error instanceof NamespaceNotReadyError) {
    return failure(
      409,
      "NAMESPACE_NOT_READY",
      "The requested Namespace is not ready for deployment.",
    );
  }
  if (error instanceof NamespaceNotEmptyError) {
    const contents =
      error.contents.length === 0 ? "" : ` It still contains: ${error.contents.join(", ")}.`;
    return failure(409, "NAMESPACE_NOT_EMPTY", `The requested Namespace is not empty.${contents}`);
  }
  if (error instanceof AgentDeletingError) {
    return failure(409, "AGENT_DELETING", "The requested Agent is being deleted.");
  }
  if (error instanceof NotImplementedError) {
    return failure(501, "NOT_IMPLEMENTED", error.message);
  }
  if (error instanceof PostgresCommitOutcomeUnknownError) {
    return failure(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
    );
  }
  if (isDependencyUnavailable(error)) {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }
  if (error instanceof ResourceStateConflictError) {
    return failure(409, "RESOURCE_CONFLICT", error.message);
  }
  if (error instanceof ResourceConflictError) {
    return failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.");
  }
  if (error instanceof ScopeViolationError) {
    return failure(404, "NOT_FOUND", "The requested platform resource was not found.");
  }
  if (error instanceof DeletionRetryOwnedError) {
    // The caller holds delete on this exact resource; only the retry condition is named.
    return failure(403, "FORBIDDEN", error.message);
  }
  if (error instanceof AgentPrincipalAuthorizationError) {
    // Only the Agent's own principal is named; caller denials stay generic below.
    return failure(403, "FORBIDDEN", error.message);
  }
  if (isAuthorizationDenied(error)) {
    return failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
  }
  if (error instanceof Error) {
    const candidate = error as FastifyError;
    if (error.name === "APIError") {
      const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
      const status = typeof statusCode === "number" ? statusCode : 500;
      if (status === 409) {
        return failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.");
      }
      if (status === 400) {
        return failure(
          400,
          "INVALID_REQUEST",
          "The request does not match the operation contract.",
        );
      }
      if (status === 401) {
        return failure(401, "UNAUTHENTICATED", "The caller did not provide valid credentials.");
      }
      if (status === 403) {
        return failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
      }
      return failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
    if (candidate.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return failure(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the permitted size.");
    }
    if (candidate.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return failure(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.");
    }
    if (
      candidate.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      candidate.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" ||
      candidate.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      candidate.statusCode === 400
    ) {
      const details = validationDetails(candidate);
      return failure(
        400,
        "INVALID_REQUEST",
        contractMessage(candidate, details),
        details.length > 0 ? details : undefined,
      );
    }
    if (error.name === "AdmissionFailure") {
      const status =
        candidate.statusCode === 403 || (candidate as { status?: number }).status === 403
          ? 403
          : 401;
      const reason = (candidate as { reason?: unknown }).reason;
      return failure(
        status,
        status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        status === 403
          ? reason === "untrusted_origin"
            ? "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header."
            : "The request did not satisfy the configured admission boundary."
          : "The caller did not provide valid admission evidence.",
      );
    }
  }
  return failure(500, "INTERNAL_ERROR", "The platform request could not be completed.");
}
