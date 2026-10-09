import type {
  AuthorizationEvidence,
  AuthorizationRequest,
  ResourceRef,
  SecretConsumers,
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
 * A permanently failed deletion belongs to the actor that started it. Another caller that
 * also holds delete may take it over only after the initiating actor loses delete, so the
 * refusal names that condition and, for audit only, the initiating actor.
 */
export class DeletionRetryOwnedError extends AuthorizationDeniedError {
  readonly initiatingActorId: string;
  declare readonly authorization: {
    readonly action: AuthorizationRequest["action"];
    readonly resource: ResourceRef;
  };

  constructor(initiatingActorId: string, resource: ResourceRef) {
    super(
      "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.",
      undefined,
      { action: "delete", resource },
    );
    this.name = "DeletionRetryOwnedError";
    this.initiatingActorId = initiatingActorId;
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

/**
 * A Secret the selected Secret Driver cannot serve, typically one stored through a driver the
 * Installation no longer selects. Each subclass is raised only after the caller's grant and the
 * Secret lookup, so it reveals nothing a 403 or 404 hides, and carries a fixed message naming
 * the fix for its own path. HTTP returns that message; every other 503 keeps the generic text.
 */
export abstract class SecretDriverOwnershipError extends DependencyUnavailableError {}

/**
 * A Configuration Secret binding the selected Secret Driver cannot serve. Only a Configuration
 * write can replace the binding, so the fixed message says so.
 */
export class SecretBindingDriverError extends SecretDriverOwnershipError {
  constructor() {
    super(
      "The selected Secret Driver does not own a Secret the Configuration binds. Bind only Secrets stored through the selected driver: update the Configuration's secretBindings, or assign the Agent another Configuration.",
    );
    this.name = "SecretBindingDriverError";
  }
}

/**
 * An Agent's requested or bound Harness authentication Secret the selected Secret Driver cannot
 * serve. The Agent's `harnessAuth` must name another Secret.
 */
export class HarnessAuthSecretDriverError extends SecretDriverOwnershipError {
  constructor() {
    super(
      "The selected Secret Driver does not own the Harness authentication Secret. Bind a Secret stored through the selected driver: set harnessAuth to another Secret, or create a new Secret with the key and bind that.",
    );
    this.name = "HarnessAuthSecretDriverError";
  }
}

/**
 * A Secret an Agent provisioning request or its accepted work uses that the selected Secret
 * Driver cannot serve. Accepted work keeps its inputs, so only a new request can replace it.
 */
export class ProvisioningSecretDriverError extends SecretDriverOwnershipError {
  constructor() {
    super(
      "The selected Secret Driver does not own a Secret this Agent provisioning uses. Use only Secrets stored through the selected driver: save replacement Secrets and submit a new provisioning request with them.",
    );
    this.name = "ProvisioningSecretDriverError";
  }
}

const SECRET_STORAGE_DRIVER_MESSAGES = Object.freeze({
  update:
    "The selected Secret Driver does not own this Secret, so its value cannot be updated. Create a new Secret with the value through the selected driver and bind it in place of this one.",
  delete:
    "The selected Secret Driver does not own this Secret, so its stored value cannot be deleted. Delete it once the Installation again selects the Secret Driver that stored it.",
});

/**
 * An exact Secret update or delete the selected Secret Driver cannot perform: OCC never writes or
 * removes a value through a driver that does not own it.
 */
export class SecretStorageDriverError extends SecretDriverOwnershipError {
  readonly operation: keyof typeof SECRET_STORAGE_DRIVER_MESSAGES;

  constructor(operation: keyof typeof SECRET_STORAGE_DRIVER_MESSAGES) {
    super(SECRET_STORAGE_DRIVER_MESSAGES[operation]);
    this.name = "SecretStorageDriverError";
    this.operation = operation;
  }
}

/**
 * A credential source registered through a Credential Gateway Driver the Installation no longer
 * selects. OCC never binds, deploys, updates or deletes a source through a driver that did not
 * register it. Raised only after the caller's grant and the source lookup, so it reveals nothing
 * a 403 or 404 hides; one fixed message names the fix on every path. An Installation with no
 * Credential Gateway, or a selected one that is unusable, is not this error.
 */
export class CredentialSourceDriverError extends DependencyUnavailableError {
  constructor() {
    super(
      "The selected Credential Gateway Driver did not register this credential source. Bind a replacement registered through the selected driver instead. To update or delete this source, an administrator must first re-select the driver that registered it.",
    );
    this.name = "CredentialSourceDriverError";
  }
}

/**
 * A running Agent has no active revision yet (its first deployment, or a redeploy after a
 * stop, is still activating). A lifecycle state, not an outage; it stays a
 * DependencyUnavailableError so callers that need a revision still answer 503.
 */
export class NoActiveAgentRevisionError extends DependencyUnavailableError {
  constructor() {
    super("The Agent has no active gateway revision.");
    this.name = "NoActiveAgentRevisionError";
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

/**
 * Device login could not start. `reason` is `unreachable` when the API could not open a
 * connection to the sign-in service (DNS, refused, reset, timeout), else `unavailable`.
 * `failure` is a bounded class for the server log only (an error code such as
 * `ECONNREFUSED`, `TimeoutError` or `HTTP_503`); no provider body or message is kept.
 */
export class DeviceAuthorizationStartError extends Error {
  readonly reason: "unreachable" | "unavailable";
  readonly failure: string;

  constructor(reason: DeviceAuthorizationStartError["reason"], failure = "unclassified") {
    super("Device login could not start.");
    this.name = "DeviceAuthorizationStartError";
    this.reason = reason;
    this.failure = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(failure) ? failure : "unclassified";
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
 * Admitted Configuration content cannot select a supported Harness runtime, or a
 * provisioning request names an execution mode the Compute Driver does not provision
 * (public through the Installation capabilities). The caller can already see what the
 * message names, so HTTP reports it as an invalid request instead of hiding it as a
 * scope miss.
 */
export class ConfigurationHarnessError extends ScopeViolationError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationHarnessError";
  }
}

/**
 * An Agent's `harnessAuth` names a credential source its `credentialSources` list does not
 * hold. OCC raises it only after every source authorization, and the rule depends only on
 * the request and the Agent the caller may already update, so HTTP reports it as an invalid
 * request instead of hiding it as a scope miss.
 */
export class AgentCredentialSourceBindingError extends ScopeViolationError {
  constructor() {
    super("The Harness credential source must be listed in the Agent's credentialSources.");
    this.name = "AgentCredentialSourceBindingError";
  }
}

/**
 * A request names an invalid Secret binding: Agent provisioning or a Configuration write
 * with a reserved or invalid environment destination or an unsupported binding shape
 * (including missing, runtime or credential-source Harness authentication in Agent
 * provisioning), or
 * any of those, an Agent's Harness authentication, a credential source, or plugin discovery
 * naming a Secret in another Namespace. Messages are static, so HTTP reports them as an
 * invalid request instead of hiding them as a scope miss; Secret existence is still checked
 * later and stays a scope miss.
 */
export class SecretBindingValidationError extends ScopeViolationError {
  /**
   * The submitted destination key that broke a destination rule, and the JSON Pointer of
   * the binding map that holds it. Never a Secret value or ID.
   */
  readonly destination?: {
    readonly bindingsPath: string;
    /** Absent for a malformed key, which is not echoed; the detail points at the map. */
    readonly key?: string;
    readonly code: "INVALID_FORMAT" | "INVALID_VALUE";
  };

  constructor(message: string, destination?: SecretBindingValidationError["destination"]) {
    super(message);
    this.name = "SecretBindingValidationError";
    if (destination !== undefined) {
      this.destination = Object.freeze({ ...destination });
    }
  }
}

/**
 * Builds a message that names a Configuration field. The error contract caps messages at
 * 256 characters; a long provider name shortens the path. The cut counts code points, so it
 * never leaves half of a surrogate pair.
 */
function configurationFieldMessage(path: string, message: (path: string) => string): string {
  const budget = 256 - message("").length;
  const characters = Array.from(path);
  return message(
    characters.length <= budget ? path : `${characters.slice(0, budget - 1).join("")}…`,
  );
}

/**
 * Builds a message that names the Configuration setting `<parent>.<key>`. A submitted key can
 * hold any character: control, format, line and paragraph separator characters show as ?, a
 * key that is not a plain ID is quoted, and a long key shortens the path to fit the
 * 256-character cap.
 */
function keyedSettingMessage(
  parent: string,
  key: string,
  message: (path: string) => string,
): string {
  const shown = key.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Cs}/gu, "?");
  const path = /^[A-Za-z0-9_-]+$/.test(shown)
    ? `${parent}.${shown}`
    : `${parent}[${JSON.stringify(shown)}]`;
  return configurationFieldMessage(path, message);
}

/** Builds a message that names the Configuration setting `agents.entries.<key>`. */
export function agentEntryMessage(key: string, message: (path: string) => string): string {
  return keyedSettingMessage("agents.entries", key, message);
}

/** Builds a message that names the Configuration setting `models.providers.<key>`. */
export function modelProviderMessage(key: string, message: (path: string) => string): string {
  return keyedSettingMessage("models.providers", key, message);
}

const modelCredentialMessage = (path: string): string =>
  `Configuration field ${path} holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.`;

/**
 * A literal credential in a known model credential field of Configuration values. The
 * message names the field's JSON pointer and never the value, so HTTP returns it.
 */
export class ModelCredentialValueError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(configurationFieldMessage(path, modelCredentialMessage));
    this.name = "ModelCredentialValueError";
    this.path = path;
  }
}

const modelProviderSettingMessages = {
  baseUrl: (path: string): string =>
    `Configuration field ${path} must be an absolute http or https URL.`,
  api: (path: string): string =>
    `Configuration field ${path} must name a model API the runtime supports, such as openai-responses, openai-completions or anthropic-messages.`,
} as const;

/**
 * A model provider `baseUrl` or `api` in Configuration values that the runtime cannot
 * use. The message names the field's JSON pointer and the expected form, never the value.
 */
export class ModelProviderSettingError extends Error {
  readonly path: string;

  constructor(path: string, setting: keyof typeof modelProviderSettingMessages) {
    super(configurationFieldMessage(path, modelProviderSettingMessages[setting]));
    this.name = "ModelProviderSettingError";
    this.path = path;
  }
}

export class ResourceConflictError extends ScopeViolationError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceConflictError";
  }
}

