import { Type } from "typebox";

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const InstallationId = Type.String({ pattern: `^ins_${UUID_V4}$` });
export const NamespaceId = Type.String({ pattern: `^ns_${UUID_V4}$` });
export const PresetId = Type.String({ pattern: `^pre_${UUID_V4}$` });
export const ConfigurationId = Type.String({ pattern: `^cfg_${UUID_V4}$` });
export const ServiceAccountId = Type.String({ pattern: `^sa_${UUID_V4}$` });
export const SecretId = Type.String({ pattern: `^sec_${UUID_V4}$` });
export const IAMRoleId = Type.String({ minLength: 1, maxLength: 200 });
export const IAMAccessBindingId = Type.String({ minLength: 1, maxLength: 200 });
export const ConfigurationKindSchema = Type.Literal("agent");
export const HarnessExecutionModeSchema = Type.Union([
  Type.Literal("embedded"),
  Type.Literal("dedicated"),
]);
export const ConfigurationGeneration = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const AgentId = Type.String({ pattern: `^agt_${UUID_V4}$` });
export const RevisionId = Type.String({ pattern: `^rev_${UUID_V4}$` });
export const AuditId = Type.String({ pattern: `^aud_${UUID_V4}$` });
export const RequestId = Type.String({ pattern: `^req_${UUID_V4}$` });
export const AgentProvisioningWorkId = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9._~:@/-]{1,200}$",
});
export const ProviderId = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$/.source,
});

export const Timestamp = Type.String({
  format: "date-time",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$",
});

export const Name = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$/.source,
});

export const KubernetesNamespaceName = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$",
});

export const Meta = Type.Object({ requestId: RequestId }, { additionalProperties: false });

export const NamedResourceBody = Type.Object({ name: Name }, { additionalProperties: false });

export const CreateNamespaceBody = Type.Object(
  { name: Name, existingNamespace: Type.Optional(KubernetesNamespaceName) },
  { additionalProperties: false },
);

export const EmptyQuery = Type.Object({}, { additionalProperties: false });

export const NamespaceParams = Type.Object(
  { namespaceId: NamespaceId },
  { additionalProperties: false },
);

export const AgentParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId },
  { additionalProperties: false },
);

export const AgentProvisioningParams = Type.Object(
  { namespaceId: NamespaceId, workId: AgentProvisioningWorkId },
  { additionalProperties: false },
);

export const ConfigurationParams = Type.Object(
  { namespaceId: NamespaceId, configurationId: ConfigurationId },
  { additionalProperties: false },
);

export const PresetParams = Type.Object(
  { namespaceId: NamespaceId, presetId: PresetId },
  { additionalProperties: false },
);

export const ServiceAccountParams = Type.Object(
  { namespaceId: NamespaceId, serviceAccountId: ServiceAccountId },
  { additionalProperties: false },
);

export const SecretParams = Type.Object(
  { namespaceId: NamespaceId, secretId: SecretId },
  { additionalProperties: false },
);

export const IAMRoleParams = Type.Object(
  { namespaceId: NamespaceId, roleId: IAMRoleId },
  { additionalProperties: false },
);

export const IAMAccessBindingParams = Type.Object(
  { namespaceId: NamespaceId, bindingId: IAMAccessBindingId },
  { additionalProperties: false },
);

export const RevisionParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, revisionId: RevisionId },
  { additionalProperties: false },
);

export const DeploymentParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, deploymentId: RevisionId },
  { additionalProperties: false },
);

export const WORKSPACE_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
] as const);

export const WorkspaceFileName = Type.Enum([...WORKSPACE_FILE_NAMES]);

export const WorkspaceFileParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, name: WorkspaceFileName },
  { additionalProperties: false },
);

export const JsonValue = Type.Union(
  [
    Type.String(),
    Type.Boolean(),
    Type.Number(),
    Type.Null(),
    Type.Array(Type.Ref("SafeJsonValue")),
    Type.Object({}, { additionalProperties: Type.Ref("SafeJsonValue") }),
  ],
  { $id: "SafeJsonValue" },
);

export const ConfigurationValues = Type.Object(
  {},
  {
    additionalProperties: Type.Ref("SafeJsonValue"),
    description: "A native OpenClaw configuration document.",
  },
);

