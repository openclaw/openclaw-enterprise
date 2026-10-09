import { Type } from "typebox";

import {
  AgentId,
  AgentProvisioningWorkId,
  PresetId,
  PresetTemplateSchema,
  ConfigurationGeneration,
  ConfigurationId,
  ConfigurationKindSchema,
  ConfigurationValues,
  CredentialSourceConfig,
  CredentialSourceId,
  CredentialSourceReference,
  CredentialSourceSecrets,
  CredentialSourceType,
  HarnessExecutionModeSchema,
  HarnessAuthBindingSchema,
  AgentCredentialSourcesSchema,
  InstallationId,
  KubernetesNamespaceName,
  Meta,
  Name,
  NamespaceId,
  PermissionActionSchema,
  BackendId,
  RepositoryBindingSelectionSchema,
  RepositoryBindingSelectionsSchema,
  RepositoryAccessSchema,
  RevisionId,
  ResourceKindSchema,
  SecretBindings,
  SecretId,
  SecretReference,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
  Timestamp,
  WorkspaceFileName,
  PluginApprovalModeSchema,
  PluginReviewerSchema,
} from "./common.ts";

const RuntimeFailureIdentifier = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9._~:@-]{1,64}$",
});

const RuntimeFailureCauseSchema = Type.Object(
  {
    kind: Type.Union(
      [
        Type.Literal("PROCESS_EXIT"),
        Type.Literal("PROBE_STATUS"),
        Type.Literal("INVALID_OUTPUT"),
        Type.Literal("WRAPPER_ERROR"),
      ],
      {
        description:
          "PROCESS_EXIT: the check process exited nonzero, was killed or could not run. PROBE_STATUS: the check ran and reported the model unusable. INVALID_OUTPUT: its output was not the expected JSON. WRAPPER_ERROR: the runtime wrapper could not prepare or read the check.",
      },
    ),
    detail: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 32,
        pattern: "^[A-Za-z0-9_-]{1,32}$",
        description:
          "A fixed token for the kind, such as exit-1, signal-SIGKILL, error-ENOBUFS, format, rate_limit, billing, no_model, turn-failed, tool-event, no-reply, json or shape. Never native output.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Why the startup model check failed, classified by the runtime.",
  },
);