/**
 * A conflict raised only after the caller was authorized on the resource, whose message
 * names what blocks the operation. HTTP returns that message instead of the generic text.
 */
export class ResourceStateConflictError extends ResourceConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceStateConflictError";
  }
}

const SECRET_CONSUMER_LABELS = [
  ["agents", "Agent", "Agents"],
  ["configurations", "Configuration", "Configurations"],
  ["credentialSources", "credential source", "credential sources"],
  [
    "provisioningRequests",
    "pending Agent provisioning request",
    "pending Agent provisioning requests",
  ],
] as const satisfies readonly (readonly [keyof SecretConsumers, string, string])[];

/** The HTTP error contract caps messages at 256 characters. */
const SECRET_REFERENCED_MESSAGE_LIMIT = 256;

/**
 * Names each kind of readable reference and as many of its IDs as fit the message cap,
 * one ID per kind in turn, so many Agents cannot crowd out a Configuration. References the
 * caller cannot read are only counted. The Secret's `consumers` on GET has the full list.
 */
function secretReferencedMessage(consumers: Readonly<SecretConsumers>): string {
  const kinds = SECRET_CONSUMER_LABELS.filter(([key]) => consumers[key].length > 0);
  const shown = new Map<string, number>(kinds.map(([key]) => [key, 0]));
  const suffix =
    consumers.provisioningRequests.length > 0
      ? "Remove those references, or let provisioning finish, first."
      : "Remove those references first.";
  const render = (): string => {
    const parts: string[] = kinds.map(([key, singular, plural]) => {
      const ids = consumers[key];
      const label = ids.length === 1 ? singular : plural;
      const count = shown.get(key) ?? 0;
      if (count === 0) {
        return `${label} (${ids.length})`;
      }
      const more = ids.length - count;
      return `${label} ${ids.slice(0, count).join(", ")}${more === 0 ? "" : ` and ${more} more`}`;
    });
    if (consumers.unreadable > 0) {
      parts.push(
        `${consumers.unreadable} ${consumers.unreadable === 1 ? "resource" : "resources"} you cannot read`,
      );
    }
    if (consumers.truncated) {
      parts.push("and more");
    }
    return `The Secret is still referenced by ${parts.join("; ")}. ${suffix}`;
  };
  // Counts alone fit today (at most SECRET_CONSUMER_LIMIT references); the fallback below
  // keeps the HTTP contract if a label or that limit grows.
  const done = new Set<string>();
  while (done.size < kinds.length) {
    for (const [key] of kinds) {
      if (done.has(key)) {
        continue;
      }
      const count = shown.get(key) ?? 0;
      shown.set(key, count + 1);
      if (count + 1 > consumers[key].length || render().length > SECRET_REFERENCED_MESSAGE_LIMIT) {
        shown.set(key, count);
        done.add(key);
      }
    }
  }
  const message = render();
  return message.length <= SECRET_REFERENCED_MESSAGE_LIMIT
    ? message
    : `The Secret is still referenced by other resources. ${suffix}`;
}

