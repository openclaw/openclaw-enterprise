import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalFailure,
  cappedPath,
  RequestFailure,
  requestFailure,
} from "../../apps/controller/src/http/errors.ts";
import {
  ConfigurationOwnershipError,
  ConfigurationValidationError,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import {
  isStaleGeneration,
  PROVISIONING_REFUSAL_CODES,
  preAdmissionRefusal,
} from "../../apps/controller/src/console/agents/list.mts";
import { ERROR_CODES, PresetValidationError } from "../../packages/contracts/src/index.ts";
import { normalizeRequestSecretBindings } from "../../packages/occ/src/agent-provisioning.ts";
import {
  AgentCredentialSourceBindingError,
  AgentDeletingError,
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  ChannelCredentialError,
  ChannelDirectoryError,
  ConfigurationGenerationConflictError,
  ConfigurationHarnessError,
  CredentialGatewayNotConfiguredError,
  CredentialTokenUnsettledError,
  CredentialWithdrawalInProgressError,
  DedicatedOpenClawSandboxError,
  DeletionRetryOwnedError,
  DependencyUnavailableError,
  DeviceAuthorizationStartError,
  HarnessAuthSecretDriverError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  ModelCredentialValueError,
  ModelDiscoveryError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  NotImplementedError,
  PersistedStateInvalidError,
  PluginDiscoveryError,
  PluginPolicyValidationError,
  PostgresCommitOutcomeUnknownError,
  ProtectedExecutionNetworkPolicyError,
  ProvisioningSecretDriverError,
  RepositoryBindingSelectionError,
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
  ResourceConflictError,
  ResourceStateConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsError,
  ScopeViolationError,
  SecretBindingDriverError,
  SecretBindingValidationError,
  SecretStorageDriverError,
  SecretValueError,
  ServiceAccountCredentialSecretExistsError,
  ServiceAccountDriverNotConfiguredError,
} from "../../packages/occ/src/index.ts";
import {
  AGENT_NAME_CONFLICT,
  DEPENDENCY_UNAVAILABLE,
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY,
  RESOURCE_CONFLICT,
  RESOURCE_NOT_FOUND,
} from "../helpers/refusal-text.mjs";

// Text that must never reach a client: the mappings below that answer with fixed text are
// checked with an error carrying this message.
const INTERNAL = "internal detail: postgres row agent_abc in ns_secret";
const agentResource = { kind: "agent", id: "agt_1", namespaceId: "ns_1" };

function apiError(statusCode) {
  return Object.assign(new Error(INTERNAL), { name: "APIError", statusCode });
}

function fastifyError(code) {
  return Object.assign(new Error(INTERNAL), { code });
}

function namedError(name) {
  return Object.assign(new Error(INTERNAL), { name });
}

function admissionFailure(fields) {
  return Object.assign(new Error(INTERNAL), { name: "AdmissionFailure", ...fields });
}

// Many OCC errors subclass ScopeViolationError, ResourceConflictError or
// AuthorizationDeniedError, so each row also guards the order of the checks in
// requestFailure: a subclass must keep its own status and text, not its parent's.
const cases = [
  // 409: conflicts the user can act on.
  [
    "a state conflict names what blocks the operation",
    new ResourceStateConflictError(AGENT_NAME_CONFLICT),
    { status: 409, code: "RESOURCE_CONFLICT", message: AGENT_NAME_CONFLICT },
  ],
  [
    "a plain resource conflict keeps the generic text",
    new ResourceConflictError(INTERNAL),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: RESOURCE_CONFLICT,
    },
  ],
  [
    "a stale Configuration generation is marked by its expectedGeneration detail",
    new ConfigurationGenerationConflictError(),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message:
        "The Configuration changed since it was read. Read its current generation before updating it.",
      details: [{ path: "/expectedGeneration", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a Role still referenced by bindings says to delete them first",
    new IAMRoleInUseError(),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "The IAM Role is referenced by AccessBindings. Delete those AccessBindings first.",
    },
  ],
  [
    "an Agent being deleted",
    new AgentDeletingError(INTERNAL),
    { status: 409, code: "AGENT_DELETING", message: "The requested Agent is being deleted." },
  ],
  [
    "a Namespace that is not ready",
    new NamespaceNotReadyError(INTERNAL),
    {
      status: 409,
      code: "NAMESPACE_NOT_READY",
      message: NAMESPACE_NOT_READY,
    },
  ],
  [
    "a non-empty Namespace names what it still contains",
    new NamespaceNotEmptyError(["Agents", "Presets"]),
    {
      status: 409,
      code: "NAMESPACE_NOT_EMPTY",
      message: "The requested Namespace is not empty. It still contains: Agents, Presets.",
    },
  ],
  [
    "a non-empty Namespace names the remaining resource IDs that fit and counts the rest",
    new NamespaceNotEmptyError(
      ["Agents", "Configurations", "Secrets", "pending Agent provisioning"],
      {
        Agents: [],
        Configurations: Array.from({ length: 12 }, (_, index) => `cfg_${String(index).repeat(36)}`),
        Secrets: ["sec_1"],
      },
    ),
    {
      status: 409,
      code: "NAMESPACE_NOT_EMPTY",
      message: `The requested Namespace is not empty. It still contains: Agents, Configurations (${["0", "1"].map((digit) => `cfg_${digit.repeat(36)}`).join(", ")} and 10 more), Secrets (sec_1), pending Agent provisioning.`,
    },
  ],
  [
    "a non-empty Namespace with many Agents still names its Configurations",
    new NamespaceNotEmptyError(["Agents", "Configurations"], {
      Agents: Array.from({ length: 5 }, (_, index) => `agt_${String(index).repeat(36)}`),
      Configurations: [`cfg_${"5".repeat(36)}`, `cfg_${"6".repeat(36)}`],
    }),
    {
      status: 409,
      code: "NAMESPACE_NOT_EMPTY",
      // IDs are taken one per kind in turn, so Agents cannot use up the whole message.
      message: `The requested Namespace is not empty. It still contains: Agents (agt_${"0".repeat(36)}, agt_${"1".repeat(36)} and 3 more), Configurations (cfg_${"5".repeat(36)} and 1 more).`,
    },
  ],
  [
    "a non-empty Namespace with unnamed contents",
    new NamespaceNotEmptyError(),
    { status: 409, code: "NAMESPACE_NOT_EMPTY", message: "The requested Namespace is not empty." },
  ],
  [
    "an Installation without a Credential Gateway",
    new CredentialGatewayNotConfiguredError(),
    {
      status: 409,
      code: "CREDENTIAL_GATEWAY_NOT_CONFIGURED",
      message: new CredentialGatewayNotConfiguredError().message,
    },
  ],
  [
    "a source delete blocked only by withdrawal work names the wait and Agent deletion",
    new CredentialWithdrawalInProgressError(),
    {
      status: 409,
      code: "CREDENTIAL_WITHDRAWAL_IN_PROGRESS",
      message:
        "A credential withdrawal is still queued or running for an Agent revision that held the source. Wait for it to finish (it retries for up to about an hour), or delete that revision's Agent, then retry.",
    },
  ],
  [
    "a source delete blocked by a token that may still be valid names the retry time",
    new CredentialTokenUnsettledError(new Date("2026-10-23T01:41:00.000Z")),
    {
      status: 409,
      code: "CREDENTIAL_TOKEN_UNSETTLED",
      message:
        "A GitHub token issued for this credential source may still be valid, so it cannot be deleted yet. Retry the deletion after 2026-10-23T01:41:00.000Z, when GitHub's maximum token lifetime has passed.",
    },
  ],
  [
    "network policy additions refused at deploy under protected execution name the rule",
    new ProtectedExecutionNetworkPolicyError("deploy"),
    {
      status: 409,
      code: "SANDBOX_POLICY_PROTECTED_EXECUTION",
      message:
        "Protected execution keeps only the Credential Proxy egress policy, so this Agent's network policy additions are refused. Remove them, then deploy.",
    },
  ],
  [
    "a git-write deploy on a Credential Proxy with no qualified sender names the alternatives",
    new RepositoryGitSenderUnqualifiedError(),
    {
      status: 409,
      code: "REPOSITORY_GIT_SENDER_UNQUALIFIED",
      message:
        "The selected Credential Proxy cannot enforce the Agent's git-write repository binding: no OpenShell release is qualified for it. Remove the binding, select a qualified installed sender, or use native prepared Git without a Sandbox, then deploy again.",
    },
  ],
  [
    "a repository profile a Credential Proxy cannot deliver names the supported profiles",
    new RepositoryGitProfileUnsupportedError(),
    {
      status: 409,
      code: "REPOSITORY_GIT_PROFILE_UNSUPPORTED",
      message:
        "A Credential Proxy delivers repository Git only for one git-write or github-installation binding, so this Agent's repository access cannot start. Keep one such binding, remove them, or use native prepared Git without a Sandbox or Proxy, then deploy again.",
    },
  ],
  [
    "service-account issuance on an Installation without a ChatGPT Backend names the fix",
    new ServiceAccountDriverNotConfiguredError("issue"),
    {
      status: 409,
      code: "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
      message:
        "This Installation has no ChatGPT Backend, so it cannot issue service-account credentials. An administrator must configure the ChatGPT Backend and select its ServiceAccount Driver; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
    },
  ],
  [
    "a ChatGPT Harness deploy on an Installation without a ChatGPT Backend names the fix",
    new ServiceAccountDriverNotConfiguredError("deploy"),
    {
      status: 409,
      code: "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
      message:
        "ChatGPT Harness authentication requires an issued account access-token credential, and this Installation has no ChatGPT Backend to issue one. An administrator must configure it; see https://docs-enterprise.openclaw.org/guides/integrations/chatgpt/",
    },
  ],
  [
    "deleting a service account with an issued token without a ChatGPT Backend names the fix",
    new ServiceAccountDriverNotConfiguredError("delete"),
    {
      status: 409,
      code: "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
      message:
        "This service account holds an issued access token, and this Installation has no ChatGPT Backend to revoke it. Re-add it, or force the delete and revoke the token at the provider; see https://docs-enterprise.openclaw.org/reference/service-accounts/",
    },
  ],
  [
    "a leftover service-account credential Secret is named with the doc's removal step",
    new ServiceAccountCredentialSecretExistsError(
      "oce-0123456789abcde",
      "service-account-0123456789abcdef0123456789abcdef",
    ),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message:
        "Kubernetes Secret oce-0123456789abcde/service-account-0123456789abcdef0123456789abcdef from an earlier issuance blocks this one. An operator must delete it, then retry; see https://docs-enterprise.openclaw.org/reference/service-accounts/",
    },
  ],
  [
    "a leftover credential Secret in a long Kubernetes namespace keeps the 256-character cap",
    new ServiceAccountCredentialSecretExistsError(
      "n".repeat(63),
      "service-account-0123456789abcdef0123456789abcdef",
    ),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message:
        "Kubernetes Secret service-account-0123456789abcdef0123456789abcdef from an earlier issuance blocks this one. An operator must delete it, then retry; see https://docs-enterprise.openclaw.org/reference/service-accounts/",
    },
  ],
  [
    "a Kubernetes API 409",
    apiError(409),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: RESOURCE_CONFLICT,
    },
  ],

  // 400: validation the caller can fix; the text names the field, never a value.
  [
    "a Role that cannot take effect through its binding",
    new IAMAccessBindingRoleError("Bindings to an exact Agent apply only agent permissions."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Bindings to an exact Agent apply only agent permissions.",
      details: [{ path: "/roleId", code: "INVALID_VALUE" }],
    },
  ],
  [
    "an IAM policy write with an unusable subject",
    new IAMPolicyValidationError("/subjectId", "The subject is not usable in this Namespace."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The subject is not usable in this Namespace.",
      details: [{ path: "/subjectId", code: "INVALID_VALUE" }],
    },
  ],
  [
    "an IAM policy path over the 512-character cap keeps whole leading segments",
    new IAMPolicyValidationError(
      `/bindings/${"b".repeat(600)}`,
      "The subject is not usable in this Namespace.",
    ),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The subject is not usable in this Namespace.",
      details: [{ path: "/bindings", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a Secret value over the byte limit",
    new SecretValueError("TOO_LONG", "Secret values must be at most 65536 UTF-8 bytes."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Secret values must be at most 65536 UTF-8 bytes.",
      details: [{ path: "/value", code: "TOO_LONG" }],
    },
  ],
  [
    "a Configuration that selects no supported Harness",
    new ConfigurationHarnessError("The Configuration does not select a supported Harness."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The Configuration does not select a supported Harness.",
    },
  ],
  [
    "an unlisted Harness credential source",
    new AgentCredentialSourceBindingError(),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The Harness credential source must be listed in the Agent's credentialSources.",
    },
  ],
  [
    "Installation-wide repository access next to another binding",
    new RepositoryBindingSelectionError(),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message:
        "Installation-wide repository access (profile github-installation) must be the Agent's only repository selection. Remove the other entries from repositoryBindings or repositoryAccess.repositories, or select each repository with its own profile instead.",
    },
  ],
  [
    "an invalid requested Secret binding",
    new SecretBindingValidationError("Secret references cannot cross Namespaces."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Secret references cannot cross Namespaces.",
    },
  ],
  [
    "a runtime image without native worker support",
    new NativeWorkerSupportError(),
    { status: 400, code: "INVALID_REQUEST", message: new NativeWorkerSupportError().message },
  ],
  [
    // A fixed Installation shape: a permanent conflict naming the missing Driver, not an
    // outage with generic text (finding 1609).
    "an Installation without a Sandbox Driver that provisions dedicated OpenClaw",
    new DedicatedOpenClawSandboxError(),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message:
        "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.",
    },
  ],
  [
    "a plugin selection the selected Plugin Driver does not offer",
    new PluginPolicyValidationError("unknownPlugin", "occ-plugin", "codex-plugin:a~b/c"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: new PluginPolicyValidationError("unknownPlugin", "occ-plugin", "codex-plugin:a~b/c")
        .message,
      details: [{ path: "/plugins/codex-plugin:a~0b~1c", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a reserved Secret binding destination",
    new SecretBindingValidationError(
      "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.",
      {
        bindingsPath: "/configuration/secretBindings",
        key: "OPENCLAW_TOKEN",
        code: "INVALID_VALUE",
      },
    ),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.",
      details: [{ path: "/configuration/secretBindings/OPENCLAW_TOKEN", code: "INVALID_VALUE" }],
    },
  ],
  // The detail path cap is 512 characters: a key that ends the path exactly there is named,
  // and one character more points at the bindings instead.
  ...[
    ["exactly at", "K".repeat(482), `/configuration/secretBindings/${"K".repeat(482)}`],
    ["one past", "K".repeat(483), "/configuration/secretBindings"],
  ].map(([where, key, path]) => [
    `a Secret binding destination whose path ends ${where} the 512-character cap`,
    new SecretBindingValidationError("A secret binding destination is invalid.", {
      bindingsPath: "/configuration/secretBindings",
      key,
      code: "INVALID_VALUE",
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "A secret binding destination is invalid.",
      details: [{ path, code: "INVALID_VALUE" }],
    },
  ]),
  [
    "plugin selections that alias the same plugin",
    new PluginPolicyValidationError("aliasedPlugin"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: new PluginPolicyValidationError("aliasedPlugin").message,
    },
  ],
  [
    "a Preset template rule",
    new PresetValidationError("Preset template.name: must be a string."),
    { status: 400, code: "INVALID_REQUEST", message: "Preset template.name: must be a string." },
  ],
  [
    "an inline model credential names its field",
    new ModelCredentialValueError("/models/providers/openai/apiKey"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: new ModelCredentialValueError("/models/providers/openai/apiKey").message,
    },
  ],
  [
    "other Configuration validation stays generic",
    new ConfigurationValidationError(INTERNAL),
    { status: 400, code: "INVALID_REQUEST", message: "The supplied configuration is invalid." },
  ],
  [
    "a channel credential with the wrong token role",
    new ChannelCredentialError("role_mismatch", "/channels/slack/botToken"),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_ROLE_MISMATCH",
      message: "The selected Secret has the wrong token role for this field.",
      details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel credential the provider rejects",
    new ChannelCredentialError("credentials_rejected", "/channels/slack/botToken"),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED",
      message: "The channel provider rejected this credential. Check the selected Secret.",
      details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel credential that is not environment-backed",
    new ChannelCredentialError("binding_required", "/channels/slack/appToken"),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_BINDING_REQUIRED",
      message: "Select an environment-backed Secret for this channel credential.",
      details: [{ path: "/channels/slack/appToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel credential path under a long account key is capped",
    new ChannelCredentialError(
      "binding_required",
      `/channels/slack/accounts/${"a".repeat(600)}/appToken`,
    ),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_BINDING_REQUIRED",
      message: "Select an environment-backed Secret for this channel credential.",
      details: [{ path: "/channels/slack/accounts", code: "INVALID_VALUE" }],
    },
  ],
  [
    "channel credential validation that is unavailable",
    new ChannelCredentialError("unavailable", "/channels/slack/botToken"),
    {
      status: 503,
      code: "CHANNEL_CREDENTIAL_UNAVAILABLE",
      message: "Channel credential validation is temporarily unavailable. Retry before deploying.",
      details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel directory credential the provider rejects",
    new ChannelDirectoryError("credentials_rejected"),
    {
      status: 400,
      code: "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED",
      message: "The channel provider rejected the selected credential. Check the Secret and retry.",
    },
  ],
  [
    "a channel directory credential without directory scopes",
    new ChannelDirectoryError("missing_scope"),
    {
      status: 400,
      code: "CHANNEL_DIRECTORY_MISSING_SCOPE",
      message:
        "The channel credential lacks directory permissions. Update its provider scopes and retry.",
    },
  ],
  [
    "a rate-limited channel directory",
    new ChannelDirectoryError("rate_limited"),
    {
      status: 429,
      code: "CHANNEL_DIRECTORY_RATE_LIMITED",
      message: "The channel provider rate-limited directory lookup. Wait and retry.",
    },
  ],
  [
    "a channel directory with an invalid response",
    new ChannelDirectoryError("invalid_response"),
    {
      status: 503,
      code: "CHANNEL_DIRECTORY_INVALID_RESPONSE",
      message:
        "The channel provider returned an invalid directory response. Retry or enter an exact ID.",
    },
  ],
  [
    "an unavailable channel directory",
    new ChannelDirectoryError("unavailable"),
    {
      status: 503,
      code: "CHANNEL_DIRECTORY_UNAVAILABLE",
      message: "Channel directory lookup is unavailable. Retry or enter an exact ID.",
    },
  ],
  // Only a recognized reason may pick the public message and code. Each of these is another
  // discovery's reason or an inherited property name, so none maps.
  ...[
    ["channel directory", new ChannelDirectoryError("constructor")],
    ["model discovery", new ModelDiscoveryError("missing_scope")],
    ["plugin discovery", new PluginDiscoveryError("missing_scope")],
  ].map(([kind, error]) => [
    `a ${kind} reason it does not define`,
    error,
    {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The platform request could not be completed.",
    },
  ]),
  [
    "a model provider that rejects discovery",
    new ModelDiscoveryError("credentials_rejected"),
    {
      status: 400,
      code: "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
      message:
        "The provider rejected model discovery. Check the selected credential and its permission to list models, then retry or enter a model ID manually.",
    },
  ],
  [
    "a rate-limited model discovery",
    new ModelDiscoveryError("rate_limited"),
    {
      status: 429,
      code: "MODEL_DISCOVERY_RATE_LIMITED",
      message:
        "The provider rate-limited model discovery. Wait and retry, or enter a model ID manually.",
    },
  ],
  [
    "a model list that is invalid",
    new ModelDiscoveryError("invalid_response"),
    {
      status: 503,
      code: "MODEL_DISCOVERY_INVALID_RESPONSE",
      message: "The provider returned an invalid model list. Retry or enter a model ID manually.",
    },
  ],
  [
    "an unavailable model service",
    new ModelDiscoveryError("unavailable"),
    {
      status: 503,
      code: "MODEL_DISCOVERY_UNAVAILABLE",
      message: "The provider model service is unavailable. Retry or enter a model ID manually.",
    },
  ],
  [
    "a plugin service that rejects the credential",
    new PluginDiscoveryError("credentials_rejected"),
    {
      status: 400,
      code: "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
      message:
        "The plugin service rejected this credential. Check its permission to list plugins, then retry.",
    },
  ],
  [
    "a rate-limited plugin service",
    new PluginDiscoveryError("rate_limited"),
    {
      status: 429,
      code: "PLUGIN_DISCOVERY_RATE_LIMITED",
      message: "The plugin service rate-limited discovery. Wait and retry.",
    },
  ],
  [
    "a plugin service with an invalid response",
    new PluginDiscoveryError("invalid_response"),
    {
      status: 503,
      code: "PLUGIN_DISCOVERY_INVALID_RESPONSE",
      message: "The plugin service returned an invalid response. Retry discovery.",
    },
  ],
  [
    "an unavailable plugin service",
    new PluginDiscoveryError("unavailable"),
    {
      status: 503,
      code: "PLUGIN_DISCOVERY_UNAVAILABLE",
      message: "The plugin service is unavailable. Retry discovery.",
    },
  ],
  [
    "a Kubernetes API 400",
    apiError(400),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request does not match the operation contract.",
    },
  ],
  [
    "a body that is not JSON",
    fastifyError("FST_ERR_CTP_INVALID_JSON_BODY"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request does not match the operation contract.",
    },
  ],
  [
    "a body over the size limit",
    fastifyError("FST_ERR_CTP_BODY_TOO_LARGE"),
    {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds the permitted size.",
    },
  ],
  [
    "a body that is not application/json",
    fastifyError("FST_ERR_CTP_INVALID_MEDIA_TYPE"),
    {
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Requests must use application/json.",
    },
  ],
  ...[
    [
      "RUNTIME_LOGS_POD_INVALID",
      400,
      "The requested Pod is not a current Pod of this Agent version and source.",
    ],
    ["RUNTIME_LOGS_SOURCE_UNAVAILABLE", 400, "This Agent version has no such runtime log source."],
    [
      "RUNTIME_LOGS_RATE_LIMITED",
      429,
      "Too many runtime log requests. Wait for Retry-After and try again.",
    ],
    [
      "RUNTIME_LOGS_CLUSTER_RBAC",
      503,
      "The cluster denied the runtime log read. Ask a platform operator to enable agentRuntimeLogs and the documented roles.",
    ],
    [
      "RUNTIME_LOGS_SANDBOX_NOT_FOUND",
      503,
      "OpenShell reports no such sandbox for OpenClaw Enterprise: it is not provisioned yet or was removed, or the gateway identity is not a member of its Workspace.",
    ],
    ["RUNTIME_LOGS_UNAVAILABLE", 503, "Runtime status or logs are unavailable. Retry later."],
    [
      "RUNTIME_LOGS_AUDIT_UNAVAILABLE",
      503,
      "The runtime log view could not be audited, so no output was read.",
    ],
  ].map(([code, status, message]) => [
    `a runtime log failure ${code}`,
    new RuntimeLogsError(code),
    { status, code, message },
  ]),
  [
    "a runtime log cursor from another view",
    new RuntimeLogsError("RUNTIME_LOGS_CURSOR_INVALID"),
    {
      status: 400,
      code: "RUNTIME_LOGS_CURSOR_INVALID",
      message: "The runtime log cursor is invalid for this caller and view. Start a new view.",
    },
  ],
  [
    "a runtime log read that timed out",
    new RuntimeLogsError("RUNTIME_LOGS_TIMEOUT"),
    {
      status: 504,
      code: "RUNTIME_LOGS_TIMEOUT",
      message: "The runtime status or log read timed out.",
    },
  ],

  // 404: a scope miss never says whether the resource exists.
  [
    "a scope violation hides its detail",
    new ScopeViolationError(INTERNAL),
    {
      status: 404,
      code: "NOT_FOUND",
      message: RESOURCE_NOT_FOUND,
    },
  ],

  // 401/403: authorization.
  [
    "a caller denial stays generic",
    new AuthorizationDeniedError(INTERNAL),
    {
      status: 403,
      code: "FORBIDDEN",
      message: GENERIC_DENIAL,
    },
  ],
  [
    "a deletion retry owned by another actor names the condition",
    new DeletionRetryOwnedError("prn_initiator", agentResource),
    {
      status: 403,
      code: "FORBIDDEN",
      message: new DeletionRetryOwnedError("prn_initiator", agentResource).message,
    },
  ],
  [
    "an Agent principal denial names the missing grant",
    new AgentPrincipalAuthorizationError("prn_agent", "operate", {
      kind: "secret",
      id: "sec_1",
      namespaceId: "ns_1",
    }),
    {
      status: 403,
      code: "FORBIDDEN",
      message:
        "The Agent service principal prn_agent is not authorized to operate secret sec_1. Grant that principal operate on the secret, then deploy again.",
    },
  ],
  [
    "a denial from another module copy, matched by name",
    namedError("AuthorizationDeniedError"),
    {
      status: 403,
      code: "FORBIDDEN",
      message: GENERIC_DENIAL,
    },
  ],
  [
    "a Kubernetes API 401",
    apiError(401),
    {
      status: 401,
      code: "UNAUTHENTICATED",
      message: "The caller did not provide valid credentials.",
    },
  ],
  [
    "a Kubernetes API 403",
    apiError(403),
    {
      status: 403,
      code: "FORBIDDEN",
      message: GENERIC_DENIAL,
    },
  ],
  [
    "a 401 admission failure",
    admissionFailure({ statusCode: 401 }),
    {
      status: 401,
      code: "UNAUTHENTICATED",
      message:
        "A valid session cookie or service API key is required: the credential sent is missing, invalid, expired, or revoked. Send service API keys in the x-api-key header; Authorization bearer tokens are not accepted.",
    },
  ],
  [
    "a refused admission boundary",
    admissionFailure({ statusCode: 403 }),
    {
      status: 403,
      code: "FORBIDDEN",
      message: "The request did not satisfy the configured admission boundary.",
    },
  ],
  [
    "a state change without a trusted browser origin",
    admissionFailure({ status: 403, reason: "untrusted_origin" }),
    {
      status: 403,
      code: "FORBIDDEN",
      message:
        "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header.",
    },
  ],

  // 5xx: the platform, not the request.
  [
    "an unimplemented operation",
    new NotImplementedError("agents.fork"),
    {
      status: 501,
      code: "NOT_IMPLEMENTED",
      message: "The requested platform operation is not implemented.",
    },
  ],
  [
    "an unknown commit outcome says not to retry automatically",
    new PostgresCommitOutcomeUnknownError(),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
    },
  ],
  [
    "an unavailable dependency is not a denial",
    new DependencyUnavailableError(INTERNAL),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: DEPENDENCY_UNAVAILABLE,
    },
  ],
  [
    // #3313: an undecodable row fails closed like any unavailable dependency.
    "a persisted row its reader cannot decode is an unavailable dependency, without its text",
    new PersistedStateInvalidError(INTERNAL),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: DEPENDENCY_UNAVAILABLE,
    },
  ],
  [
    "a Configuration Secret binding the selected Secret Driver cannot serve names the fix",
    new SecretBindingDriverError(),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The selected Secret Driver does not own a Secret the Configuration binds. Bind only Secrets stored through the selected driver: update the Configuration's secretBindings, or assign the Agent another Configuration.",
    },
  ],
  [
    "a Harness authentication Secret the selected Secret Driver cannot serve names the fix",
    new HarnessAuthSecretDriverError(),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The selected Secret Driver does not own the Harness authentication Secret. Bind a Secret stored through the selected driver: set harnessAuth to another Secret, or create a new Secret with the key and bind that.",
    },
  ],
  [
    "an Agent provisioning Secret the selected Secret Driver cannot serve names the fix",
    new ProvisioningSecretDriverError(),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The selected Secret Driver does not own a Secret this Agent provisioning uses. Use only Secrets stored through the selected driver: save replacement Secrets and submit a new provisioning request with them.",
    },
  ],
  [
    "a Secret update the selected Secret Driver cannot perform names the fix",
    new SecretStorageDriverError("update"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The selected Secret Driver does not own this Secret, so its value cannot be updated. Create a new Secret with the value through the selected driver and bind it in place of this one.",
    },
  ],
  [
    "a Secret delete the selected Secret Driver cannot perform names the fix",
    new SecretStorageDriverError("delete"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The selected Secret Driver does not own this Secret, so its stored value cannot be deleted. Delete it once the Installation again selects the Secret Driver that stored it.",
    },
  ],
  [
    "a cluster RBAC denial of runtime credentials names the fix, not the namespace",
    new RuntimeCredentialsForbiddenByClusterError({
      verb: "get",
      resource: "secrets",
      kubernetesNamespace: INTERNAL,
      plane: "execution",
      status: 403,
    }),
    {
      status: 503,
      code: "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
      message:
        "The cluster denied OCC access needed for this Agent's runtime credentials. Ask a platform operator to grant the API ServiceAccount the documented tenant RoleBindings in the Agent's Kubernetes namespaces.",
    },
  ],
  [
    "a Configuration ConfigMap OCC does not own",
    new ConfigurationOwnershipError(INTERNAL),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: DEPENDENCY_UNAVAILABLE,
    },
  ],
  [
    "an unavailable dependency from another module copy, matched by name",
    namedError("DependencyUnavailableError"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: DEPENDENCY_UNAVAILABLE,
    },
  ],
  [
    "a device login when OCC cannot reach the issuer",
    new DeviceAuthorizationStartError("unreachable", "ECONNREFUSED"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "OCC could not reach the sign-in service at auth.openai.com. An operator must allow HTTPS egress from the API Pods to it (Helm api.modelDiscoveryCidrs), then try again.",
    },
  ],
  [
    "a device login the sign-in service could not start",
    new DeviceAuthorizationStartError("unavailable", "HTTP_503"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Device login could not start. Try again.",
    },
  ],
  [
    "a Kubernetes API 404",
    apiError(404),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: DEPENDENCY_UNAVAILABLE,
    },
  ],
  [
    "a RequestFailure passes through unchanged",
    new RequestFailure(422, "UNPROCESSABLE", "The route's own sentence.", [
      { path: "/name", code: "TOO_LONG" },
    ]),
    {
      status: 422,
      code: "UNPROCESSABLE",
      message: "The route's own sentence.",
      details: [{ path: "/name", code: "TOO_LONG" }],
    },
  ],
  [
    "an unclassified error",
    new Error(INTERNAL),
    {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The platform request could not be completed.",
    },
  ],
];

