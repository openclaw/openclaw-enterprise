import { Type } from "typebox";
import {
  BACKEND_ID_MAX_CHARACTERS,
  BACKEND_ID_PATTERN,
  NAME_MAX_CHARACTERS,
  PLAIN_TEXT_PATTERN,
} from "./plain-text.ts";

// The Name and Backend ID text rules live in a module with no dependencies, so the
// installation profile renderer can load them without `pnpm install`.
export {
  BACKEND_ID_MAX_CHARACTERS,
  BACKEND_ID_PATTERN,
  isBackendId,
  isName,
  NAME_MAX_CHARACTERS,
  NAME_RULE,
} from "./plain-text.ts";

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const InstallationId = Type.String({ pattern: `^ins_${UUID_V4}$` });
export const NamespaceId = Type.String({ pattern: `^ns_${UUID_V4}$` });
export const PresetId = Type.String({ pattern: `^pre_${UUID_V4}$` });
export const ConfigurationId = Type.String({ pattern: `^cfg_${UUID_V4}$` });
export const ServiceAccountId = Type.String({ pattern: `^sa_${UUID_V4}$` });
export const SecretId = Type.String({ pattern: `^sec_${UUID_V4}$` });
export const CredentialSourceId = Type.String({ pattern: `^cs_${UUID_V4}$` });
export const IAMRoleId = Type.String({ minLength: 1, maxLength: 200 });
export const IAMAccessBindingId = Type.String({ minLength: 1, maxLength: 200 });
export const IAMServicePrincipalId = Type.String({ minLength: 1, maxLength: 200 });
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
export const BackendId = Type.String({
  minLength: 1,
  maxLength: BACKEND_ID_MAX_CHARACTERS,
  pattern: BACKEND_ID_PATTERN,
});

export const Timestamp = Type.String({
  format: "date-time",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$",
});

/** A resource Name: 1 to 200 code points that follow the plain text rule. */
export const Name = Type.String({
  minLength: 1,
  maxLength: NAME_MAX_CHARACTERS,
  pattern: PLAIN_TEXT_PATTERN,
});

export const PluginApproversSchema = Type.Array(
  Type.Object(
    {
      channel: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" }),
      id: Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u0020\\u007f]+$" }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 64, uniqueItems: true, $id: "PluginApprovers" },
);

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

export const CredentialSourceParams = Type.Object(
  { namespaceId: NamespaceId, credentialSourceId: CredentialSourceId },
  { additionalProperties: false },
);

export const AgentCredentialSourceParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, credentialSourceId: CredentialSourceId },
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

export const IAMServicePrincipalParams = Type.Object(
  { namespaceId: NamespaceId, servicePrincipalId: IAMServicePrincipalId },
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

/** Query strings are not coerced; boolean values are exact text. */
export const ServiceAccountDeleteQuery = Type.Object(
  {
    force: Type.Optional(
      Type.Union([Type.Literal("true"), Type.Literal("false")], {
        description:
          "`true` deletes an account whose issued access token no ChatGPT Backend can revoke, and leaves the token for an administrator to revoke at the provider. With a ChatGPT Backend configured it is ignored and the token is revoked as usual.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Query strings are not coerced; numeric and boolean values are exact decimal text. */
export const AgentRuntimeLogsQuery = Type.Object(
  {
    source: Type.Union([Type.Literal("gateway"), Type.Literal("agent"), Type.Literal("sandbox")]),
    pod: Type.Optional(
      Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$" }),
    ),
    previous: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    tailLines: Type.Optional(
      Type.String({
        pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
        description: "Lines from the end of the stream, 1 to 1000; default 200.",
      }),
    ),
    sinceSeconds: Type.Optional(
      Type.String({
        pattern: "^(?:[1-9][0-9]{0,3}|[1-7][0-9]{4}|8[0-5][0-9]{3}|86[0-3][0-9]{2}|86400)$",
        description: "Only lines newer than this many seconds, 1 to 86400.",
      }),
    ),
    minLevel: Type.Optional(
      Type.Union(
        [Type.Literal("error"), Type.Literal("warn"), Type.Literal("info"), Type.Literal("debug")],
        {
          description:
            "Return only lines at this level or above; lines of unknown level, gaps and withheld counts are always returned. Default: every level.",
        },
      ),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 2048,
        pattern: "^v1\\.[A-Za-z0-9_-]{1,1900}\\.[A-Za-z0-9_-]{43}$",
        description: "Opaque cursor returned by the previous page of the same view.",
      }),
    ),
    download: Type.Optional(
      Type.Union([Type.Literal("true"), Type.Literal("false")], {
        description:
          "`true` returns the last 1000 lines as a text/plain attachment and is audited per download; it cannot be combined with `cursor`.",
      }),
    ),
  },
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
    {
      method: Type.Literal("codex_pat"),
      source: Type.Union([
        SecretReference,
        Type.Object(
          { kind: Type.Literal("service_account"), namespaceId: NamespaceId, id: ServiceAccountId },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { method: Type.Literal("oauth"), source: SecretReference },
    { additionalProperties: false },
  ),
  Type.Object(
    { method: Type.Literal("credential_source"), sourceId: CredentialSourceId },
    { additionalProperties: false },
  ),
]);

export const AgentCredentialSourcesSchema = Type.Array(
  Type.Object({ sourceId: CredentialSourceId }, { additionalProperties: false }),
  {
    maxItems: 8,
    uniqueItems: true,
    description:
      "Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values.",
  },
);

export const CredentialSourceReference = Type.Object(
  { kind: Type.Literal("credential_source"), namespaceId: NamespaceId, id: CredentialSourceId },
  {
    additionalProperties: false,
    description:
      'Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`.',
  },
);

const CredentialSourceFieldName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_]{0,63}$",
});

export const CredentialSourceType = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]{0,63}$",
  description: "Source type from the selected Credential Gateway catalog, for example `openai`.",
});