/**
 * Secret deletion found current references. Raised only after the delete authorization;
 * the message names the references the caller may read and counts the others.
 */
export class SecretReferencedError extends ResourceStateConflictError {
  readonly consumers: Readonly<SecretConsumers>;

  constructor(consumers: Readonly<SecretConsumers>) {
    super(secretReferencedMessage(consumers));
    this.name = "SecretReferencedError";
    this.consumers = consumers;
  }
}

/**
 * The Compute Driver refuses a gateway setting in the caller's own Configuration that it
 * cannot provision, such as `gateway.auth.mode` or `gateway.trustedProxies`. Like the
 * Configuration errors above, the message names the setting and what the Driver accepts,
 * never a submitted value, so HTTP returns it with the 409 that other plan refusals use,
 * and provisioning status keeps it. Raised only after the caller was authorized.
 */
export class ComputeGatewaySettingError extends ResourceStateConflictError {
  readonly setting: string;

  constructor(setting: string, requirement: string) {
    // A submitted key can be part of the setting's path; status stores this message as is.
    const shown = setting.replace(/[\p{Cc}\p{Cf}]|\p{Cs}/gu, "?");
    super(
      configurationFieldMessage(shown, (path) => `Configuration setting ${path} ${requirement}.`),
    );
    this.name = "ComputeGatewaySettingError";
    this.setting = setting;
  }
}