for (const [name, error, expected] of cases) {
  test(`HTTP error mapping: ${name} (${expected.status} ${expected.code})`, () => {
    const failure = requestFailure(error);
    assert.deepEqual(
      {
        status: failure.status,
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      },
      expected,
    );
    assert.doesNotMatch(failure.message, /internal detail/);
    // The wire cap (256 characters) must not cut a mapped message, such as a trailing doc link.
    let sent;
    const reply = {
      request: { id: "req_1" },
      header: () => reply,
      status: () => reply,
      send: (body) => {
        sent = body;
        return reply;
      },
    };
    canonicalFailure(reply, failure);
    assert.equal(sent.error.message, failure.message);
  });
}

// Create Agent shows the reason of a 503 from POST /agents/provision only for the codes that
// request sends before its own admission (finding 1635), and Deploy on the Agent page does the
// same for POST /agents/{id}/deploy, which sends them only before its revision commits (finding
// 1638). Every other 503 code, and every code this table does not map (it may answer 503), is
// listed here with where it comes from, so a new one fails this test until someone decides which
// it is.
const NOT_PROVISIONING_REFUSALS = [
  // Discovery and runtime log reads, never a provisioning request.
  "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  "CHANNEL_DIRECTORY_UNAVAILABLE",
  "MODEL_DISCOVERY_INVALID_RESPONSE",
  "MODEL_DISCOVERY_UNAVAILABLE",
  "PLUGIN_DISCOVERY_INVALID_RESPONSE",
  "PLUGIN_DISCOVERY_UNAVAILABLE",
  "RUNTIME_LOGS_AUDIT_UNAVAILABLE",
  "RUNTIME_LOGS_CLUSTER_RBAC",
  "RUNTIME_LOGS_SANDBOX_NOT_FOUND",
  "RUNTIME_LOGS_UNAVAILABLE",
  // The runtime credential routes, deploy and the provisioning worker, after admission. Deploy
  // meets it before its revision commits and names it with its own text.
  "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
  // Raised by other routes themselves, outside this mapping.
  "INSTALLATION_EXISTS",
  "METHOD_NOT_ALLOWED",
  "NATIVE_ADMIN_RETURN_RATE_LIMITED",
  "REPOSITORY_OPTIONS_UNAVAILABLE",
  "UNKNOWN_OUTCOME",
];

