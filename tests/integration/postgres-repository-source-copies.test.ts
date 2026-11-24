import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createRepositorySourceCustody } from "../../apps/controller/src/backends/repository-credentials/source-custody.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { GIT_REVISION } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { openShellSourceGitProviderPrefix } from "../../apps/controller/src/drivers/egress-proxy/openshell-repository-git-evidence.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type {
  Agent,
  AuditEvent,
  CredentialSourceReference,
} from "../../packages/contracts/src/index.ts";
import { createAgentCredentialAccess } from "../../packages/occ/src/agent-credential-access.ts";
import {
  RepositorySourceCopiesUnretiredError,
  ResourceConflictError,
  PostgresPlatformState,
  ScopeViolationError,
  type UpdateManagedCredentialSourceInput,
} from "../../packages/occ/src/index.ts";
import { seedSessionRevision } from "../conformance/repository-sessions.contract.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";

// The repository token Source copy record (migration 0093) on real PostgreSQL: deployment
// records a copy, the Worker completes and retires it with read-back, and Source deletion
// answers 409 while any copy is not confirmed retired. The deploy-time write itself is pinned in
// tests/integration/repository-credentials-deployment-admission-cases.ts; the Worker's Gateway
// reactions in tests/conformance/repository-source-copy-retirement.test.ts.

// Fake values are built from parts so that no scanner reads them as tokens.
const fineGrained = () =>
  ["github", "pat", `fixture${randomUUID().slice(0, 8)}`.padEnd(30, "x")].join("_");

const OWNER = "openclaw.dev/prepared-git-binding";

// The ceiling is passed through to the Source service (the HTTP route does the same).
const sourceInput = (repositoryCeiling: string) => {
  const input = {
    name: "Repository token",
    lifecycleConfig: { type: "static", settings: {} },
    secret: { token: fineGrained() },
    providerPreset: "github",
    repositoryCeiling,
  };
  return input;
};

/** A Workspace's prepared Git Providers as OpenShell lists them; a Sandbox blocks deletion. */
function gateway() {
  const providers = new Map<string, OpenShellProviderResponse>();
  const attached = new Set<string>();
  const state = { down: false };
  const reach = () => {
    if (state.down) {
      throw Object.assign(new Error("Gateway unavailable"), { code: 14 });
    }
  };
  const client = {
    listProviders: async () => {
      reach();
      return Array.from(providers.values());
    },
    deleteProvider: async (_workspace: string, name: string) => {
      reach();
      if (attached.has(name)) {
        throw new Error("FAILED_PRECONDITION: a Sandbox still attaches the provider");
      }
      providers.delete(name);
    },
    getProviderProfile: async () => undefined,
    listProviderProfiles: async () => [],
    deleteProviderProfile: async () => {},
  };
  const prepare = (revisionId: string) => {
    const owner = createHash("sha256").update(revisionId).digest("hex").slice(0, 48);
    const name = openShellSourceGitProviderPrefix + owner.slice(0, 32);
    providers.set(name, {
      name,
      type: name,
      labels: { [OWNER]: owner, [GIT_REVISION]: revisionId },
      config: {},
      resourceVersion: "1",
    });
    return name;
  };
  return {
    client: client as unknown as OpenShellGatewayClient,
    providers,
    attached,
    prepare,
    state,
  };
}

/** The Worker's retirement against the real route store; no listener, no delivery. */
function worker(store: PostgresOpenShellGitRouteStore) {
  const git = new OpenShellGitRuntime(
    {
      registrationName: "oce-prepared-git",
      authority: {
        host: "127.0.0.1",
        port: 0,
        certificatePath: "",
        privateKeyPath: "",
        issuerPublicKeyPath: "",
        issuer: "test-issuer",
        audience: "test-audience",
        keyId: "test-key",
      },
    },
    (() => {
      throw new Error("No delivery is resolved to retire a copy.");
    }) as never,
  );
  git["routes"] = store;
  return git;
}