const COMPUTE_PROVISIONING_REFUSED =
  "The Compute Driver cannot provision this execution mode or gateway configuration.";

/**
 * Any other Compute Driver refusal of a provisioning plan, such as an Installation gateway or
 * routing setting. Its cause may name Installation configuration, so the caller gets fixed
 * text; HTTP logs `reason` (bounded) with the request ID for the operator.
 */
export class ComputeProvisioningRefusedError extends ResourceStateConflictError {
  readonly reason: string;

  constructor(cause: unknown) {
    super(COMPUTE_PROVISIONING_REFUSED);
    this.name = "ComputeProvisioningRefusedError";
    const reason = cause instanceof Error ? cause.message : "The Compute Driver refused the plan.";
    this.reason = Array.from(reason).slice(0, 512).join("");
  }
}

/*
 * Duplicate caller-chosen names, shared by the memory and PostgreSQL stores so both report
 * them alike. Each is raised only after the caller was authorized to create (or rename) that
 * resource kind in that scope, and the 409 already revealed that the name is taken, so naming
 * the kind discloses nothing new.
 */
export const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
export const SECRET_NAME_CONFLICT =
  "A Secret with this name already exists in this Namespace. Choose a different name.";
export const PRESET_NAME_CONFLICT =
  "A Preset with this name already exists in this Namespace. Choose a different name.";