export const SecretReference = Type.Object(
  { kind: Type.Literal("secret"), namespaceId: NamespaceId, id: SecretId },
  {
    additionalProperties: false,
    description:
      'Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`.',
  },
);

export const HarnessAuthBindingSchema = Type.Union([
  Type.Object({ method: Type.Literal("runtime") }, { additionalProperties: false }),
  Type.Object(
    { method: Type.Literal("api_key"), source: SecretReference },
    { additionalProperties: false },
  ),
  Type.Object(
    { method: Type.Literal("codex_pat"), source: SecretReference },
    { additionalProperties: false },
  ),
  Type.Object(
    { method: Type.Literal("chatgpt_service_account"), serviceAccountId: ServiceAccountId },
    { additionalProperties: false },
  ),
]);

export const SecretDelivery = Type.Object(
  { type: Type.Literal("env") },
  {
    additionalProperties: false,
    description: 'Gateway delivery mode. Only `{ "type": "env" }` is supported.',
  },
);

export const SecretBinding = Type.Object(
  { source: SecretReference, delivery: Type.Optional(SecretDelivery) },
  {
    additionalProperties: false,
    description:
      'Maps one destination environment variable to one exact Secret reference. Optional `delivery` defaults to `{ "type": "env" }` during admission.',
  },
);

export const SecretBindings = Type.Record(
  Type.String({
    minLength: 1,
    maxLength: 253,
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  }),
  SecretBinding,
  {
    maxProperties: 64,
    description:
      'Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth.',
  },
);

export const SecretValue = Type.String({
  minLength: 1,
  maxLength: 65536,
  pattern: "^[^\\u0000]*$",
  description:
    "Protected Secret value. It must be nonempty UTF-8 without NUL; OCC accepts at most 65,536 UTF-8 bytes and still enforces the route request body limit.",
});

export const CreateSecretBody = Type.Object(
  { name: Name, value: SecretValue },
  { additionalProperties: false },
);

export const UpdateSecretBody = Type.Object(
  { value: SecretValue },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialsBody = Type.Object({}, { additionalProperties: false });

export const DiscoverAgentModelsBody = Type.Object(
  {
    provider: Type.Union([Type.Literal("openai"), Type.Literal("anthropic")]),
    authMethod: Type.Union([Type.Literal("api_key"), Type.Literal("codex_pat")]),
    apiKey: Type.String({ minLength: 1, maxLength: 8192, pattern: "\\S", writeOnly: true }),
  },
  { additionalProperties: false },
);

export const PermissionActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("read"),
  Type.Literal("update"),
  Type.Literal("delete"),
  Type.Literal("deploy"),
  Type.Literal("operate"),
  Type.Literal("administer"),
]);

export const ResourceKindSchema = Type.Union([
  Type.Literal("installation"),
  Type.Literal("namespace"),
  Type.Literal("configuration"),
  Type.Literal("preset"),
  Type.Literal("service_account"),
  Type.Literal("secret"),
  Type.Literal("agent"),
  Type.Literal("agent_revision"),
]);

export const NamespacePolicyResourceKindSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("agent_revision"),
  Type.Literal("configuration"),
  Type.Literal("preset"),
  Type.Literal("secret"),
  Type.Literal("service_account"),
]);

export const IAMPermissionBody = Type.Object(
  { action: PermissionActionSchema, resourceKind: NamespacePolicyResourceKindSchema },
  { additionalProperties: false },
);

