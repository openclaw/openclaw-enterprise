import type { CredentialPolicyReductionState } from "./platform-state.ts";
import type {
  InitialWorkspaceFiles,
  ProtectedEgressSource,
  EgressInstallation,
  AgentDesiredRuntimeState,
  AgentStatus,
  CredentialSourceState,
  CredentialSourceOwnerCapability,
  HarnessExecutionMode,
  HarnessAuthBinding,
  AgentCredentialSourceBinding,
  PluginDesiredState,
  PluginApprovers,
  PresetTemplate,
  RepositoryBindingSelection,
  RepositoryAccess,
  SecretBindings,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";

export const occSchema = pgSchema("occ");

const collatedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text COLLATE "C"';
  },
});

const identifierPatterns = {
  installation: "^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  namespace: "^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  preset: "^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  configuration: "^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  serviceAccount: "^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  agent: "^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  revision: "^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  secret: "^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  credentialSource: "^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  audit: "^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;

export const installation = occSchema.table(
  "installation",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("installation_id_format", sql`${table.id} ~ ${identifierPatterns.installation}`),
    check("installation_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "installation_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    uniqueIndex("installation_one_row").on(sql`true`),
  ],
);

export const namespaces = occSchema.table(
  "namespaces",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull().unique(),
    existingNamespace: text("existing_namespace"),
    status: text("status").notNull().default("provisioning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("namespaces_existing_namespace_unique")
      .on(table.existingNamespace)
      .where(sql`${table.existingNamespace} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    check("namespaces_id_format", sql`${table.id} ~ ${identifierPatterns.namespace}`),
    check(
      "namespaces_status_valid",
      sql`${table.status} IN ('provisioning', 'ready', 'failed', 'deleting')`,
    ),
    check("namespaces_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "namespaces_existing_namespace_valid",
      sql`${table.existingNamespace} IS NULL OR (
        char_length(${table.existingNamespace}) BETWEEN 1 AND 63
        AND ${table.existingNamespace} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
      )`,
    ),
    check(
      "namespaces_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "namespaces_tombstone_valid",
      sql`${table.deletedAt} IS NULL OR (${table.status} = 'deleting' AND ${table.deletedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const presets = occSchema.table(
  "presets",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    template: jsonb("template").$type<PresetTemplate>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("presets_namespace_id_name_unique").on(table.namespaceId, table.name),
    check("presets_id_format", sql`${table.id} ~ ${identifierPatterns.preset}`),
    check("presets_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "presets_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check("presets_template_object", sql`jsonb_typeof(${table.template}) = 'object'`),
  ],
);

export const configurations = occSchema.table(
  "configurations",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    kind: text("kind").$type<"agent">().notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    secretBindings: jsonb("secret_bindings").$type<SecretBindings>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("configurations_namespace_id_id_unique").on(table.namespaceId, table.id),
    check("configurations_id_format", sql`${table.id} ~ ${identifierPatterns.configuration}`),
    check("configurations_kind_valid", sql`${table.kind} = 'agent'`),
    check(
      "configurations_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "configurations_secret_bindings_valid",
      sql`${table.secretBindings} IS NULL OR occ.secret_bindings_are_valid(${table.secretBindings}, ${table.namespaceId})`,
    ),
  ],
);

export const serviceAccounts = occSchema.table(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    credential: jsonb("credential").$type<ServiceAccountCredential>(),
  },
  (table) => [
    unique("service_accounts_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("service_accounts_namespace_id_name_unique").on(table.namespaceId, table.name),
    check("service_accounts_id_format", sql`${table.id} ~ ${identifierPatterns.serviceAccount}`),
    check("service_accounts_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "service_accounts_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "service_accounts_credential_valid",
      sql`${table.credential} IS NULL OR (
        jsonb_typeof(${table.credential}) = 'object'
        AND (${table.credential} ?& ARRAY['kind', 'secretRef'])
        AND (${table.credential} - 'kind' - 'secretRef') = '{}'::jsonb
        AND jsonb_typeof(${table.credential}->'kind') = 'string'
        AND (${table.credential}->>'kind') IN ('api_key', 'oauth_access_token', 'access_token')
        AND jsonb_typeof(${table.credential}->'secretRef') = 'object'
        AND ((${table.credential}->'secretRef') ?& ARRAY['name', 'key'])
        AND ((${table.credential}->'secretRef') - 'name' - 'key') = '{}'::jsonb
        AND jsonb_typeof(${table.credential} #> '{secretRef,name}') = 'string'
        AND char_length(${table.credential} #>> '{secretRef,name}') BETWEEN 1 AND 253
        AND (${table.credential} #>> '{secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
        AND jsonb_typeof(${table.credential} #> '{secretRef,key}') = 'string'
        AND char_length(${table.credential} #>> '{secretRef,key}') BETWEEN 1 AND 253
        AND (${table.credential} #>> '{secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
        AND (${table.credential} #>> '{secretRef,key}') NOT IN ('.', '..')
      )`,
    ),
  ],
);

export const serviceAccountDriverBindings = occSchema.table(
  "service_account_driver_bindings",
  {
    serviceAccountId: text("service_account_id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    backendId: text("backend_id").notNull(),
    driverId: text("driver_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    externalCredentialId: text("external_credential_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    foreignKey({
      name: "service_account_driver_bindings_account_owner",
      columns: [table.namespaceId, table.serviceAccountId],
      foreignColumns: [serviceAccounts.namespaceId, serviceAccounts.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    unique("service_account_driver_bindings_external_account_unique").on(
      table.driverId,
      table.workspaceId,
      table.externalAccountId,
    ),
    check(
      "service_account_driver_bindings_backend_id_valid",
      sql`char_length(${table.backendId}) BETWEEN 1 AND 200 AND ${table.backendId} = btrim(${table.backendId})`,
    ),
    check(
      "service_account_driver_bindings_driver_id_valid",
      sql`char_length(${table.driverId}) BETWEEN 1 AND 200 AND ${table.driverId} = btrim(${table.driverId})`,
    ),
    check(
      "service_account_driver_bindings_external_account_id_valid",
      sql`char_length(${table.externalAccountId}) BETWEEN 1 AND 200 AND ${table.externalAccountId} = btrim(${table.externalAccountId})`,
    ),
    check(
      "service_account_driver_bindings_external_credential_id_valid",
      sql`${table.externalCredentialId} IS NULL OR (char_length(${table.externalCredentialId}) BETWEEN 1 AND 200 AND ${table.externalCredentialId} = btrim(${table.externalCredentialId}))`,
    ),
    check(
      "service_account_driver_bindings_workspace_id_valid",
      sql`char_length(${table.workspaceId}) BETWEEN 1 AND 200 AND ${table.workspaceId} = btrim(${table.workspaceId})`,
    ),
  ],
);

export const agents = occSchema.table(
  "agents",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    configurationId: text("configuration_id").notNull(),
    backendId: text("backend_id"),
    executionMode: text("execution_mode").$type<HarnessExecutionMode>().notNull(),
    gatewayManagedMode: boolean("gateway_managed_mode").notNull().default(true),
    sandboxPolicyEditing: boolean("sandbox_policy_editing").notNull().default(false),
    plugins: jsonb("plugins").$type<PluginDesiredState>(),
    pluginApprovers: jsonb("plugin_approvers").$type<PluginApprovers>(),
    repositoryBindings: jsonb("repository_bindings").$type<readonly RepositoryBindingSelection[]>(),
    repositoryAccess: jsonb("repository_access").$type<RepositoryAccess>(),
    servicePrincipalId: text("service_principal_id").notNull(),
    harnessAuth: jsonb("harness_auth").$type<HarnessAuthBinding>(),
    harnessAuthSecretId: text("harness_auth_secret_id").generatedAlwaysAs(
      sql`CASE WHEN harness_auth #>> '{source,kind}' = 'secret' THEN harness_auth #>> '{source,id}' END`,
    ),
    harnessAuthServiceAccountId: text("harness_auth_service_account_id").generatedAlwaysAs(
      sql`CASE WHEN harness_auth #>> '{source,kind}' = 'service_account' THEN harness_auth #>> '{source,id}' END`,
    ),
    harnessAuthCredentialSourceId: text("harness_auth_credential_source_id").generatedAlwaysAs(
      sql`CASE WHEN harness_auth->>'method' = 'credential_source' THEN harness_auth->>'sourceId' END`,
    ),
    credentialSources: jsonb("credential_sources").$type<readonly AgentCredentialSourceBinding[]>(),
    activeRevisionId: text("active_revision_id"),
    desiredRuntimeState: text("desired_runtime_state")
      .$type<AgentDesiredRuntimeState>()
      .notNull()
      .default("stopped"),
    status: text("status").$type<AgentStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("agents_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("agents_namespace_id_name_unique").on(table.namespaceId, table.name),
    unique("agents_namespace_id_id_service_principal_id_unique").on(
      table.namespaceId,
      table.id,
      table.servicePrincipalId,
    ),
    check("agents_id_format", sql`${table.id} ~ ${identifierPatterns.agent}`),
    check("agents_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check("agents_execution_mode_valid", sql`${table.executionMode} IN ('embedded', 'dedicated')`),
    check(
      "agents_desired_runtime_state_valid",
      sql`${table.desiredRuntimeState} IN ('running', 'stopped')`,
    ),
    check("agents_status_valid", sql`${table.status} IN ('active', 'deleting')`),
    check(
      "agents_harness_credential_source_listed",
      sql`${table.harnessAuth} IS NULL
        OR ${table.harnessAuth}->>'method' IS DISTINCT FROM 'credential_source'
        OR COALESCE(${table.credentialSources}, '[]'::jsonb) @> jsonb_build_array(
          jsonb_build_object('sourceId', ${table.harnessAuth}->>'sourceId'))`,
    ),
    check(
      "agents_deleting_is_stopped",
      sql`${table.status} <> 'deleting' OR ${table.desiredRuntimeState} = 'stopped'`,
    ),
    check(
      "agents_backend_id_valid",
      sql`${table.backendId} IS NULL OR (char_length(${table.backendId}) BETWEEN 1 AND 200 AND ${table.backendId} = btrim(${table.backendId}) AND ${table.backendId} !~ '[[:cntrl:]]')`,
    ),
    check(
      "agents_plugins_object",
      sql`${table.plugins} IS NULL OR jsonb_typeof(${table.plugins}) = 'object'`,
    ),
    check(
      "agents_repository_access_valid",
      sql`occ.repository_access_is_valid(${table.repositoryAccess}, ${table.repositoryBindings})`,
    ),
    check(
      "agents_repository_bindings_valid",
      sql`${table.repositoryBindings} IS NULL OR occ.repository_bindings_are_valid(${table.repositoryBindings}, false)`,
    ),
    check(
      "agents_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    foreignKey({
      name: "agents_configuration_owner",
      columns: [table.namespaceId, table.configurationId],
      foreignColumns: [configurations.namespaceId, configurations.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "agents_harness_auth_valid",
      sql`${table.harnessAuth} IS NULL OR occ.harness_auth_is_valid(${table.harnessAuth}, ${table.namespaceId}, false)`,
    ),
    foreignKey({
      name: "agents_harness_auth_secret_owner",
      columns: [table.namespaceId, table.harnessAuthSecretId],
      foreignColumns: [secrets.namespaceId, secrets.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "agents_harness_auth_service_account_owner",
      columns: [table.namespaceId, table.harnessAuthServiceAccountId],
      foreignColumns: [serviceAccounts.namespaceId, serviceAccounts.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "agents_harness_auth_credential_source_owner",
      columns: [table.namespaceId, table.harnessAuthCredentialSourceId],
      foreignColumns: [credentialSources.namespaceId, credentialSources.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "agent_active_revision_owner",
      columns: [table.namespaceId, table.id, table.activeRevisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    // The checked-in migration makes both Agent ownership cycle edges
    // DEFERRABLE INITIALLY DEFERRED; Drizzle does not model FK deferral.
    foreignKey({
      name: "agent_service_principal_owner",
      columns: [table.namespaceId, table.id, table.servicePrincipalId],
      foreignColumns: [iamIdentities.namespaceId, iamIdentities.agentId, iamIdentities.id],
    })
      .onUpdate("restrict")
      .onDelete("no action"),
  ],
);

export const workspaceSetups = occSchema.table(
  "workspace_setups",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    defaultsId: text("defaults_id"),
    files: jsonb("files").$type<InitialWorkspaceFiles>(),
    completed: boolean("completed").notNull().default(false),
  },
  (table) => [
    unique("workspace_setups_agent_unique").on(table.namespaceId, table.agentId),
    check("workspace_setups_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("workspace_setups_defaults_id_valid", sql`${table.defaultsId} ~ '^[a-f0-9]{64}$'`),
    check(
      "workspace_setups_completion_valid",
      sql`(${table.completed} AND ${table.files} IS NULL) OR (NOT ${table.completed} AND occ.workspace_setup_files_valid(${table.files}))`,
    ),
    foreignKey({
      name: "workspace_setups_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
  ],
);

export const secrets = occSchema.table(
  "secrets",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    driverId: text("driver_id").notNull(),
    backendNamespaceName: text("backend_namespace_name").notNull(),
    backendName: text("backend_name").notNull(),
    backendKey: text("backend_key").notNull(),
    backendUid: text("backend_uid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("secrets_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("secrets_namespace_id_name_unique").on(table.namespaceId, table.name),
    check("secrets_id_format", sql`${table.id} ~ ${identifierPatterns.secret}`),
    check("secrets_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "secrets_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "secrets_driver_id_valid",
      sql`char_length(${table.driverId}) BETWEEN 1 AND 200 AND ${table.driverId} = btrim(${table.driverId})`,
    ),
    check(
      "secrets_backend_namespace_name_valid",
      sql`char_length(${table.backendNamespaceName}) BETWEEN 1 AND 63
        AND ${table.backendNamespaceName} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'`,
    ),
    check(
      "secrets_backend_name_valid",
      sql`char_length(${table.backendName}) BETWEEN 1 AND 253
        AND ${table.backendName} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'`,
    ),
    check(
      "secrets_backend_key_valid",
      sql`char_length(${table.backendKey}) BETWEEN 1 AND 253
        AND ${table.backendKey} ~ '^[-._a-zA-Z0-9]+$'
        AND ${table.backendKey} NOT IN ('.', '..')`,
    ),
    check(
      "secrets_backend_uid_valid",
      sql`${table.backendUid} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

export const credentialSources = occSchema.table(
  "credential_sources",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    name: collatedText("name").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").$type<Readonly<Record<string, string>>>().notNull(),
    egress: jsonb("egress").$type<ProtectedEgressSource>(),
    driverId: text("driver_id").notNull(),
    ownerCapability: text("owner_capability").$type<CredentialSourceOwnerCapability>().notNull(),
    state: text("state").$type<CredentialSourceState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "credential_sources_egress_valid",
      sql`CASE WHEN ${table.type} = 'credential-free-repository-metadata' THEN
      ${table.config}->'authority' = '"execution"'::jsonb
      AND ${table.config}->'agent_id' = ${table.egress} #> '{grant,isolationId}' AND ${table.config}->'origin' = ${table.egress}->'origin'
      AND ${table.config}->'repository_id' = ${table.egress} #> '{grant,repositoryId}' AND ${table.config}->'repository' = ${table.egress} #> '{grant,repository}'
      AND occ.credential_free_metadata_source_is_valid(${table.egress}, ${table.namespaceId}, ${table.id})
    ELSE ${table.egress} IS NULL OR occ.egress_source_is_valid(${table.egress}, ${table.namespaceId}, ${table.id}) END IS TRUE`,
    ),
    unique("credential_sources_namespace_id_id_unique").on(table.namespaceId, table.id),
    unique("credential_sources_namespace_id_name_unique").on(table.namespaceId, table.name),
    check(
      "credential_sources_id_format",
      sql`${table.id} ~ ${identifierPatterns.credentialSource}`,
    ),
    check("credential_sources_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "credential_sources_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check("credential_sources_type_valid", sql`${table.type} ~ '^[a-z][a-z0-9-]{0,63}$'`),
    check(
      "credential_sources_config_valid",
      sql`occ.credential_source_config_is_valid(${table.config})`,
    ),
    check(
      "credential_sources_owner_capability_valid",
      sql`${table.ownerCapability} = 'credential_gateway' OR (${table.ownerCapability} = 'credential_proxy' AND ${table.egress} IS NOT NULL)`,
    ),
    check(
      "credential_sources_driver_id_valid",
      sql`char_length(${table.driverId}) BETWEEN 1 AND 200 AND ${table.driverId} = btrim(${table.driverId})`,
    ),
    check(
      "credential_sources_state_valid",
      sql`${table.state} IN ('registering', 'ready', 'deleting')`,
    ),
  ],
);

/** Kept exact by the `agent_credential_sources_are_synchronized` trigger on `agents`. */
export const agentCredentialSources = occSchema.table(
  "agent_credential_sources",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    credentialSourceId: text("credential_source_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: "agent_credential_sources_pkey",
      columns: [table.namespaceId, table.agentId, table.credentialSourceId],
    }),
    foreignKey({
      name: "agent_credential_sources_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    foreignKey({
      name: "agent_credential_sources_source_owner",
      columns: [table.namespaceId, table.credentialSourceId],
      foreignColumns: [credentialSources.namespaceId, credentialSources.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    index("agent_credential_sources_source_idx").on(table.namespaceId, table.credentialSourceId),
  ],
);

export const credentialSourceSecrets = occSchema.table(
  "credential_source_secrets",
  {
    namespaceId: text("namespace_id").notNull(),
    credentialSourceId: text("credential_source_id").notNull(),
    field: collatedText("field").notNull(),
    secretId: text("secret_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: "credential_source_secrets_pkey",
      columns: [table.credentialSourceId, table.field],
    }),
    foreignKey({
      name: "credential_source_secrets_source_owner",
      columns: [table.namespaceId, table.credentialSourceId],
      foreignColumns: [credentialSources.namespaceId, credentialSources.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    foreignKey({
      name: "credential_source_secrets_secret_owner",
      columns: [table.namespaceId, table.secretId],
      foreignColumns: [secrets.namespaceId, secrets.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check("credential_source_secrets_field_format", sql`${table.field} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    index("credential_source_secrets_secret_idx").on(table.namespaceId, table.secretId),
  ],
);

export const credentialWithdrawals = occSchema.table(
  "credential_withdrawals",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").notNull(),
    credentialSourceId: text("credential_source_id").notNull(),
    state: text("state").$type<"pending" | "revoked">().notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastReason: text("last_reason"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: "credential_withdrawals_pkey",
      columns: [table.namespaceId, table.revisionId, table.credentialSourceId],
    }),
    foreignKey({
      name: "credential_withdrawals_revision_owner",
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    foreignKey({
      name: "credential_withdrawals_source_owner",
      columns: [table.namespaceId, table.credentialSourceId],
      foreignColumns: [credentialSources.namespaceId, credentialSources.id],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    check("credential_withdrawals_state_valid", sql`${table.state} IN ('pending', 'revoked')`),
    check(
      "credential_withdrawals_completion",
      sql`(${table.state} = 'revoked') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "credential_withdrawals_requested_by_valid",
      sql`char_length(${table.requestedBy}) BETWEEN 1 AND 256 AND ${table.requestedBy} = btrim(${table.requestedBy})`,
    ),
    check(
      "credential_withdrawals_last_attempt",
      sql`(${table.lastReason} IS NULL) = (${table.lastAttemptAt} IS NULL) AND (${table.lastReason} IS NULL OR ${table.lastReason} ~ '^[A-Z0-9_]{1,64}$')`,
    ),
    index("credential_withdrawals_source_idx").on(table.namespaceId, table.credentialSourceId),
  ],
);

export const agentRevisions = occSchema.table(
  "agent_revisions",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionNumber: bigint("revision_number", { mode: "number" }).notNull(),
    backendId: text("backend_id"),
    gatewayManagedMode: boolean("gateway_managed_mode").notNull().default(true),
    admittedSpec: jsonb("admitted_spec").$type<Record<string, unknown>>().notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("agent_revisions_namespace_id_agent_id_id_unique").on(
      table.namespaceId,
      table.agentId,
      table.id,
    ),
    unique("agent_revisions_namespace_id_agent_id_revision_number_unique").on(
      table.namespaceId,
      table.agentId,
      table.revisionNumber,
    ),
    foreignKey({
      name: "agent_revisions_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    // PostgreSQL stores these expressions as DDL; identifier patterns must be literals.
    check(
      "agent_revisions_id_format",
      sql`${table.id} ~ ${identifierPatterns.revision}`.inlineParams(),
    ),
    check("agent_revisions_revision_positive", sql`${table.revisionNumber} > 0`),
    check(
      "agent_revisions_backend_id_valid",
      sql`${table.backendId} IS NULL OR (char_length(${table.backendId}) BETWEEN 1 AND 200 AND ${table.backendId} = btrim(${table.backendId}) AND ${table.backendId} !~ '[[:cntrl:]]')`,
    ),
    check("agent_revisions_spec_object", sql`jsonb_typeof(${table.admittedSpec}) = 'object'`),
    check(
      "agent_revisions_egress_scope",
      sql`NOT (${table.admittedSpec} ? 'egress_plan') OR COALESCE(
        jsonb_typeof(${table.admittedSpec}->'egress_plan') = 'object'
        AND ${table.admittedSpec}->'egress_plan'->'execution'->>'namespaceId' = ${table.namespaceId}
        AND ${table.admittedSpec}->'egress_plan'->'execution'->>'agentId' = ${table.agentId}
        AND ${table.admittedSpec}->'egress_plan'->'execution'->>'revisionId' = ${table.id}
        AND jsonb_typeof(${table.admittedSpec}->'egress_plan'->'routes') = 'array',
        false)`,
    ),
    // Migration 0060 adds this as NOT VALID, records the unprotected decision on
    // revisions admitted before it existed and validates every stored row.
    check(
      "agent_revisions_execution_admission",
      sql`COALESCE(
        jsonb_typeof(${table.admittedSpec}->'execution_admission') = 'object'
        AND (${table.admittedSpec}->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((${table.admittedSpec}->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
        AND (
          (${table.admittedSpec}->'execution_admission'->>'mode' = 'unprotected'
            AND ${table.admittedSpec} #> '{execution_admission,version}' = '2'::jsonb
            AND NOT (${table.admittedSpec} ? 'egress_plan')
            AND NOT ((${table.admittedSpec}->'harness_auth') ? 'protectedExecutionVersion'))
          OR (${table.admittedSpec}->'execution_admission'->>'mode' = 'protected'
            AND ${table.admittedSpec} ? 'egress_plan'
            AND ${table.admittedSpec} #> '{harness_auth,protectedExecutionVersion}'
              = ${table.admittedSpec} #> '{execution_admission,version}'
            AND (
                ${table.admittedSpec} #>> '{execution_admission,version}' IN ('3','4','5','6','7')
                AND CASE WHEN ${table.admittedSpec} #>> '{execution_admission,version}' = '7'
                  THEN ${table.admittedSpec} #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (${table.admittedSpec}->'egress_plan' ? 'policyReductionVersion') OR
                    (${table.admittedSpec} #>> '{execution_admission,version}' = '3' AND ${table.admittedSpec} #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((${table.admittedSpec} #>> '{execution_admission,version}') IN ('4','5','6','7'))
                  = ((${table.admittedSpec}->'egress_plan') ? 'repositoryGit')
                AND (NOT ((${table.admittedSpec}->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(${table.admittedSpec}->'repository_credentials')='object'
                    AND ${table.admittedSpec} #> '{egress_plan,repositoryGit}' = ${table.admittedSpec}->'repository_credentials'))
                AND CASE WHEN ${table.admittedSpec} #>> '{execution_admission,version}' = '5'
                    THEN ${table.admittedSpec} #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN ${table.admittedSpec} #>> '{execution_admission,version}' = '6' THEN
                      ${table.admittedSpec} #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND ${table.admittedSpec} #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(${table.admittedSpec} #> '{egress_plan,repositoryGit,bindings}') = 1
                    ELSE NOT ((${table.admittedSpec}->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(${table.admittedSpec} #> '{egress_plan,driver}') = 'object'
                AND length(${table.admittedSpec} #>> '{egress_plan,driver,id}') > 0
                AND length(${table.admittedSpec} #>> '{egress_plan,driver,implementation}') > 0
                AND ${table.admittedSpec} #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false)`,
    ),
    check(
      "agent_revisions_admitted_snapshot",
      sql`(${table.admittedSpec} ?& ARRAY[
          'configuration_id', 'configuration_kind', 'configuration_generation',
          'draft_spec', 'harness', 'compute', 'harness_auth'
        ])
        AND (${table.admittedSpec}
          - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
          - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
          - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins'
          - 'plugin_approvers' - 'repository_credentials' - 'egress_plan' - 'execution_admission') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec}->'configuration_id') = 'string'
        AND (${table.admittedSpec}->>'configuration_id') ~ ${identifierPatterns.configuration}
        AND jsonb_typeof(${table.admittedSpec}->'configuration_kind') = 'string'
        AND (${table.admittedSpec}->>'configuration_kind') = 'agent'
        AND jsonb_typeof(${table.admittedSpec}->'configuration_generation') = 'number'
        AND (${table.admittedSpec}->>'configuration_generation')::numeric
          BETWEEN 1 AND 9007199254740991
        AND mod((${table.admittedSpec}->>'configuration_generation')::numeric, 1) = 0
        AND jsonb_typeof(${table.admittedSpec}->'draft_spec') = 'object'
        AND jsonb_typeof(${table.admittedSpec}->'harness') = 'object'
        AND ((${table.admittedSpec}->'harness') ?& ARRAY['id', 'version', 'mode'])
        AND ((${table.admittedSpec}->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,id}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{harness,id}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,version}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{harness,version}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{harness,mode}') = 'string'
        AND (${table.admittedSpec} #>> '{harness,mode}') IN ('embedded', 'dedicated')
        AND jsonb_typeof(${table.admittedSpec}->'compute') = 'object'
        AND ((${table.admittedSpec}->'compute') ?& ARRAY['id', 'implementation'])
        AND ((${table.admittedSpec}->'compute') - 'id' - 'implementation' - 'admission') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,id}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,id}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,implementation}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,implementation}'), '') <> ''
        AND (
          NOT ((${table.admittedSpec}->'compute') ? 'admission')
          OR (jsonb_typeof(${table.admittedSpec} #> '{compute,admission}') = 'string'
              AND char_length(${table.admittedSpec} #>> '{compute,admission}') BETWEEN 1 AND 1024
              AND (${table.admittedSpec} #>> '{compute,admission}') ~ '^[ -~]+$')
        )
        AND (
          NOT (${table.admittedSpec} ? 'sandbox_driver_id')
          OR (
            jsonb_typeof(${table.admittedSpec}->'sandbox_driver_id') = 'string'
            AND COALESCE(btrim(${table.admittedSpec}->>'sandbox_driver_id'), '') <> ''
          )
        )
        AND (
          NOT (${table.admittedSpec} ? 'secret_driver_id')
          OR (
            jsonb_typeof(${table.admittedSpec}->'secret_driver_id') = 'string'
            AND COALESCE(btrim(${table.admittedSpec}->>'secret_driver_id'), '') <> ''
          )
        )
        AND (
          NOT (${table.admittedSpec} ? 'secret_bindings')
          OR occ.secret_bindings_are_valid(${table.admittedSpec}->'secret_bindings', ${table.namespaceId})
        )
        AND CASE WHEN jsonb_typeof(${table.admittedSpec}->'harness_auth') = 'object' THEN
          occ.harness_auth_is_valid((${table.admittedSpec}->'harness_auth') - 'protectedExecutionVersion', ${table.namespaceId}, true)
        ELSE false END
        AND (
          NOT (${table.admittedSpec} ? 'repository_credentials')
          OR occ.repository_credentials_are_valid(${table.admittedSpec}->'repository_credentials')
        )
        AND (
          NOT (${table.admittedSpec} ? 'plugins')
          OR jsonb_typeof(${table.admittedSpec}->'plugins') = 'object'
        )
        AND (
          NOT (${table.admittedSpec} ? 'plugin_approvers')
          OR (jsonb_typeof(${table.admittedSpec}->'plugin_approvers') = 'array'
            AND jsonb_array_length(${table.admittedSpec}->'plugin_approvers') <= 64)
        )
        AND (
          NOT (${table.admittedSpec} ? 'credential_sources')
          OR occ.credential_source_snapshots_are_valid(${table.admittedSpec}->'credential_sources')
        )`.inlineParams(),
    ),
  ],
);

export const repositoryStandingApprovals = occSchema.table(
  "repository_standing_approvals",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    repositoryRef: text("repository_ref").notNull(),
    binding: jsonb("binding").notNull(),
    scope: jsonb("scope").notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    approvedBy: text("approved_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("standing_approvals_id_check", sql`id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`),
    check(
      "standing_approvals_binding_check",
      sql`occ.repository_bindings_are_valid(jsonb_build_array(binding),true) AND binding->>'repositoryRef'=repository_ref`,
    ),
    check(
      "standing_approvals_scope_check",
      sql`jsonb_typeof(scope)='object' AND octet_length(scope::text) BETWEEN 2 AND 65536`,
    ),
    check("standing_approvals_scope_fingerprint_check", sql`scope_fingerprint ~ '^[0-9a-f]{64}$'`),
    check("standing_approvals_generation_check", sql`generation BETWEEN 1 AND 9007199254740991`),
    check("standing_approvals_approved_by_check", sql`length(approved_by) BETWEEN 1 AND 512`),
    check("standing_approvals_created_at_check", sql`isfinite(created_at)`),
    check(
      "standing_approvals_revoked_at_check",
      sql`isfinite(revoked_at) AND revoked_at >= created_at`,
    ),
    uniqueIndex("repository_standing_approvals_generation").on(
      t.namespaceId,
      t.agentId,
      t.repositoryRef,
      t.generation,
    ),
    uniqueIndex("repository_standing_approvals_current")
      .on(t.namespaceId, t.agentId, t.repositoryRef)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const repositoryStandingExecutions = occSchema.table(
  "repository_standing_executions",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").primaryKey(),
    approvalId: text("approval_id")
      .notNull()
      .references(() => repositoryStandingApprovals.id),
    approvalGeneration: bigint("approval_generation", { mode: "number" }).notNull(),
    executionId: text("execution_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    closed: boolean("closed").notNull().default(false),
  },
  (t) => [
    check("repository_standing_execution_id", sql`length(${t.executionId}) BETWEEN 1 AND 512`),
    check("repository_standing_execution_fingerprint", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const repositorySessionAttempts = occSchema.table(
  "repository_session_attempts",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").notNull(),
    liveRevisionId: text("live_revision_id"),
    cleanupContext: jsonb("cleanup_context").notNull(),
    repositoryRef: text("repository_ref").notNull(),
    admissionId: text("admission_id").primaryKey(),
    durationSeconds: bigint("duration_seconds", { mode: "number" }).notNull(),
    deadlineWallMs: bigint("deadline_wall_ms", { mode: "number" }).notNull(),
    phase: text("phase").notNull(),
    sessionId: text("session_id"),
    predecessorAdmissionId: text("predecessor_admission_id"),
    executionFingerprint: text("execution_fingerprint"),
    brokerProtocol: smallint("broker_protocol").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "repository_session_succession_fields",
      sql`(${table.predecessorAdmissionId} IS NULL AND ${table.executionFingerprint} IS NULL) OR
      (${table.predecessorAdmissionId} IS NOT NULL AND ${table.executionFingerprint} IS NOT NULL AND ${table.executionFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
    uniqueIndex("repository_session_succession_once")
      .on(table.predecessorAdmissionId)
      .where(sql`${table.predecessorAdmissionId} IS NOT NULL`),
    foreignKey({
      name: "repository_session_attempts_revision_owner",
      columns: [table.namespaceId, table.agentId, table.liveRevisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "repository_session_attempts_live_revision_valid",
      sql`${table.liveRevisionId} IS NULL OR ${table.liveRevisionId} = ${table.revisionId}`,
    ),
    check(
      "repository_session_attempts_cleanup_context_valid",
      sql`jsonb_typeof(${table.cleanupContext}) = 'object'
        AND ${table.cleanupContext} ?& ARRAY['driver', 'binding']
        AND ${table.cleanupContext} - 'driver' - 'binding' = '{}'::jsonb
        AND occ.repository_credentials_are_valid(jsonb_build_object(
          'driver', ${table.cleanupContext}->'driver', 'deadlineWallMs', ${table.deadlineWallMs},
          'bindings', jsonb_build_array(${table.cleanupContext}->'binding')))
        AND ${table.cleanupContext} #>> '{binding,repositoryRef}' = ${table.repositoryRef}`,
    ),
    uniqueIndex("repository_session_attempts_active_binding_unique")
      .on(table.revisionId, table.repositoryRef)
      .where(sql`${table.phase} IN ('opening', 'open')`),
    uniqueIndex("repository_session_attempts_session_id_unique")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("repository_session_attempts_owner").on(
      table.namespaceId,
      table.agentId,
      table.revisionId,
    ),
    check(
      "repository_session_attempts_repository_ref_valid",
      sql`${table.repositoryRef} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "repository_session_attempts_admission_id_valid",
      sql`${table.admissionId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "repository_session_attempts_session_id_valid",
      sql`${table.sessionId} IS NULL OR ${table.sessionId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "repository_session_attempts_duration_valid",
      sql`${table.durationSeconds} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "repository_session_attempts_deadline_valid",
      sql`${table.deadlineWallMs} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "repository_session_attempts_broker_protocol_valid",
      sql`${table.brokerProtocol} IN (0, 1, 2, 3)`,
    ),
    check(
      "repository_session_attempts_phase_valid",
      sql`${table.phase} IN ('opening', 'open', 'closing', 'disposed', 'invalidated')`,
    ),
    check(
      "repository_session_attempts_phase_session_valid",
      sql`(${table.phase} = 'opening' AND ${table.sessionId} IS NULL)
        OR (${table.phase} IN ('open', 'disposed') AND ${table.sessionId} IS NOT NULL)
        OR ${table.phase} IN ('closing', 'invalidated')`,
    ),
    check(
      "repository_session_attempts_timestamps_valid",
      sql`isfinite(${table.createdAt}) AND isfinite(${table.updatedAt}) AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const repositoryBrokerReceipts = occSchema.table(
  "repository_broker_receipts",
  {
    admissionId: text("admission_id")
      .primaryKey()
      .references(() => repositorySessionAttempts.admissionId, { onDelete: "restrict" }),
    state: text("state").notNull(),
    generation: uuid("generation"),
    sessionId: text("session_id").unique(),
    deadlineWallMs: bigint("deadline_wall_ms", { mode: "number" }),
    revoked: bigint("revoked", { mode: "number" }),
    expired: bigint("expired", { mode: "number" }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "repository_broker_receipts_session_valid",
      sql`${table.sessionId} IS NULL OR ${table.sessionId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      "repository_broker_receipts_state_valid",
      sql`
      (${table.state} = 'fenced' AND ${table.sessionId} IS NULL AND ${table.deadlineWallMs} IS NULL AND ${table.revoked} IS NULL AND ${table.expired} IS NULL)
      OR (${table.state} = 'reserved' AND ${table.generation} IS NOT NULL AND ${table.sessionId} IS NULL AND ${table.deadlineWallMs} IS NULL AND ${table.revoked} IS NULL AND ${table.expired} IS NULL)
      OR (${table.state} = 'active' AND ${table.generation} IS NOT NULL AND ${table.sessionId} IS NOT NULL AND ${table.deadlineWallMs} IS NOT NULL AND ${table.deadlineWallMs} BETWEEN 1 AND 9007199254740991 AND ${table.revoked} IS NULL AND ${table.expired} IS NULL)
      OR (${table.state} = 'disposed' AND ${table.generation} IS NOT NULL AND ${table.sessionId} IS NOT NULL AND ${table.deadlineWallMs} IS NOT NULL AND ${table.deadlineWallMs} BETWEEN 1 AND 9007199254740991 AND ${table.revoked} IS NOT NULL AND ${table.revoked} BETWEEN 0 AND 9007199254740991 AND ${table.expired} IS NOT NULL AND ${table.expired} BETWEEN 0 AND 9007199254740991)
    `,
    ),
  ],
);

export const iamIdentities = occSchema.table(
  "iam_identities",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    issuer: text("issuer"),
    subject: text("subject"),
  },
  (table) => [
    unique("iam_identities_namespace_id_agent_id_id_unique")
      .on(table.namespaceId, table.agentId, table.id)
      .nullsNotDistinct(),
    foreignKey({
      name: "iam_identities_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("no action"),
    check("iam_identities_kind_valid", sql`${table.kind} IN ('principal', 'service_principal')`),
    check(
      "iam_identities_kind_ownership",
      sql`(
        (${table.kind} = 'principal'
          AND ${table.namespaceId} IS NULL AND ${table.agentId} IS NULL
          AND ${table.issuer} IS NOT NULL AND ${table.subject} IS NOT NULL)
        OR (${table.kind} = 'service_principal'
          AND (${table.agentId} IS NULL OR ${table.namespaceId} IS NOT NULL)
          AND ${table.issuer} IS NULL AND ${table.subject} IS NULL)
      )`,
    ),
    uniqueIndex("iam_principal_external_subject")
      .on(table.issuer, table.subject)
      .where(sql`${table.kind} = 'principal'`),
    uniqueIndex("iam_one_service_principal_per_agent")
      .on(table.namespaceId, table.agentId)
      .where(sql`${table.kind} = 'service_principal' AND ${table.agentId} IS NOT NULL`),
  ],
);

export const iamRoles = occSchema.table(
  "iam_roles",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    name: collatedText("name"),
    permissions: jsonb("permissions").$type<readonly Record<string, unknown>[]>().notNull(),
  },
  (table) => [
    unique("iam_roles_namespace_id_id_unique").on(table.namespaceId, table.id).nullsNotDistinct(),
    check("iam_roles_permissions_array", sql`jsonb_typeof(${table.permissions}) = 'array'`),
  ],
);

export const iamGroups = occSchema.table(
  "iam_groups",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    name: collatedText("name").notNull(),
  },
  (table) => [
    unique("iam_groups_namespace_id_id_unique").on(table.namespaceId, table.id).nullsNotDistinct(),
    unique("iam_groups_namespace_id_name_unique")
      .on(table.namespaceId, table.name)
      .nullsNotDistinct(),
    check("iam_groups_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      "iam_groups_name_normalized",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const iamGroupMemberships = occSchema.table(
  "iam_group_memberships",
  {
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    groupId: text("group_id")
      .notNull()
      .references(() => iamGroups.id, { onDelete: "restrict", onUpdate: "restrict" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => iamIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  },
  (table) => [
    unique("iam_group_memberships_group_principal_unique").on(table.groupId, table.principalId),
  ],
);

export const iamAccessBindings = occSchema.table(
  "iam_access_bindings",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    identitySubjectId: text("identity_subject_id").references(() => iamIdentities.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    groupSubjectId: text("group_subject_id").references(() => iamGroups.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    roleId: text("role_id")
      .notNull()
      .references(() => iamRoles.id, { onDelete: "restrict", onUpdate: "restrict" }),
    resourceKind: text("resource_kind"),
    resourceId: text("resource_id"),
  },
  (table) => [
    check(
      "iam_access_bindings_one_subject",
      sql`num_nonnulls(${table.identitySubjectId}, ${table.groupSubjectId}) = 1`,
    ),
    check(
      "iam_access_bindings_resource_pair",
      sql`(${table.resourceKind} IS NULL) = (${table.resourceId} IS NULL)`,
    ),
  ],
);

export const iamRestrictions = occSchema.table(
  "iam_restrictions",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
    action: text("action").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id"),
    effect: text("effect").notNull().default("deny"),
  },
  (table) => [
    check(
      "iam_restrictions_action_valid",
      sql`${table.action} IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer', 'read_logs', 'manage_policy')`,
    ),
    check(
      "iam_restrictions_resource_kind_valid",
      sql`${table.resourceKind} IN ('installation', 'namespace', 'configuration', 'preset', 'service_account', 'secret', 'credential_source', 'sandbox_policy', 'agent', 'agent_revision')`,
    ),
    check("iam_restrictions_effect_deny", sql`${table.effect} = 'deny'`),
    check(
      "iam_restrictions_resource_id_normalized",
      sql`${table.resourceId} IS NULL OR (${table.resourceId} = btrim(${table.resourceId}) AND char_length(${table.resourceId}) BETWEEN 1 AND 200)`,
    ),
  ],
);

export const auditEvents = occSchema.table(
  "audit_events",
  {
    id: text("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    namespaceId: text("namespace_id"),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    outcome: text("outcome").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("audit_events_work_attempt_idx")
      .on(sql`(${table.details}->>'workId')`, table.occurredAt.desc(), table.id.desc())
      .where(
        sql`${table.kind} = 'mutation' AND ${table.action} = 'reconcile' AND ${table.resourceKind} = 'agent_revision'`,
      ),
    check("audit_events_id_format", sql`${table.id} ~ ${identifierPatterns.audit}`),
    check("audit_events_outcome_valid", sql`${table.outcome} IN ('success', 'denied', 'failure')`),
    check(
      "audit_events_details_object",
      sql`${table.details} IS NULL OR jsonb_typeof(${table.details}) = 'object'`,
    ),
  ],
);

export const controllerWork = occSchema.table(
  "controller_work",
  {
    workKind: text("work_kind").notNull().default("lifecycle"),
    idempotencyKey: text("idempotency_key").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "restrict", onUpdate: "restrict" }),
    agentId: text("agent_id"),
    revisionId: text("revision_id"),
    actorId: text("actor_id").notNull(),
    namespaceTarget: text("namespace_target"),
    agentTarget: text("agent_target"),
    state: text("state").notNull().default("queued"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reasonCode: text("reason_code"),
    resultData: jsonb("result_data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Migration 0017 makes both work-owner constraints deferrable; Drizzle
    // models their NO ACTION semantics but not FK deferral.
    foreignKey({
      name: "controller_work_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("no action"),
    foreignKey({
      name: "controller_work_revision_owner",
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("no action"),
    check("controller_work_kind_valid", sql`${table.workKind} IN ('lifecycle', 'provisioning')`),
    check(
      "controller_work_idempotency_key_length",
      sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 512`,
    ),
    check(
      "controller_work_state_valid",
      sql`${table.state} IN ('queued', 'claimed', 'succeeded', 'failed_permanent')`,
    ),
    check("controller_work_attempt_count_valid", sql`${table.attemptCount} >= 0`),
    check(
      "controller_work_revision_requires_agent",
      sql`${table.revisionId} IS NULL OR ${table.agentId} IS NOT NULL`,
    ),
    check(
      "controller_work_namespace_target_valid",
      sql`(
        (${table.workKind} = 'lifecycle' AND ${table.agentId} IS NULL AND ${table.revisionId} IS NULL
          AND ${table.namespaceTarget} IS NOT NULL
          AND ${table.namespaceTarget} IN ('ready', 'deleted')
          AND ${table.agentTarget} IS NULL)
        OR (${table.workKind} = 'lifecycle' AND ${table.agentId} IS NOT NULL AND ${table.revisionId} IS NULL
          AND ${table.namespaceTarget} IS NULL
          AND ${table.agentTarget} IS NOT NULL
          AND ${table.agentTarget} IN ('stopped', 'deleted', 'sandbox_policy'))
        OR (${table.workKind} = 'lifecycle' AND ${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL
          AND ${table.namespaceTarget} IS NULL
          AND (${table.agentTarget} IS NULL OR ${table.agentTarget} = 'credentials_withdrawn'))
        OR (${table.workKind} = 'provisioning' AND ${table.agentId} IS NULL
          AND ${table.revisionId} IS NULL AND ${table.namespaceTarget} IS NULL
          AND ${table.agentTarget} IS NULL)
        OR (${table.workKind} = 'lifecycle' AND ${table.agentId} IS NULL
          AND ${table.revisionId} IS NULL AND ${table.namespaceTarget} IS NULL
          AND ${table.agentTarget} IS NULL
          AND ${table.idempotencyKey} ~ '^agent_revision:rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
      )`,
    ),
    check(
      "controller_work_claim_state",
      sql`(
        (${table.state} = 'claimed'
          AND ${table.claimToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.state} <> 'claimed'
          AND ${table.claimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)
      )`,
    ),
    check(
      "controller_work_completion_state",
      sql`(
        (${table.state} IN ('succeeded', 'failed_permanent')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reasonCode} IS NOT NULL)
        OR (${table.state} NOT IN ('succeeded', 'failed_permanent')
          AND ${table.completedAt} IS NULL
          AND ${table.reasonCode} IS NULL
          AND ${table.resultData} IS NULL)
      )`,
    ),
    check(
      "controller_work_reason_code_length",
      sql`${table.reasonCode} IS NULL OR char_length(${table.reasonCode}) BETWEEN 1 AND 64`,
    ),
    check(
      "controller_work_result_data_state",
      sql`${table.resultData} IS NULL OR (
        jsonb_typeof(${table.resultData}) = 'object'
        AND (
          (
            ${table.state} = 'failed_permanent'
            AND ${table.reasonCode} IN ('HARNESS_CREDENTIAL_BOOTSTRAP_FAILED', 'HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT')
            AND (${table.resultData} - 'preparation') = '{}'::jsonb
            AND occ.compute_preparation_failure_is_valid(${table.resultData}->'preparation')
          )
          OR
          (
            ${table.state} = 'failed_permanent'
            AND ${table.reasonCode} = 'CONVERGENCE_DEADLINE_EXCEEDED'
            AND ${table.resultData} ? 'timeoutMs'
            AND (${table.resultData} - 'timeoutMs' - 'runtimeFailure') = '{}'::jsonb
            AND jsonb_typeof(${table.resultData}->'timeoutMs') = 'number'
            AND (${table.resultData}->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
            AND (${table.resultData}->>'timeoutMs')::numeric <= 9007199254740991
            AND (
              NOT (${table.resultData} ? 'runtimeFailure')
              OR (
                jsonb_typeof(${table.resultData}->'runtimeFailure') = 'object'
                AND (${table.resultData}->'runtimeFailure') ?& ARRAY['component', 'check', 'checkedAt', 'code']
                AND ((${table.resultData}->'runtimeFailure') - 'component' - 'check' - 'checkedAt' - 'code') = '{}'::jsonb
                AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,component}') = 'string'
                AND char_length(${table.resultData} #>> '{runtimeFailure,component}') BETWEEN 1 AND 64
                AND (${table.resultData} #>> '{runtimeFailure,component}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
                AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,check}') = 'string'
                AND char_length(${table.resultData} #>> '{runtimeFailure,check}') BETWEEN 1 AND 64
                AND (${table.resultData} #>> '{runtimeFailure,check}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
                AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,checkedAt}') = 'string'
                AND occ.iso_timestamp_is_valid(${table.resultData} #>> '{runtimeFailure,checkedAt}')
                AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,code}') = 'string'
                AND char_length(${table.resultData} #>> '{runtimeFailure,code}') BETWEEN 1 AND 64
                AND (${table.resultData} #>> '{runtimeFailure,code}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
              )
            )
          )
          OR (
            ${table.state} = 'failed_permanent'
            AND ${table.reasonCode} = 'RUNTIME_MODEL_PROBE_FAILED'
            AND ${table.resultData} ? 'runtimeFailure'
            AND (${table.resultData} - 'runtimeFailure') = '{}'::jsonb
            AND jsonb_typeof(${table.resultData}->'runtimeFailure') = 'object'
            AND (${table.resultData}->'runtimeFailure') ?& ARRAY['component', 'check', 'checkedAt', 'code']
            AND ((${table.resultData}->'runtimeFailure') - 'component' - 'check' - 'checkedAt' - 'code' - 'cause') = '{}'::jsonb
            AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,component}') = 'string'
            AND (${table.resultData} #>> '{runtimeFailure,component}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,check}') = 'string'
            AND (${table.resultData} #>> '{runtimeFailure,check}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,checkedAt}') = 'string'
            AND occ.iso_timestamp_is_valid(${table.resultData} #>> '{runtimeFailure,checkedAt}')
            AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,code}') = 'string'
            AND (${table.resultData} #>> '{runtimeFailure,code}') = 'MODEL_PROBE_FAILED'
            AND (
              NOT ((${table.resultData}->'runtimeFailure') ? 'cause')
              OR (
                jsonb_typeof(${table.resultData} #> '{runtimeFailure,cause}') = 'object'
                AND (${table.resultData} #> '{runtimeFailure,cause}') ? 'kind'
                AND ((${table.resultData} #> '{runtimeFailure,cause}') - 'kind' - 'detail') = '{}'::jsonb
                AND jsonb_typeof(${table.resultData} #> '{runtimeFailure,cause,kind}') = 'string'
                AND (${table.resultData} #>> '{runtimeFailure,cause,kind}') IN ('PROCESS_EXIT', 'PROBE_STATUS', 'INVALID_OUTPUT', 'WRAPPER_ERROR')
                AND (
                  NOT ((${table.resultData} #> '{runtimeFailure,cause}') ? 'detail')
                  OR (
                    jsonb_typeof(${table.resultData} #> '{runtimeFailure,cause,detail}') = 'string'
                    AND (${table.resultData} #>> '{runtimeFailure,cause,detail}') ~ '^[A-Za-z0-9_-]{1,32}$'
                  )
                )
              )
            )
          )
          OR (
            ${table.state} = 'succeeded'
            AND ${table.reasonCode} IN ('REVISION_ACTIVATED', 'REVISION_ALREADY_ACTIVE')
            AND ${table.resultData} ? 'warnings'
            AND (${table.resultData} - 'warnings') = '{}'::jsonb
            AND jsonb_typeof(${table.resultData}->'warnings') = 'array'
            AND NOT jsonb_path_exists(
              ${table.resultData},
              '$.warnings[*] ? (@.type() != "object" || !(exists(@.code)) || !(exists(@.pluginId)) || @.code.type() != "string" || @.pluginId.type() != "string" || !(@.code == "PLUGIN_INSTALL_FAILED" || @.code == "PLUGIN_AUTH_REQUIRED") || !(@.pluginId like_regex "^[A-Za-z0-9._~:@-]{1,253}$"))'
            )
            AND NOT jsonb_path_exists(
              ${table.resultData},
              '$.warnings[*].keyvalue() ? (@.key != "code" && @.key != "pluginId")'
            )
          )
        )
      )`,
    ),
    index("controller_work_ready")
      .on(table.availableAt, table.createdAt, table.idempotencyKey)
      .where(sql`${table.state} = 'queued'`),
    index("controller_work_expired")
      .on(table.leaseExpiresAt, table.idempotencyKey)
      .where(sql`${table.state} = 'claimed'`),
    uniqueIndex("controller_work_one_claim_per_resource")
      .on(sql`COALESCE(${table.agentId}, ${table.namespaceId})`)
      .where(sql`${table.state} = 'claimed'`),
  ],
);

export const agentProvisioningWork = occSchema.table(
  "agent_provisioning_work",
  {
    workId: text("work_id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id"),
    configurationId: text("configuration_id"),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull(),
    completedPhase: text("completed_phase").notNull(),
    revisionId: text("revision_id"),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "agent_provisioning_work_work_owner",
      columns: [table.workId],
      foreignColumns: [controllerWork.idempotencyKey],
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    foreignKey({
      name: "agent_provisioning_work_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "agent_provisioning_work_configuration_owner",
      columns: [table.namespaceId, table.configurationId],
      foreignColumns: [configurations.namespaceId, configurations.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "agent_provisioning_work_revision_owner",
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("no action"),
    unique("agent_provisioning_request_unique").on(
      table.namespaceId,
      table.actorId,
      table.requestId,
    ),
    unique("agent_provisioning_agent_unique").on(table.namespaceId, table.agentId),
    unique("agent_provisioning_configuration_unique").on(table.namespaceId, table.configurationId),
    check(
      "agent_provisioning_status_valid",
      sql`${table.status} IN ('queued', 'running', 'failed', 'succeeded', 'cancelled')`,
    ),
    check(
      "agent_provisioning_phase_valid",
      sql`${table.completedPhase} IN ('admitted', 'configuration', 'transport', 'handoff')`,
    ),
    check(
      "agent_provisioning_fingerprint_valid",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "agent_provisioning_json_objects",
      sql`jsonb_typeof(${table.plan}) = 'object'
        AND jsonb_typeof(${table.progress}) = 'object'`,
    ),
    check(
      "agent_provisioning_revision_requires_handoff",
      sql`${table.revisionId} IS NULL OR (${table.completedPhase} = 'handoff' AND ${table.agentId} IS NOT NULL)`,
    ),
    check(
      "agent_provisioning_success_requires_handoff",
      sql`${table.status} <> 'succeeded' OR (${table.completedPhase} = 'handoff' AND ${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL)`,
    ),
    check(
      "agent_provisioning_admitted_revision_status_valid",
      sql`${table.revisionId} IS NULL OR ${table.status} IN ('running', 'succeeded', 'failed')`,
    ),
  ],
);

export const user = occSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull(),
    email: collatedText("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("auth_user_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_user_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check("auth_user_email_length", sql`char_length(${table.email}) BETWEEN 3 AND 320`),
    check(
      "auth_user_email_normalized",
      sql`${table.email} = lower(btrim(${table.email})) AND ${table.email} LIKE '%@%'`,
    ),
    check("auth_user_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const session = occSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    check("auth_session_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_session_token_length", sql`char_length(${table.token}) BETWEEN 1 AND 512`),
    check("auth_session_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const account = occSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    authenticationVersion: integer("authentication_version").notNull().default(1),
    identityOnly: boolean("identity_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("account_authentication_version_positive", sql`${table.authenticationVersion} > 0`),
    check(
      "account_identity_only",
      sql`NOT ${table.identityOnly} OR (
      ${table.providerId} <> 'credential' AND ${table.password} IS NULL AND ${table.accessToken} IS NULL
      AND ${table.refreshToken} IS NULL AND ${table.idToken} IS NULL AND ${table.accessTokenExpiresAt} IS NULL
      AND ${table.refreshTokenExpiresAt} IS NULL AND ${table.scope} IS NULL)`,
    ),
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
    check("auth_account_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_account_provider_length", sql`char_length(${table.providerId}) BETWEEN 1 AND 200`),
    check(
      "auth_account_external_id_length",
      sql`char_length(${table.accountId}) BETWEEN 1 AND 512`,
    ),
    check("auth_account_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const humanAuthenticationAccounts = occSchema.table(
  "human_authentication_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onUpdate: "restrict", onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => iamIdentities.id, { onUpdate: "restrict", onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    disabled: boolean("disabled").notNull().default(false),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("human_authentication_version_positive", sql`${table.version} > 0`),
    unique("human_authentication_principal_unique").on(table.principalId),
  ],
);

export const humanAuthenticationSessions = occSchema.table(
  "human_authentication_sessions",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onUpdate: "restrict", onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => humanAuthenticationAccounts.userId, {
        onUpdate: "restrict",
        onDelete: "cascade",
      }),
    methodId: text("method_id")
      .notNull()
      .references(() => account.id, { onUpdate: "restrict", onDelete: "cascade" }),
    version: integer("version").notNull(),
    methodVersion: integer("method_version").notNull(),
  },
  (table) => [
    check("human_authentication_session_version_positive", sql`${table.version} > 0`),
    check("human_authentication_session_method_version_positive", sql`${table.methodVersion} > 0`),
  ],
);

export const humanAuthenticationRecovery = occSchema.table("human_authentication_recovery", {
  installationId: text("installation_id")
    .primaryKey()
    .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => humanAuthenticationAccounts.userId, {
      onUpdate: "restrict",
      onDelete: "restrict",
    }),
  principalId: text("principal_id")
    .notNull()
    .references(() => iamIdentities.id, { onUpdate: "restrict", onDelete: "restrict" }),
  methodId: text("method_id")
    .notNull()
    .references(() => account.id, { onUpdate: "restrict", onDelete: "restrict" }),
});

export const humanAuthenticationAttempts = occSchema.table(
  "human_authentication_attempts",
  {
    stateHash: text("state_hash").primaryKey(),
    browserHash: text("browser_hash").notNull(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    callbackURL: text("callback_url").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("human_authentication_state_hash", sql`${table.stateHash} ~ '^[a-f0-9]{64}$'`),
    check("human_authentication_browser_hash", sql`${table.browserHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "human_authentication_provider_length",
      sql`char_length(${table.providerId}) BETWEEN 1 AND 200 AND ${table.providerId} <> 'credential'`,
    ),
    check(
      "human_authentication_callback_length",
      sql`char_length(${table.callbackURL}) BETWEEN 1 AND 2048`,
    ),
    check(
      "human_authentication_verifier",
      sql`${table.codeVerifier} ~ '^[A-Za-z0-9._~-]{43,128}$'`,
    ),
    check(
      "human_authentication_attempt_lifetime",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`,
    ),
    index("human_authentication_attempt_expiry").on(table.expiresAt),
  ],
);

export const verification = occSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    check("auth_verification_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check(
      "auth_verification_identifier_length",
      sql`char_length(${table.identifier}) BETWEEN 1 AND 512`,
    ),
    check("auth_verification_value_length", sql`char_length(${table.value}) BETWEEN 1 AND 4096`),
    check("auth_verification_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

// Better Auth owns this schema and hashed key lifecycle. referenceId resolves
// through the selected IAM Driver, which need not store identities in OCC.
export const apikey = occSchema.table(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull().unique(),
    refillInterval: bigint("refill_interval", { mode: "number" }),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(false),
    rateLimitTimeWindow: bigint("rate_limit_time_window", { mode: "number" }),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
  ],
);

/** Exact authenticated runtime installation; admission remains owned by the revision. */
export const egressInstallations = occSchema.table(
  "egress_installations",
  {
    senderId: text("sender_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    revisionId: text("revision_id").notNull(),
    agentId: text("agent_id").notNull(),
    installation: jsonb("installation").$type<EgressInstallation>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.senderId, table.sandboxId] }),
    check(
      "egress_installations_check",
      sql`length(${table.senderId}) BETWEEN 1 AND 200 AND length(${table.sandboxId}) BETWEEN 1 AND 200`,
    ),
    check(
      "egress_installations_check1",
      sql`COALESCE(${table.installation}->'sender'->>'id' = ${table.senderId}
        AND ${table.installation}->>'sandboxId' = ${table.sandboxId}
        AND ${table.installation}->'plan'->'execution'->>'namespaceId' = ${table.namespaceId}
        AND ${table.installation}->'plan'->'execution'->>'revisionId' = ${table.revisionId}
        AND ${table.installation}->'plan'->'execution'->>'agentId' = ${table.agentId}, false)`,
    ),
    unique().on(table.namespaceId, table.revisionId),
    foreignKey({
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    }).onDelete("cascade"),
  ],
);

export const egressRejectedMaterial = occSchema.table(
  "egress_rejected_material",
  {
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    secretDriverId: text("secret_driver_id").notNull(),
    materialId: text("material_id").notNull(),
    materialVersion: text("material_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespaceId, table.secretDriverId, table.materialId, table.materialVersion],
    }),
    check(
      "egress_rejected_material_check",
      sql`length(${table.secretDriverId}) > 0 AND length(${table.materialId}) > 0 AND length(${table.materialVersion}) > 0`,
    ),
  ],
);

/** Metadata only: possible dispatch, observed response policy and independent settlement. */
export const egressSendReceipts = occSchema.table(
  "egress_send_receipts",
  {
    senderId: text("sender_id").notNull(),
    senderGeneration: bigint("sender_generation", { mode: "number" }).notNull(),
    instanceId: text("instance_id").notNull(),
    useId: text("use_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    binding: jsonb("binding").notNull(),
    authorization: jsonb("authorized_dispatch"),
    observation: jsonb("observation"),
    outcome: jsonb("outcome").notNull(),
    settled: boolean("settled").notNull().default(false),
    feedback: text("feedback"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.senderId,
        table.senderGeneration,
        table.instanceId,
        table.useId,
        table.attemptId,
      ],
    }),
    check("egress_send_receipts_check_0", sql`length(sender_id) > 0`),
    check("egress_send_receipts_check_1", sql`sender_generation > 0`),
    check("egress_send_receipts_check_2", sql`length(instance_id) > 0`),
    check("egress_send_receipts_check_3", sql`length(use_id) > 0`),
    check("egress_send_receipts_check_4", sql`length(attempt_id) > 0`),
    check("egress_send_receipts_check_5", sql`jsonb_typeof(binding) = 'object'`),
    check("egress_send_receipts_check_6", sql`jsonb_typeof(outcome) = 'object'`),
    check("egress_send_receipts_check_7", sql`feedback = 'fenced'`),
    check(
      "egress_send_receipts_check_8",
      sql`(binding->'sender'->>'id' = sender_id
      AND (binding->'sender'->>'generation')::bigint = sender_generation
      AND binding->>'instanceId' = instance_id
      AND binding->>'useId' = use_id AND binding->>'attemptId' = attempt_id
      AND length(binding->>'deadlineAt') > 0
      AND jsonb_typeof(binding->'material') IN ('object', 'null')) IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_9",
      sql`(
    (outcome->>'kind' = 'refused' AND outcome->'dispatched' = 'false'::jsonb AND settled)
    OR (outcome->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
        AND outcome->>'dispatch' = 'confirmed' AND settled)
    OR (outcome->>'kind' = 'uncertain' AND outcome->>'dispatch' = 'possible')
  ) IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_10",
      sql`outcome->>'kind' <> 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'`,
    ),
    check(
      "egress_send_receipts_check_11",
      sql`outcome->>'kind' <> 'response_blocked' OR (outcome->>'code' = 'response_policy') IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_12",
      sql`outcome->>'kind' NOT IN ('response', 'provider_rejected')
    OR ((outcome->>'status')::integer BETWEEN 100 AND 599) IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_13",
      sql`observation IS NULL OR (jsonb_typeof(observation) = 'object'
    AND observation->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
    AND observation->>'dispatch' = 'confirmed'
    AND CASE WHEN observation->>'kind' = 'response_blocked'
      THEN observation->>'code' = 'response_policy'
      ELSE (observation->>'status')::integer BETWEEN 100 AND 599 END) IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_14",
      sql`observation->>'kind' IS DISTINCT FROM 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'`,
    ),
    check(
      "egress_send_receipts_check_15",
      sql`observation IS NULL OR NOT settled OR outcome = observation OR outcome->>'kind' = 'uncertain'`,
    ),
    check(
      "egress_send_receipts_check_16",
      sql`feedback IS NULL OR ((observation IS NOT NULL OR (settled AND outcome->>'dispatch' = 'confirmed'))
    AND occ.egress_receipt_material_is_valid(binding->'material')) IS TRUE`,
    ),
    check(
      "egress_send_receipts_check_17",
      sql`authorized_dispatch IS NULL OR (
    jsonb_typeof(authorized_dispatch) = 'object'
    AND authorized_dispatch #>> '{association,installation,instanceId}' = instance_id
    AND authorized_dispatch #>> '{association,execution,installationId}' = binding #>> '{material,source,installationId}'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz > (authorized_dispatch->>'authorizedAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (authorized_dispatch->>'authorizedAt')::timestamptz + interval '1 second'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz
    AND CASE WHEN binding #>> '{material,kind}' = 'no_material_required' THEN
      (binding->'material') - ARRAY['kind','source','binding','grantHash','isolationId'] = '{}'::jsonb
      AND binding #>> '{material,grantHash}' ~ '^[0-9a-f]{64}$'
      AND occ.egress_ref_is_valid(binding #> '{material,binding}')
      AND binding #> '{material,source,provider}' = '{"id":"credential-free-repository-metadata","generation":1}'::jsonb
      AND occ.egress_ref_is_valid(binding #> '{material,source,source}') AND occ.egress_ref_is_valid(binding #> '{material,source,backend}')
      AND binding #>> '{material,source,namespaceId}' = authorized_dispatch #>> '{association,execution,namespaceId}'
      AND occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material')
      AND authorized_dispatch->>'injectionDigest' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ELSE occ.egress_receipt_material_is_valid(binding->'material')
      AND (binding #>> '{material,kind}' = 'static' OR occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material'))
      AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding #>> '{material,usableUntil}')::timestamptz
      AND length(authorized_dispatch #>> '{association,exchangeId}') > 0 AND length(authorized_dispatch #>> '{association,responseId}') > 0
      AND length(authorized_dispatch #>> '{association,custodyId}') > 0 AND length(authorized_dispatch->>'requestDigest') = 64
      AND length(authorized_dispatch->>'injectionDigest') = 64
    END) IS TRUE`,
    ),
  ],
);

/** Lifecycle custody, never an Agent-readable Secret or a substitute for live source authority. */
export const preparedGitHubFamilies = occSchema.table(
  "prepared_github_families",
  {
    sourceId: text("source_id").primaryKey(),
    source: jsonb("source").notNull(),
    issuer: jsonb("issuer").notNull(),
    admission: jsonb("admission").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    workerClaim: uuid("worker_claim"),
  },
  (t) => [
    check(
      "prepared_github_families_check",
      sql`(source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  (
   (((source->>'adoption' = 'prepared_repository_git' OR (
       source->>'adoption' = 'credential_proxy_repository_git'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'))
   AND ((source #>> '{grant,profile}' = 'git-ref-write' AND NOT (source->'grant' ? 'pullRequestBase'))
       OR (source #>> '{grant,profile}' = 'git-ref-draft-pr' AND length(source #>> '{grant,pullRequestBase}') > 0))
   AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}')
   OR (source->>'adoption' = 'credential_proxy_github_repository'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'
       AND source #>> '{session,credentialProxyExecution,enforcement,repositoryGitRecipient,deliveryProfile}' = 'github_repository'
       AND source #>> '{session,binding,profile}' = 'github-repository'
       AND source #>> '{grant,profile}' = 'github-repository'
       AND jsonb_typeof(source #> '{grant,repositories}') = 'array'
       AND jsonb_array_length(source #> '{grant,repositories}') BETWEEN 1 AND 16
       AND jsonb_typeof(source #> '{grant,permissions}') = 'object'
       AND source #>> '{grant,permissions,metadata}' = 'read'
       AND jsonb_typeof(source #> '{session,bindings}') = 'array'
       AND jsonb_array_length(source #> '{session,bindings}') = jsonb_array_length(source #> '{grant,repositories}')
       AND NOT jsonb_path_exists(source, '$.session.bindings[*] ? (@.profile != "github-repository")')
       AND jsonb_path_query_array(source, '$.session.bindings[*].grant.repositoryId') @> jsonb_path_query_array(source, '$.grant.repositories[*].repositoryId')
       AND jsonb_path_query_array(source, '$.grant.repositories[*].repositoryId') @> jsonb_path_query_array(source, '$.session.bindings[*].grant.repositoryId')
       AND source #>> '{grant,appId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{grant,installationId}' ~ '^[1-9][0-9]*$')
   OR (source->>'adoption' = 'credential_proxy_github_installation'
       AND jsonb_typeof(source #> '{session,credentialProxyExecution,driver}') = 'object'
       AND source #>> '{session,credentialProxyExecution,enforcement,repositoryGitRecipient,deliveryProfile}' = 'github_installation'
       AND source #>> '{session,binding,profile}' = 'github-installation'
       AND source #>> '{grant,profile}' = 'github-installation'
       AND (source->'grant') - ARRAY['id','isolationId','appId','installationId','profile'] = '{}'::jsonb
       AND source #>> '{grant,appId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{grant,installationId}' ~ '^[1-9][0-9]*$'
       AND source #>> '{session,grant,repositoryId}' = 'github-installation:' || (source #>> '{grant,installationId}'))
   )
   AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE`,
    ),
    index("prepared_github_families_due")
      .on(t.nextCheckAt)
      .where(sql`enabled`),
  ],
);

export const preparedGitHubAttempts = occSchema.table(
  "prepared_github_attempts",
  {
    id: uuid("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => preparedGitHubFamilies.sourceId),
    admission: jsonb("admission").notNull(),
    state: text("state").notNull(),
    custody: text("custody").notNull().default("intent"),
    materialVersion: uuid("material_version").unique(),
    providerExpiresAt: timestamp("provider_expires_at", { withTimezone: true }),
    usableUntil: timestamp("usable_until", { withTimezone: true }),
    sealed: customType<{ data: Buffer }>({ dataType: () => "bytea" })("sealed"),
    // Bounds an uncertain issue or revocation; see issueAttemptLiveBoundMs.
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("prepared_github_attempt_version").on(t.id, t.materialVersion),
    check(
      "prepared_github_attempts_state_check",
      sql`state IN ('issuing', 'committed', 'quarantined')`,
    ),
    check(
      "prepared_github_attempts_custody_check",
      sql`custody IN ('intent', 'current', 'retire', 'revoking', 'revoked', 'expired', 'unknown', 'not_issued')`,
    ),
    check(
      "prepared_github_attempts_not_issued_check",
      sql`custody <> 'not_issued' OR (state = 'quarantined' AND material_version IS NULL)`,
    ),
    check(
      "prepared_github_attempts_expired_check",
      sql`custody <> 'expired' OR (state = 'committed' AND material_version IS NOT NULL
        AND isfinite(usable_until) AND isfinite(provider_expires_at)
        AND usable_until < provider_expires_at) IS TRUE`,
    ),
    check(
      "prepared_github_attempts_check",
      sql`custody <> 'current' OR (state = 'committed' AND sealed IS NOT NULL
    AND material_version IS NOT NULL AND usable_until IS NOT NULL
    AND provider_expires_at IS NOT NULL AND usable_until <= provider_expires_at)`,
    ),
    check(
      "prepared_github_attempts_check1",
      sql`(sealed IS NOT NULL) = (custody IN ('current','retire','revoking','unknown'))`,
    ),
    uniqueIndex("prepared_github_current")
      .on(t.sourceId)
      .where(sql`custody='current'`),
    index("prepared_github_attempts_family").on(t.sourceId),
  ],
);

export const preparedRepositoryGitUses = occSchema.table(
  "prepared_repository_git_uses",
  {
    exchangeId: uuid("exchange_id").primaryKey(),
    admissionId: text("admission_id")
      .notNull()
      .references(() => repositorySessionAttempts.admissionId),
    attemptId: uuid("attempt_id").notNull(),
    materialVersion: uuid("material_version").notNull(),
    operation: text("operation").notNull(),
    recipientFence: bigint("recipient_fence", { mode: "number" }),
    requestDigestSha256: text("request_digest_sha256").notNull(),
    sendStartBy: timestamp("send_start_by", { withTimezone: true }),
    authorizationReplyBy: timestamp("authorization_reply_by", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.attemptId, t.materialVersion],
      foreignColumns: [preparedGitHubAttempts.id, preparedGitHubAttempts.materialVersion],
    }),
    check(
      "prepared_repository_git_uses_decision_deadline",
      sql`num_nonnulls(${t.sendStartBy}, ${t.authorizationReplyBy}) = 1`,
    ),
    check(
      "prepared_repository_git_uses_operation_check",
      sql`(${t.operation} IN ('advertise-upload-pack','upload-pack','advertise-receive-pack','receive-pack')
        OR (${t.recipientFence} IS NULL AND ${t.operation} = 'create-draft-pull')
        OR (${t.recipientFence} IS NOT NULL AND ${t.operation} IN ('github-rest','github-graphql')))
      AND (${t.recipientFence} IS NULL OR ${t.recipientFence} > 0)`,
    ),
    check(
      "prepared_repository_git_uses_request_digest_sha256_check",
      sql`${t.requestDigestSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const preparedRepositoryDraftPulls = occSchema.table(
  "prepared_repository_draft_pulls",
  {
    grantId: text("grant_id").primaryKey(),
    operationId: uuid("operation_id").notNull(),
    receiptId: uuid("receipt_id").notNull().unique(),
    admissionId: text("admission_id")
      .notNull()
      .references(() => repositorySessionAttempts.admissionId),
    attemptId: uuid("attempt_id").notNull(),
    materialVersion: uuid("material_version").notNull(),
    requestDigestSha256: text("request_digest_sha256").notNull(),
    scope: jsonb("scope").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    sendStartBy: timestamp("send_start_by", { withTimezone: true }),
    authorizationReplyBy: timestamp("authorization_reply_by", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    outcome: text("outcome").notNull().default("outcome_unknown"),
    projection: jsonb("projection"),
  },
  (t) => [
    foreignKey({
      columns: [t.attemptId, t.materialVersion],
      foreignColumns: [preparedGitHubAttempts.id, preparedGitHubAttempts.materialVersion],
    }),
    check(
      "prepared_repository_draft_pulls_decision_deadline",
      sql`num_nonnulls(${t.sendStartBy}, ${t.authorizationReplyBy}) = 1`,
    ),
    check(
      "prepared_repository_draft_pulls_request_digest_sha256_check",
      sql`${t.requestDigestSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "prepared_repository_draft_pulls_outcome_check",
      sql`${t.outcome} IN ('created','not-submitted','outcome_unknown')`,
    ),
    check(
      "prepared_repository_draft_pulls_check",
      sql`(${t.outcome}='created') = (${t.projection} IS NOT NULL)`,
    ),
    check(
      "prepared_repository_draft_pulls_check1",
      sql`${t.settledAt} IS NOT NULL OR ${t.outcome}='outcome_unknown'`,
    ),
  ],
);

export const credentialDeliveries = occSchema.table(
  "credential_deliveries",
  {
    revisionId: text("revision_id").notNull(),
    liveRevisionId: text("live_revision_id").references(() => agentRevisions.id, {
      onDelete: "set null",
    }),
    bindingId: text("binding_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    target: jsonb("target").notNull(),
    fence: bigint("fence", { mode: "number" }).notNull().default(1),
    workerInstance: uuid("worker_instance").notNull(),
    adoptedAt: timestamp("adopted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    desired: jsonb("desired"),
    observed: jsonb("observed"),
    materialVersion: uuid("material_version"),
    preparationAttemptId: uuid("preparation_attempt_id"),
    targetMaterialVersion: uuid("target_material_version"),
    targetPreparationAttemptId: uuid("target_preparation_attempt_id"),
    settlement: text("settlement").notNull(),
    operationFence: bigint("operation_fence", { mode: "number" }).notNull().default(1),
    writePending: text("write_pending"),
    blocked: text("blocked"),
    retainedPolicyHash: text("retained_policy_hash"),
  },
  (t) => [
    check(
      "credential_deliveries_live_revision_check",
      sql`${t.liveRevisionId} IS NULL OR ${t.liveRevisionId} = ${t.revisionId}`,
    ),
    check("credential_deliveries_operation_fence_check", sql`${t.operationFence} >= 1`),
    check("credential_deliveries_settlement_check", sql`${t.settlement} IN ('snapshot','witness')`),
    check(
      "credential_deliveries_rotation_target_check",
      sql`${t.writePending} IS DISTINCT FROM 'rotate' OR ${t.targetMaterialVersion} IS NOT NULL`,
    ),
    // Deferred in 0062 so the live-reference SET NULL runs before the owner check.
    foreignKey({
      columns: [t.namespaceId, t.agentId, t.liveRevisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    }),
    primaryKey({ columns: [t.revisionId, t.bindingId] }),
    index("credential_deliveries_namespace").on(t.namespaceId),
    unique("credential_deliveries_revision_id_target_key").on(t.revisionId, t.target),
    check("credential_deliveries_binding_id_check", sql`${t.bindingId} <> ''`),
    check("credential_deliveries_target_check", sql`jsonb_typeof(${t.target}) = 'object'`),
    check("credential_deliveries_fence_check", sql`${t.fence} >= 1`),
    check("credential_deliveries_desired_check", sql`jsonb_typeof(${t.desired}) = 'object'`),
    check("credential_deliveries_observed_check", sql`jsonb_typeof(${t.observed}) = 'object'`),
    check(
      "credential_deliveries_write_pending_check",
      sql`${t.writePending} IN ('bootstrap','rotate')`,
    ),
    check(
      "credential_deliveries_retained_policy_hash_check",
      sql`${t.retainedPolicyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "credential_deliveries_check",
      sql`(${t.materialVersion} IS NULL) = (${t.preparationAttemptId} IS NULL)`,
    ),
    check(
      "credential_deliveries_check1",
      sql`(${t.targetMaterialVersion} IS NULL) = (${t.targetPreparationAttemptId} IS NULL)`,
    ),
  ],
);

export const credentialDeliveryReductions = occSchema.table(
  "credential_delivery_reductions",
  {
    revisionId: text("revision_id").notNull(),
    bindingId: text("binding_id").notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    recipient: jsonb("recipient"),
    materialVersion: uuid("material_version"),
    retainedPolicyHash: text("retained_policy_hash"),
    requestId: uuid("request_id"),
    expectedVersion: text("expected_version"),
    observedGeneration: text("observed_generation"),
    policyRequest: jsonb("policy_request").$type<CredentialPolicyReductionState["request"]>(),
    policyObserved: jsonb("policy_observed").$type<EgressInstallation>(),
    deliveryBindingId: text("delivery_binding_id").generatedAlwaysAs(
      sql`CASE WHEN policy_request IS NULL THEN binding_id END`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.bindingId] }),
    foreignKey({
      columns: [t.revisionId, t.deliveryBindingId],
      foreignColumns: [credentialDeliveries.revisionId, credentialDeliveries.bindingId],
    }).onDelete("cascade"),
    check(
      "credential_delivery_reductions_policy_check",
      sql`CASE WHEN ${t.policyRequest} IS NULL THEN
      ${t.recipient} IS NOT NULL AND ${t.materialVersion} IS NOT NULL AND ${t.retainedPolicyHash} IS NOT NULL AND ${t.policyObserved} IS NULL
    ELSE COALESCE(
      ${t.recipient} IS NULL AND ${t.materialVersion} IS NULL AND ${t.retainedPolicyHash} IS NULL
      AND ${t.policyRequest}->>'version' IN ('1','2')
      AND ${t.policyRequest}->>'operationId' = ${t.requestId}::text
      AND ${t.policyRequest} #>> '{expected,plan,execution,revisionId}' = ${t.revisionId}
      AND ${t.policyRequest} #>> '{expected,plan,generation}' = ${t.expectedVersion}
      AND jsonb_typeof(${t.policyRequest} #> '{retained,routes}') = 'array'
      AND (${t.policyObserved} IS NULL OR (
        ${t.policyObserved}->'plan' = ${t.policyRequest}->'retained'
        AND ${t.policyObserved} #>> '{plan,generation}' = ${t.observedGeneration})), false) END`,
    ),
    check("credential_delivery_reductions_binding_id_check", sql`${t.bindingId} <> ''`),
    check("credential_delivery_reductions_fence_check", sql`${t.fence} >= 1`),
    check(
      "credential_delivery_reductions_recipient_check",
      sql`jsonb_typeof(${t.recipient}) = 'object'`,
    ),
    check(
      "credential_delivery_reductions_retained_policy_hash_check",
      sql`${t.retainedPolicyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("credential_delivery_reductions_expected_version_check", sql`${t.expectedVersion} <> ''`),
    check(
      "credential_delivery_reductions_observed_generation_check",
      sql`${t.observedGeneration} <> ''`,
    ),
    check(
      "credential_delivery_reductions_check",
      sql`(${t.requestId} IS NULL) = (${t.expectedVersion} IS NULL)`,
    ),
    check(
      "credential_delivery_reductions_check1",
      sql`${t.observedGeneration} IS NULL OR ${t.requestId} IS NOT NULL`,
    ),
  ],
);

export const sandboxPolicies = occSchema.table(
  "sandbox_policies",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    version: integer("version").notNull(),
    document: jsonb("document")
      .$type<import("@openclaw-enterprise/contracts").SandboxPolicy>()
      .notNull(),
  },
  (table) => [
    unique("sandbox_policies_agent_unique").on(table.namespaceId, table.agentId),
    foreignKey({
      name: "sandbox_policies_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    check(
      "sandbox_policies_document_valid",
      sql`occ.sandbox_policy_is_valid(${table.document}, ${table.id}, ${table.namespaceId}, ${table.agentId}, ${table.version})`,
    ),
  ],
);