test(
  "a Source cannot be deleted until the Worker confirms each recorded copy retired, across restarts",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "repository-source-copies",
      authSecret: "repository-source-copies-session-secret",
      requestAudit: false,
      controllerOptions: { iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()) },
    });
    await controller.applyIAMConfiguration();
    // PostgreSQL, Native IAM and TokenService are real; only the Kubernetes API is simulated.
    const { driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const ownerId = "repository-source-copies";
    const instanceId = await controller.activateTokenServiceInstance(ownerId, randomUUID());
    const owner = new OCCTokenServiceDriver(
      ownerId,
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);
    const created = await inject("POST", "/namespaces", { name: `Copies ${randomUUID()}` });
    assert.equal(created.statusCode, 201, created.body);
    const namespaceId: string = created.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const namespaceName = (
      await pool.query("SELECT name FROM occ.namespaces WHERE id=$1", [namespaceId])
    ).rows[0]?.name as string;
    const event = (action: string, ref: CredentialSourceReference, phase?: string): AuditEvent => ({
      ...auditEvent(
        controller.installation.id,
        namespaceId,
        principal.id,
        phase ? `${action}.started` : action,
        ref,
      ),
      ...(phase ? { details: { phase } } : {}),
    });
    const source = await controller.createManagedCredentialSource(
      principal.id,
      namespaceId,
      sourceInput("fixture/a:write"),
      (ref, phase) => event("openclaw.credential_sources.create", ref, phase),
    );
    const retire = () =>
      controller.deleteCredentialSource(principal.id, namespaceId, source.id, (_removed, phase) =>
        event(
          "openclaw.credential_sources.delete",
          { kind: "credential_source", namespaceId, id: source.id },
          phase,
        ),
      );
    const copy = (revisionId: string) => ({
      namespaceId,
      credentialSourceId: source.id,
      tokenServiceInstanceId: instanceId,
      // No Agent row: the revision's Agent was deleted, which the record outlives.
      agentId: `agent-${revisionId}`,
      revisionId,
    });
    const row = async (revisionId: string) =>
      (
        await pool.query(
          `SELECT provider_name,source_version,installed_at IS NOT NULL AS installed,
             retirement_blocked,retired_at IS NOT NULL AS retired
           FROM occ.repository_source_copies WHERE revision_id=$1`,
          [revisionId],
        )
      ).rows[0];

    // Deployment recorded two copies of the Source; neither is installed yet, as for a pending
    // deployment, and each already counts. This controller's registry does not name the
    // Source: the operator removed its entry and restarted, as the refusal message asks.
    const first = `rev-${randomUUID()}`;
    const second = `rev-${randomUUID()}`;
    await state.transact(async (unit) => {
      await unit.credentialSources.recordRepositorySourceCopy(copy(first));
      await unit.credentialSources.recordRepositorySourceCopy(copy(second));
    });
    // One copy per revision.
    await assert.rejects(
      state.transact((unit) => unit.credentialSources.recordRepositorySourceCopy(copy(first))),
      ResourceConflictError,
    );
    await assert.rejects(retire(), RepositorySourceCopiesUnretiredError);
    // The caller may read the (deleted) Agent, so the answer names the oldest copy.
    await assert.rejects(retire(), {
      message: `2 Source copies unretired (unretired_repository_source_copy): agent-${first}/${first} +1. Stop or redeploy its Agents without it; the Worker retries every few minutes.`,
    });
    // The refusal changed nothing: the Source is still ready and keeps its value.
    assert.equal(
      (
        await state.read((view) =>
          view.credentialSources.findCredentialSource(namespaceId, source.id),
        )
      )?.state,
      "ready",
    );

    // The Worker completes a copy at installation; a retired copy can never be completed again.
    const store = new PostgresOpenShellGitRouteStore(pool);
    const version = randomUUID();
    assert.equal(await store.recordSourceCopyInstalled(first, "oce-github-token-x", version), true);
    assert.deepEqual(await row(first), {
      provider_name: "oce-github-token-x",
      source_version: version,
      installed: true,
      retirement_blocked: null,
      retired: false,
    });

    // The first copy's Sandbox still attaches its Provider; the second's Gateway is the same.
    const g = gateway();
    const firstProvider = g.prepare(first);
    g.prepare(second);
    g.attached.add(firstProvider);
    const git = worker(store);
    // An unreachable Gateway proves nothing: the copy stays unretired with the reason.
    g.state.down = true;
    assert.equal(
      await git.retireSourceCopy(first, g.client, namespaceName, AbortSignal.timeout(5_000)),
      "gateway_unavailable",
    );
    assert.equal((await row(first))?.retirement_blocked, "gateway_unavailable");
    assert.equal((await row(first))?.retired, false);
    g.state.down = false;
    assert.equal(
      await git.retireSourceCopy(first, g.client, namespaceName, AbortSignal.timeout(5_000)),
      "provider_present",
    );
    assert.equal((await row(first))?.retirement_blocked, "provider_present");
    // The answer carries the reason the Worker recorded; never the Provider name.
    await assert.rejects(retire(), (error: Error) => {
      assert.match(
        error.message,
        new RegExp(`^2 Source copies unretired .*/${first} \\(provider_present\\) \\+1\\. `),
      );
      assert.doesNotMatch(error.message, /oce-github-token/);
      return true;
    });

    // A Worker stopped during retirement: it deleted the second Provider but recorded nothing.
    g.providers.delete(
      Array.from(g.providers.values()).find(({ labels }) => labels[GIT_REVISION] === second)!.name,
    );
    assert.equal((await row(second))?.retired, false);
    // Restarted, it reads the record (not the registry): both copies are idle (no Agent, no work).
    const idle = await store.idleSourceCopies();
    assert.deepEqual(
      idle
        .filter(({ credentialSourceId }) => credentialSourceId === source.id)
        .map(({ revisionId, namespaceName: name }) => [revisionId, name])
        .sort(),
      [
        [first, namespaceName],
        [second, namespaceName],
      ].sort(),
    );
    await git.retireIdleSourceCopies(() => g.client, AbortSignal.timeout(5_000));
    assert.equal((await row(second))?.retired, true);
    assert.equal((await row(first))?.retired, false, "an attached Provider keeps its copy");
    await assert.rejects(
      retire(),
      /: 1 Source copy unretired .* \(provider_present\)\. Stop or redeploy its Agent /,
    );

    // Once the Sandbox is gone, the next pass retires the last copy and deletion proceeds.
    g.attached.delete(firstProvider);
    await git.retireIdleSourceCopies(() => g.client, AbortSignal.timeout(5_000));
    assert.deepEqual(await row(first), {
      provider_name: "oce-github-token-x",
      source_version: version,
      installed: true,
      retirement_blocked: null,
      retired: true,
    });
    await retire();
    assert.equal(
      await state.read((view) =>
        view.credentialSources.findCredentialSource(namespaceId, source.id),
      ),
      undefined,
    );
    // The copies went with the Source row.
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM occ.repository_source_copies WHERE credential_source_id=$1",
          [source.id],
        )
      ).rows[0]?.n,
      0,
    );
  },
);