export const CreateIAMRoleBody = Type.Object(
  {
    name: Type.Optional(Name),
    permissions: Type.Array(IAMPermissionBody, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

export const CreateIAMAccessBindingBody = Type.Object(
  {
    subjectKind: Type.Literal("identity"),
    subjectId: Type.String({ minLength: 1, maxLength: 200 }),
    roleId: IAMRoleId,
    resourceKind: NamespacePolicyResourceKindSchema,
    resourceId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const CreateConfigurationBody = Type.Object(
  {
    kind: ConfigurationKindSchema,
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
  },
  { additionalProperties: false },
);

export const UpdateConfigurationBody = Type.Object(
  { values: ConfigurationValues, secretBindings: Type.Optional(SecretBindings) },
  { additionalProperties: false },
);

export const ServiceAccountCredentialSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("api_key"),
      Type.Literal("access_token"),
      Type.Literal("oauth_access_token"),
    ]),
    secretRef: Type.Object(
      {
        name: Type.String({
          maxLength: 253,
          pattern: "^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$",
        }),
        key: Type.String({ maxLength: 253, pattern: "^(?![.]{1,2}$)[-._a-zA-Z0-9]+$" }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CreateServiceAccountBody = Type.Object(
  { name: Name },
  { additionalProperties: false },
);

export const CreateServiceAccountCredentialBody = Type.Object({}, { additionalProperties: false });

export const UpdateServiceAccountCredentialBody = Type.Object(
  {
    kind: Type.Union([Type.Literal("api_key"), Type.Literal("oauth_access_token")]),
    secretRef: ServiceAccountCredentialSchema.properties.secretRef,
  },
  { additionalProperties: false },
);

const RepositoryBindingSelector = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});

export const RepositoryBindingRequestSchema = Type.Object(
  {
    repositoryRef: RepositoryBindingSelector,
    profile: Type.Optional(RepositoryBindingSelector),
  },
  { additionalProperties: false },
);

export const RepositoryBindingSelectionSchema = Type.Object(
  { repositoryRef: RepositoryBindingSelector, profile: RepositoryBindingSelector },
  { additionalProperties: false },
);

export const RepositoryBindingRequestsSchema = Type.Array(RepositoryBindingRequestSchema, {
  maxItems: 16,
  description:
    "Requested repository references and optional profiles. Omission means no bindings on create and preserves bindings on update; an empty update clears bindings. Admission requires unique repository references.",
});

export const RepositoryBindingSelectionsSchema = Type.Array(RepositoryBindingSelectionSchema, {
  minItems: 1,
  maxItems: 16,
});

export const CreateAgentBody = Type.Object(
  {
    initialWorkspaceFiles: Type.Optional(
      Type.Object(
        Object.fromEntries(
          WORKSPACE_FILE_NAMES.map((name) => [
            name,
            Type.Optional(Type.String({ maxLength: 16 * 1024, pattern: "^[^\\u0000]*$" })),
          ]),
        ),
        { additionalProperties: false },
      ),
    ),
    workspaceDefaultsId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    name: Name,
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    harnessAuth: Type.Optional(Type.Union([HarnessAuthBindingSchema, Type.Null()])),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
  },
  { additionalProperties: false },
);

export const ProvisionAgentConfigurationBody = Type.Object(
  {
    kind: ConfigurationKindSchema,
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
  },
  { additionalProperties: false },
);

export const ProvisionAgentBody = Type.Object(
  {
    requestId: RequestId,
    initialWorkspaceFiles: Type.Optional(CreateAgentBody.properties.initialWorkspaceFiles),
    workspaceDefaultsId: Type.Optional(CreateAgentBody.properties.workspaceDefaultsId),
    name: Name,
    configuration: ProvisionAgentConfigurationBody,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    harnessAuth: Type.Optional(Type.Union([HarnessAuthBindingSchema, Type.Null()])),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
  },
  { additionalProperties: false },
);

export const UpdateAgentBody = Type.Object(
  {
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    harnessAuth: Type.Optional(Type.Union([HarnessAuthBindingSchema, Type.Null()])),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
  },
  { additionalProperties: false },
);

export const UpdateWorkspaceFileBody = Type.Object(
  {
    content: Type.String({
      maxLength: 16 * 1024,
      pattern: "^[^\\u0000]*$",
      description:
        "Workspace file content. The controller also enforces a 16 KiB UTF-8 byte limit and rejects unpaired UTF-16 surrogates.",
    }),
  },
  { additionalProperties: false },
);

export const PluginApprovalModeSchema = Type.Union([
  Type.Literal("always"),
  Type.Literal("never"),
  Type.Literal("prompt"),
  Type.Literal("auto"),
]);

export const PluginApprovalsReviewerSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("auto_review"),
]);

export const ERROR_DETAIL_CODES = Object.freeze([
  "REQUIRED",
  "UNKNOWN_FIELD",
  "INVALID_TYPE",
  "INVALID_FORMAT",
  "INVALID_VALUE",
  "TOO_LONG",
  "TOO_DEEP",
] as const);

export const ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INSTALLATION_EXISTS",
  "RESOURCE_CONFLICT",
  "AGENT_DELETING",
  "NAMESPACE_NOT_READY",
  "NAMESPACE_NOT_EMPTY",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNKNOWN_OUTCOME",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
  "DEPENDENCY_UNAVAILABLE",
  "REPOSITORY_OPTIONS_UNAVAILABLE",
  "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
  "MODEL_DISCOVERY_RATE_LIMITED",
  "MODEL_DISCOVERY_UNAVAILABLE",
  "MODEL_DISCOVERY_INVALID_RESPONSE",
] as const);

