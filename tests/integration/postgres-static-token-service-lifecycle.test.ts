import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { BUILTIN_CODEX_OAUTH_PRESET } from "../../apps/controller/src/backends/token-service/codex-oauth-preset.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type {
  AuditEvent,
  CredentialSourceReference,
  SourceProviderPresetId,
} from "../../packages/contracts/src/index.ts";
import {
  AuditAppendUnavailableError,
  AuthorizationDeniedError,
  CredentialSourceConfigError,
  ResourceStateConflictError,
  ScopeViolationError,
  TokenServiceSourceInputError,
  type UpdateManagedCredentialSourceInput,
} from "../../packages/occ/src/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

const migratorUrl = process.env.OCC_TEST_STATIC_TOKEN_SERVICE_MIGRATION_DATABASE_URL;

async function withRejectedAuditRows<T>(migrator: Pool, action: string, run: () => Promise<T>) {
  // The disposable migrator role can refuse a new action without invalidating earlier ledger rows.
  await migrator.query(
    `ALTER TABLE occ.audit_events ADD CONSTRAINT reject_static_token_service_audit
       CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    return await run();
  } finally {
    await migrator.query(
      "ALTER TABLE occ.audit_events DROP CONSTRAINT reject_static_token_service_audit",
    );
  }
}

test(
  "staged TokenService lifecycle keeps private custody, audit, and exact update authority",
  {
    skip:
      databaseUrl && migratorUrl ? false : "Prepare the dedicated postgres-platform file fixture.",
  },
  async (t) => {
    assert.ok(databaseUrl && migratorUrl);
    const appTarget = new URL(databaseUrl);
    const migratorTarget = new URL(migratorUrl);
    assert.ok(
      appTarget.protocol === "postgresql:" &&
        appTarget.hostname === "127.0.0.1" &&
        appTarget.pathname.startsWith("/openclaw_ci_") &&
        migratorTarget.protocol === appTarget.protocol &&
        migratorTarget.hostname === appTarget.hostname &&
        migratorTarget.port === appTarget.port &&
        migratorTarget.pathname === appTarget.pathname &&
        appTarget.username === "occ_app" &&
        migratorTarget.username === "occ_migrator",
      "Audit constraints require a role-separated disposable loopback database.",
    );
    const migrator = testPool(t, { connectionString: migratorUrl });
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "staged-token-service",
      authSecret: "staged-token-service-session-secret",
      requestAudit: false,
      controllerOptions: {
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      },
      appOptions: {
        provisionAuthAccount: (
          ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
        ) => provision(...args),
      },
    });
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    await controller.applyIAMConfiguration();
    // PostgreSQL, Native IAM, and both concrete Drivers are real; only the Kubernetes API transport is simulated.
    const { core, driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const ownerId = "staged-token-service";
    const instanceId = await controller.activateTokenServiceInstance(ownerId, randomUUID());
    const owner = new OCCTokenServiceDriver(
      ownerId,
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
      undefined,
      new OAuthAccountTokens(state, driver, controller.resolveConnectionClient.bind(controller)),
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);

    const createdNamespace = await inject("POST", "/namespaces", {
      name: `Staged source ${randomUUID()}`,
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId: string = createdNamespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const base = `/namespaces/${namespaceId}/credential-sources`;
    const event = (
      actorId: string,
      action: string,
      ref: CredentialSourceReference,
      phase?: string,
    ): AuditEvent => ({
      ...auditEvent(
        controller.installation.id,
        namespaceId,
        actorId,
        phase ? `${action}.started` : action,
        ref,
      ),
      ...(phase ? { details: { phase } } : {}),
    });
    const createAudit = (ref: CredentialSourceReference, phase?: "registration_started") =>
      event(principal.id, "openclaw.credential_sources.create", ref, phase);
    const createSource = (name: string, credential: string, providerPreset?: string) =>
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name,
          lifecycleConfig: { type: "static", settings: {} },
          secret: { opaque: credential },
          ...(providerPreset === undefined ? {} : { providerPreset }),
        },
        createAudit,
      );
    const retire = (id: string) =>
      controller.deleteCredentialSource(principal.id, namespaceId, id, (_removed, phase) =>
        event(
          principal.id,
          "openclaw.credential_sources.delete",
          { kind: "credential_source", namespaceId, id },
          phase,
        ),
      );
    const custodyRows = async () =>
      (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM occ.credential_sources WHERE namespace_id=$1) AS sources,
              (SELECT count(*)::int FROM occ.iam_access_bindings WHERE namespace_id=$1 AND resource_kind='credential_source') AS bindings`,
          [namespaceId],
        )
      ).rows;

    const createsBefore = core.calls.createNamespacedSecret;
    // The owner resolves one static value; ambiguous material must fail before custody starts.
    await assert.rejects(
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name: "Ambiguous credential",
          lifecycleConfig: { type: "static", settings: {} },
          secret: { first: randomUUID(), second: randomUUID() },
        },
        createAudit,
      ),
      TokenServiceSourceInputError,
    );
    await assert.rejects(
      createSource("Oversized", "a".repeat(65_471)),
      TokenServiceSourceInputError,
    );
    // Provider approval belongs to OCC. Neither an unknown ID nor a lifecycle setting can create it.
    for (const invalid of ["", "unknown"]) {
      await assert.rejects(
        createSource("Invalid preset", randomUUID(), invalid),
        CredentialSourceConfigError,
      );
    }
    await assert.rejects(
      controller.createManagedCredentialSource(
        principal.id,
        namespaceId,
        {
          name: "Lifecycle cannot approve a provider",
          lifecycleConfig: { type: "static", settings: { provider_preset: "openai" } },
          secret: { opaque: randomUUID() },
        },
        createAudit,
      ),
      ScopeViolationError,
    );
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // Refusing intent prevents the concrete owner from taking custody or leaving a creator binding.
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.create.started",
      async () => {
        await assert.rejects(
          createSource("Intent refused", randomUUID()),
          AuditAppendUnavailableError,
        );
      },
    );
    assert.equal(core.calls.createNamespacedSecret, createsBefore);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // The private store can accept a write and lose its acknowledgment. The request fails,
    // and the canonical Source transaction rolls back; orphaned custody is an accepted outcome.
    const unknownKey = randomUUID();
    core.createAppliedFailureCodes.push(503);
    const unknown = await inject("POST", base, {
      name: "Unknown credential write",
      type: "static",
      secret: { opaque: unknownKey },
    });
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);
    assert.equal(
      core.secrets.size,
      1,
      "the lost acknowledgment can leave private orphaned material",
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT actor_id,resource_id,details->>'phase' AS phase FROM occ.audit_events
           WHERE action='openclaw.credential_sources.create.started' AND resource_id=$1 AND actor_id=$2`,
          [namespaceId, principal.id],
        )
      ).rows.at(-1),
      { actor_id: principal.id, resource_id: namespaceId, phase: "registration_started" },
    );

    // TokenService commits the Source and credential before OCC grants creator IAM and appends
    // completion audit. A failure in OCC leaves a real dangling Source; the prior intent remains.
    const createIntentCount = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.create.started' AND resource_id=$1 AND actor_id=$2",
          [namespaceId, principal.id],
        )
      ).rows[0].count as number;
    const createIntentsBeforeDangling = await createIntentCount();
    const danglingKey = randomUUID();
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.create", async () => {
      await assert.rejects(
        createSource("Dangling after audit failure", danglingKey),
        AuditAppendUnavailableError,
      );
    });
    const dangling = (
      await pool.query(
        `SELECT id,state FROM occ.credential_sources WHERE namespace_id=$1 AND name=$2`,
        [namespaceId, "Dangling after audit failure"],
      )
    ).rows[0];
    assert.equal(dangling.state, "ready");
    assert.deepEqual(await custodyRows(), [{ sources: 1, bindings: 0 }]);
    assert.equal(
      (
        await owner.resolveCredential(
          {
            sourceRef: { kind: "credential_source", namespaceId, id: dangling.id },
            tokenServiceInstanceId: instanceId,
          },
          AbortSignal.timeout(5_000),
        )
      ).credential,
      danglingKey,
    );
    assert.equal(await createIntentCount(), createIntentsBeforeDangling + 1);
    await retire(dangling.id);
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);

    // Static custody accepts no settings. Successful registration proves OCC did not forward the approval.
    const approved = await createSource("Approved provider", randomUUID(), "openai");
    assert.equal(approved.type, "static");
    assert.deepEqual(approved.config, { provider_preset: "openai" });
    assert.deepEqual(
      (await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [approved.id]))
        .rows[0].config,
      { provider_preset: "openai" },
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT actor_id, details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.create' AND resource_id=$1",
          [approved.id],
        )
      ).rows,
      [{ actor_id: principal.id, preset: "openai" }],
    );
    const beforeDuplicate = core.calls.createNamespacedSecret;
    const duplicate = await inject("POST", base, {
      name: "Approved provider",
      type: "static",
      secret: { opaque: randomUUID() },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(core.calls.createNamespacedSecret, beforeDuplicate);
    await retire(approved.id);

    const key = randomUUID();
    const source = await createSource("Private credential", key);
    assert.equal(source.type, "static");
    assert.deepEqual(source.config, {});
    const sourceId = source.id;
    const ref = source.ref;
    const persisted = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(persisted?.ownerCapability === "token_service");
    assert.equal(persisted.tokenServiceInstanceId, instanceId);
    assert.equal(persisted.type, "static");
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS count FROM occ.secrets WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rows[0].count,
      0,
    );
    const resolve = async () =>
      (
        await owner.resolveCredential(
          {
            sourceRef: ref,
            tokenServiceInstanceId: instanceId,
          },
          AbortSignal.timeout(5_000),
        )
      ).credential;
    assert.equal(await resolve(), key);
    // Static custody has no renewal operation; refusal must leave the current value intact.
    await assert.rejects(
      owner.forceRefresh(
        {
          sourceRef: ref,
          tokenServiceInstanceId: instanceId,
        },
        AbortSignal.timeout(5_000),
      ),
      /static credential cannot be refreshed/i,
    );
    assert.equal(await resolve(), key);

    const updateSource = (actorId: string, input: UpdateManagedCredentialSourceInput) =>
      controller.updateManagedCredentialSource(
        actorId,
        { namespaceId, credentialSourceId: sourceId },
        input,
        (resource, phase) => event(actorId, "openclaw.credential_sources.update", resource, phase),
        (reasonCode) => ({
          ...event(actorId, "openclaw.credential_sources.update", ref),
          outcome: "failure",
          reasonCode,
        }),
      );
    const update = (actorId: string, credential: string) =>
      updateSource(actorId, { secret: { replacement: credential } });
    const sourceConfig = async () =>
      (await pool.query("SELECT config FROM occ.credential_sources WHERE id=$1", [sourceId]))
        .rows[0].config;
    await assert.rejects(
      updateSource(principal.id, { providerPreset: "unknown" as SourceProviderPresetId }),
      ScopeViolationError,
    );
    const replacementsBeforePreset = core.calls.replaceNamespacedSecret;
    const readsBeforePreset = core.reads;
    // Metadata and its attributable audit must commit together; custody is untouched.
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.update", async () => {
      await assert.rejects(
        updateSource(principal.id, { providerPreset: "openai" }),
        AuditAppendUnavailableError,
      );
    });
    assert.deepEqual(await sourceConfig(), {});
    const presetUpdate = await updateSource(principal.id, { providerPreset: "openai" });
    assert.equal(presetUpdate.type, "static");
    assert.deepEqual(presetUpdate.config, { provider_preset: "openai" });
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.equal(core.calls.replaceNamespacedSecret, replacementsBeforePreset);
    assert.equal(core.reads, readsBeforePreset);
    // A mixed approval and material change is rejected before custody changes.
    await assert.rejects(
      updateSource(principal.id, {
        secret: { replacement: randomUUID() },
        providerPreset: null,
      }),
      ResourceStateConflictError,
    );
    assert.equal(await resolve(), key);
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2",
          [sourceId, principal.id],
        )
      ).rows,
      [{ preset: "openai" }],
    );
    await updateSource(principal.id, { lifecycleConfig: { type: "static", settings: {} } });
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    const replacementKey = randomUUID();
    await updateSource(principal.id, {
      secret: { replacement: replacementKey },
      providerPreset: "openai",
    });
    assert.equal(await resolve(), replacementKey);
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });

    // Refusing the separately committed intent must stop the owner before private custody changes.
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.update.started",
      async () => {
        await assert.rejects(update(principal.id, randomUUID()), AuditAppendUnavailableError);
      },
    );
    assert.equal(await resolve(), replacementKey);

    // Even if both completion and rollback audit writes fail after custody changes, the
    // authorized source-targeted intent remains attributable in the ledger.
    const committedKey = randomUUID();
    const intentCount = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.update.started' AND resource_id=$1 AND actor_id=$2",
          [sourceId, principal.id],
        )
      ).rows[0].count as number;
    const beforeIntent = await intentCount();
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.update", async () => {
      await assert.rejects(update(principal.id, committedKey), AuditAppendUnavailableError);
    });
    assert.equal(await resolve(), committedKey);
    assert.equal(await intentCount(), beforeIntent + 1);

    const account = await inject("POST", "/api/auth/accounts", {
      name: "Source updater",
      email: `source-${randomUUID()}@example.test`,
      password: randomUUID(),
    });
    assert.equal(account.statusCode, 201, account.body);
    const memberId: string = account.json().data.principalId;
    await assert.rejects(
      updateSource(memberId, { providerPreset: null }),
      AuthorizationDeniedError,
    );
    assert.deepEqual(await sourceConfig(), { provider_preset: "openai" });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2",
          [sourceId, memberId],
        )
      ).rows[0].count,
      0,
    );
    const role = await inject("POST", `/namespaces/${namespaceId}/iam/roles`, {
      name: "Exact updater",
      permissions: [{ action: "update", resourceKind: "credential_source" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const grant = await inject("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: memberId,
      roleId: role.json().data.id,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
    assert.equal(grant.statusCode, 201, grant.body);

    await updateSource(memberId, { providerPreset: null });
    assert.deepEqual(await sourceConfig(), {});
    assert.deepEqual(
      (
        await pool.query(
          "SELECT details ? 'providerPreset' AS recorded, details->'providerPreset' AS preset FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2 AND details->'providerPreset' = 'null'::jsonb",
          [sourceId, memberId],
        )
      ).rows,
      [{ recorded: true, preset: null }],
    );

    // A member can update a Source while granted access; revocation denies later requests.
    const memberSuccessCount = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.update' AND resource_id=$1 AND actor_id=$2 AND outcome='success'",
          [sourceId, memberId],
        )
      ).rows[0].count as number;
    const successesBeforeUpdate = await memberSuccessCount();
    const updatedKey = randomUUID();
    assert.equal((await update(memberId, updatedKey)).id, sourceId);
    assert.equal(await resolve(), updatedKey);
    assert.equal(await memberSuccessCount(), successesBeforeUpdate + 1);

    const revoked = await inject(
      "DELETE",
      `/namespaces/${namespaceId}/iam/access-bindings/${grant.json().data.id}`,
    );
    assert.equal(revoked.statusCode, 204);
    await assert.rejects(update(memberId, randomUUID()), AuthorizationDeniedError);
    assert.equal(await resolve(), updatedKey);

    const valueBeforeRetirement = await resolve();
    await withRejectedAuditRows(
      migrator,
      "openclaw.credential_sources.delete.started",
      async () => {
        await assert.rejects(retire(sourceId), AuditAppendUnavailableError);
      },
    );
    assert.equal(await resolve(), valueBeforeRetirement);
    assert.equal(
      (await pool.query("SELECT state FROM occ.credential_sources WHERE id=$1", [sourceId])).rows[0]
        .state,
      "ready",
    );
    // TokenService already removed the Source, custody, and its IAM bindings when OCC's
    // completion audit fails. The separately committed retirement intent remains attributable.
    await withRejectedAuditRows(migrator, "openclaw.credential_sources.delete", async () => {
      await assert.rejects(retire(sourceId), AuditAppendUnavailableError);
    });
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.delete.started' AND resource_id=$1 AND actor_id=$2",
          [sourceId, principal.id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE action='openclaw.credential_sources.delete' AND resource_id=$1",
          [sourceId],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(retire(sourceId), ScopeViolationError);
    assert.equal(core.secrets.size, 1, "only the accepted orphan from the lost write remains");
    assert.deepEqual(await custodyRows(), [{ sources: 0, bindings: 0 }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE details::text LIKE $1",
          [`%${unknownKey}%`],
        )
      ).rows[0].count,
      0,
    );

    // This is the trusted post-exchange boundary, not a public enrollment request or a device-flow proof.
    core.addNamespace(namespaceId);
    const codexAccount = { accountId: "account-1", planType: "plus", isFedramp: false };
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const builtin = await owner.createSource(
      {
        kind: "oauth_refresh_token",
        namespaceId,
        name: "Built-in Codex account",
        consent: {
          kind: "builtin_codex",
          ownerPrincipalId: principal.id,
          account: codexAccount,
        },
        grant: {
          accessToken,
          refreshToken,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          requestedScopes: ["openid"],
          grantedScopes: ["openid"],
        },
      },
      AbortSignal.timeout(5_000),
    );
    assert.equal(builtin.type, "oauth2-refresh-token");
    const rawConsent = {
      kind: "builtin_codex",
      ownerPrincipalId: principal.id,
      requestedScopes: ["openid"],
      grantedScopes: ["openid"],
      account: codexAccount,
    };
    const persistedBuiltin = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, builtin.id),
    );
    assert.ok(
      persistedBuiltin?.ownerCapability === "token_service" &&
        persistedBuiltin.type === "oauth2-refresh-token",
    );
    assert.deepEqual(persistedBuiltin.consent, rawConsent);
    const exact = await inject("GET", `${base}/${builtin.id}`);
    assert.equal(exact.statusCode, 200, exact.body);
    assert.deepEqual(exact.json().data.consent, { ...rawConsent, ...BUILTIN_CODEX_OAUTH_PRESET });
    const list = await inject("GET", base);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      list.json().data.find((entry: { id: string }) => entry.id === builtin.id)?.consent,
      exact.json().data.consent,
    );
    assert.equal(Object.hasOwn(exact.json().data, "connectionTemplateId"), false);
    assert.equal(exact.body.includes(accessToken) || exact.body.includes(refreshToken), false);
    const resolved = await owner.resolveCredential(
      {
        sourceRef: { kind: "credential_source", namespaceId, id: builtin.id },
        tokenServiceInstanceId: instanceId,
      },
      AbortSignal.timeout(5_000),
    );
    assert.equal(resolved.credential, accessToken);
    assert.equal(resolved.accountId, codexAccount.accountId);
    assert.equal(resolved.isFedramp, codexAccount.isFedramp);
    const directEnrollment = await inject("POST", base, {
      name: "Caller-selected Codex account",
      type: "oauth2-refresh-token",
      consent: { kind: "builtin_codex", account: codexAccount },
    });
    assert.equal(directEnrollment.statusCode, 400, directEnrollment.body);

    const template = await inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "OAuth authorization",
      mode: "manual",
      issuer: "https://issuer.example.test",
      authorizationUrl: "https://issuer.example.test/authorize",
      tokenUrl: "https://issuer.example.test/token",
      scopes: [],
      destinations: [{ host: "api.example.test", port: 443, path: "/**" }],
    });
    assert.equal(template.statusCode, 201, template.body);
    const templateId: string = template.json().data.id;
    const insertInvalid = (templateId: string | null, invalidAccount: object) =>
      pool.query(
        `INSERT INTO occ.credential_sources
           (id,namespace_id,name,type,config,state,created_at,owner_capability,token_service_instance_id,
            connection_template_id,oauth_provenance,oauth_account,oauth_owner_principal_id,oauth_requested_scopes,oauth_granted_scopes)
         SELECT $2,namespace_id,$3,type,config,state,created_at,owner_capability,token_service_instance_id,
                $4,oauth_provenance,$5::jsonb,oauth_owner_principal_id,oauth_requested_scopes,oauth_granted_scopes
         FROM occ.credential_sources WHERE id=$1`,
        [
          builtin.id,
          `cs_${randomUUID()}`,
          randomUUID(),
          templateId,
          JSON.stringify(invalidAccount),
        ],
      );
    // Persisted provenance cannot combine the built-in preset with a Template or smuggle fields into account metadata.
    await assert.rejects(insertInvalid(templateId, codexAccount), { code: "23514" });
    for (const extra of [{ arbitrary: "value" }, { accessToken }, { refreshToken }]) {
      await assert.rejects(insertInvalid(null, { ...codexAccount, ...extra }), {
        code: "23514",
        constraint: "credential_sources_oauth_shape",
      });
    }
    assert.equal((await inject("DELETE", `${base}/${builtin.id}`)).statusCode, 204);
    assert.equal((await inject("DELETE", `/connection-templates/${templateId}`)).statusCode, 204);
  },
);