test("every API error code that may answer 503 is classified for Create Agent's and Deploy's pre-admission refusals", () => {
  const statuses = new Map(cases.map(([, , expected]) => [expected.code, expected.status]));
  const unclassified = ERROR_CODES.filter((code) => (statuses.get(code) ?? 503) === 503);
  assert.deepEqual(
    [...PROVISIONING_REFUSAL_CODES, ...NOT_PROVISIONING_REFUSALS].sort(),
    unclassified.sort(),
  );
});

// Both answer 503 DEPENDENCY_UNAVAILABLE, so Create Agent and Deploy tell a refusal from a commit
// the API could not confirm only by the API's sentence (finding 1650). Each mapping above that
// answers a refusal code is classified here through the console's own function, so rewording the
// API's sentence or the console's copy alone fails: Deploy would show an unconfirmed commit as a
// refusal and offer Deploy again.
const UNNAMED_503_CASES = [
  "an unknown commit outcome says not to retry automatically",
  "an unavailable dependency is not a denial",
  "a persisted row its reader cannot decode is an unavailable dependency, without its text",
  "a Configuration ConfigMap OCC does not own",
  "an unavailable dependency from another module copy, matched by name",
  "a Kubernetes API 404",
];

test("Create Agent and Deploy show the API's reason only for a named 503 refusal", () => {
  const refusals = cases.filter(
    ([, , expected]) =>
      expected.status === 503 && PROVISIONING_REFUSAL_CODES.includes(expected.code),
  );
  const refusalNames = refusals.map(([name]) => name);
  for (const name of UNNAMED_503_CASES) {
    assert.ok(refusalNames.includes(name), `no 503 refusal-code case: ${name}`);
  }
  assert.ok(refusals.length > UNNAMED_503_CASES.length);
  for (const [name, error] of refusals) {
    const failure = requestFailure(error);
    const shown = preAdmissionRefusal({
      status: failure.status,
      code: failure.code,
      serverMessage: failure.message,
    });
    assert.equal(shown, UNNAMED_503_CASES.includes(name) ? undefined : failure.message, name);
  }
});

