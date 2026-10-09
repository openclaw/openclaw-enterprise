# Database entities cheat sheet

Look up the SQL table and column names stored by OpenClaw Control Plane (OCC).
The tables below are in the `occ` PostgreSQL schema; use `occ."user"` when
querying the `user` table.

The [database schema](../../../packages/occ/src/state/postgres-schema.ts) defines
columns and constraints. The
[repository-credentials migration](../../../migrations/0025_repository_credentials.sql)
adds the repository binding and session-attempt storage below. The
[Drizzle migration-history table](../../../drizzle.config.ts),
`drizzle.__drizzle_migrations`, is excluded. See [migration history](../settings/operations.md#migration-history)
for supported database states and [platform repositories](../platform-repositories.md)
for how OCC reads and writes its data.

## Platform resources

### `installation`

Stores the single OCC Installation record.

- `id`
- `name`
- `created_at`

### `namespaces`

Tracks platform Namespaces, their lifecycle status, and any existing Kubernetes namespace they use.

- `id`
- `name`
- `existing_namespace`
- `status`
- `created_at`
- `deleted_at`

### `agents`

Stores Agent drafts, their desired runtime state, and the active revision reference.

- `id`
- `namespace_id`
- `name`
- `configuration_id`
- `backend_id`
- `execution_mode`
- `plugins`
- `plugin_approvers`
- `repository_bindings`
- `repository_access` (default and explicit per-repository overrides)
- `service_principal_id`
- `harness_auth`
- `harness_auth_secret_id`
- `harness_auth_service_account_id`
- `harness_auth_credential_source_id`
- `credential_sources` (every bound credential source)
- `active_revision_id`
- `desired_runtime_state`
- `status`
- `created_at`

### `agent_revisions`

Stores numbered, immutable snapshots of Agent settings accepted for deployment.

- `id`
- `namespace_id`
- `agent_id`
- `revision_number`
- `backend_id`
- `admitted_spec`
- `admitted_at`

### `workspace_setups`

Holds private initial workspace input for one exact Namespace and Agent. Activation
completion clears `files`; setup identity and completion metadata remain until
Agent deletion. See the [workspace setup flow](../../flows/workspace-files.md).

- `id`
- `namespace_id`
- `agent_id`
- `defaults_id`
- `files`
- `completed`

### `configurations`

Stores each Agent Configuration’s current generation and Secret bindings; the Driver stores values.

- `id`
- `namespace_id`
- `kind`
- `generation`
- `secret_bindings`
- `created_at`

### `presets`

Stores reusable Agent launch templates and variable definitions within one Namespace.

- `id`
- `namespace_id`
- `name`
- `template`
- `created_at`

### `secrets`

Stores Secret metadata and backend references; Secret values are kept by the selected Driver.

- `id`
- `namespace_id`
- `name`
- `driver_id`
- `backend_namespace_name`
- `backend_name`
- `backend_key`
- `backend_uid`
- `created_at`

### `credential_sources`

Stores credential sources registered with the selected Credential Gateway; the gateway holds the values.

- `id`
- `namespace_id`
- `name`
- `type`
- `config`
- `driver_id`
- `state`
- `created_at`

### `agent_credential_sources`

Mirrors each Agent draft's `credential_sources` through a trigger, so the database refuses to delete a source an Agent still binds.

- `namespace_id`
- `agent_id`
- `credential_source_id`

### `credential_source_secrets`

Links a credential source field to its Namespace Secret. Static sources retain these links; refresh sources clear them after successful handoff without deleting the Secrets.

- `namespace_id`
- `credential_source_id`
- `field`
- `secret_id`

### `credential_withdrawals`

Records one credential source withdrawn from one Agent revision, until the gateway confirms revocation.

- `namespace_id`
- `agent_id`
- `revision_id`
- `credential_source_id`
- `state`
- `requested_by`
- `requested_at`
- `completed_at`
- `last_reason`
- `last_attempt_at`

### `service_accounts`

Stores Namespace service accounts and any credential Secret references.

- `id`
- `namespace_id`
- `name`
- `credential`

### `service_account_driver_bindings`

Links managed accounts to a Backend, Driver, upstream account, workspace, and any issued credential.

- `service_account_id`
- `namespace_id`
- `backend_id`
- `driver_id`
- `external_account_id`
- `external_credential_id`
- `workspace_id`

### `repository_session_attempts`

Retains repository-session identity and cleanup context after AgentRevision deletion.

- `namespace_id`
- `agent_id`
- `revision_id`
- `live_revision_id`
- `cleanup_context`
- `repository_ref`
- `admission_id`
- `duration_seconds`
- `deadline_wall_ms`
- `broker_protocol`
- `phase`
- `session_id`
- `created_at`
- `updated_at`

### `repository_broker_receipts`

Retains nonsecret admission fences and broker-confirmed terminal evidence for an exact attempt.

- `admission_id`
- `state`
- `generation`
- `session_id`
- `deadline_wall_ms`
- `revoked`
- `expired`

## Identity and access

### `iam_identities`

Stores human Principals and service identities, including those owned by an Agent.

- `id`
- `namespace_id`
- `agent_id`
- `kind`
- `issuer`
- `subject`

### `iam_groups`

Defines native IAM groups at Installation or Namespace scope.

- `id`
- `namespace_id`
- `name`

### `iam_group_memberships`

Links human Principals to their native IAM groups.

- `namespace_id`
- `group_id`
- `principal_id`

### `iam_roles`

Defines native IAM roles as sets of actions and resource kinds.

- `id`
- `namespace_id`
- `name`
- `permissions`

### `iam_access_bindings`

Grants a native IAM role to an identity or group, optionally for a specific resource.

- `id`
- `namespace_id`
- `identity_subject_id`
- `group_subject_id`
- `role_id`
- `resource_kind`
- `resource_id`

### `iam_restrictions`

Defines native IAM rules that deny actions on a resource kind or specific resource, overriding grants.

- `id`
- `namespace_id`
- `action`
- `resource_kind`
- `resource_id`
- `effect`

## Audit and controller

### `audit_events`

Keeps an append-only record of bootstrap, changes to resources, and authorization denials.

- `id`
- `occurred_at`
- `kind`
- `actor_id`
- `action`
- `namespace_id`
- `resource_kind`
- `resource_id`
- `outcome`
- `details`

### `controller_work`

Queues and tracks controller work for Namespace and Agent lifecycle changes, Agent provisioning, and revision deployments.

- `work_kind`
- `idempotency_key`
- `namespace_id`
- `agent_id`
- `revision_id`
- `actor_id`
- `namespace_target`
- `agent_target`
- `state`
- `available_at`
- `attempt_count`
- `claim_token`
- `lease_expires_at`
- `completed_at`
- `reason_code`
- `result_data`
- `created_at`
- `updated_at`

### `agent_provisioning_work`

Records one Agent provisioning request and its progress. Each row belongs to a
`controller_work` row with `work_kind = 'provisioning'`. See the
[Agent provisioning flow](../../flows/agent-provisioning.md).

- `work_id`
- `namespace_id`
- `agent_id`
- `configuration_id`
- `actor_id`
- `request_id`
- `request_fingerprint`
- `status`
- `completed_phase`
- `revision_id`
- `plan`
- `progress`
- `created_at`
- `updated_at`

## Browser authentication and service API keys

### `user`

Stores the profiles of people provisioned to sign in.

- `id`
- `name`
- `email`
- `email_verified`
- `image`
- `created_at`
- `updated_at`

### `session`

Stores expiring browser sessions for signed-in users.

- `id`
- `expires_at`
- `token`
- `created_at`
- `updated_at`
- `ip_address`
- `user_agent`
- `user_id`

### `account`

Links a user to their sign-in method. Password methods store a password hash;
identity-only external methods reject password and provider-token storage.
See [GitHub sign-in](../authentication/external-sign-in.md#github-sign-in-for-existing-accounts).

- `id`
- `account_id`
- `provider_id`
- `user_id`
- `access_token`
- `refresh_token`
- `id_token`
- `access_token_expires_at`
- `refresh_token_expires_at`
- `scope`
- `password`
- `authentication_version`
- `identity_only`
- `created_at`
- `updated_at`

### `human_authentication_accounts`

Binds each enrolled human user to its existing Installation Principal and current
account version. Disabled accounts cannot issue or use profile-bound sessions.

- `user_id`
- `installation_id`
- `principal_id`
- `version`
- `disabled`
- `changed_at`

### `human_authentication_sessions`

Binds an ordinary browser session to its admitted account and method versions.

- `session_id`
- `user_id`
- `method_id`
- `version`
- `method_version`

### `human_authentication_recovery`

Retains the fixed existing password recovery administrator for an Installation.

- `installation_id`
- `user_id`
- `principal_id`
- `method_id`

### `human_authentication_attempts`

Stores one-use external-login attempts with browser binding and a maximum
five-minute lifetime. Stores the PKCE verifier, but no authorization code or
provider token. Consumed attempts are deleted before exchange.

- `state_hash`
- `browser_hash`
- `installation_id`
- `provider_id`
- `callback_url`
- `code_verifier`
- `created_at`
- `expires_at`

### `verification`

Stores expiring verification records managed by Better Auth.

- `id`
- `identifier`
- `value`
- `expires_at`
- `created_at`
- `updated_at`

### `apikey`

Stores hashed service API keys and their settings for IAM service identities.

- `id`
- `config_id`
- `name`
- `start`
- `reference_id`
- `prefix`
- `key`
- `refill_interval`
- `refill_amount`
- `last_refill_at`
- `enabled`
- `rate_limit_enabled`
- `rate_limit_time_window`
- `rate_limit_max`
- `request_count`
- `remaining`
- `last_request`
- `expires_at`
- `created_at`
- `updated_at`
- `permissions`
- `metadata`