export const CredentialSourceConfig = Type.Record(
  CredentialSourceFieldName,
  Type.String({ minLength: 1, maxLength: 2048 }),
  {
    maxProperties: 32,
    description: "Non-secret source configuration keyed by catalog field name.",
  },
);

export const CredentialSourceSecrets = Type.Record(CredentialSourceFieldName, SecretReference, {
  maxProperties: 16,
  description:
    "Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value.",
});

export const CreateCredentialSourceBody = Type.Object(
  {
    name: Name,
    type: CredentialSourceType,
    config: Type.Optional(CredentialSourceConfig),
    secrets: Type.Optional(CredentialSourceSecrets),
  },
  { additionalProperties: false },
);

export const UpdateCredentialSourceBody = Type.Object(
  {
    secrets: Type.Optional(CredentialSourceSecrets),
  },
  {
    additionalProperties: false,
    description:
      "Re-reads the source's Secret values, or those of replacement Secret references, and updates the Credential Gateway copy. A refresh token field (`refresh_token` of `oauth2-refresh-token`) must reference a new Secret. Non-secret config is immutable.",
  },
);

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

const PluginDiscoveryAccessToken = Type.String({
  minLength: 1,
  maxLength: 16384,
  pattern: "\\S",
  writeOnly: true,
});

// At most one credential source is accepted; the selected Driver determines whether it is required.
export const DiscoverAgentPluginsBody = Type.Union([
  Type.Object(
    {
      oauthLogin: SecretReference,
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      q: Type.Optional(Type.String({ maxLength: 1024 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      q: Type.Optional(Type.String({ maxLength: 1024 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      accessToken: PluginDiscoveryAccessToken,
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      q: Type.Optional(Type.String({ maxLength: 1024 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      secretRef: SecretReference,
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      q: Type.Optional(Type.String({ maxLength: 1024 })),
    },
    { additionalProperties: false },
  ),
]);

export const DiscoverAgentPluginDetailsBody = Type.Union([
  Type.Object(
    { oauthLogin: SecretReference, pluginId: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { pluginId: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      accessToken: PluginDiscoveryAccessToken,
      pluginId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { secretRef: SecretReference, pluginId: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
]);

export const DiscoverSavedAgentPluginsBody = Type.Object(
  {
    oauthLogin: Type.Optional(SecretReference),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    q: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);

export const DiscoverSavedAgentPluginDetailsBody = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 256 }),
    oauthLogin: Type.Optional(SecretReference),
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
  Type.Literal("read_logs"),
  Type.Literal("use"),
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
  Type.Literal("credential_source"),
]);

export const NamespacePolicyResourceKindSchema = Type.Union([
  Type.Literal("namespace"),
  Type.Literal("agent"),
  Type.Literal("agent_revision"),
  Type.Literal("configuration"),
  Type.Literal("credential_source"),
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

export const RuntimeRoleConfiguration = Type.Object(
  { id: ConfigurationId, generation: ConfigurationGeneration },
  { additionalProperties: false },
);

export const AgentRuntimeRoleSchema = Type.Object(
  { id: Type.String(), permissions: Type.Record(Type.String(), Type.Unknown()) },
  { additionalProperties: false },
);

export const CreateIAMServicePrincipalBody = Type.Object({}, { additionalProperties: false });

export const CreateIAMAccessBindingBody = Type.Object(
  {
    subjectKind: Type.Literal("identity"),
    subjectId: Type.String({ minLength: 1, maxLength: 200 }),
    roleId: IAMRoleId,
    runtimeRole: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^\\S(?:.*\\S)?$" }),
    ),
    runtimeRoleConfiguration: Type.Optional(RuntimeRoleConfiguration),
    resourceKind: NamespacePolicyResourceKindSchema,
    resourceId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const UpdateIAMRuntimeRoleBody = Type.Object(
  {
    runtimeRole: Type.String({ minLength: 1, maxLength: 128, pattern: "^\\S(?:.*\\S)?$" }),
    runtimeRoleConfiguration: RuntimeRoleConfiguration,
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

export const RepositoryAccessSchema = Type.Object(
  {
    defaultProfile: RepositoryBindingSelector,
    repositories: Type.Array(RepositoryBindingRequestSchema, { maxItems: 16 }),
  },
  {
    additionalProperties: false,
    description:
      "Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests.",
  },
);

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
    backendId: Type.Optional(Type.Union([BackendId, Type.Null()])),
    harnessAuth: Type.Optional(Type.Union([HarnessAuthBindingSchema, Type.Null()])),
    credentialSources: Type.Optional(AgentCredentialSourcesSchema),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    pluginApprovers: Type.Optional(Type.Ref("PluginApprovers")),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
    repositoryAccess: Type.Optional(RepositoryAccessSchema),
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
    backendId: Type.Optional(Type.Union([BackendId, Type.Null()])),
    harnessAuth: Type.Optional(
      Type.Union([HarnessAuthBindingSchema, Type.Null()], {
        description:
          "Dedicated Harness authentication, required. Omitted, null, `runtime` and `credential_source` are refused with 400 INVALID_REQUEST; for a credential source, create the Agent with the source, then deploy it.",
      }),
    ),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    pluginApprovers: Type.Optional(Type.Ref("PluginApprovers")),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
    repositoryAccess: Type.Optional(RepositoryAccessSchema),
  },
  { additionalProperties: false },
);

export const UpdateAgentBody = Type.Object(
  {
    configurationId: ConfigurationId,
    backendId: Type.Optional(Type.Union([BackendId, Type.Null()])),
    harnessAuth: Type.Optional(Type.Union([HarnessAuthBindingSchema, Type.Null()])),
    credentialSources: Type.Optional(AgentCredentialSourcesSchema),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    pluginApprovers: Type.Optional(Type.Union([Type.Ref("PluginApprovers"), Type.Null()])),
    repositoryBindings: Type.Optional(RepositoryBindingRequestsSchema),
    repositoryAccess: Type.Optional(RepositoryAccessSchema),
  },
  { additionalProperties: false },
);

const ChannelDirectoryLookupFields = {
  secretId: SecretId,
  kind: Type.Union([Type.Literal("users"), Type.Literal("channels")]),
  query: Type.Optional(Type.String({ maxLength: 200, pattern: "^[^\\u0000]*$" })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: "^[^\\u0000]*$" })),
};

const ChannelDirectoryHydrationFields = {
  secretId: SecretId,
  kind: Type.Union([Type.Literal("users"), Type.Literal("channels")]),
  ids: Type.Array(
    Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
    { minItems: 1, maxItems: 20, uniqueItems: true },
  ),
};

export const ChannelDirectoryLookupBody = Type.Union([
  Type.Object(ChannelDirectoryLookupFields, { additionalProperties: false }),
  Type.Object(
    { ...ChannelDirectoryLookupFields, agentId: AgentId },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ChannelDirectoryLookupFields, configurationId: ConfigurationId },
    { additionalProperties: false },
  ),
  Type.Object(ChannelDirectoryHydrationFields, { additionalProperties: false }),
  Type.Object(
    { ...ChannelDirectoryHydrationFields, agentId: AgentId },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ChannelDirectoryHydrationFields, configurationId: ConfigurationId },
    { additionalProperties: false },
  ),
]);

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

export const PluginReviewerSchema = Type.Union([Type.Literal("human"), Type.Literal("auto")]);

export const PluginApprovalModeSchema = Type.Union([
  Type.Literal("provider_default"),
  Type.Literal("all_actions"),
  Type.Literal("write_actions"),
  Type.Literal("none"),
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
  "CREDENTIAL_GATEWAY_NOT_CONFIGURED",
  "CREDENTIAL_WITHDRAWAL_IN_PROGRESS",
  "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
  "REPOSITORY_OPTIONS_UNAVAILABLE",
  "MODEL_DISCOVERY_CREDENTIALS_REJECTED",
  "MODEL_DISCOVERY_RATE_LIMITED",
  "MODEL_DISCOVERY_UNAVAILABLE",
  "MODEL_DISCOVERY_INVALID_RESPONSE",
  "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
  "PLUGIN_DISCOVERY_RATE_LIMITED",
  "PLUGIN_DISCOVERY_UNAVAILABLE",
  "PLUGIN_DISCOVERY_INVALID_RESPONSE",
  "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED",
  "CHANNEL_DIRECTORY_MISSING_SCOPE",
  "CHANNEL_DIRECTORY_RATE_LIMITED",
  "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  "CHANNEL_DIRECTORY_UNAVAILABLE",
  "CHANNEL_CREDENTIAL_ROLE_MISMATCH",
  "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED",
  "CHANNEL_CREDENTIAL_UNAVAILABLE",
  "CHANNEL_CREDENTIAL_BINDING_REQUIRED",
  "RUNTIME_LOGS_CURSOR_INVALID",
  "RUNTIME_LOGS_POD_INVALID",
  "RUNTIME_LOGS_SOURCE_UNAVAILABLE",
  "RUNTIME_LOGS_RATE_LIMITED",
  "RUNTIME_LOGS_CLUSTER_RBAC",
  "RUNTIME_LOGS_SANDBOX_NOT_FOUND",
  "RUNTIME_LOGS_UNAVAILABLE",
  "RUNTIME_LOGS_AUDIT_UNAVAILABLE",
  "RUNTIME_LOGS_TIMEOUT",
  "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
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
          Type.Literal("CREDENTIAL_GATEWAY_NOT_CONFIGURED", {
            description:
              "The Installation selects no Credential Gateway, so credential sources cannot be registered.",
          }),
          Type.Literal("CREDENTIAL_WITHDRAWAL_IN_PROGRESS", {
            description:
              "Only credential withdrawal work still queued or running for an Agent revision that held the source keeps it from being deleted.",
          }),
          Type.Literal("SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED", {
            description:
              "The Installation has no ChatGPT Backend, so service-account credentials cannot be issued, used for Harness authentication, or revoked to delete their account.",
          }),
          Type.Literal("REPOSITORY_OPTIONS_UNAVAILABLE", {
            description:
              "Only repository-option discovery is unavailable after Agent create authorization. An Agent without repository bindings may be submitted and is authorized again. Other dependency failures do not carry this meaning.",
          }),
          Type.Literal("MODEL_DISCOVERY_CREDENTIALS_REJECTED"),
          Type.Literal("MODEL_DISCOVERY_RATE_LIMITED"),
          Type.Literal("MODEL_DISCOVERY_UNAVAILABLE"),
          Type.Literal("MODEL_DISCOVERY_INVALID_RESPONSE"),
          Type.Literal("PLUGIN_DISCOVERY_CREDENTIALS_REJECTED"),
          Type.Literal("PLUGIN_DISCOVERY_RATE_LIMITED"),
          Type.Literal("PLUGIN_DISCOVERY_UNAVAILABLE"),
          Type.Literal("PLUGIN_DISCOVERY_INVALID_RESPONSE"),
          Type.Literal("CHANNEL_DIRECTORY_CREDENTIALS_REJECTED"),
          Type.Literal("CHANNEL_DIRECTORY_MISSING_SCOPE"),
          Type.Literal("CHANNEL_DIRECTORY_RATE_LIMITED"),
          Type.Literal("CHANNEL_DIRECTORY_INVALID_RESPONSE"),
          Type.Literal("CHANNEL_DIRECTORY_UNAVAILABLE"),
          Type.Literal("CHANNEL_CREDENTIAL_ROLE_MISMATCH"),
          Type.Literal("CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED"),
          Type.Literal("CHANNEL_CREDENTIAL_UNAVAILABLE"),
          Type.Literal("CHANNEL_CREDENTIAL_BINDING_REQUIRED"),
          Type.Literal("RUNTIME_LOGS_CURSOR_INVALID"),
          Type.Literal("RUNTIME_LOGS_POD_INVALID"),
          Type.Literal("RUNTIME_LOGS_SOURCE_UNAVAILABLE"),
          Type.Literal("RUNTIME_LOGS_RATE_LIMITED"),
          Type.Literal("RUNTIME_LOGS_CLUSTER_RBAC"),
          Type.Literal("RUNTIME_LOGS_SANDBOX_NOT_FOUND"),
          Type.Literal("RUNTIME_LOGS_UNAVAILABLE"),
          Type.Literal("RUNTIME_LOGS_AUDIT_UNAVAILABLE"),
          Type.Literal("RUNTIME_LOGS_TIMEOUT"),
          Type.Literal("RUNTIME_CREDENTIALS_CLUSTER_RBAC"),
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
export type IAMServicePrincipalId = Type.Static<typeof IAMServicePrincipalId>;
export type ConfigurationGeneration = Type.Static<typeof ConfigurationGeneration>;
export type AgentId = Type.Static<typeof AgentId>;
export type RevisionId = Type.Static<typeof RevisionId>;
export type AuditId = Type.Static<typeof AuditId>;
export type RequestId = Type.Static<typeof RequestId>;
export type BackendId = Type.Static<typeof BackendId>;
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
export type IAMServicePrincipalParams = Type.Static<typeof IAMServicePrincipalParams>;
export type AgentParams = Type.Static<typeof AgentParams>;
export type RevisionParams = Type.Static<typeof RevisionParams>;
export type DeploymentParams = Type.Static<typeof DeploymentParams>;
export type ServiceAccountDeleteQuery = Type.Static<typeof ServiceAccountDeleteQuery>;
export type AgentRuntimeLogsQuery = Type.Static<typeof AgentRuntimeLogsQuery>;
export type WorkspaceFileName = Type.Static<typeof WorkspaceFileName>;
export type AgentRuntimeCredentialsBody = Type.Static<typeof AgentRuntimeCredentialsBody>;
export type WorkspaceFileParams = Type.Static<typeof WorkspaceFileParams>;
export type CreateIAMRoleBody = Type.Static<typeof CreateIAMRoleBody>;
export type CreateIAMAccessBindingBody = Type.Static<typeof CreateIAMAccessBindingBody>;
export type CreateIAMServicePrincipalBody = Type.Static<typeof CreateIAMServicePrincipalBody>;
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
export type ChannelDirectoryLookupBody = Type.Static<typeof ChannelDirectoryLookupBody>;
export type UpdateWorkspaceFileBody = Type.Static<typeof UpdateWorkspaceFileBody>;
export type UpdateCredentialSourceBody = Type.Static<typeof UpdateCredentialSourceBody>;
export type AgentCredentialSourceParams = Type.Static<typeof AgentCredentialSourceParams>;
export type ErrorDetail = Type.Static<typeof ErrorDetail>;
export type ErrorResponse = Type.Static<typeof ErrorResponse>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorDetailCode = (typeof ERROR_DETAIL_CODES)[number];

// One object shape, so a bad field gets one error at its own path rather than one per
// variable kind. Preset admission checks that a default matches `type` and that password
// variables have none, and names the variable when they do not.
export const PresetVariableSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("string"),
      Type.Literal("number"),
      Type.Literal("boolean"),
      Type.Literal("password"),
    ]),
    description: Type.Optional(Type.String()),
    default: Type.Optional(
      Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
        description: "A value of the declared type. Password variables take no default.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const PresetTemplateSchema = Type.Object(
  {
    variables: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), PresetVariableSchema),
    ),
    agent: Type.Optional(
      Type.Object(
        {
          ...Object.fromEntries(
            [
              "name",
              "executionMode",
              "backendId",
              "harnessAuth",
              "plugins",
              "pluginApprovers",
              "repositoryBindings",
              "repositoryAccess",
            ].map((key) => [key, Type.Optional(Type.Ref("SafeJsonValue"))]),
          ),
          initialWorkspaceFiles: Type.Optional(CreateAgentBody.properties.initialWorkspaceFiles),
        },
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