// Only the API's generation conflict, marked by its /expectedGeneration detail, offers Reload
// draft; any other RESOURCE_CONFLICT, with or without details, meets the same refusal again
// after a reread (finding 1511).
test("only the Configuration generation conflict reads as a stale save in the console", () => {
  // The console error fields isStaleGeneration reads. api-client.mts also drops detail paths
  // outside its pattern and past 32 details; none of these errors have such paths.
  const consoleError = (error) => {
    const failure = requestFailure(error);
    const detailPaths = failure.details?.map(({ path }) => path);
    return { status: failure.status, code: failure.code, ...(detailPaths && { detailPaths }) };
  };
  const reserved =
    "The Configuration is reserved for provisioning and is not available for this operation.";
  const conflicts = [
    ...cases.filter(([, , expected]) => expected.code === "RESOURCE_CONFLICT"),
    ["a provisioning reservation", new ResourceStateConflictError(reserved)],
    [
      "a state conflict with another detail",
      new ResourceStateConflictError(reserved, [{ path: "/name", code: "INVALID_VALUE" }]),
    ],
  ];
  const stale = conflicts.filter(
    ([, error]) => error instanceof ConfigurationGenerationConflictError,
  );
  assert.equal(stale.length, 1);
  for (const [name, error] of conflicts) {
    assert.equal(isStaleGeneration(consoleError(error)), stale[0][1] === error, name);
  }
});