export const ErrorDetail = Type.Object(
  {
    path: Type.String({
      maxLength: 512,
      pattern: "^(?:/(?:[^~/]|~0|~1)*)*$",
    }),
    code: Type.Union([
      Type.Literal("REQUIRED"),
      Type.Literal("UNKNOWN_FIELD"),
      Type.Literal("INVALID_TYPE"),
      Type.Literal("INVALID_FORMAT"),
      Type.Literal("INVALID_VALUE"),
      Type.Literal("TOO_LONG"),
      Type.Literal("TOO_DEEP"),
    ]),
  },
  { additionalProperties: false },
);

export const ErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("INVALID_REQUEST"),
          Type.Literal("UNAUTHENTICATED"),
          Type.Literal("FORBIDDEN"),
          Type.Literal("NOT_FOUND"),
          Type.Literal("METHOD_NOT_ALLOWED"),
          Type.Literal("INSTALLATION_EXISTS"),
          Type.Literal("RESOURCE_CONFLICT"),
          Type.Literal("AGENT_DELETING"),
          Type.Literal("NAMESPACE_NOT_READY"),
          Type.Literal("NAMESPACE_NOT_EMPTY"),
          Type.Literal("PAYLOAD_TOO_LARGE"),
          Type.Literal("UNSUPPORTED_MEDIA_TYPE"),
          Type.Literal("UNKNOWN_OUTCOME"),
          Type.Literal("NOT_IMPLEMENTED"),
          Type.Literal("INTERNAL_ERROR"),
          Type.Literal("DEPENDENCY_UNAVAILABLE"),
          Type.Literal("REPOSITORY_OPTIONS_UNAVAILABLE", {
            description:
              "Only repository-option discovery is unavailable after Agent create authorization. An Agent without repository bindings may be submitted and is authorized again. Other dependency failures do not carry this meaning.",
          }),
          Type.Literal("MODEL_DISCOVERY_CREDENTIALS_REJECTED"),
          Type.Literal("MODEL_DISCOVERY_RATE_LIMITED"),
          Type.Literal("MODEL_DISCOVERY_UNAVAILABLE"),
          Type.Literal("MODEL_DISCOVERY_INVALID_RESPONSE"),
        ]),
        message: Type.String({ minLength: 1, maxLength: 256 }),
        details: Type.Optional(Type.Array(ErrorDetail, { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { $id: "ErrorResponse", additionalProperties: false },
);

export type InstallationId = Type.Static<typeof InstallationId>;
export type NamespaceId = Type.Static<typeof NamespaceId>;
export type ConfigurationId = Type.Static<typeof ConfigurationId>;
export type ServiceAccountId = Type.Static<typeof ServiceAccountId>;
export type SecretId = Type.Static<typeof SecretId>;
export type IAMRoleId = Type.Static<typeof IAMRoleId>;
export type IAMAccessBindingId = Type.Static<typeof IAMAccessBindingId>;
export type ConfigurationGeneration = Type.Static<typeof ConfigurationGeneration>;
export type AgentId = Type.Static<typeof AgentId>;
export type RevisionId = Type.Static<typeof RevisionId>;
export type AuditId = Type.Static<typeof AuditId>;
export type RequestId = Type.Static<typeof RequestId>;
export type ProviderId = Type.Static<typeof ProviderId>;
export type Timestamp = Type.Static<typeof Timestamp>;
export type Name = Type.Static<typeof Name>;
export type Meta = Type.Static<typeof Meta>;
export type NamedResourceBody = Type.Static<typeof NamedResourceBody>;
export type EmptyQuery = Type.Static<typeof EmptyQuery>;
export type NamespaceParams = Type.Static<typeof NamespaceParams>;
export type ConfigurationParams = Type.Static<typeof ConfigurationParams>;
export type ServiceAccountParams = Type.Static<typeof ServiceAccountParams>;
export type SecretParams = Type.Static<typeof SecretParams>;
export type IAMRoleParams = Type.Static<typeof IAMRoleParams>;
export type IAMAccessBindingParams = Type.Static<typeof IAMAccessBindingParams>;
export type AgentParams = Type.Static<typeof AgentParams>;
export type RevisionParams = Type.Static<typeof RevisionParams>;
export type DeploymentParams = Type.Static<typeof DeploymentParams>;
export type WorkspaceFileName = Type.Static<typeof WorkspaceFileName>;
export type AgentRuntimeCredentialsBody = Type.Static<typeof AgentRuntimeCredentialsBody>;
export type WorkspaceFileParams = Type.Static<typeof WorkspaceFileParams>;
export type CreateIAMRoleBody = Type.Static<typeof CreateIAMRoleBody>;
export type CreateIAMAccessBindingBody = Type.Static<typeof CreateIAMAccessBindingBody>;
export type ConfigurationValues = Type.Static<typeof ConfigurationValues>;
export type CreateSecretBody = Type.Static<typeof CreateSecretBody>;
export type UpdateSecretBody = Type.Static<typeof UpdateSecretBody>;
export type CreateConfigurationBody = Type.Static<typeof CreateConfigurationBody>;
export type UpdateConfigurationBody = Type.Static<typeof UpdateConfigurationBody>;
export type CreateServiceAccountBody = Type.Static<typeof CreateServiceAccountBody>;
export type CreateServiceAccountCredentialBody = Type.Static<
  typeof CreateServiceAccountCredentialBody
>;
export type UpdateServiceAccountCredentialBody = Type.Static<
  typeof UpdateServiceAccountCredentialBody
>;
export type CreateAgentBody = Type.Static<typeof CreateAgentBody>;
export type ProvisionAgentBody = Type.Static<typeof ProvisionAgentBody>;
export type UpdateAgentBody = Type.Static<typeof UpdateAgentBody>;
export type UpdateWorkspaceFileBody = Type.Static<typeof UpdateWorkspaceFileBody>;
export type ErrorDetail = Type.Static<typeof ErrorDetail>;
export type ErrorResponse = Type.Static<typeof ErrorResponse>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorDetailCode = (typeof ERROR_DETAIL_CODES)[number];

export const PresetVariableSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("password"), description: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
  ...(["string", "number", "boolean"] as const).map((type) =>
    Type.Object(
      {
        type: Type.Literal(type),
        description: Type.Optional(Type.String()),
        default: Type.Optional(
          type === "string" ? Type.String() : type === "number" ? Type.Number() : Type.Boolean(),
        ),
      },
      { additionalProperties: false },
    ),
  ),
]);

export const PresetTemplateSchema = Type.Object(
  {
    variables: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), PresetVariableSchema),
    ),
    agent: Type.Optional(
      Type.Object(
        Object.fromEntries(
          ["name", "executionMode", "providerId", "harnessAuth", "plugins"].map((key) => [
            key,
            Type.Optional(Type.Ref("SafeJsonValue")),
          ]),
        ),
        { additionalProperties: false },
      ),
    ),
    configuration: Type.Optional(
      Type.Object(
        {
          values: Type.Optional(ConfigurationValues),
          secretBindings: Type.Optional(
            Type.Object(
              {},
              {
                additionalProperties: Type.Ref("SafeJsonValue"),
                description:
                  "Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}.",
              },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings.",
  },
);

export const CreatePresetBody = Type.Object(
  { name: Name, template: PresetTemplateSchema },
  { additionalProperties: false },
);
export const UpdatePresetBody = Type.Object(
  { name: Type.Optional(Name), template: Type.Optional(PresetTemplateSchema) },
  { additionalProperties: false, minProperties: 1 },
);