test(
  "the copy record keeps its identity and its retirement final for the application role",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
      label: "repository-source-copy-rules",
      authSecret: "repository-source-copy-rules-session-secret",
      requestAudit: false,
      controllerOptions: { iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()) },
    });
    await controller.applyIAMConfiguration();
    const { driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const instanceId = await controller.activateTokenServiceInstance("copy-rules", randomUUID());
    const owner = new OCCTokenServiceDriver(
      "copy-rules",
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);
    const created = await inject("POST", "/namespaces", { name: `Copy rules ${randomUUID()}` });
    assert.equal(created.statusCode, 201, created.body);
    const namespaceId: string = created.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const source = await controller.createManagedCredentialSource(
      principal.id,
      namespaceId,
      sourceInput("fixture/a:read"),
      (ref, phase) => ({
        ...auditEvent(
          controller.installation.id,
          namespaceId,
          principal.id,
          phase
            ? "openclaw.credential_sources.create.started"
            : "openclaw.credential_sources.create",
          ref,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
    const revisionId = `rev-${randomUUID()}`;
    await state.transact((unit) =>
      unit.credentialSources.recordRepositorySourceCopy({
        namespaceId,
        credentialSourceId: source.id,
        tokenServiceInstanceId: instanceId,
        agentId: "agent-a",
        revisionId,
      }),
    );
    // A copy of a Source that is not in its Namespace is refused by the foreign key.
    await assert.rejects(
      state.transact((unit) =>
        unit.credentialSources.recordRepositorySourceCopy({
          namespaceId,
          credentialSourceId: "cs_missing",
          tokenServiceInstanceId: instanceId,
          agentId: "agent-a",
          revisionId: `rev-${randomUUID()}`,
        }),
      ),
      ScopeViolationError,
    );
    // The application role cannot move a copy to another Source, Namespace or revision.
    await assert.rejects(
      pool.query(
        "UPDATE occ.repository_source_copies SET credential_source_id='cs_other' WHERE revision_id=$1",
        [revisionId],
      ),
      /permission denied/,
    );
    await assert.rejects(
      pool.query("DELETE FROM occ.repository_source_copies WHERE revision_id=$1", [revisionId]),
      /permission denied/,
    );
    // Half an installation record and a retired copy with a blocked reason are refused.
    await assert.rejects(
      pool.query(
        "UPDATE occ.repository_source_copies SET provider_name='oce-github-token-x' WHERE revision_id=$1",
        [revisionId],
      ),
      /repository_source_copies_installed_check/,
    );
    const store = new PostgresOpenShellGitRouteStore(pool);
    assert.equal(await store.retainSourceCopy(revisionId, "gateway_unavailable"), true);
    assert.equal(await store.retireSourceCopy(revisionId), true);
    // Retirement is final: no later write reopens or completes the copy.
    assert.equal(await store.retireSourceCopy(revisionId), false);
    assert.equal(await store.retainSourceCopy(revisionId, "provider_present"), false);
    assert.equal(
      await store.recordSourceCopyInstalled(revisionId, "oce-github-token-x", "v"),
      false,
    );
    await assert.rejects(
      pool.query("UPDATE occ.repository_source_copies SET retired_at=NULL WHERE revision_id=$1", [
        revisionId,
      ]),
      /retired repository Source copy is final/,
    );
    assert.deepEqual(
      await state.transact((unit) =>
        unit.credentialSources.findUnretiredRepositorySourceCopies(namespaceId, source.id),
      ),
      [],
    );
    // With its only copy retired, the Source can be deleted (and the next case's TokenService
    // instance can replace this one).
    await controller.deleteCredentialSource(
      principal.id,
      namespaceId,
      source.id,
      (_removed, phase) => ({
        ...auditEvent(
          controller.installation.id,
          namespaceId,
          principal.id,
          phase
            ? "openclaw.credential_sources.delete.started"
            : "openclaw.credential_sources.delete",
          { kind: "credential_source", namespaceId, id: source.id },
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
  },
);

test(
  "the Worker's idle rule skips a copy with queued or claimed work or a running active revision, and retires a stopped Agent's",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const pool = testPool(t, { connectionString: databaseUrl, max: 4 });
    const state = new PostgresPlatformState(pool);
    const store = new PostgresOpenShellGitRouteStore(pool);
    /** A seeded Agent with one revision whose copy of a Source in its Namespace is recorded. */
    const seeded = async () => {
      const { namespace, agent, revision } = await seedSessionRevision(state);
      const sourceId = `cs_${randomUUID()}`;
      await state.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource({
          id: sourceId,
          namespaceId: namespace.id,
          name: `repository-token-${randomUUID().slice(0, 8)}`,
          type: "registry",
          config: { host: "registry.example.com" },
          secrets: {},
          ownerCapability: "credential_gateway",
          driverId: "credential-gateway-test",
          state: "ready",
          createdAt: "2030-03-17T17:46:40.000Z",
        });
        await unit.credentialSources.recordRepositorySourceCopy({
          namespaceId: namespace.id,
          credentialSourceId: sourceId,
          tokenServiceInstanceId: "tsi-idle-rule",
          agentId: agent.id,
          revisionId: revision.id,
        });
      });
      const work = () =>
        state.transact((unit) =>
          unit.operations.append({
            kind: "agent_revision",
            action: "reconcile",
            namespaceId: namespace.id,
            resourceId: revision.id,
            actorId: revision.servicePrincipalId,
          }),
        );
      const desired = (from: "running" | "stopped", to: "running" | "stopped") =>
        state.transact((unit) =>
          unit.agents.transitionAgentDesiredRuntimeState(namespace.id, agent.id, from, to),
        );
      const activate = () =>
        state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
        );
      return { revisionId: revision.id, work, desired, activate };
    };
    const setWork = (revisionId: string, set: string) =>
      pool.query(`UPDATE occ.controller_work SET ${set} WHERE revision_id=$1 AND state='queued'`, [
        revisionId,
      ]);
    // The work clause alone keeps these two: each Agent is stopped and runs no revision.
    const queued = await seeded();
    await queued.work();
    await queued.desired("running", "stopped");
    const claimed = await seeded();
    await claimed.work();
    await claimed.desired("running", "stopped");
    assert.equal(
      (
        await setWork(
          claimed.revisionId,
          `state='claimed',claim_token='${randomUUID()}',attempt_count=1,
           lease_expires_at=clock_timestamp()+interval '1 minute'`,
        )
      ).rowCount,
      1,
    );
    // The active-revision clause alone keeps this one: no work, the Agent runs the revision.
    const running = await seeded();
    assert.ok(await running.activate());
    // Idle: the same, but the Agent is stopped and its finished work no longer counts.
    const stopped = await seeded();
    assert.ok(await stopped.activate());
    await stopped.work();
    assert.equal(
      (
        await setWork(
          stopped.revisionId,
          "state='succeeded',completed_at=clock_timestamp(),reason_code='DEPLOYED'",
        )
      ).rowCount,
      1,
    );
    await stopped.desired("running", "stopped");
    // Idle as well: no work, and the Agent does not run this revision (no active revision, as
    // after a deployment that never became active).
    const replaced = await seeded();
    const ours = new Set(
      [queued, claimed, running, stopped, replaced].map(({ revisionId }) => revisionId),
    );

    const idle = (await store.idleSourceCopies())
      .map(({ revisionId }) => revisionId)
      .filter((revisionId) => ours.has(revisionId));
    assert.deepEqual(new Set(idle), new Set([stopped.revisionId, replaced.revisionId]));

    // The pass retires only those: the Gateway lists no Provider for any revision.
    const g = gateway();
    await worker(store).retireIdleSourceCopies(() => g.client, AbortSignal.timeout(5_000));
    const rows = (
      await pool.query(
        `SELECT revision_id,retired_at IS NOT NULL AS retired,retirement_attempted_at IS NOT NULL AS attempted
         FROM occ.repository_source_copies WHERE revision_id = ANY($1)`,
        [[...ours]],
      )
    ).rows as { revision_id: string; retired: boolean; attempted: boolean }[];
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.revision_id, [row.retired, row.attempted]])),
      {
        [queued.revisionId]: [false, false],
        [claimed.revisionId]: [false, false],
        [running.revisionId]: [false, false],
        [stopped.revisionId]: [true, true],
        [replaced.revisionId]: [true, true],
      },
    );
  },
);