test("a submitted Secret binding destination names its rule and key, never the Secret", () => {
  const source = { kind: "secret", namespaceId: "ns_1", id: "sec_private_id" };
  for (const [destination, bindingsPath, message, details] of [
    [
      "OPENCLAW_TOKEN",
      undefined,
      "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.",
      [{ path: "/secretBindings/OPENCLAW_TOKEN", code: "INVALID_VALUE" }],
    ],
    [
      "path",
      "/configuration/secretBindings",
      "A secret binding destination is a reserved process or platform variable name: path.",
      [{ path: "/configuration/secretBindings/path", code: "INVALID_VALUE" }],
    ],
    [
      "bad/name\n",
      undefined,
      "A secret binding destination is not a valid environment variable name: it must match ^[A-Za-z_][A-Za-z0-9_]*$ and have at most 253 characters.",
      // A malformed key is not echoed; the detail points at the binding map.
      [{ path: "/secretBindings", code: "INVALID_FORMAT" }],
    ],
  ]) {
    let failure;
    try {
      normalizeRequestSecretBindings({ [destination]: { source } }, bindingsPath);
    } catch (error) {
      failure = requestFailure(error);
    }
    assert.ok(failure, destination);
    assert.equal(failure.status, 400, destination);
    assert.equal(failure.message, message, destination);
    assert.deepEqual(failure.details, details, destination);
    assert.doesNotMatch(JSON.stringify({ ...failure, message: failure.message }), /sec_private_id/);
  }
});

