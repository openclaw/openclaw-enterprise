import { Type } from "typebox";

import {
  AgentId,
  ConfigurationGeneration,
  ConfigurationId,
  ConfigurationKindSchema,
  ConfigurationValues,
  HarnessExecutionModeSchema,
  InstallationId,
  KubernetesNamespaceName,
  Meta,
  Name,
  NamespaceId,
  ProviderId,
  RevisionId,
  SecretBindings,
  SecretId,
  SecretReference,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
  Timestamp,
  WorkspaceFileName,
  PluginApprovalModeSchema,
  PluginApprovalsReviewerSchema,
} from "./common.ts";

export const InstallationSchema = Type.Object(
  { id: InstallationId, name: Name, createdAt: Timestamp },
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
    configurationId: ConfigurationId,
    providerId: Type.Union([ProviderId, Type.Null()]),
    serviceAccountId: Type.Optional(ServiceAccountId),
    executionMode: HarnessExecutionModeSchema,
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    activeRevisionId: Type.Optional(RevisionId),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const PluginDriverIdentitySchema = Type.Object(
  { id: Type.String({ minLength: 1 }), implementation: Type.String({ minLength: 1 }) },
  { additionalProperties: false, $id: "PluginDriverIdentity" },
);

export const PluginToolPolicySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    approvalMode: Type.Optional(PluginApprovalModeSchema),
  },
  { additionalProperties: false, minProperties: 1, $id: "PluginToolPolicy" },
);

const PluginIdPattern = "^[A-Za-z0-9._~:@-]{1,253}$";
const PluginToolPolicyMapSchema = Type.Unsafe({
  type: "object",
  description:
    "Plugin tool policy map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$.",
  propertyNames: { pattern: PluginIdPattern },
  additionalProperties: false,
  patternProperties: {
    [PluginIdPattern]: Type.Ref("PluginToolPolicy"),
  },
});

export const PluginDesiredSelectionSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    approvalMode: PluginApprovalModeSchema,
    approvalsReviewer: Type.Optional(PluginApprovalsReviewerSchema),
    destructiveActions: Type.Optional(PluginApprovalModeSchema),
    writes: Type.Optional(PluginApprovalModeSchema),
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
    modelConfigured: Type.Boolean(),
    slackConfigured: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ServiceAccountSchema = Type.Object(
  {
    id: ServiceAccountId,
    namespaceId: NamespaceId,
    name: Name,
    credential: Type.Optional(ServiceAccountCredentialSchema),
  },
  { additionalProperties: false },
);

export const ProviderSummarySchema = Type.Object(
  { id: ProviderId, type: Type.Literal("chatgpt") },
  { additionalProperties: false },
);

export const InstallationResponse = Type.Object(
  { data: InstallationSchema, meta: Meta },
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

export const AgentRuntimeCredentialResponse = Type.Object(
  { data: AgentRuntimeCredentialStatusSchema, meta: Meta },
  { $id: "AgentRuntimeCredentialResponse", additionalProperties: false },
);

export const AgentListResponse = Type.Object(
  { data: Type.Array(AgentSchema), meta: Meta },
  { additionalProperties: false },
);

export const ProviderListResponse = Type.Object(
  { data: Type.Array(ProviderSummarySchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentRevisionSchema = Type.Object(
  {
    id: RevisionId,
    namespaceId: NamespaceId,
    agentId: AgentId,
    revision: Type.Integer({ minimum: 1 }),
    providerId: Type.Union([ProviderId, Type.Null()]),
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
    serviceAccount: Type.Optional(
      Type.Object(
        {
          id: ServiceAccountId,
          credential: Type.Object(
            {
              kind: Type.Union([Type.Literal("api_key"), Type.Literal("access_token")]),
              secretRef: ServiceAccountCredentialSchema.properties.secretRef,
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
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
export type NamespaceWire = Type.Static<typeof NamespaceSchema>;
export type ConfigurationWire = Type.Static<typeof ConfigurationSchema>;
export type SecretWire = Type.Static<typeof SecretSchema>;
export type ServiceAccountWire = Type.Static<typeof ServiceAccountSchema>;
export type ProviderSummaryWire = Type.Static<typeof ProviderSummarySchema>;
export type AgentWire = Type.Static<typeof AgentSchema>;
export type AgentRuntimeCredentialStatusWire = Type.Static<
  typeof AgentRuntimeCredentialStatusSchema
>;
export type AgentRevisionWire = Type.Static<typeof AgentRevisionSchema>;
export type InstallationResponse = Type.Static<typeof InstallationResponse>;
export type NamespaceResponse = Type.Static<typeof NamespaceResponse>;
export type NamespaceListResponse = Type.Static<typeof NamespaceListResponse>;
export type ConfigurationResponse = Type.Static<typeof ConfigurationResponse>;
export type SecretResponse = Type.Static<typeof SecretResponse>;
export type ServiceAccountResponse = Type.Static<typeof ServiceAccountResponse>;
export type ServiceAccountListResponse = Type.Static<typeof ServiceAccountListResponse>;
export type AgentResponse = Type.Static<typeof AgentResponse>;
export type AgentRuntimeCredentialResponse = Type.Static<typeof AgentRuntimeCredentialResponse>;
export type AgentListResponse = Type.Static<typeof AgentListResponse>;
export type ProviderListResponse = Type.Static<typeof ProviderListResponse>;
export type AgentRevisionResponse = Type.Static<typeof AgentRevisionResponse>;
export type AgentRevisionListResponse = Type.Static<typeof AgentRevisionListResponse>;
export type WorkspaceFileResponse = Type.Static<typeof WorkspaceFileResponse>;
export type WorkspaceFileUpdateResponse = Type.Static<typeof WorkspaceFileUpdateResponse>;