/** A ready Namespace with one managed repository token Source, its DELETE and its copy input. */
async function managedSource(t: TestContext, label: string, repeatableRead = false) {
  assert.ok(databaseUrl);
  // A controller whose connections default to repeatable read: a lock wait alone must not leave
  // a transaction with a snapshot taken before the wait.
  const transport = new URL(databaseUrl);
  if (repeatableRead) {
    const prior = transport.searchParams.get("options");
    transport.searchParams.set(
      "options",
      [prior, "-c default_transaction_isolation=repeatable\\ read"].filter(Boolean).join(" "),
    );
  }
  const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
    label,
    authSecret: `${label}-session-secret`,
    requestAudit: false,
    controllerOptions: { iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()) },
    ...(repeatableRead && { transportDatabaseUrl: transport.toString() }),
  });
  await controller.applyIAMConfiguration();
  const { driver } = useInstallationSecretDriver(controller);
  assert.ok(driver.installationSecrets);
  const instanceId = await controller.activateTokenServiceInstance(label, randomUUID());
  const owner = new OCCTokenServiceDriver(
    label,
    controller.installation.id,
    driver.installationSecrets,
    instanceId,
    state,
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  const created = await inject("POST", "/namespaces", { name: `${label} ${randomUUID()}` });
  assert.equal(created.statusCode, 201, created.body);
  const namespaceId: string = created.json().data.id;
  await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
  const event = (action: string, ref: CredentialSourceReference, phase?: string): AuditEvent => ({
    ...auditEvent(
      controller.installation.id,
      namespaceId,
      principal.id,
      phase ? `${action}.started` : action,
      ref,
    ),
    ...(phase ? { details: { phase } } : {}),
  });
  const source = await controller.createManagedCredentialSource(
    principal.id,
    namespaceId,
    sourceInput("fixture/a:write"),
    (ref, phase) => event("openclaw.credential_sources.create", ref, phase),
  );
  const retire = () =>
    controller.deleteCredentialSource(principal.id, namespaceId, source.id, (_removed, phase) =>
      event(
        "openclaw.credential_sources.delete",
        { kind: "credential_source", namespaceId, id: source.id },
        phase,
      ),
    );
  const copy = (revisionId: string) => ({
    namespaceId,
    credentialSourceId: source.id,
    tokenServiceInstanceId: instanceId,
    agentId: `agent-${revisionId}`,
    revisionId,
  });
  const update = (input: UpdateManagedCredentialSourceInput) =>
    controller.updateManagedCredentialSource(
      principal.id,
      { namespaceId, credentialSourceId: source.id },
      input,
      (ref, phase) => event("openclaw.credential_sources.update", ref, phase),
      (reasonCode) => ({
        ...event("openclaw.credential_sources.update", {
          kind: "credential_source",
          namespaceId,
          id: source.id,
        }),
        outcome: "failure",
        reasonCode,
      }),
    );
  // A Worker's Source custody on its own lock pool, as a fresh Worker process builds it.
  const custody = () => {
    assert.ok(databaseUrl);
    const lockPool = testPool(t, { connectionString: databaseUrl, max: 4 });
    lockPool.on("error", () => {});
    return createRepositorySourceCustody({
      lockPool,
      state,
      tokenServiceDriverId: owner.id,
      tokenService: () => owner,
      iam: { authorize: async () => ({ allowed: true }) as never },
    });
  };
  const namespaceName = (
    await pool.query("SELECT name FROM occ.namespaces WHERE id=$1", [namespaceId])
  ).rows[0]?.name as string;
  return {
    pool,
    state,
    owner,
    instanceId,
    namespaceId,
    namespaceName,
    source,
    retire,
    copy,
    update,
    custody,
  };
}