export const AgentDeviceAuthorizationResponse = Type.Object(
  {
    data: Type.Object(
      {
        session: SecretReference,
        source: Type.Optional(CredentialSourceReference),
        status: Type.Union([Type.Literal("pending"), Type.Literal("ready")]),
        verificationUrl: Type.String({ format: "uri" }),
        userCode: Type.String(),
        expiresAt: Timestamp,
        intervalSeconds: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentModelListResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }),
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

const PluginCatalogLinkSchema = Type.Object(
  { label: Type.String(), url: Type.String() },
  { additionalProperties: false },
);

const PluginCatalogEntrySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    remoteId: Type.Optional(Type.String()),
    logoUrl: Type.Optional(Type.String()),
    websiteUrl: Type.Optional(Type.String()),
    privacyPolicyUrl: Type.Optional(Type.String()),
    termsOfServiceUrl: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    available: Type.Optional(Type.Boolean()),
    unavailableReason: Type.Optional(Type.String()),
    unavailableHelp: Type.Optional(PluginCatalogLinkSchema),
    selectableWithoutTools: Type.Optional(Type.Boolean()),
    tools: Type.Union([
      Type.Null(),
      Type.Array(
        Type.Object(
          {
            id: Type.String(),
            name: Type.String(),
            description: Type.Optional(Type.String()),
            ownerId: Type.String(),
            available: Type.Optional(Type.Boolean()),
            unavailableReason: Type.Optional(Type.String()),
            destructive: Type.Optional(Type.Boolean()),
            writes: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      ),
    ]),
  },
  { additionalProperties: false },
);

export const AgentPluginCatalogResponse = Type.Object(
  {
    data: Type.Object(
      {
        plugins: Type.Array(PluginCatalogEntrySchema),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
        setup: Type.Optional(
          Type.Object(
            { message: Type.String(), links: Type.Array(PluginCatalogLinkSchema) },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentPluginDetailsResponse = Type.Object(
  { data: PluginCatalogEntrySchema, meta: Meta },
  { additionalProperties: false },
);

export const ChannelDirectoryLookupResponse = Type.Object(
  {
    data: Type.Object(
      {
        workspaceId: Type.String({ minLength: 1, maxLength: 200 }),
        workspaceName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        candidates: Type.Array(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 200 }),
              name: Type.String({ minLength: 1, maxLength: 200 }),
              displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        complete: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

const RuntimeEvidenceTimestamp = Type.String({
  format: "date-time",
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});

const PluginPolicyCapabilitiesSchema = Type.Object(
  {
    driver: Type.Ref("PluginDriverIdentity"),
    approvers: Type.Optional(
      Type.Object(
        { agent: Type.Boolean(), plugin: Type.Boolean(), tools: Type.Boolean() },
        { additionalProperties: false },
      ),
    ),
    toolDefaults: Type.Object(
      {
        enabled: Type.Boolean(),
        approval: Type.Array(PluginApprovalModeSchema),
        reviewer: Type.Array(PluginReviewerSchema),
      },
      { additionalProperties: false },
    ),
    tools: Type.Object(
      {
        enabled: Type.Boolean(),
        approval: Type.Array(PluginApprovalModeSchema),
        reviewer: Type.Array(PluginReviewerSchema),
      },
      { additionalProperties: false },
    ),
    driverPolicySchema: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

const PluginDiscoveryCredentialSchema = Type.Union([
  Type.Literal("required"),
  Type.Literal("none"),
]);

export const AgentPluginPolicyCapabilitiesResponse = Type.Object(
  {
    data: Type.Object(
      {
        ...PluginPolicyCapabilitiesSchema.properties,
        discoveryCredential: PluginDiscoveryCredentialSchema,
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

const InstallationCapabilitiesSchema = Type.Object(
  {
    agentProvisioning: Type.Optional(
      Type.Object(
        { executionModes: Type.Array(HarnessExecutionModeSchema, { minItems: 1, maxItems: 2 }) },
        { additionalProperties: false },
      ),
    ),
    pluginDiscovery: Type.Optional(
      Type.Object({ credential: PluginDiscoveryCredentialSchema }, { additionalProperties: false }),
    ),
    pluginPolicies: Type.Optional(PluginPolicyCapabilitiesSchema),
    nativeWorkers: Type.Optional(
      Type.Object(
        { support: Type.Union([Type.Literal("pinned-runtime"), Type.Literal("custom-image")]) },
        {
          additionalProperties: false,
          description:
            "Present only when dedicated native OpenClaw can be admitted, and says where its native worker support comes from.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export const InstallationSchema = Type.Object(
  {
    id: InstallationId,
    name: Name,
    createdAt: Timestamp,
    capabilities: Type.Optional(InstallationCapabilitiesSchema),
  },
  { additionalProperties: false },
);

export const NamespaceSchema = Type.Object(
  {
    id: NamespaceId,
    name: Name,
    existingNamespace: Type.Optional(KubernetesNamespaceName),
    status: Type.Union([
      Type.Literal("provisioning"),
      Type.Literal("ready"),
      Type.Literal("failed"),
      Type.Literal("deleting"),
    ]),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentSchema = Type.Object(
  {
    id: AgentId,
    namespaceId: NamespaceId,
    name: Name,
    servicePrincipalId: Type.String({ minLength: 1, maxLength: 200 }),
    configurationId: ConfigurationId,
    backendId: Type.Union([BackendId, Type.Null()]),
    harnessAuth: Type.Union([HarnessAuthBindingSchema, Type.Null()]),
    credentialSources: Type.Optional(AgentCredentialSourcesSchema),
    executionMode: HarnessExecutionModeSchema,
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    pluginApprovers: Type.Optional(Type.Ref("PluginApprovers")),
    repositoryBindings: Type.Optional(RepositoryBindingSelectionsSchema),
    repositoryAccess: Type.Optional(RepositoryAccessSchema),
    desiredRuntimeState: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
    activeRevisionId: Type.Optional(RevisionId),
    status: Type.Union([Type.Literal("active"), Type.Literal("deleting")]),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

const ConfigurationReadErrorSchema = Type.Object(
  {
    code: Type.Literal("SAVED_CONFIGURATION_UNREADABLE"),
    field: Type.Union([
      Type.Literal("plugins"),
      Type.Literal("pluginApprovers"),
      Type.Literal("repositoryBindings"),
      Type.Literal("repositoryAccess"),
      Type.Literal("harnessAuth"),
      Type.Literal("credentialSources"),
      Type.Literal("secretBindings"),
      Type.Literal("repositoryCredentials"),
      Type.Literal("configuration"),
    ]),
  },
  { additionalProperties: false },
);

const agentReadDescription =
  "An Agent with readable saved settings, or Agent metadata with configurationReadError (code SAVED_CONFIGURATION_UNREADABLE and the unreadable field). The error variant omits plugins, pluginApprovers, repositoryBindings, repositoryAccess, harnessAuth, and credentialSources.";

export const AgentReadSchema = Type.Union(
  [
    AgentSchema,
    Type.Object(
      {
        ...Type.Omit(AgentSchema, [
          "plugins",
          "pluginApprovers",
          "repositoryBindings",
          "repositoryAccess",
          "harnessAuth",
          "credentialSources",
        ]).properties,
        configurationReadError: ConfigurationReadErrorSchema,
      },
      { additionalProperties: false },
    ),
  ],
  {
    description: agentReadDescription,
  },
);

export const PluginDriverIdentitySchema = Type.Object(
  { id: Type.String({ minLength: 1 }), implementation: Type.String({ minLength: 1 }) },
  { additionalProperties: false, $id: "PluginDriverIdentity" },
);

export const PluginToolDefaultsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    approval: Type.Optional(PluginApprovalModeSchema),
    reviewer: Type.Optional(PluginReviewerSchema),
  },
  { additionalProperties: false, minProperties: 1, $id: "PluginToolDefaults" },
);

export const PluginToolPolicySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    approval: Type.Optional(PluginApprovalModeSchema),
    reviewer: Type.Optional(PluginReviewerSchema),
    approvers: Type.Optional(Type.Ref("PluginApprovers")),
  },
  { additionalProperties: false, minProperties: 1, $id: "PluginToolPolicy" },
);

const PluginIdPattern = "^[A-Za-z0-9._~:@-]{1,253}$";
const PluginToolIdPattern = "^[^\\u0000-\\u0020\\u007f]{1,1024}$";
const PluginToolPolicyMapSchema = Type.Unsafe({
  type: "object",
  description:
    "Tool overrides keyed by exact opaque tool IDs from the selected Plugin Driver catalog.",
  propertyNames: { pattern: PluginToolIdPattern },
  additionalProperties: false,
  patternProperties: {
    [PluginToolIdPattern]: Type.Ref("PluginToolPolicy"),
  },
});

export const PluginDesiredSelectionSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    approvers: Type.Optional(Type.Ref("PluginApprovers")),
    toolDefaults: Type.Optional(Type.Ref("PluginToolDefaults")),
    driverPolicy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    tools: Type.Optional(PluginToolPolicyMapSchema),
  },
  { additionalProperties: false, $id: "PluginDesiredSelection" },
);

export const PluginDesiredStateSchema = Type.Unsafe({
  $id: "PluginDesiredState",
  type: "object",
  description:
    "Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$.",
  propertyNames: { pattern: PluginIdPattern },
  additionalProperties: false,
  patternProperties: {
    [PluginIdPattern]: Type.Ref("PluginDesiredSelection"),
  },
});

export const ConfigurationSchema = Type.Object(
  {
    id: ConfigurationId,
    namespaceId: NamespaceId,
    kind: ConfigurationKindSchema,
    generation: ConfigurationGeneration,
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const SecretSchema = Type.Object(
  {
    id: SecretId,
    namespaceId: NamespaceId,
    name: Name,
    ref: SecretReference,
  },
  { additionalProperties: false },
);

/** Mirrors `SECRET_CONSUMER_LIMIT` in OCC: the most references one read examines. */
const SECRET_CONSUMER_LIMIT = 50;

export const SecretConsumersSchema = Type.Object(
  {
    agents: Type.Array(AgentId, {
      maxItems: SECRET_CONSUMER_LIMIT,
      description:
        "Readable Agents whose draft, active revision, or pending deployment references the Secret. Each needs a new deployment to receive a rotated value.",
    }),
    configurations: Type.Array(ConfigurationId, {
      maxItems: SECRET_CONSUMER_LIMIT,
      description: "Readable Configurations whose `secretBindings` reference the Secret.",
    }),
    credentialSources: Type.Array(CredentialSourceId, {
      maxItems: SECRET_CONSUMER_LIMIT,
      description: "Readable credential sources that hold the Secret.",
    }),
    provisioningRequests: Type.Array(AgentProvisioningWorkId, {
      maxItems: SECRET_CONSUMER_LIMIT,
      description:
        "Work IDs of queued or running Agent provisioning requests that reference the Secret, listed only for the actor that started them.",
    }),
    unreadable: Type.Integer({
      minimum: 0,
      maximum: SECRET_CONSUMER_LIMIT,
      description:
        "Examined references to resources the caller may not read. They are counted, never named.",
    }),
    truncated: Type.Boolean({
      description: `\`true\` when the Secret has more than ${SECRET_CONSUMER_LIMIT} references; only the first ${SECRET_CONSUMER_LIMIT}, ordered by kind and ID, are examined.`,
    }),
  },
  {
    additionalProperties: false,
    description:
      "Current references that block deletion of the Secret. Returned by the exact Secret read only.",
  },
);

export const SecretDetailSchema = Type.Object(
  {
    ...SecretSchema.properties,
    consumers: SecretConsumersSchema,
  },
  { additionalProperties: false },
);

export const CredentialRefreshStatusSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")]),
    expiresAt: Type.Optional(Type.String({ format: "date-time" })),
    nextRefreshAt: Type.Optional(Type.String({ format: "date-time" })),
    lastRefreshAt: Type.Optional(Type.String({ format: "date-time" })),
    failureCode: Type.Optional(Type.String({ maxLength: 128 })),
    recoveryAction: Type.Optional(
      Type.Union([
        Type.Literal("retry"),
        Type.Literal("reauthorize"),
        Type.Literal("fix_configuration"),
        Type.Literal("investigate"),
      ]),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material.",
  },
);

export const CredentialSourceStatusSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("ready"),
      Type.Literal("pending"),
      Type.Literal("failed"),
      Type.Literal("absent"),
    ]),
    reason: Type.Optional(Type.String({ maxLength: 512 })),
    refresh: Type.Optional(CredentialRefreshStatusSchema),
  },
  {
    additionalProperties: false,
    description:
      "Live status reported by the selected Credential Gateway. It never contains credential values.",
  },
);

export const CredentialSourceSchema = Type.Object(
  {
    id: CredentialSourceId,
    namespaceId: NamespaceId,
    name: Name,
    type: CredentialSourceType,
    config: CredentialSourceConfig,
    secrets: CredentialSourceSecrets,
    state: Type.Union([
      Type.Literal("registering"),
      Type.Literal("ready"),
      Type.Literal("deleting"),
    ]),
    ref: CredentialSourceReference,
    status: Type.Optional(CredentialSourceStatusSchema),
  },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialStatusSchema = Type.Object(
  {
    transportConfigured: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AgentRuntimeImagesResponse = Type.Object(
  {
    data: Type.Object(
      {
        status: Type.Union([
          Type.Literal("observed"),
          Type.Literal("undeployed"),
          Type.Literal("unsupported"),
        ]),
        images: Type.Array(
          Type.Object(
            {
              workload: Type.String(),
              container: Type.String(),
              image: Type.String(),
              imageId: Type.Union([Type.String(), Type.Null()]),
              commit: Type.Union([Type.String({ pattern: "^[a-f0-9]{40}$" }), Type.Null()]),
              openclawCommit: Type.Union([Type.String({ pattern: "^[a-f0-9]{40}$" }), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentProvisioningStatusSchema = Type.Object(
  {
    workId: Type.String({ minLength: 1, maxLength: 200 }),
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
    ]),
    phase: Type.Union([
      Type.Literal("admitted"),
      Type.Literal("configuration"),
      Type.Literal("transport"),
      Type.Literal("handoff"),
    ]),
    attemptCount: Type.Integer({ minimum: 0 }),
    updatedAt: Timestamp,
    agentId: Type.Optional(AgentId),
    configurationId: Type.Optional(ConfigurationId),
    revisionId: Type.Optional(RevisionId),
    url: Type.String({ minLength: 1 }),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 64 }),
          message: Type.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const IAMPermissionSchema = Type.Object(
  { action: PermissionActionSchema, resourceKind: ResourceKindSchema },
  { additionalProperties: false },
);

export const IAMRoleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    namespaceId: NamespaceId,
    name: Type.Optional(Name),
    permissions: Type.Array(IAMPermissionSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

const IAMAccessBindingBaseSchema = {
  id: Type.String({ minLength: 1, maxLength: 200 }),
  namespaceId: NamespaceId,
  subjectKind: Type.Union([Type.Literal("identity"), Type.Literal("group")]),
  subjectId: Type.String({ minLength: 1, maxLength: 200 }),
  roleId: Type.String({ minLength: 1, maxLength: 200 }),
};

export const IAMAccessBindingSchema = Type.Union([
  Type.Object(IAMAccessBindingBaseSchema, { additionalProperties: false }),
  Type.Object(
    {
      ...IAMAccessBindingBaseSchema,
      resourceKind: ResourceKindSchema,
      resourceId: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
]);

export const IAMServicePrincipalSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    namespaceId: NamespaceId,
  },
  {
    additionalProperties: false,
    description:
      "A non-Agent automation identity fixed to one Namespace. It holds only the grants of AccessBindings that name it.",
  },
);

export const ServiceAccountSchema = Type.Object(
  {
    id: ServiceAccountId,
    namespaceId: NamespaceId,
    name: Name,
    credential: Type.Optional(
      Type.Object(
        { kind: ServiceAccountCredentialSchema.properties.kind },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const BackendSummarySchema = Type.Object(
  {
    id: BackendId,
    type: Type.Union([Type.Literal("chatgpt"), Type.Literal("github"), Type.Literal("openshell")]),
  },
  { additionalProperties: false },
);

export const RepositoryOptionSchema = Type.Object(
  {
    repositoryRef: RepositoryBindingSelectionSchema.properties.repositoryRef,
    displayName: Name,
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    allowedProfiles: Type.Array(RepositoryBindingSelectionSchema.properties.profile, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const InstallationResponse = Type.Object(
  { data: InstallationSchema, meta: Meta },
  { additionalProperties: false },
);

export const InstallationDeploymentInventorySchema = Type.Object(
  {
    installationId: InstallationId,
    namespaces: Type.Array(
      Type.Object(
        {
          id: NamespaceId,
          status: NamespaceSchema.properties.status,
          agents: Type.Array(
            Type.Object(
              {
                id: AgentId,
                status: AgentSchema.properties.status,
                desiredRuntimeState: AgentSchema.properties.desiredRuntimeState,
                executionMode: AgentSchema.properties.executionMode,
                activeRevisionId: Type.Optional(RevisionId),
                deploymentInProgress: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const InstallationDeploymentInventoryResponse = Type.Object(
  { data: InstallationDeploymentInventorySchema, meta: Meta },
  { additionalProperties: false },
);

export const NamespaceResponse = Type.Object(
  { data: NamespaceSchema, meta: Meta },
  { additionalProperties: false },
);

export const NamespaceListResponse = Type.Object(
  { data: Type.Array(NamespaceSchema), meta: Meta },
  { additionalProperties: false },
);

export const ConfigurationResponse = Type.Object(
  { data: ConfigurationSchema, meta: Meta },
  { additionalProperties: false },
);

export const SecretResponse = Type.Object(
  { data: SecretSchema, meta: Meta },
  {
    $id: "SecretResponse",
    additionalProperties: false,
  },
);

export const SecretDetailResponse = Type.Object(
  { data: SecretDetailSchema, meta: Meta },
  { additionalProperties: false },
);

export const CredentialSourceResponse = Type.Object(
  { data: CredentialSourceSchema, meta: Meta },
  {
    $id: "CredentialSourceResponse",
    additionalProperties: false,
  },
);

export const CredentialWithdrawalSchema = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    revisionId: Type.String({
      ...RevisionId,
      description:
        "The revision whose withdrawal is reported: the active one, unless an earlier revision not yet retired or a later admitted one still has a `pending` withdrawal of the source (one with no attempt queued first). So `revoked` means every revision that may run with the source confirmed it.",
    }),
    credentialSourceId: CredentialSourceId,
    state: Type.Union([Type.Literal("pending"), Type.Literal("revoked")], {
      description:
        "`revoked` only after the Credential Gateway confirmed that the revision's placeholders no longer resolve.",
    }),
    requestedBy: Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        "Principal whose `agent:operate` permission the worker re-checks before revoking.",
    }),
    requestedAt: Type.String({ format: "date-time" }),
    completedAt: Type.Optional(Type.String({ format: "date-time" })),
    reason: Type.Optional(
      Type.String({
        pattern: "^[A-Z0-9_]{1,64}$",
        description:
          "Reason code of the worker's most recent attempt, for example `CREDENTIAL_WITHDRAWAL_PENDING` while the gateway has not confirmed revocation.",
      }),
    ),
    lastAttemptAt: Type.Optional(Type.String({ format: "date-time" })),
    withdrawalInProgress: Type.Boolean({
      description:
        "`true` while a withdrawal attempt is queued or running. A `pending` withdrawal with `false` has no attempt queued; unless revision maintenance queues one, send the withdraw request again to retry it.",
    }),
  },
  { additionalProperties: false },
);

export const CredentialWithdrawalResponse = Type.Object(
  { data: CredentialWithdrawalSchema, meta: Meta },
  { additionalProperties: false },
);

export const CredentialSourceListResponse = Type.Object(
  { data: Type.Array(CredentialSourceSchema), meta: Meta },
  { additionalProperties: false },
);

export const SecretListResponse = Type.Object(
  { data: Type.Array(SecretSchema), meta: Meta },
  { additionalProperties: false },
);

export const ServiceAccountResponse = Type.Object(
  { data: ServiceAccountSchema, meta: Meta },
  { additionalProperties: false },
);

export const ServiceAccountForceDeletionResponse = Type.Object(
  {
    data: Type.Object(
      {
        id: ServiceAccountId,
        namespaceId: NamespaceId,
        revocation: Type.Literal("skipped", {
          description:
            "The account's issued access token was not revoked: no ChatGPT Backend can revoke it. Revoke it at the provider; the audit event names its Backend and credential ID.",
        }),
        backendId: Type.Optional(BackendId),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  {
    additionalProperties: false,
    description:
      "A forced deletion removed the account and its credential Secret but could not revoke its issued access token.",
  },
);

export const ServiceAccountListResponse = Type.Object(
  { data: Type.Array(ServiceAccountSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentResponse = Type.Object(
  { data: AgentSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentReadResponse = Type.Object(
  { data: AgentReadSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentProvisioningResponse = Type.Object(
  {
    data: Type.Object(
      {
        provisioning: AgentProvisioningStatusSchema,
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentProvisioningStatusResponse = Type.Object(
  { data: AgentProvisioningStatusSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialResponse = Type.Object(
  { data: AgentRuntimeCredentialStatusSchema, meta: Meta },
  { $id: "AgentRuntimeCredentialResponse", additionalProperties: false },
);

export const IAMRoleResponse = Type.Object(
  { data: IAMRoleSchema, meta: Meta },
  { additionalProperties: false },
);

export const IAMRoleListResponse = Type.Object(
  { data: Type.Array(IAMRoleSchema), meta: Meta },
  { additionalProperties: false },
);

export const IAMAccessBindingResponse = Type.Object(
  { data: IAMAccessBindingSchema, meta: Meta },
  { additionalProperties: false },
);

export const IAMServicePrincipalResponse = Type.Object(
  { data: IAMServicePrincipalSchema, meta: Meta },
  { additionalProperties: false },
);

export const IAMServicePrincipalListResponse = Type.Object(
  { data: Type.Array(IAMServicePrincipalSchema), meta: Meta },
  { additionalProperties: false },
);

export const IAMAccessBindingListResponse = Type.Object(
  { data: Type.Array(IAMAccessBindingSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentListResponse = Type.Object(
  { data: Type.Array(AgentReadSchema, { description: agentReadDescription }), meta: Meta },
  { additionalProperties: false },
);

export const BackendListResponse = Type.Object(
  { data: Type.Array(BackendSummarySchema), meta: Meta },
  { additionalProperties: false },
);

export const RepositoryOptionListResponse = Type.Object(
  {
    data: Type.Array(RepositoryOptionSchema, { maxItems: 1000 }),
    meta: Type.Object(
      { ...Meta.properties, descriptionsPending: Type.Boolean() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ObservabilityResponse = Type.Object(
  {
    data: Type.Object(
      { url: Type.Union([Type.String({ format: "uri" }), Type.Null()]) },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

/** Public revision projection excludes provider grant identities and material. */
export const RepositoryRevisionStateSchema = Type.Object(
  {
    driver: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        implementation: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    deadlineWallMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    bindings: RepositoryBindingSelectionsSchema,
  },
  { additionalProperties: false },
);

export const AgentRevisionSchema = Type.Object(
  {
    id: RevisionId,
    namespaceId: NamespaceId,
    agentId: AgentId,
    revision: Type.Integer({ minimum: 1 }),
    backendId: Type.Union([BackendId, Type.Null()]),
    configurationId: ConfigurationId,
    configurationKind: ConfigurationKindSchema,
    configurationGeneration: ConfigurationGeneration,
    configuration: ConfigurationValues,
    harness: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        version: Type.String({ minLength: 1 }),
        mode: HarnessExecutionModeSchema,
      },
      { additionalProperties: false },
    ),
    compute: Type.Object(
      { id: Type.String({ minLength: 1 }), implementation: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    secretDriverId: Type.Optional(Type.String({ minLength: 1 })),
    secretBindings: Type.Optional(SecretBindings),
    plugins: Type.Optional(
      Type.Object(
        {
          driver: Type.Ref("PluginDriverIdentity"),
          plugins: Type.Ref("PluginDesiredState"),
        },
        { additionalProperties: false },
      ),
    ),
    pluginApprovers: Type.Optional(Type.Ref("PluginApprovers")),
    harnessAuth: HarnessAuthBindingSchema,
    credentialSources: Type.Optional(AgentCredentialSourcesSchema),
    repositoryCredentials: Type.Optional(RepositoryRevisionStateSchema),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentRevisionResponse = Type.Object(
  { data: AgentRevisionSchema, meta: Meta },
  { additionalProperties: false },
);

const agentRevisionReadDescription =
  "An immutable revision with readable saved settings, or revision metadata with configurationReadError (code SAVED_CONFIGURATION_UNREADABLE and the unreadable field). The error variant omits saved configuration fields.";

export const AgentRevisionReadSchema = Type.Union(
  [
    AgentRevisionSchema,
    Type.Object(
      {
        ...Type.Pick(AgentRevisionSchema, [
          "id",
          "namespaceId",
          "agentId",
          "revision",
          "backendId",
          "createdAt",
        ]).properties,
        configurationReadError: ConfigurationReadErrorSchema,
      },
      { additionalProperties: false },
    ),
  ],
  {
    description: agentRevisionReadDescription,
  },
);

export const AgentRevisionReadResponse = Type.Object(
  { data: AgentRevisionReadSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentRevisionListResponse = Type.Object(
  {
    data: Type.Array(AgentRevisionReadSchema, { description: agentRevisionReadDescription }),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentDeploymentStatusSchema = Type.Object(
  {
    deploymentId: RevisionId,
    namespaceId: NamespaceId,
    agentId: AgentId,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
    ]),
    progress: Type.Union(
      [
        Type.Null(),
        Type.Object(
          {
            lastAttempt: Type.Union(
              [
                Type.Null(),
                Type.Object(
                  {
                    at: Timestamp,
                    code: Type.String({ minLength: 1, maxLength: 64 }),
                    message: Type.String({ minLength: 1 }),
                  },
                  { additionalProperties: false },
                ),
              ],
              {
                description:
                  "Latest reconciliation result bound to this exact deployment work item. Null means no bound result is available, not proof that work never ran. Codes and messages are allowlisted; provider text is not exposed.",
              },
            ),
            nextAttemptAt: Type.Union([Timestamp, Type.Null()], {
              description:
                "Earliest time queued work is eligible to run, not a promised start time. Null while claimed.",
            }),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          "Pending deployment progress. Null for terminal outcomes. A last attempt describes a recorded result, not current runtime health.",
      },
    ),
    error: Type.Union(
      [
        Type.Null(),
        Type.Object(
          {
            code: Type.String({ minLength: 1, maxLength: 64 }),
            message: Type.String({ minLength: 1 }),
            data: Type.Optional(
              Type.Union([
                Type.Object(
                  {
                    timeoutMs: Type.Integer({ minimum: 1 }),
                    runtimeFailure: Type.Optional(
                      Type.Object(
                        {
                          component: RuntimeFailureIdentifier,
                          check: RuntimeFailureIdentifier,
                          checkedAt: RuntimeEvidenceTimestamp,
                          code: RuntimeFailureIdentifier,
                        },
                        { additionalProperties: false },
                      ),
                    ),
                  },
                  { additionalProperties: false },
                ),
                Type.Object(
                  {
                    runtimeFailure: Type.Object(
                      {
                        component: RuntimeFailureIdentifier,
                        check: RuntimeFailureIdentifier,
                        checkedAt: RuntimeEvidenceTimestamp,
                        code: Type.Literal("MODEL_PROBE_FAILED"),
                        cause: Type.Optional(RuntimeFailureCauseSchema),
                      },
                      { additionalProperties: false },
                    ),
                  },
                  { additionalProperties: false },
                ),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          "Null unless deployment failed. A failure contains code, a fixed safe message, and optional allowlisted data. CONVERGENCE_DEADLINE_EXCEEDED may include data.timeoutMs and data.runtimeFailure with bounded startup-failure evidence. RUNTIME_MODEL_PROBE_FAILED may include data.runtimeFailure with the classified cause of the startup model check failure. Native error text is never returned.",
      },
    ),
    warnings: Type.Array(
      Type.Object(
        {
          code: Type.Union([
            Type.Literal("PLUGIN_INSTALL_FAILED"),
            Type.Literal("PLUGIN_AUTH_REQUIRED"),
          ]),
          pluginId: Type.String({
            minLength: 1,
            maxLength: 253,
            pattern: PluginIdPattern,
            description: "The admitted Agent plugin selection key.",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description:
          "Warnings recorded from this deployment startup. Plugin install and connector-auth warnings mean the deployment succeeded after the runtime disabled the affected admitted plugin for that startup.",
      },
    ),
  },
  { additionalProperties: false },
);

export const AgentDeploymentStatusResponse = Type.Object(
  { data: AgentDeploymentStatusSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentDeploymentDiagnosticsSchema = Type.Object(
  {
    revisionId: RevisionId,
    observedAt: Timestamp,
    checks: Type.Array(
      Type.Object(
        {
          component: RuntimeFailureIdentifier,
          check: RuntimeFailureIdentifier,
          state: Type.Union([
            Type.Literal("succeeded"),
            Type.Literal("failed"),
            Type.Literal("unknown"),
          ]),
          checkedAt: Type.Union([Timestamp, Type.Null()]),
          code: Type.Optional(RuntimeFailureIdentifier),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

export const AgentDeploymentDiagnosticsResponse = Type.Object(
  { data: AgentDeploymentDiagnosticsSchema, meta: Meta },
  { $id: "AgentDeploymentDiagnosticsResponse", additionalProperties: false },
);

const RuntimeLogContainerSourceIdSchema = Type.Union([
  Type.Literal("gateway"),
  Type.Literal("agent"),
]);
const RuntimeLogSourceIdSchema = Type.Union([
  Type.Literal("gateway"),
  Type.Literal("agent"),
  Type.Literal("sandbox"),
]);
const KubernetesObjectName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$",
});
const KubernetesUid = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9-]+$" });
const RuntimeReason = Type.String({ maxLength: 128 });
const RuntimeMessage = Type.String({ maxLength: 8192 });
// Kubelet timestamps carry up to nanosecond precision.
const RuntimeTimestamp = Type.Union([
  Type.String({
    format: "date-time",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?Z$",
  }),
  Type.Null(),
]);

export const RuntimeLogStreamSchema = Type.Object(
  {
    source: RuntimeLogSourceIdSchema,
    pod: Type.Optional(KubernetesObjectName),
    podUid: Type.Optional(KubernetesUid),
    container: Type.Optional(KubernetesObjectName),
    restartCount: Type.Optional(Type.Integer({ minimum: 0 })),
    sandbox: Type.Optional(KubernetesObjectName),
  },
  { additionalProperties: false },
);

export const RuntimeLogRecordSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("line"),
      time: RuntimeTimestamp,
      stream: RuntimeLogStreamSchema,
      contentClass: Type.Union([
        Type.Literal("operational"),
        Type.Literal("activity"),
        Type.Literal("content"),
      ]),
      kind: Type.Union([
        Type.Literal("wrapper"),
        Type.Literal("openclaw"),
        Type.Literal("codex"),
        Type.Literal("sandbox"),
        Type.Literal("text"),
      ]),
      level: Type.Union([
        Type.Literal("error"),
        Type.Literal("warn"),
        Type.Literal("info"),
        Type.Literal("debug"),
        Type.Literal("unknown"),
      ]),
      message: RuntimeMessage,
      subsystem: Type.Optional(Type.String({ maxLength: 512 })),
      fields: Type.Optional(
        Type.Record(
          Type.String({ maxLength: 64 }),
          Type.Union([Type.String({ maxLength: 1024 }), Type.Number(), Type.Boolean()]),
        ),
      ),
      truncated: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("gap"),
      time: RuntimeTimestamp,
      stream: RuntimeLogStreamSchema,
      reason: Type.Union([
        Type.Literal("stream_replaced"),
        Type.Literal("window_exceeded"),
        Type.Literal("cursor_expired"),
        Type.Literal("truncated"),
        Type.Literal("buffer_lost"),
      ]),
      remedy: Type.String({ maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("withheld"),
      time: RuntimeTimestamp,
      stream: RuntimeLogStreamSchema,
      count: Type.Integer({ minimum: 1 }),
      reason: Type.Union([
        Type.Literal("unrecognised_structured"),
        Type.Literal("oversized"),
        Type.Literal("malformed"),
      ]),
    },
    { additionalProperties: false },
  ),
]);

export const AgentRuntimeDescriptionSchema = Type.Object(
  {
    revisionId: RevisionId,
    observedAt: Timestamp,
    pods: Type.Array(
      Type.Object(
        {
          role: RuntimeLogContainerSourceIdSchema,
          cluster: Type.Union([Type.Literal("control"), Type.Literal("execution")]),
          name: KubernetesObjectName,
          uid: KubernetesUid,
          phase: Type.String({ maxLength: 64 }),
          ready: Type.Boolean(),
          createdAt: RuntimeTimestamp,
          containers: Type.Array(
            Type.Object(
              {
                name: KubernetesObjectName,
                state: Type.Union([
                  Type.Literal("waiting"),
                  Type.Literal("running"),
                  Type.Literal("terminated"),
                  Type.Literal("unknown"),
                ]),
                reason: Type.Union([RuntimeReason, Type.Null()]),
                ready: Type.Boolean(),
                restartCount: Type.Integer({ minimum: 0 }),
                startedAt: RuntimeTimestamp,
                lastTermination: Type.Union([
                  Type.Object(
                    {
                      reason: Type.Union([RuntimeReason, Type.Null()]),
                      exitCode: Type.Union([Type.Integer(), Type.Null()]),
                      finishedAt: RuntimeTimestamp,
                    },
                    { additionalProperties: false },
                  ),
                  Type.Null(),
                ]),
              },
              { additionalProperties: false },
            ),
            { maxItems: 16 },
          ),
          events: Type.Array(
            Type.Object(
              {
                type: Type.Union([Type.Literal("Normal"), Type.Literal("Warning")]),
                container: Type.Union([KubernetesObjectName, Type.Null()]),
                reason: RuntimeReason,
                message: Type.String({ maxLength: 2048 }),
                count: Type.Integer({ minimum: 1 }),
                lastObservedAt: RuntimeTimestamp,
              },
              { additionalProperties: false },
            ),
            { maxItems: 100 },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    sources: Type.Array(
      Type.Object(
        {
          id: RuntimeLogSourceIdSchema,
          kind: Type.Union([Type.Literal("container"), Type.Literal("sandbox")]),
          pods: Type.Array(
            Type.Object(
              {
                name: KubernetesObjectName,
                uid: KubernetesUid,
                container: KubernetesObjectName,
                restartCount: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 16 },
          ),
          available: Type.Boolean(),
          unavailableCode: Type.Optional(Type.Literal("NO_POD")),
          retention: Type.String({ maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

export const AgentRuntimeResponse = Type.Object(
  { data: AgentRuntimeDescriptionSchema, meta: Meta },
  { $id: "AgentRuntimeResponse", additionalProperties: false },
);

export const AgentRuntimeLogPageSchema = Type.Object(
  {
    revisionId: RevisionId,
    source: RuntimeLogSourceIdSchema,
    stream: Type.Union([RuntimeLogStreamSchema, Type.Null()]),
    observedAt: Timestamp,
    records: Type.Array(RuntimeLogRecordSchema, { maxItems: 1100 }),
    withheld: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    cursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const AgentRuntimeLogsResponse = Type.Object(
  { data: AgentRuntimeLogPageSchema, meta: Meta },
  { $id: "AgentRuntimeLogsResponse", additionalProperties: false },
);

export const WorkspaceFileResponse = Type.Object(
  {
    data: Type.Object(
      {
        name: WorkspaceFileName,
        content: Type.String({ maxLength: 16 * 1024, pattern: "^[^\\u0000]*$" }),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const WorkspaceFileUpdateResponse = Type.Object(
  {
    data: Type.Object(
      {
        name: WorkspaceFileName,
        size: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 * 1024 })),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export type InstallationWire = Type.Static<typeof InstallationSchema>;
export type InstallationDeploymentInventoryWire = Type.Static<
  typeof InstallationDeploymentInventorySchema
>;
export type NamespaceWire = Type.Static<typeof NamespaceSchema>;
export type ConfigurationWire = Type.Static<typeof ConfigurationSchema>;
export type SecretWire = Type.Static<typeof SecretSchema>;
export type ServiceAccountWire = Type.Static<typeof ServiceAccountSchema>;
export type BackendSummaryWire = Type.Static<typeof BackendSummarySchema>;
export type AgentReadWire = Type.Static<typeof AgentReadSchema>;
export type AgentRevisionReadWire = Type.Static<typeof AgentRevisionReadSchema>;
export type AgentReadResponse = Type.Static<typeof AgentReadResponse>;
export type AgentRevisionReadResponse = Type.Static<typeof AgentRevisionReadResponse>;
export type AgentWire = Type.Static<typeof AgentSchema>;
export type AgentRuntimeCredentialStatusWire = Type.Static<
  typeof AgentRuntimeCredentialStatusSchema
>;
export type AgentProvisioningStatusWire = Type.Static<typeof AgentProvisioningStatusSchema>;
export type IAMPermissionWire = Type.Static<typeof IAMPermissionSchema>;
export type IAMRoleWire = Type.Static<typeof IAMRoleSchema>;
export type IAMAccessBindingWire = Type.Static<typeof IAMAccessBindingSchema>;
export type AgentRevisionWire = Type.Static<typeof AgentRevisionSchema>;
export type AgentDeploymentStatusWire = Type.Static<typeof AgentDeploymentStatusSchema>;
export type AgentDeploymentDiagnosticsWire = Type.Static<typeof AgentDeploymentDiagnosticsSchema>;
export type InstallationResponse = Type.Static<typeof InstallationResponse>;
export type InstallationDeploymentInventoryResponse = Type.Static<
  typeof InstallationDeploymentInventoryResponse
>;
export type NamespaceResponse = Type.Static<typeof NamespaceResponse>;
export type NamespaceListResponse = Type.Static<typeof NamespaceListResponse>;
export type ConfigurationResponse = Type.Static<typeof ConfigurationResponse>;
export type SecretResponse = Type.Static<typeof SecretResponse>;
export type SecretDetailResponse = Type.Static<typeof SecretDetailResponse>;
export type CredentialSourceWire = Type.Static<typeof CredentialSourceSchema>;
export type CredentialSourceResponse = Type.Static<typeof CredentialSourceResponse>;
export type CredentialSourceListResponse = Type.Static<typeof CredentialSourceListResponse>;
export type CredentialWithdrawalWire = Type.Static<typeof CredentialWithdrawalSchema>;
export type CredentialWithdrawalResponse = Type.Static<typeof CredentialWithdrawalResponse>;
export type SecretListResponse = Type.Static<typeof SecretListResponse>;
export type ServiceAccountResponse = Type.Static<typeof ServiceAccountResponse>;
export type ServiceAccountForceDeletionResponse = Type.Static<
  typeof ServiceAccountForceDeletionResponse
>;
export type ServiceAccountListResponse = Type.Static<typeof ServiceAccountListResponse>;
export type AgentResponse = Type.Static<typeof AgentResponse>;
export type AgentRuntimeCredentialResponse = Type.Static<typeof AgentRuntimeCredentialResponse>;
export type IAMRoleResponse = Type.Static<typeof IAMRoleResponse>;
export type IAMRoleListResponse = Type.Static<typeof IAMRoleListResponse>;
export type IAMAccessBindingResponse = Type.Static<typeof IAMAccessBindingResponse>;
export type IAMAccessBindingListResponse = Type.Static<typeof IAMAccessBindingListResponse>;
export type IAMServicePrincipalResponse = Type.Static<typeof IAMServicePrincipalResponse>;
export type IAMServicePrincipalListResponse = Type.Static<typeof IAMServicePrincipalListResponse>;
export type AgentListResponse = Type.Static<typeof AgentListResponse>;
export type BackendListResponse = Type.Static<typeof BackendListResponse>;
export type AgentProvisioningResponse = Type.Static<typeof AgentProvisioningResponse>;
export type AgentProvisioningStatusResponse = Type.Static<typeof AgentProvisioningStatusResponse>;
export type RepositoryOptionListResponse = Type.Static<typeof RepositoryOptionListResponse>;
export type AgentRevisionResponse = Type.Static<typeof AgentRevisionResponse>;
export type AgentRevisionListResponse = Type.Static<typeof AgentRevisionListResponse>;
export type AgentDeploymentStatusResponse = Type.Static<typeof AgentDeploymentStatusResponse>;
export type AgentDeploymentDiagnosticsResponse = Type.Static<
  typeof AgentDeploymentDiagnosticsResponse
>;
export type AgentRuntimeResponse = Type.Static<typeof AgentRuntimeResponse>;
export type AgentRuntimeLogsResponse = Type.Static<typeof AgentRuntimeLogsResponse>;
export type AgentRuntimeLogPageWire = Type.Static<typeof AgentRuntimeLogPageSchema>;
export type WorkspaceFileResponse = Type.Static<typeof WorkspaceFileResponse>;
export type WorkspaceFileUpdateResponse = Type.Static<typeof WorkspaceFileUpdateResponse>;

export const PresetSchema = Type.Object(
  {
    id: PresetId,
    namespaceId: NamespaceId,
    name: Name,
    template: PresetTemplateSchema,
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export const PresetResponse = Type.Object(
  { data: PresetSchema, meta: Meta },
  { additionalProperties: false },
);
export const PresetListResponse = Type.Object(
  { data: Type.Array(PresetSchema), meta: Meta },
  { additionalProperties: false },
);
export type PresetWire = Type.Static<typeof PresetSchema>;
export type PresetResponse = Type.Static<typeof PresetResponse>;
export type PresetListResponse = Type.Static<typeof PresetListResponse>;
