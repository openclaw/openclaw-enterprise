import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
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
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
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
    await assert.rejects(retire(), /2 native Git copies .*unretired_repository_source_copy/);
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
    await assert.rejects(retire(), /2 native Git copies/);

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
    await assert.rejects(retire(), /1 native Git copy of this credential source is not/);

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