export const SERVICE_ACCOUNT_NAME_CONFLICT =
  "A ServiceAccount with this name already exists in this Namespace. Choose a different name.";
export const CREDENTIAL_SOURCE_NAME_CONFLICT =
  "A credential source with this name already exists in this Namespace. Choose a different name.";
export const NAMESPACE_NAME_CONFLICT =
  "A Namespace with this name already exists. Choose a different name.";
/** A deleted Namespace's tombstone keeps its name, so a name can be taken by one no longer listed. */
export const DELETED_NAMESPACE_NAME_CONFLICT =
  "This name belongs to a deleted Namespace and cannot be reused. Choose a different name.";

export class AgentDeletingError extends ResourceConflictError {
  constructor(message = "The Agent is being deleted.") {
    super(message);
    this.name = "AgentDeletingError";
  }
}

export class NamespaceNotEmptyError extends ResourceConflictError {
  /** Public resource kinds that still occupy the Namespace, such as "Presets". */
  readonly contents: readonly string[];
  /** IDs of the remaining resources of each kind, so an operator can delete them. */
  readonly ids: Readonly<Record<string, readonly string[]>>;

  constructor(
    contents: readonly string[] = [],
    ids: Readonly<Record<string, readonly string[]>> = {},
  ) {
    super("The Namespace must be empty before deletion.");
    this.name = "NamespaceNotEmptyError";
    this.contents = Object.freeze([...contents]);
    this.ids = Object.freeze(
      Object.fromEntries(
        Object.entries(ids).map(([kind, list]) => [kind, Object.freeze([...list])]),
      ),
    );
  }
}

export class NamespaceNotReadyError extends ResourceConflictError {
  constructor(message = "The Namespace is not ready.") {
    super(message);
    this.name = "NamespaceNotReadyError";
  }
}

/** Dedicated native OpenClaw needs OpenClaw support that the selected runtime image lacks. */
export class NativeWorkerSupportError extends Error {
  constructor() {
    super(
      "Dedicated native OpenClaw is unavailable: the pinned runtime does not support required worker placement (cloudWorkers.requiredProfile) or native worker inference. See https://docs-enterprise.openclaw.org/reference/harness-execution/#native-worker-support",
    );
    this.name = "NativeWorkerSupportError";
  }
}

/**
 * A platform dependency a Compute Driver, or the Sandbox Driver it calls, reaches while
 * it reconciles a revision. `sandbox_admission` is the Sandbox gateway's per-caller
 * request admission quota, which frees up as completed requests age out.
 */
export type TransientDependency = "agent_gateway" | "kubernetes_api" | "sandbox_admission";

/** Why the dependency failed, from a closed set that carries no provider text. */
export type TransientDependencyReason = "unreachable" | "timeout" | "unavailable";

const TRANSIENT_DEPENDENCY_CODES: Readonly<Record<TransientDependency, string>> = Object.freeze({
  agent_gateway: "AGENT_GATEWAY_UNAVAILABLE",
  kubernetes_api: "KUBERNETES_API_UNAVAILABLE",
  sandbox_admission: "SANDBOX_ADMISSION_LIMIT_REACHED",
});

/**
 * A Compute dependency failed in a way that clears without a change to the
 * revision: the Kubernetes API timed out or answered 429/5xx, the Agent
 * Gateway's route refused or dropped a connection while it converged, or the
 * Sandbox gateway refused new requests at its request admission limit. The
 * worker retries it within the deployment's convergence deadline instead of
 * spending the attempt budget, and records `code`, which names the dependency.
 * The message stays in the controller; status shows a fixed text.
 */
export class TransientDependencyError extends Error {
  readonly dependency: TransientDependency;
  readonly reason: TransientDependencyReason;
  readonly code: string;

  constructor(
    dependency: TransientDependency,
    reason: TransientDependencyReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransientDependencyError";
    this.dependency = dependency;
    this.reason = reason;
    this.code = TRANSIENT_DEPENDENCY_CODES[dependency];
  }
}

