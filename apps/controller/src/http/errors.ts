import type { FastifyError, FastifyReply } from "fastify";
import { PresetValidationError } from "@openclaw-enterprise/contracts";
import { UNTRUSTED_ORIGIN_MESSAGE } from "../admission/admission-verifier.ts";
import {
  AgentCredentialSourceBindingError,
  AgentDeletingError,
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  DeletionRetryOwnedError,
  ChannelDirectoryError,
  ChannelCredentialError,
  ConfigurationHarnessError,
  CredentialGatewayNotConfiguredError,
  CredentialSourceDriverError,
  DependencyUnavailableError,
  DeviceAuthorizationStartError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  ModelCredentialValueError,
  ModelDiscoveryError,
  ModelProviderSettingError,
  PluginDiscoveryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NotImplementedError,
  NativeWorkerSupportError,
  PluginPolicyValidationError,
  PostgresCommitOutcomeUnknownError,
  ResourceConflictError,
  ResourceStateConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsError,
  ScopeViolationError,
  SecretBindingValidationError,
  SecretDriverOwnershipError,
  SecretValueError,
  ServiceAccountDriverNotConfiguredError,
  type RuntimeLogsErrorCode,
} from "@openclaw-enterprise/occ";
import {
  ConfigurationOwnershipError,
  ConfigurationValidationError,
} from "../drivers/configuration/kubernetes/index.ts";
import {
  collapseScalarUnions,
  jsonPointer,
  type ContractProblem,
  type ErrorDetail,
  type ValidationEntry,
} from "./error-details.ts";

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

/**
 * One INVALID_VALUE detail for a submitted object key under `parent`. The error contract
 * caps detail paths at 512 characters; a key too long to fit points at `parent` instead.
 */
function pointerDetail(
  parent: string,
  key: string,
  code: ErrorDetail["code"] = "INVALID_VALUE",
): readonly ErrorDetail[] {
  const path = `${parent}/${jsonPointer(key.replaceAll("\u0000", "?").replace(/\p{Cs}/gu, "?"))}`;
  return [{ path: path.length <= 512 ? path : parent, code }];
}

/**
 * Caps a JSON Pointer, given as its escaped segments, at the 512 characters that the error
 * contract allows for detail paths. It keeps whole leading segments, so a cut path still
 * names an ancestor of the offending field, or as much of the first one as fits (cut between
 * escapes and whole characters).
 */
function cappedPointer(segments: readonly string[]): string {
  let path = "";
  for (const segment of segments) {
    if (path.length + segment.length + 1 <= 512) {
      path += `/${segment}`;
      continue;
    }
    if (path === "") {
      path = "/";
      for (const piece of segment.match(/~[01]|[^]/gu) ?? []) {
        if (path.length + piece.length > 512) {
          break;
        }
        path += piece;
      }
    }
    break;
  }
  return path;
}

/** `cappedPointer` for a whole JSON Pointer, such as an Ajv instance path. */
export function cappedPath(pointer: string): string {
  return pointer.length <= 512 ? pointer : cappedPointer(pointer.split("/").slice(1));
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
      // Some messages come from Drivers or name submitted values; none may break the cap.
      message: capped(error.message),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    meta: { requestId: reply.request.id },
  });
}

// Ajv runs in verbose mode (index.ts), so each entry also holds the request value it judged
// (`data`, which can be a token or a whole body) and its schema. Problems are built from paths
// and schema values only; once they are, drop those fields so that nothing that later logs or
// serializes the error can carry request values.
function forgetValidationValues(entries: readonly ValidationEntry[]): void {
  for (const entry of entries) {
    const verbose = entry as { data?: unknown; schema?: unknown; parentSchema?: unknown };
    delete verbose.data;
    delete verbose.schema;
    delete verbose.parentSchema;
  }
}

