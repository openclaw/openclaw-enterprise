import type { FastifyError, FastifyReply } from "fastify";
import { PresetValidationError } from "@openclaw-enterprise/contracts";
import {
  AgentDeletingError,
  AuthorizationDeniedError,
  ChannelDirectoryError,
  DependencyUnavailableError,
  ModelDiscoveryError,
  PluginDiscoveryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  PluginPolicyValidationError,
  ResourceConflictError,
  ScopeViolationError,
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

export function requestFailure(error: unknown): RequestFailure {
  if (error instanceof RequestFailure) {
    return error;
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
    return failure(409, "NAMESPACE_NOT_EMPTY", "The requested Namespace is not empty.");
  }
  if (error instanceof AgentDeletingError) {
    return failure(409, "AGENT_DELETING", "The requested Agent is being deleted.");
  }
  if (error instanceof NotImplementedError) {
    return failure(501, "NOT_IMPLEMENTED", error.message);
  }
  if (isDependencyUnavailable(error)) {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }
  if (error instanceof ResourceConflictError) {
    return failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.");
  }
  if (error instanceof ScopeViolationError) {
    return failure(404, "NOT_FOUND", "The requested platform resource was not found.");
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
        "The request does not match the operation contract.",
        details.length > 0 ? details : undefined,
      );
    }
    if (error.name === "AdmissionFailure") {
      const status =
        candidate.statusCode === 403 || (candidate as { status?: number }).status === 403
          ? 403
          : 401;
      return failure(
        status,
        status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        status === 403
          ? "The request did not satisfy the configured admission boundary."
          : "The caller did not provide valid admission evidence.",
      );
    }
  }
  return failure(500, "INTERNAL_ERROR", "The platform request could not be completed.");
}