/** A step of dedicated activation that completes by itself once a workload catches up. */
export type ActivationPendingCode = "WORKSPACE_NODE_PENDING" | "WORKSPACE_NODE_BINDING_PENDING";

/**
 * Activation found its workloads ready but is still waiting for one of them:
 * the Gateway has not applied the workspace node it was handed, or the Harness
 * node has not connected to the Gateway. The worker records `code` so status
 * names the wait. The message stays in the controller.
 */
export class ActivationPendingError extends Error {
  readonly code: ActivationPendingCode;

  constructor(code: ActivationPendingCode, message: string) {
    super(message);
    this.name = "ActivationPendingError";
    this.code = code;
  }
}

/** An activation step that cannot complete for this revision. */
export type ActivationFailedCode = "AGENT_GATEWAY_UNAUTHORIZED";

/**
 * Activation found its workloads running but one of them can never complete
 * activation for this revision: the dedicated Gateway refuses its own in-Pod CLI
 * as unauthorized, so it cannot confirm its workspace node. The cause is fixed
 * by the admitted Configuration, so the worker fails the deployment with `code`
 * instead of waiting for the convergence deadline. The message stays in the
 * controller; status shows a fixed text.
 */
export class ActivationFailedError extends Error {
  readonly code: ActivationFailedCode;

  constructor(code: ActivationFailedCode, message: string) {
    super(message);
    this.name = "ActivationFailedError";
    this.code = code;
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

/**
 * A Credential Gateway cannot attach this exact AgentRevision's credential sources: two of them
 * would place their placeholders in the same Sandbox environment variable. The revision's
 * source list and each source's config are fixed, so retrying cannot change the outcome; the
 * worker fails the deployment with `code`. The message stays in the controller; status shows a
 * fixed text.
 */
export class CredentialSourceRevisionError extends Error {
  readonly code: "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT";

  constructor(code: CredentialSourceRevisionError["code"], message: string) {
    super(message);
    this.name = "CredentialSourceRevisionError";
    this.code = code;
  }
}

/**
 * A Compute Driver cannot withdraw a credential source from this exact AgentRevision: its
 * configuration cannot identify the revision's Sandbox, or it found an object it does not
 * own. Retrying cannot change the outcome until an operator corrects the cause, so the worker
 * fails the withdrawal at once with `code` instead of retrying it for an hour; a replay tries
 * again. The message stays in the controller.
 */
export class CredentialWithdrawalRefusedError extends Error {
  readonly code: "CREDENTIAL_WITHDRAWAL_MISCONFIGURED" | "CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT";

  constructor(code: CredentialWithdrawalRefusedError["code"], message: string) {
    super(message);
    this.name = "CredentialWithdrawalRefusedError";
    this.code = code;
  }
}

/**
 * Source deletion is refused only because a credential withdrawal attempt or retry series is
 * still queued or running for an inactive revision that holds the source; nothing else
 * references it. A fixed message: it names no Agent or revision, which the caller, who holds
 * only `delete` on the source, may not be allowed to read. A replay cannot help, since the
 * Agent's active revision no longer holds the source.
 */
export class CredentialWithdrawalInProgressError extends ResourceStateConflictError {
  constructor() {
    super(
      "A credential withdrawal is still queued or running for an Agent revision that held the source. Wait for it to finish (it retries for up to about an hour), or delete that revision's Agent, then retry.",
    );
    this.name = "CredentialWithdrawalInProgressError";
  }
}

/**
 * An AccessBinding Role carries Permissions that can never take effect through the
 * binding: `create` is checked against the Namespace, not an existing resource, and a
 * binding to an exact resource applies only Permissions of that resource's kind.
 */
export class IAMAccessBindingRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IAMAccessBindingRoleError";
  }
}

/**
 * A Namespace IAM policy write names an invalid or unavailable input: an unsupported
 * Permission, or a subject, Role or target that is not usable in the exact Namespace.
 * The caller already administers the Namespace's IAM policy, so HTTP reports the static
 * message and the offending request field as an invalid request.
 */
