import { Type } from "typebox";

import {
  AgentId,
  PresetId,
  PresetTemplateSchema,
  ConfigurationGeneration,
  ConfigurationId,
  ConfigurationKindSchema,
  ConfigurationValues,
  HarnessExecutionModeSchema,
  HarnessAuthBindingSchema,
  InstallationId,
  KubernetesNamespaceName,
  Meta,
  Name,
  NamespaceId,
  PermissionActionSchema,
  BackendId,
  RepositoryBindingSelectionSchema,
  RepositoryBindingSelectionsSchema,
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
    executionMode: HarnessExecutionModeSchema,
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    pluginApprovers: Type.Optional(Type.Ref("PluginApprovers")),
    repositoryBindings: Type.Optional(RepositoryBindingSelectionsSchema),
    desiredRuntimeState: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
    activeRevisionId: Type.Optional(RevisionId),
    status: Type.Union([Type.Literal("active"), Type.Literal("deleting")]),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
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
    type: Type.Union([Type.Literal("chatgpt"), Type.Literal("github")]),
  },
  { additionalProperties: false },
);

export const RepositoryOptionSchema = Type.Object(
  {
    repositoryRef: RepositoryBindingSelectionSchema.properties.repositoryRef,
    displayName: Name,
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

export const SecretListResponse = Type.Object(
  { data: Type.Array(SecretSchema), meta: Meta },
  { additionalProperties: false },
);

export const ServiceAccountResponse = Type.Object(
  { data: ServiceAccountSchema, meta: Meta },
  { additionalProperties: false },
);

export const ServiceAccountListResponse = Type.Object(
  { data: Type.Array(ServiceAccountSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentResponse = Type.Object(
  { data: AgentSchema, meta: Meta },
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

export const IAMAccessBindingListResponse = Type.Object(
  { data: Type.Array(IAMAccessBindingSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentListResponse = Type.Object(
  { data: Type.Array(AgentSchema), meta: Meta },
  { additionalProperties: false },
);

export const BackendListResponse = Type.Object(
  { data: Type.Array(BackendSummarySchema), meta: Meta },
  { additionalProperties: false },
);

export const RepositoryOptionListResponse = Type.Object(
  { data: Type.Array(RepositoryOptionSchema, { maxItems: 128 }), meta: Meta },
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
    repositoryCredentials: Type.Optional(RepositoryRevisionStateSchema),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentRevisionResponse = Type.Object(
  { data: AgentRevisionSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentRevisionListResponse = Type.Object(
  { data: Type.Array(AgentRevisionSchema), meta: Meta },
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
    error: Type.Union(
      [
        Type.Null(),
        Type.Object(
          {
            code: Type.String({ minLength: 1, maxLength: 64 }),
            message: Type.String({ minLength: 1 }),
            data: Type.Optional(
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
            ),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          "Null unless deployment failed. A failure contains code, a fixed safe message, and optional allowlisted data. CONVERGENCE_DEADLINE_EXCEEDED may include data.timeoutMs and data.runtimeFailure with bounded startup-failure evidence. Native error text is never returned.",
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
export type SecretListResponse = Type.Static<typeof SecretListResponse>;
export type ServiceAccountResponse = Type.Static<typeof ServiceAccountResponse>;
export type ServiceAccountListResponse = Type.Static<typeof ServiceAccountListResponse>;
export type AgentResponse = Type.Static<typeof AgentResponse>;
export type AgentRuntimeCredentialResponse = Type.Static<typeof AgentRuntimeCredentialResponse>;
export type IAMRoleResponse = Type.Static<typeof IAMRoleResponse>;
export type IAMRoleListResponse = Type.Static<typeof IAMRoleListResponse>;
export type IAMAccessBindingResponse = Type.Static<typeof IAMAccessBindingResponse>;
export type IAMAccessBindingListResponse = Type.Static<typeof IAMAccessBindingListResponse>;
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
