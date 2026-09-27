import type {
  InitialWorkspaceFiles,
  AgentDesiredRuntimeState,
  AgentStatus,
  HarnessExecutionMode,
  HarnessAuthBinding,
  PluginDesiredState,
  PluginApprovers,
  PresetTemplate,
  RepositoryBindingSelection,
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
    plugins: jsonb("plugins").$type<PluginDesiredState>(),
    pluginApprovers: jsonb("plugin_approvers").$type<PluginApprovers>(),
    repositoryBindings: jsonb("repository_bindings").$type<readonly RepositoryBindingSelection[]>(),
    servicePrincipalId: text("service_principal_id").notNull(),
    harnessAuth: jsonb("harness_auth").$type<HarnessAuthBinding>(),
    harnessAuthSecretId: text("harness_auth_secret_id").generatedAlwaysAs(
      sql`CASE WHEN harness_auth->>'method' IN ('api_key', 'codex_pat') THEN harness_auth #>> '{source,id}' END`,
    ),
    harnessAuthServiceAccountId: text("harness_auth_service_account_id").generatedAlwaysAs(
      sql`CASE WHEN harness_auth->>'method' = 'chatgpt_service_account' THEN harness_auth->>'serviceAccountId' END`,
    ),
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

export const agentRevisions = occSchema.table(
  "agent_revisions",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionNumber: bigint("revision_number", { mode: "number" }).notNull(),
    backendId: text("backend_id"),
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
    check("agent_revisions_id_format", sql`${table.id} ~ ${identifierPatterns.revision}`),
    check("agent_revisions_revision_positive", sql`${table.revisionNumber} > 0`),
    check(
      "agent_revisions_backend_id_valid",
      sql`${table.backendId} IS NULL OR (char_length(${table.backendId}) BETWEEN 1 AND 200 AND ${table.backendId} = btrim(${table.backendId}) AND ${table.backendId} !~ '[[:cntrl:]]')`,
    ),
    check("agent_revisions_spec_object", sql`jsonb_typeof(${table.admittedSpec}) = 'object'`),
    check(
      "agent_revisions_admitted_snapshot",
      sql`(${table.admittedSpec} ?& ARRAY[
          'configuration_id', 'configuration_kind', 'configuration_generation',
          'draft_spec', 'harness', 'compute', 'harness_auth'
        ])
        AND (${table.admittedSpec}
          - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
          - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
          - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'plugins'
          - 'repository_credentials') = '{}'::jsonb
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
        AND ((${table.admittedSpec}->'compute') - 'id' - 'implementation') = '{}'::jsonb
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,id}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,id}'), '') <> ''
        AND jsonb_typeof(${table.admittedSpec} #> '{compute,implementation}') = 'string'
        AND COALESCE(btrim(${table.admittedSpec} #>> '{compute,implementation}'), '') <> ''
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
        AND occ.harness_auth_is_valid(${table.admittedSpec}->'harness_auth', ${table.namespaceId}, true)
        AND (
          NOT (${table.admittedSpec} ? 'repository_credentials')
          OR occ.repository_credentials_are_valid(${table.admittedSpec}->'repository_credentials')
        )
        AND (
          NOT (${table.admittedSpec} ? 'plugins')
          OR jsonb_typeof(${table.admittedSpec}->'plugins') = 'object'
        )`,
    ),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "repository_session_attempts_revision_owner",
      columns: [table.namespaceId, table.agentId, table.liveRevisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "repository_session_attempts_live_revision_valid",
      sql`(${table.liveRevisionId} IS NOT NULL AND ${table.liveRevisionId} = ${table.revisionId})
        OR (${table.liveRevisionId} IS NULL AND ${table.phase} = 'disposed')`,
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
      sql`${table.action} IN ('create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer')`,
    ),
    check(
      "iam_restrictions_resource_kind_valid",
      sql`${table.resourceKind} IN ('installation', 'namespace', 'configuration', 'preset', 'service_account', 'secret', 'agent', 'agent_revision')`,
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
          AND ${table.agentTarget} IN ('stopped', 'deleted'))
        OR (${table.workKind} = 'lifecycle' AND ${table.agentId} IS NOT NULL AND ${table.revisionId} IS NOT NULL
          AND ${table.namespaceTarget} IS NULL AND ${table.agentTarget} IS NULL)
        OR (${table.workKind} = 'provisioning' AND ${table.agentId} IS NULL
          AND ${table.revisionId} IS NULL AND ${table.namespaceTarget} IS NULL
          AND ${table.agentTarget} IS NULL)
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
      sql`${table.status} <> 'succeeded' OR (${table.completedPhase} = 'handoff' AND ${table.agentId} IS NOT NULL AND ${table.configurationId} IS NOT NULL AND ${table.revisionId} IS NOT NULL)`,
    ),
    check(
      "agent_provisioning_failed_before_handoff",
      sql`${table.status} NOT IN ('failed', 'cancelled') OR ${table.revisionId} IS NULL`,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
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