export class IAMPolicyValidationError extends ScopeViolationError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "IAMPolicyValidationError";
    this.path = path;
  }
}

/**
 * A Secret value passed the request schema but not OCC's stricter rules: it holds an
 * unpaired UTF-16 surrogate (not valid UTF-8) or exceeds 65536 UTF-8 bytes. HTTP reports
 * it as an invalid `/value` instead of hiding it as a scope miss.
 */
export class SecretValueError extends ScopeViolationError {
  readonly code: "INVALID_VALUE" | "TOO_LONG";

  constructor(code: "INVALID_VALUE" | "TOO_LONG", message: string) {
    super(message);
    this.name = "SecretValueError";
    this.code = code;
  }
}

/** A Namespace Role cannot be deleted while AccessBindings still reference it. */
export class IAMRoleInUseError extends ResourceConflictError {
  constructor() {
    super("The IAM Role is referenced by AccessBindings. Delete those AccessBindings first.");
    this.name = "IAMRoleInUseError";
  }
}

/** The Installation selects no Credential Gateway, so credential sources are unavailable. */
export class CredentialGatewayNotConfiguredError extends Error {
  constructor() {
    super(
      "This Installation has no Credential Gateway, so credential sources are unavailable. An administrator must select the OpenShell Credential Gateway Driver; see https://docs-enterprise.openclaw.org/reference/credential-sources/",
    );
    this.name = "CredentialGatewayNotConfiguredError";
  }
}

/** A Driver rejected nonsecret source configuration before registration. */
export class CredentialSourceConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "CredentialSourceConfigError";
    this.field = field;
  }
}

/**
 * The selected Credential Gateway's catalog lacks a source type: registration names one it does
 * not offer, or a configuration change dropped an existing source's type (OpenShell offers
 * `bearer-token` only with `toolBinaries`). An Installation property, raised only after the
 * caller's grant and the source lookup, so it reveals nothing a 403 or 404 hides. The fixed
 * message names the fix.
 */
export class CredentialSourceTypeNotOfferedError extends ResourceStateConflictError {
  constructor() {
    super(
      "The selected Credential Gateway does not offer this credential source type. An administrator must enable it, for example toolBinaries for OpenShell bearer-token; see https://docs-enterprise.openclaw.org/reference/drivers/openshell-credential-gateway/",
    );
    this.name = "CredentialSourceTypeNotOfferedError";
  }
}

const SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED_MESSAGES = Object.freeze({
  issue:
    "This Installation has no ChatGPT Backend, so it cannot issue service-account credentials. An administrator must configure the ChatGPT Backend and select its ServiceAccount Driver; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
  deploy:
    "ChatGPT Harness authentication requires an issued account access-token credential, and this Installation has no ChatGPT Backend to issue one. An administrator must configure it; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
  delete:
    "This service account holds an issued access token, and this Installation has no ChatGPT Backend to revoke it. Re-add it, or force the delete and revoke the token at the provider; see https://docs-enterprise.openclaw.org/reference/service-accounts/",
});

/**
 * The Installation has no ChatGPT Backend, so it selects no ServiceAccount Driver: no account
 * credential can be issued, a ChatGPT Harness binding cannot deploy, and an account holding an
 * issued access token cannot be deleted unless forced, since nothing can revoke the token. An Installation
 * property, raised only after the caller's grant and the account lookup, so it reveals nothing
 * a 403 or 404 hides. The fixed message names the fix.
 */
export class ServiceAccountDriverNotConfiguredError extends ResourceConflictError {
  constructor(operation: "issue" | "deploy" | "delete") {
    super(SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED_MESSAGES[operation]);
    this.name = "ServiceAccountDriverNotConfiguredError";
  }
}

const SERVICE_ACCOUNT_REFERENCE_URL =
  "https://docs-enterprise.openclaw.org/reference/service-accounts/";

/**
 * An account-owned credential Secret left by an earlier issuance whose outcome OCC could not
 * settle (a lost create reply whose cleanup failed) blocks every retry until an operator deletes
 * it (finding 935). Raised only after the caller's update grant, the account lookup and the
 * "no credential yet" check, so it reaches only callers who may issue for this account. It
 * names the Kubernetes namespace and Secret (never its contents) and the doc's removal step.
 */