// Runs once per error (the app's error handler): a discriminated union is read from the
// verbose fields that this drops, so a second call would report every shape again.
function validationProblems(error: FastifyError): readonly ContractProblem[] {
  if (!Array.isArray(error.validation)) {
    return [];
  }
  // Shapes that fail the same way report the same problem; list it once, in first-seen order.
  const seen = new Set<string>();
  // Instance paths name submitted object keys, such as an unknown field or a map entry, so
  // they are capped like other detail paths.
  const problems = collapseScalarUnions(error.validation)
    .map((problem): ContractProblem => {
      const path = cappedPath(problem.detail.path);
      // Dropped segments make the path an ancestor of the field. A cut inside one long first key
      // still names that key, so it keeps the field's own wording.
      const shortened = path.split("/").length < problem.detail.path.split("/").length;
      return { ...problem, detail: { ...problem.detail, path }, shortened };
    })
    .filter(({ detail, expected, shortened }) => {
      const key = JSON.stringify([detail.path, detail.code, expected, shortened]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 32);
  forgetValidationValues(error.validation);
  return problems;
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

// A path that lost segments to the cap names an ancestor of the offending field, which may
// well be accepted, so the message places the problem inside it.
const SHORTENED_PATH_PROBLEMS: Readonly<Record<ErrorDetail["code"], string>> = Object.freeze({
  REQUIRED: "or an object under it is missing a required field",
  UNKNOWN_FIELD: "contains a field that is not accepted",
  INVALID_TYPE: "contains a field that has the wrong type",
  INVALID_FORMAT: "contains a field that has an invalid format",
  INVALID_VALUE: "contains a field that has an unsupported value",
  TOO_LONG: "contains a field that is too long",
  TOO_DEEP: "contains a field that is nested too deeply",
});

// The error contract caps messages at 256 characters.
const MESSAGE_CAP = 256;
// The shortest cut path a message shows when it lists more than one problem, and when it
// shows only one (a character and the ellipsis).
const MIN_SHOWN_PATH = 32;
const MIN_SOLE_PATH = 2;

// Names the first few offending fields so clients that print only the message, such as
// occ, still show which field to fix. The full list stays in `details`.
function contractMessage(error: FastifyError, found: readonly ContractProblem[]): string {
  if (found.length === 0) {
    return "The request does not match the operation contract.";
  }
  const context =
    typeof error.validationContext === "string" && error.validationContext.length > 0
      ? `${error.validationContext} `
      : "";
  const seen = new Set<string>();
  const problems: { readonly path: string; readonly wording: string }[] = [];
  for (const problem of found) {
    const path = `${context}${problem.detail.path || "/"}`;
    const wording = ` ${
      (problem.shortened === true ? SHORTENED_PATH_PROBLEMS : DETAIL_PROBLEMS)[problem.detail.code]
    }${problem.expected === undefined ? "" : ` (expected ${problem.expected})`}`;
    if (!seen.has(path + wording)) {
      seen.add(path + wording);
      problems.push({ path, wording });
    }
  }
  const prefix = "The request does not match the operation contract: ";
  // Long paths are cut before any wording is: show fewer problems rather than cut any path
  // below MIN_SHOWN_PATH, so each shown problem keeps its path start and its whole wording.
  for (let count = Math.min(problems.length, 3); count >= 1; count -= 1) {
    const shown = problems.slice(0, count);
    const more = problems.length > count ? `; and ${problems.length - count} more` : "";
    const fixed = `${prefix}${shown.map(({ wording }) => wording).join("; ")}${more}.`;
    const paths = pathsWithin(
      shown.map(({ path }) => path),
      MESSAGE_CAP - Array.from(fixed).length,
      count === 1 ? MIN_SOLE_PATH : MIN_SHOWN_PATH,
    );
    if (paths !== undefined) {
      const listed = shown.map(({ wording }, index) => `${paths[index]}${wording}`).join("; ");
      return capped(`${prefix}${listed}${more}.`);
    }
  }
  // Wording too long for the cap even with the shortest cut path (none is today): cut the
  // message end.
  const listed = problems
    .slice(0, 3)
    .map(({ path, wording }) => `${path}${wording}`)
    .join("; ");
  const more = problems.length > 3 ? `; and ${problems.length - 3} more` : "";
  return capped(`${prefix}${listed}${more}.`);
}

/**
 * Cuts the longest of `paths` first, each to the same length ending in "…", so that together
 * they take at most `budget` characters. Paths that fit stay whole. Returns undefined when a
 * cut path would be shorter than `minimum` characters. Counts code points, so a cut never
 * leaves half of a surrogate pair; it can split a `~0` or `~1` escape, which `details` keeps.
 */
function pathsWithin(
  paths: readonly string[],
  budget: number,
  minimum: number,
): readonly string[] | undefined {
  const characters = paths.map((path) => Array.from(path));
  if (characters.reduce((total, path) => total + path.length, 0) <= budget) {
    return paths;
  }
  // The largest length that every longer path can be cut to.
  let left = budget;
  let longer = characters.length;
  let length = 0;
  for (const size of characters.map((path) => path.length).sort((a, b) => a - b)) {
    if (size * longer > left) {
      length = Math.floor(left / longer);
      break;
    }
    left -= size;
    longer -= 1;
  }
  if (length < minimum) {
    return undefined;
  }
  return characters.map((path) =>
    path.length <= length ? path.join("") : `${path.slice(0, length - 1).join("")}…`,
  );
}

/**
 * Puts `path` between `before` and `after`, cutting the path so that the whole message fits
 * the cap and `after`, the problem wording, stays whole.
 */
function pathMessage(before: string, path: string, after: string): string {
  const [shown] = pathsWithin(
    [path],
    MESSAGE_CAP - Array.from(before + after).length,
    MIN_SOLE_PATH,
  ) ?? [path];
  return capped(`${before}${shown}${after}`);
}

// Any message longer than the cap is cut at its end; contract messages cut paths first.
// Control and format characters from submitted object keys are replaced, and the cut keeps whole characters.
function capped(message: string): string {
  const characters = Array.from(message.replace(/[\p{Cc}\p{Cf}]/gu, "?"));
  return characters.length <= MESSAGE_CAP
    ? characters.join("")
    : `${characters.slice(0, MESSAGE_CAP - 1).join("")}…`;
}

// In Unicode mode, `\p{Cs}` matches only a surrogate that is not part of a pair.
const UNPAIRED_SURROGATE = /\p{Cs}/u;

function unstorableText(value: string): "nul" | "surrogate" | undefined {
  return value.includes("\u0000")
    ? "nul"
    : UNPAIRED_SURROGATE.test(value)
      ? "surrogate"
      : undefined;
}

/**
 * PostgreSQL text and jsonb cannot hold U+0000, and UTF-8 has no encoding for an unpaired
 * UTF-16 surrogate: text stores U+FFFD in its place and jsonb rejects it. Refuses either one
 * in any string or object key of `value` (path parameters or a parsed JSON body), so the
 * caller gets a 400 instead of a 500 or 503 from the database, or a name stored differently
 * from the one it was shown. It names the first offender in document order. Detail codes
 * follow the workspace file content rule: a NUL is INVALID_FORMAT (as a `^[^\u0000]*$`
 * pattern reports it), a surrogate INVALID_VALUE. The walk is iterative because a body can
 * nest deeply.
 */
export function unstorableTextFailure(
  context: "params" | "body",
  value: unknown,
): RequestFailure | undefined {
  interface Node {
    readonly value: unknown;
    readonly parent?: Node;
    readonly key?: string;
  }
  const pending: Node[] = [{ value }];
  let found: { readonly node: Node; readonly problem: "nul" | "surrogate" } | undefined;
  while (found === undefined && pending.length > 0) {
    const node = pending.pop()!;
    // A key is checked when its entry is visited, so keys and values share document order.
    const problem =
      (node.key === undefined ? undefined : unstorableText(node.key)) ??
      (typeof node.value === "string" ? unstorableText(node.value) : undefined);
    if (problem !== undefined) {
      found = { node, problem };
    } else if (node.value !== null && typeof node.value === "object") {
      const entries = Array.isArray(node.value)
        ? node.value.map((entry, index) => [String(index), entry] as const)
        : Object.entries(node.value);
      // Reversed onto the stack, so the walk reports the first offender in document order.
      // (A loop, not push(...entries): a large array would exceed the argument limit.)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entry] = entries[index]!;
        pending.push({ value: entry, parent: node, key });
      }
    }
  }
  if (found === undefined) {
    return undefined;
  }
  const segments: string[] = [];
  for (let node: Node | undefined = found.node; node?.key !== undefined; node = node.parent) {
    segments.push(jsonPointer(node.key.replaceAll("\u0000", "?").replace(/\p{Cs}/gu, "?")));
  }
  segments.reverse();
  const path = cappedPointer(segments);
  const nul = found.problem === "nul";
  return failure(
    400,
    "INVALID_REQUEST",
    pathMessage(
      `The request does not match the operation contract: ${context} `,
      path || "/",
      ` contains ${nul ? "a NUL character" : "an unpaired UTF-16 surrogate"}.`,
    ),
    [{ path, code: nul ? "INVALID_FORMAT" : "INVALID_VALUE" }],
  );
}

/**
 * Names each remaining kind and as many of its resource IDs as fit the 256-character
 * message contract; a kind whose IDs do not all fit says how many are left.
 */
function namespaceNotEmptyMessage(error: NamespaceNotEmptyError): string {
  const prefix = "The requested Namespace is not empty.";
  if (error.contents.length === 0) {
    return prefix;
  }
  const shown = new Map(error.contents.map((kind) => [kind, 0]));
  const render = (): string => {
    const parts = error.contents.map((kind) => {
      const ids = error.ids[kind] ?? [];
      const count = shown.get(kind) ?? 0;
      if (ids.length === 0) {
        return kind;
      }
      if (count === 0) {
        return `${kind} (${ids.length})`;
      }
      const more = ids.length - count;
      return `${kind} (${ids.slice(0, count).join(", ")}${more === 0 ? "" : ` and ${more} more`})`;
    });
    return `${prefix} It still contains: ${parts.join(", ")}.`;
  };
  // Add one ID per kind in turn, so a kind with many IDs cannot crowd out the ones after it
  // (Configurations, the kind with no list route). A kind whose next ID does not fit is done.
  const kinds = new Set(error.contents);
  const done = new Set<string>();
  while (done.size < kinds.size) {
    for (const kind of kinds) {
      const count = shown.get(kind) ?? 0;
      if (done.has(kind)) {
        continue;
      }
      shown.set(kind, count + 1);
      if (count + 1 > (error.ids[kind]?.length ?? 0) || Array.from(render()).length > 256) {
        shown.set(kind, count);
        done.add(kind);
      }
    }
  }
  return capped(render());
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
  if (error instanceof RuntimeCredentialsForbiddenByClusterError) {
    return failure(
      503,
      "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
      "The cluster denied OCC access needed for this Agent's runtime credentials. Ask a platform operator to grant the API ServiceAccount the documented tenant RoleBindings in the Agent's Kubernetes namespaces.",
    );
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
      // The Channel Driver's path can name a submitted account key.
      [{ path: cappedPath(error.path), code: "INVALID_VALUE" }],
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
  if (error instanceof DeviceAuthorizationStartError) {
    // Device login starts at auth.openai.com from the API Pods, which the chart's default
    // network policy does not allow, so name that cause when no connection was made.
    return failure(
      503,
      "DEPENDENCY_UNAVAILABLE",
      error.reason === "unreachable"
        ? "OCC could not reach the sign-in service at auth.openai.com. An operator must allow HTTPS egress from the API Pods to it (Helm api.modelDiscoveryCidrs or the cluster's egress policy), then try again."
        : "The sign-in service could not start device login. Try again.",
    );
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
      { path: cappedPath(error.path), code: "INVALID_VALUE" },
    ]);
  }
  if (error instanceof IAMRoleInUseError) {
    return failure(409, "RESOURCE_CONFLICT", error.message);
  }
  if (error instanceof CredentialGatewayNotConfiguredError) {
    return failure(409, "CREDENTIAL_GATEWAY_NOT_CONFIGURED", error.message);
  }
  if (error instanceof ServiceAccountDriverNotConfiguredError) {
    // A fixed message naming the fix; raised only after the account's grant and lookup.
    return failure(409, "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED", error.message);
  }
  if (error instanceof SecretValueError) {
    return failure(400, "INVALID_REQUEST", error.message, [{ path: "/value", code: error.code }]);
  }
  if (error instanceof ConfigurationHarnessError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof AgentCredentialSourceBindingError) {
    // Either field can break the rule (an update may drop the source from the list), so
    // the message names it and no detail points at one field.
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof SecretBindingValidationError) {
    // The message names the rule, and the detail the submitted destination key.
    const { destination } = error;
    return failure(
      400,
      "INVALID_REQUEST",
      error.message,
      destination === undefined
        ? undefined
        : destination.key === undefined
          ? [{ path: destination.bindingsPath, code: destination.code }]
          : pointerDetail(destination.bindingsPath, destination.key, destination.code),
    );
  }
  if (error instanceof NativeWorkerSupportError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof PluginPolicyValidationError) {
    return failure(
      400,
      "INVALID_REQUEST",
      error.message,
      error.pluginId === undefined ? undefined : pointerDetail("/plugins", error.pluginId),
    );
  }
  if (error instanceof PresetValidationError && error instanceof Error) {
    // Preset messages name the template path (including submitted object keys) and the
    // rule, not submitted values.
    return failure(400, "INVALID_REQUEST", capped(error.message));
  }
  if (error instanceof ModelCredentialValueError || error instanceof ModelProviderSettingError) {
    // The message names only the field; other Configuration validation stays generic.
    // The field's path includes a submitted provider name, so it is capped like other
    // messages that name submitted object keys.
    return failure(400, "INVALID_REQUEST", capped(error.message));
  }
  if (error instanceof ConfigurationValidationError) {
    return failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.");
  }
  if (error instanceof ConfigurationOwnershipError) {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }
  if (error instanceof NamespaceNotReadyError) {
    return failure(409, "NAMESPACE_NOT_READY", "The requested Namespace is not ready.");
  }
  if (error instanceof NamespaceNotEmptyError) {
    return failure(409, "NAMESPACE_NOT_EMPTY", namespaceNotEmptyMessage(error));
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
  if (error instanceof SecretDriverOwnershipError) {
    // A fixed message naming the path's fix; raised only after the Secret's grant and lookup.
    return failure(503, "DEPENDENCY_UNAVAILABLE", error.message);
  }
  if (error instanceof CredentialSourceDriverError) {
    // A fixed message naming the fix; raised only after the source's grant and lookup.
    return failure(503, "DEPENDENCY_UNAVAILABLE", error.message);
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
      const problems = validationProblems(candidate);
      return failure(
        400,
        "INVALID_REQUEST",
        contractMessage(candidate, problems),
        problems.length > 0 ? problems.map(({ detail }) => detail) : undefined,
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
            ? UNTRUSTED_ORIGIN_MESSAGE
            : "The request did not satisfy the configured admission boundary."
          : "A valid session cookie or service API key is required: the credential sent is missing, invalid, expired, or revoked. Send service API keys in the x-api-key header; Authorization bearer tokens are not accepted.",
      );
    }
  }
  return failure(500, "INTERNAL_ERROR", "The platform request could not be completed.");
}
