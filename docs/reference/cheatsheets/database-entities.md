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

Stores Agent drafts, their desired runtime state, and the selected version reference.

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
- `sandbox_policy_editing`
- `status`
- `created_at`

### `sandbox_policies`

Stores one Agent-owned desired network policy with versioned application evidence.
See [per-Agent policies](../sandbox-policies.md).

- `id`
- `namespace_id`
- `agent_id`
- `version`
- `document` (additions, pending/latest application, last confirmed live version)

### `agent_revisions`

Stores numbered, immutable snapshots of Agent settings accepted for deployment.
`admitted_spec` includes the explicit v2
[execution admission decision](../credential-sources/protected-inference.md#execution-admission-cutoff).

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

Records which Credential Gateway or Credential Proxy admitted each source. The capability and Driver ID are immutable; the table holds no credential values.

- `id`
- `namespace_id`
- `name`
- `type`
- `config`
- `egress` (optional admitted source and versioned resolver references)
- `owner_capability` (`credential_gateway` or `credential_proxy`)
- `driver_id`
- `state`
- `created_at`

### `egress_installations`

Binds authenticated supervisor/Sandbox identity and an immutable loaded-enforcement
instance/configuration fingerprint to the exact admitted revision plan.
See [protected inference](../credential-sources/protected-inference.md).

- `sender_id`, `sandbox_id`
- `namespace_id`, `agent_id`, `revision_id`
- `installation`

### `credential_deliveries`

Tracks delivery custody for the exact Namespace, Agent and revision. See the
[repository flow](../../flows/agent-repository-credentials.md).

- `revision_id`, `live_revision_id`, `binding_id`, `namespace_id`, `agent_id`, `target`
- `fence`, `operation_fence`, `settlement`, `worker_instance`, `adopted_at`, `updated_at`
- `desired`, `observed`, `write_pending`, `blocked`, `retained_policy_hash`
- `material_version`, `preparation_attempt_id`
- `target_material_version`, `target_preparation_attempt_id`

### `credential_delivery_reductions`

Retains material-delivery and execution-policy reduction requests for static and
repository bindings. An unobserved request cannot be sent again. See the
[policy reduction flow](../../flows/credential-source-egress.md#6-reduce-the-live-credential-policy).

- `revision_id`, `binding_id`, `fence`, `recipient`, `material_version`, `retained_policy_hash`
- `request_id`, `expected_version`, `observed_generation`
- `policy_request`, `policy_observed`, `delivery_binding_id`

### `prepared_github_families`

Owns prepared token issuance and renewal for an explicitly admitted source.

- `source_id`, `source`, `issuer`, `admission`
- `enabled`, `next_check_at`, `worker_claim`

### `prepared_github_attempts`

Retains issuance and disposal custody, including unknown outcomes. Authenticated
expiry is distinct from confirmed revocation. A refusal with no token is `not_issued`.
An unknown outcome settles after GitHub's maximum token lifetime from `started_at`.

- `id`, `source_id`, `admission`, `state`, `custody`, `started_at`
- `material_version`, `provider_expires_at`, `usable_until`, `sealed`

### `prepared_repository_git_uses`

Append-only records of possible disclosure, bound to the exact attempt and material version.

- `exchange_id`, `admission_id`, `attempt_id`, `material_version`
- `operation`, `recipient_fence`, `request_digest_sha256`
- `send_start_by`, `authorization_reply_by` (exactly one deadline)

### `prepared_repository_draft_pulls`

Retains the single draft-creation allowance for a grant, independently of later PR updates.

- `grant_id`, `operation_id`, `receipt_id`, `admission_id`, `attempt_id`, `material_version`
- `request_digest_sha256`, `scope`, `admitted_at`, `send_start_by`, `authorization_reply_by`
- `settled_at`, `outcome`, `projection`

### `protected_repository_git_recipients`

Records where the selected Driver observed the protected Git recipient and which token version it installed.
If the installation result is unknown, `state` stays `installing`. The sender must still get permission for each Git request.

- `revision_id`, `installation` (the exact installation OCC recorded for this Agent revision)
- `fence` (advances before each attempt to install a token), `state` (`observed`, `installing`, or `installed`)
- `attempt_id`, `material_version` (identify the prepared token without storing its value here)

### `egress_send_receipts`

Retains exact sender attempts and safe observations independently of final delivery proof.
See [protected inference](../credential-sources/protected-inference.md).

- `sender_id`, `sender_generation`, `instance_id`, `use_id`, `attempt_id`
- `binding` (selected material evidence and original deadline)
- `authorized_dispatch` (accepted execution, installation and custody, digests and send-start bound)
- `outcome`, `observation`, `settled`, `feedback`

### `egress_rejected_material`

Fences a provider-rejected version independently of later authoritative rereads.

- `namespace_id`, `secret_driver_id`
- `material_id`, `material_version`

### `agent_credential_sources`

Mirrors each Agent draft's `credential_sources` through a trigger, so the database refuses to delete a source an Agent still binds.

- `namespace_id`
- `agent_id`
- `credential_source_id`

### `credential_source_secrets`

Links each credential source secret field to the Namespace Secret that supplied it.

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
- `broker_protocol` (0/1: historical native; 2: protected; 3: prepared native)
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

Queues and tracks controller work for Namespace and Agent lifecycle changes, Agent provisioning, and version deployments.

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