test(
  "a deploy's copy and Source DELETE serialize on the Source row: whichever commits first, the other sees it",
  requiresPostgres,
  async (t) => {
    const f = await managedSource(t, "repository-source-copy-race");
    const revisionId = `rev-${randomUUID()}`;
    // The deploy's side as admission takes it: the Namespace row, then the Source row, then the
    // copy, all in one transaction that stays open until `commit` is called.
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    let locked!: () => void;
    const lockedSource = new Promise<void>((resolve) => (locked = resolve));
    const deploy = f.state.transact(async (unit) => {
      assert.ok(await unit.namespaces.lockNamespace(f.namespaceId));
      const source = await unit.credentialSources.lockCredentialSource(f.namespaceId, f.source.id);
      assert.equal(source?.state, "ready");
      await unit.credentialSources.recordRepositorySourceCopy(f.copy(revisionId));
      locked();
      await committing;
    });
    await lockedSource;
    // DELETE waits behind the open deploy transaction, then reads the committed copy.
    let settled = false;
    const deleting = f.retire().finally(() => (settled = true));
    deleting.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(settled, false, "DELETE waits for the deploy's row locks");
    commit();
    await deploy;
    await assert.rejects(deleting, RepositorySourceCopiesUnretiredError);
    assert.equal(
      (
        await f.state.read((view) =>
          view.credentialSources.findCredentialSource(f.namespaceId, f.source.id),
        )
      )?.state,
      "ready",
    );

    // DELETE first: once the copy is retired it commits, and the next deploy finds no ready
    // Source to record a copy for.
    assert.equal(
      await new PostgresOpenShellGitRouteStore(f.pool).retireSourceCopy(revisionId),
      true,
    );
    await f.retire();
    await assert.rejects(
      f.state.transact(async (unit) => {
        assert.ok(await unit.namespaces.lockNamespace(f.namespaceId));
        assert.equal(
          await unit.credentialSources.lockCredentialSource(f.namespaceId, f.source.id),
          undefined,
        );
        await unit.credentialSources.recordRepositorySourceCopy(f.copy(`rev-${randomUUID()}`));
      }),
      ScopeViolationError,
    );
  },
);