// A Fastify body-validation error carrying `validation`, Ajv's (verbose) entries.
function contractFailure(validation) {
  return requestFailure(
    Object.assign(new Error("body is invalid"), {
      statusCode: 400,
      validationContext: "body",
      validation,
    }),
  );
}

// Ajv reports a referenced schema's failures under the reference ("Scalar/anyOf/0/type"), not
// under the union branch that refers to it, and an inner union there can have a shorter schema
// path than the outer union (finding 808). Entries as Ajv (verbose) reports a boolean sent for
// `{ anyOf: [{ $ref: "Scalar" }, { type: "null" }] }` where Scalar is a string-or-number union.
test("a nullable union of a referenced schema attributes the reference's problems to its branch", () => {
  const validation = [
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf/0/type",
      params: { type: "string" },
    },
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf/1/type",
      params: { type: "number" },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "Scalar/anyOf",
      params: {},
      schema: [{ type: "string" }, { type: "number" }],
    },
    {
      keyword: "type",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf/1/type",
      params: { type: "null" },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf",
      params: {},
      schema: [{ $ref: "Scalar" }, { type: "null" }],
    },
  ];
  const failure = contractFailure(validation);
  assert.equal(failure.status, 400);
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /a has the wrong type (expected one of string, number, null).",
  );
});