export class ServiceAccountCredentialSecretExistsError extends ResourceStateConflictError {
  readonly secretNamespace: string;
  readonly secretName: string;

  constructor(secretNamespace: string, secretName: string) {
    const message = (secret: string) =>
      `Kubernetes Secret ${secret} from an earlier issuance blocks this one. An operator must delete it, then retry; see ${SERVICE_ACCOUNT_REFERENCE_URL}`;
    const full = message(`${secretNamespace}/${secretName}`);
    // The HTTP error contract caps messages at 256 characters; only a long namespace exceeds it.
    super(full.length <= 256 ? full : message(secretName));
    this.name = "ServiceAccountCredentialSecretExistsError";
    this.secretNamespace = secretNamespace;
    this.secretName = secretName;
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
 * The cluster refused the API access to an Agent's runtime credential Secrets or their
 * Deployment preflight: an operator must grant the documented tenant RoleBinding. It stays a
 * dependency outage for callers that fail closed, and carries only fixed operation names and
 * the Kubernetes namespace, for the server log.
 */
export class RuntimeCredentialsForbiddenByClusterError extends DependencyUnavailableError {
  readonly verb: "get" | "list" | "create";
  readonly resource: "secrets" | "deployments";
  readonly kubernetesNamespace: string;
  readonly plane: "control" | "execution";
  readonly status: 403;

  constructor(denial: {
    readonly verb: RuntimeCredentialsForbiddenByClusterError["verb"];
    readonly resource: RuntimeCredentialsForbiddenByClusterError["resource"];
    readonly kubernetesNamespace: string;
    readonly plane: RuntimeCredentialsForbiddenByClusterError["plane"];
    readonly status: RuntimeCredentialsForbiddenByClusterError["status"];
  }) {
    super("The cluster denied access to Agent runtime credentials.");
    this.name = "RuntimeCredentialsForbiddenByClusterError";
    this.verb = denial.verb;
    this.resource = denial.resource;
    this.kubernetesNamespace = denial.kubernetesNamespace;
    this.plane = denial.plane;
    this.status = denial.status;
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
  /** The rejected plugin selection key, so HTTP can point at `/plugins/<id>`. */
  readonly pluginId?: string;

  constructor(
    field?:
      | "toolDefaults.reviewer"
      | "tools[id].reviewer"
      | "approvers"
      | "aliasedPlugin"
      | "unknownPlugin",
    driverId?: string,
    pluginId?: string,
  ) {
    let message = "The supplied plugin policies are invalid.";
    if (field === "unknownPlugin") {
      // driverId comes from trusted Installation configuration, never from the request.
      // pluginId is a selection key admitted under the API contract's [A-Za-z0-9._~:@-] rule,
      // from this request or from storage. It follows the rule, so HTTP's message cap cuts
      // the advice first.
      message = `A plugin selection names a plugin that the selected Plugin Driver${
        driverId === undefined ? "" : ` (${driverId})`
      } does not offer${
        pluginId === undefined ? "" : `: ${pluginId}`
      }. Check each plugin ID and its Driver prefix against that Driver's catalog; an Installation selects one Plugin Driver.`;
    } else if (field === "aliasedPlugin") {
      message =
        'Two plugin selections name the same plugin (a native ID and its driver-prefixed ID, such as "diffs" and "occ-plugin:diffs"). Keep one selection per plugin.';
    } else if (field === "approvers") {
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
    if (field === "unknownPlugin" && pluginId !== undefined) {
      this.pluginId = pluginId;
    }
  }

  /**
   * The same refusal without the `/plugins/<id>` pointer, for selections read from storage
   * (deploy, an update that omits `plugins`, provisioning replay or retry): the request body
   * holds no such path. The message still names the plugin.
   */
  withoutRequestPath(): PluginPolicyValidationError {
    const stored = new PluginPolicyValidationError();
    stored.message = this.message;
    return stored;
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