/** Whether a promise settles within `ms`, without consuming its rejection. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

test(
  "an unknown Provider write fences Source replacement and deletion until the Worker retires its copy, across restarts",
  requiresPostgres,
  async (t) => {
    const f = await managedSource(t, "repository-source-write-fence");
    const ref = { namespaceId: f.namespaceId, sourceId: f.source.id };
    const row = async (revisionId: string) =>
      (
        await f.pool.query(
          `SELECT unknown_write_version, confirmed_source_version, retired_at IS NOT NULL AS retired
           FROM occ.repository_source_copies WHERE revision_id=$1`,
          [revisionId],
        )
      ).rows[0] as
        | { unknown_write_version: string | null; confirmed_source_version: string | null }
        | undefined;
    const lost = `rev-${randomUUID()}`;
    const live = `rev-${randomUUID()}`;
    await f.state.transact(async (unit) => {
      await unit.credentialSources.recordRepositorySourceCopy(f.copy(lost));
      await unit.credentialSources.recordRepositorySourceCopy(f.copy(live));
    });

    // The Worker records the write under its hold, then its answer is lost: the hold ends with
    // the write unsettled.
    const worker1 = f.custody();
    const lent = await worker1.lock(ref);
    assert.ok(lent?.source);
    assert.equal(await lent.recorded(lost), true);
    const { version } = await worker1.resolve(ref, lent.source);
    assert.ok(version);
    assert.equal(await lent.write(lost, version).dispatching(), true);
    await lent.hold.release();
    assert.equal((await row(lost))?.unknown_write_version, version);

    const fenced = {
      name: "RepositorySourceWriteUnreconciledError",
      message: `1 Provider write is unreconciled (unreconciled_repository_source_write): agent-${lost}/${lost}. Stop or redeploy its Agent; the Worker then confirms the Provider retired.`,
    };
    await assert.rejects(f.update({ secret: { token: fineGrained() } }), fenced);
    await assert.rejects(f.retire(), fenced);
    // Metadata and the ceiling change no Provider value: not refused.
    await f.update({
      providerPreset: "github",
      repositoryCeiling: "fixture/a:write,fixture/b:read",
    });

    // A Worker whose hold ended records nothing, so it sends nothing.
    assert.equal(await lent.write(live, version).dispatching(), false);
    assert.equal((await row(live))?.unknown_write_version, null);

    // A restarted Worker reads the same record. While the Sandbox still attaches the Provider
    // the copy stays, and so does the fence; once the Provider is read back gone it is retired
    // and the unknown write cleared in the same update.
    const g = gateway();
    const provider = g.prepare(lost);
    g.attached.add(provider);
    const restarted = worker(new PostgresOpenShellGitRouteStore(f.pool));
    assert.equal(
      await restarted.retireSourceCopy(lost, g.client, f.namespaceName, AbortSignal.timeout(5_000)),
      "provider_present",
    );
    assert.equal((await row(lost))?.unknown_write_version, version, "no clear on a guess");
    await assert.rejects(f.update({ secret: { token: fineGrained() } }), fenced);
    g.attached.delete(provider);
    assert.equal(
      await restarted.retireSourceCopy(lost, g.client, f.namespaceName, AbortSignal.timeout(5_000)),
      "retired",
    );
    assert.deepEqual(await row(lost), {
      unknown_write_version: null,
      confirmed_source_version: null,
      retired: true,
    });
    await f.update({ secret: { token: fineGrained() } });

    // An ordinary write on two sessions: a replacement started during it waits on the Source
    // row, and the write is settled before the hold ends, so the replacement never sees it.
    const worker2 = f.custody();
    const writing = await worker2.lock(ref);
    assert.ok(writing?.source);
    const current = (await worker2.resolve(ref, writing.source)).version;
    assert.ok(current);
    const replacing = f.update({ secret: { token: fineGrained() } });
    assert.equal(await settlesWithin(replacing, 750), false, "replacement waits for the hold");
    const write = writing.write(live, current);
    assert.equal(await write.dispatching(), true, "the record does not wait on the replacement");
    await write.settled("applied");
    await writing.hold.release();
    await replacing;
    // Settling clears the record of the write; the Gateway accepting it is not delivery, so no
    // confirmed version is written here.
    assert.deepEqual(await row(live), {
      unknown_write_version: null,
      confirmed_source_version: null,
      retired: false,
    });

    // The same write left unsettled when the hold ends: the waiting replacement then reads it.
    const unsettled = await worker2.lock(ref);
    assert.ok(unsettled?.source);
    const next = (await worker2.resolve(ref, unsettled.source)).version;
    assert.ok(next && next !== current, "the Worker sees the committed replacement");
    const blocked = f.update({ secret: { token: fineGrained() } });
    const deleting = f.retire();
    deleting.catch(() => {});
    assert.equal(await settlesWithin(blocked, 750), false);
    assert.equal(await unsettled.write(live, next).dispatching(), true);
    await unsettled.hold.release();
    const fencedLive = {
      ...fenced,
      message: `1 Provider write is unreconciled (unreconciled_repository_source_write): agent-${live}/${live}. Stop or redeploy its Agent; the Worker then confirms the Provider retired.`,
    };
    await assert.rejects(blocked, fencedLive);
    await assert.rejects(deleting, fencedLive);

    // A write proven unapplied clears only its own record.
    const refused = await worker2.lock(ref);
    assert.ok(refused?.source);
    const proof = refused.write(live, next);
    assert.equal(await proof.dispatching(), true);
    await proof.settled("unapplied");
    await refused.hold.release();
    assert.equal((await row(live))?.unknown_write_version, next, "an earlier unknown write stays");
    await assert.rejects(f.update({ secret: { token: fineGrained() } }), fencedLive);

    // Reconciled by retirement, the Source is replaced and then deleted.
    g.prepare(live);
    assert.equal(
      await restarted.retireSourceCopy(live, g.client, f.namespaceName, AbortSignal.timeout(5_000)),
      "retired",
    );
    await f.update({ secret: { token: fineGrained() } });
    await f.retire();
  },
);

test(
  "the policy read's delivery state comes from the copy record alone: pending until the Sandbox activates the committed version",
  requiresPostgres,
  async (t) => {
    const f = await managedSource(t, "repository-source-delivery-state");
    const ref = { namespaceId: f.namespaceId, sourceId: f.source.id };
    const routes = new PostgresOpenShellGitRouteStore(f.pool);
    const revisionId = `rev-${randomUUID()}`;
    await f.state.transact((unit) =>
      unit.credentialSources.recordRepositorySourceCopy(f.copy(revisionId)),
    );
    // Only the read and its record lookups are under test: every caller may read the Source.
    const access = createAgentCredentialAccess({
      authority: { authorizationDecision: async () => ({ decision: { allowed: true } }) },
      requireTokenServiceOwner: () => {},
    } as unknown as Parameters<typeof createAgentCredentialAccess>[0]);
    const resolve = t.mock.method(f.owner, "resolveCredential");
    const agent = { id: `agent-${revisionId}`, namespaceId: f.namespaceId } as Agent;
    const delivery = async () => {
      const calls = resolve.mock.callCount();
      const view = await f.state.read((state) =>
        access.readRepositoryCredentialSource(state, "reader", agent, f.source.id, [], []),
      );
      assert.equal(resolve.mock.callCount(), calls, "the read makes no TokenService call");
      assert.ok("deliveries" in view);
      assert.equal(view.deliveries.length, 1);
      return view.deliveries[0]!;
    };
    // The Worker's write of the Source's current value, accepted by the Gateway and installed.
    const write = async () => {
      const worker = f.custody();
      const lent = await worker.lock(ref);
      assert.ok(lent?.source);
      assert.equal(await lent.recorded(revisionId), true);
      const { version } = await worker.resolve(ref, lent.source);
      assert.ok(version);
      const written = lent.write(revisionId, version);
      assert.equal(await written.dispatching(), true);
      await written.settled("applied");
      await lent.hold.release();
      assert.equal(await routes.recordSourceCopyInstalled(revisionId, "provider-a", version), true);
      return version;
    };
    const committed = async () => {
      const [copy] = (
        await f.pool.query(
          "SELECT expected_source_version FROM occ.repository_source_copies WHERE revision_id=$1",
          [revisionId],
        )
      ).rows as { expected_source_version: string | null }[];
      return copy?.expected_source_version;
    };

    assert.deepEqual(await delivery(), { revisionId, state: "pending" });
    // The Gateway accepted the first value; the Sandbox has not activated it.
    const first = await write();
    assert.deepEqual(await delivery(), { revisionId, state: "pending" });
    // No replacement committed since the copy was recorded: its first activation is delivery.
    assert.equal(await routes.recordSourceCopyConfirmed(revisionId, first), true);
    const initial = await delivery();
    assert.equal(initial.state, "confirmed");
    assert.equal(initial.confirmedSourceVersion, first);
    assert.equal(initial.committedSourceVersion, undefined);

    // A replacement commits: the copy expects its version and is pending again.
    await f.update({ secret: { token: fineGrained() } });
    const replaced = await committed();
    assert.ok(replaced && replaced !== first);
    const expected = await delivery();
    assert.equal(expected.state, "pending");
    assert.equal(expected.committedSourceVersion, replaced);
    assert.equal(expected.confirmedSourceVersion, first);
    assert.equal(await write(), replaced);
    assert.equal((await delivery()).state, "pending", "accepted by the Gateway is not delivered");

    // A second replacement commits before the Sandbox activates the first: activating the older
    // version never reads confirmed.
    await f.update({ secret: { token: fineGrained() } });
    const latest = await committed();
    assert.ok(latest && latest !== replaced);
    assert.equal(await routes.recordSourceCopyConfirmed(revisionId, replaced), true);
    const older = await delivery();
    assert.equal(older.state, "pending");
    assert.equal(older.committedSourceVersion, latest);
    assert.equal(older.confirmedSourceVersion, replaced);

    // The latest written and activated: confirmed, with both times. An older version's
    // activation can no longer be recorded over it.
    assert.equal(await write(), latest);
    assert.equal(await routes.recordSourceCopyConfirmed(revisionId, latest), true);
    assert.equal(await routes.recordSourceCopyConfirmed(revisionId, replaced), false);
    const confirmed = await delivery();
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.committedSourceVersion, latest);
    assert.equal(confirmed.confirmedSourceVersion, latest);
    assert.ok(confirmed.committedAt && confirmed.confirmedAt);
    assert.ok(Date.parse(confirmed.committedAt) <= Date.parse(confirmed.confirmedAt));

    // A write whose outcome is unknown: unreconciled, whatever was confirmed before.
    const holder = f.custody();
    const lent = await holder.lock(ref);
    assert.ok(lent?.source);
    assert.equal(await lent.recorded(revisionId), true);
    const { version } = await holder.resolve(ref, lent.source);
    assert.equal(await lent.write(revisionId, version).dispatching(), true);
    await lent.hold.release();
    assert.equal((await delivery()).state, "unreconciled");

    // Retired once its Provider reads back gone: no delivery is listed, and a late activation
    // cannot bring the copy back.
    const g = gateway();
    g.prepare(revisionId);
    assert.equal(
      await worker(routes).retireSourceCopy(
        revisionId,
        g.client,
        f.namespaceName,
        AbortSignal.timeout(5_000),
      ),
      "retired",
    );
    assert.equal(await routes.recordSourceCopyConfirmed(revisionId, latest), false);
    const retired = await f.state.read((state) =>
      access.readRepositoryCredentialSource(state, "reader", agent, f.source.id, [], []),
    );
    assert.ok("deliveries" in retired);
    assert.deepEqual(retired.deliveries, []);
    await f.retire();
  },
);

test(
  "under a repeatable-read connection default, Source replacement and deletion see a Provider write recorded while they wait on the Source row",
  requiresPostgres,
  async (t) => {
    const f = await managedSource(t, "repository-source-write-fence-rr", true);
    const isolation = await f.pool.query("SHOW default_transaction_isolation");
    assert.equal(isolation.rows[0]?.default_transaction_isolation, "repeatable read");
    const ref = { namespaceId: f.namespaceId, sourceId: f.source.id };
    const revisionId = `rev-${randomUUID()}`;
    await f.state.transact((unit) =>
      unit.credentialSources.recordRepositorySourceCopy(f.copy(revisionId)),
    );
    const fenced = {
      name: "RepositorySourceWriteUnreconciledError",
      message: `1 Provider write is unreconciled (unreconciled_repository_source_write): agent-${revisionId}/${revisionId}. Stop or redeploy its Agent; the Worker then confirms the Provider retired.`,
    };
    const worker = f.custody();

    // The TokenService step of PATCH starts its transaction, then waits on the Source row the
    // Worker holds. The Worker records its write during that wait, and the answer is lost. The
    // replacement must read the record committed during its wait, not a snapshot from before it.
    const writing = await worker.lock(ref);
    assert.ok(writing?.source);
    const { version } = await worker.resolve(ref, writing.source);
    const replacing = f.owner.updateSource(
      {
        sourceRef: { kind: "credential_source", namespaceId: f.namespaceId, id: f.source.id },
        tokenServiceInstanceId: f.instanceId,
      },
      { secret: { token: fineGrained() } },
      AbortSignal.timeout(30_000),
    );
    replacing.catch(() => {});
    assert.equal(await settlesWithin(replacing, 750), false, "the replacement waits on the row");
    const write = writing.write(revisionId, version);
    assert.equal(await write.dispatching(), true);
    await writing.hold.release();
    await assert.rejects(replacing, { name: fenced.name });
    // Proven unapplied, the record clears, so the deletion below meets only its own record.
    await write.settled("unapplied");

    // The same for DELETE: it reads the record committed while it waited, so it names the
    // unreconciled write rather than only the unretired copy.
    const again = await worker.lock(ref);
    assert.ok(again?.source);
    const deleting = f.retire();
    deleting.catch(() => {});
    assert.equal(await settlesWithin(deleting, 750), false, "the deletion waits on the row");
    assert.equal(await again.write(revisionId, version).dispatching(), true);
    await again.hold.release();
    await assert.rejects(deleting, fenced);
  },
);