// A reference that two branches make could be either branch's, so it is attributed to neither
// and each problem keeps naming what its field accepts. Entries as Ajv (verbose) reports
// `{ a: { x: [1, 1] } }` for `{ anyOf: [{ $ref: "List" }, { type: "object", properties:
// { x: { $ref: "List" } } }] }`, where List is a uniqueItems array.
test("a reference that two union branches make is attributed to neither", () => {
  const validation = [
    { keyword: "type", instancePath: "/a", schemaPath: "List/type", params: { type: "array" } },
    {
      keyword: "uniqueItems",
      instancePath: "/a/x",
      schemaPath: "List/uniqueItems",
      params: { i: 1, j: 0 },
    },
    {
      keyword: "anyOf",
      instancePath: "/a",
      schemaPath: "#/properties/a/anyOf",
      params: {},
      schema: [{ $ref: "List" }, { type: "object", properties: { x: { $ref: "List" } } }],
    },
  ];
  const failure = contractFailure(validation);
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /a has the wrong type (expected array); body /a/x has an unsupported value (expected no duplicate items); body /a has an unsupported value.",
  );
});

// The cap as it was before the first segment was cut to 1,024 characters (finding 1131).
function uncutCappedPath(pointer) {
  if (pointer.length <= 512) {
    return pointer;
  }
  let path = "";
  for (const segment of pointer.split("/").slice(1)) {
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

test("a capped detail path is unchanged by cutting a long first segment", () => {
  const pointers = ["", "/", "/a/b", `/${"a".repeat(511)}`, `/a/${"b".repeat(600)}/c`];
  // First segments just over the cap and past the 1,024-character cut, with escapes and
  // surrogate pairs straddling the 512-character boundary and the cut.
  for (const length of [511, 512, 513, 1023, 1024, 1025, 2048]) {
    for (const [fill, tail] of [
      ["k", "k"],
      ["k", "~0"],
      ["k", "~1"],
      ["k", "\u{1F600}"],
      ["k", "\ud800"],
      ["~0", "k"],
      ["\u{1F600}", "k"],
    ]) {
      const prefix = fill.repeat(Math.floor((length - 1) / fill.length));
      for (const key of [`${prefix}${tail}`, `k${prefix}${tail}`]) {
        pointers.push(`/${key}`, `/${key}/next`, `/${key}${"/x".repeat(10)}`);
      }
    }
  }
  for (const pointer of pointers) {
    const path = cappedPath(pointer);
    assert.equal(path, uncutCappedPath(pointer), `${pointer.length}: ${pointer.slice(0, 40)}`);
    assert.ok(path.length <= 512);
  }
});

test("a multi-megabyte first segment is capped in bounded time and heap", () => {
  // Before the cut, the per-character split built six million pieces here (finding 1131).
  const pointer = `/${"k".repeat(6_000_000)}/x`;
  const expected = `/${"k".repeat(511)}`;
  // Reading a character flattens the built string, so its 6 MB is not counted below.
  assert.equal(pointer.at(-1), "x");
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const path = cappedPath(pointer);
  const elapsedMs = performance.now() - started;
  const grewMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  assert.equal(path, expected);
  // About 0.1 MB with the cut, 85 to 120 MB without it.
  assert.ok(grewMb < 16, `heap grew ${grewMb.toFixed(1)} MB`);
  assert.ok(elapsedMs < 1000, `took ${Math.round(elapsedMs)} ms`);
});

test("a contract refusal lists at most the 32 details the error contract allows", () => {
  const failure = contractFailure(
    Array.from({ length: 40 }, (_, index) => ({
      keyword: "required",
      instancePath: "",
      schemaPath: "#/required",
      params: { missingProperty: `field${index}` },
    })),
  );
  assert.equal(failure.details.length, 32);
  assert.deepEqual(failure.details.at(-1), { path: "/field31", code: "REQUIRED" });
  assert.equal(
    failure.message,
    "The request does not match the operation contract: body /field0 is required; body /field1 is required; body /field2 is required; and 29 more.",
  );
});

test("a contract message shows fewer problems rather than cut a path below 32 characters", () => {
  // Three would cut each path to 26 characters, below the 32 minimum, so the message names two.
  const failure = contractFailure(
    ["0", "1", "2", "3"].map((digit) => ({
      keyword: "type",
      instancePath: `/${digit.repeat(40)}`,
      schemaPath: "#/type",
      params: { type: "string" },
    })),
  );
  assert.equal(
    failure.message,
    `The request does not match the operation contract: body /${"0".repeat(40)} has the wrong type (expected string); body /${"1".repeat(40)} has the wrong type (expected string); and 2 more.`,
  );
  assert.equal(failure.details.length, 4);
});
