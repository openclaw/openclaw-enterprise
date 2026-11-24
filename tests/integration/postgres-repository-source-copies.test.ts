import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { GIT_REVISION } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { openShellSourceGitProviderPrefix } from "../../apps/controller/src/drivers/egress-proxy/openshell-repository-git-evidence.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { AuditEvent, CredentialSourceReference } from "../../packages/contracts/src/index.ts";
import {
  RepositorySourceCopiesUnretiredError,
  ResourceConflictError,
  PostgresPlatformState,
  ScopeViolationError,
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
async function managedSource(t: TestContext, label: string) {
  assert.ok(databaseUrl);
  const { controller, inject, pool, principal, state } = await createPostgresAgentApp(t, {
    label,
    authSecret: `${label}-session-secret`,
    requestAudit: false,
    controllerOptions: { iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()) },
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
  return { pool, state, namespaceId, source, retire, copy };
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
