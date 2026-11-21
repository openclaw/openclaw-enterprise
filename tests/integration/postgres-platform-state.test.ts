import assert from "node:assert/strict";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-platform-state.ts";
import {
  persistNamespaceLifecycle,
  refuseUninitializedInstallation,
} from "./postgres-state-admission-cases.ts";
import {
  browseUnreadableState,
  refuseUnreadableDeployment,
  selectNativeAdminRevision,
} from "./postgres-state-browsing-cases.ts";
import { verifyPostgresStateConformance } from "./postgres-state-conformance-case.ts";
import { persistGuardedDeployment } from "./postgres-state-guarded-deployment-case.ts";
import { persistPluginState } from "./postgres-state-plugin-case.ts";
import {
  persistRepositoryNetworkPolicy,
  verifyMemoryRepositoryPolicyPersistence,
} from "./postgres-state-repository-network-policy-case.ts";
import {
  checkpointProvisioning,
  completeProvisioning,
  replayProvisioning,
} from "./postgres-state-provisioning-cases.ts";
import { drainApiOnSigterm, recheckNamespaceRestriction } from "./postgres-state-worker-cases.ts";

// These cases share the prepared file database. The startup refusal precedes bootstrap.
test(
  "PostgreSQL rejects platform writes until the singleton Installation is bootstrapped",
  requiresPostgres,
  refuseUninitializedInstallation,
);
test(
  "real OCC Namespace lifecycle persists provisioning, readiness, deletion, and its tombstone",
  requiresPostgres,
  persistNamespaceLifecycle,
);
test(
  "PostgreSQL Agent provisioning persistence replays requests and fences checkpoints",
  requiresPostgres,
  replayProvisioning,
);
test(
  "PostgreSQL Agent provisioning success completes its queue row atomically",
  requiresPostgres,
  completeProvisioning,
);
test(
  "PostgreSQL Agent provisioning direct checkpoint still moves ordinary progress",
  requiresPostgres,
  checkpointProvisioning,
);
test(
  "PostgreSQL platform state satisfies memory adapter ownership, immutability, and atomicity",
  requiresPostgres,
  verifyPostgresStateConformance,
);
test(
  "PostgreSQL persists Agent plugin desired state and immutable revision snapshots atomically",
  requiresPostgres,
  persistPluginState,
);
test(
  "memory State admits both execution modes with repository network policy",
  verifyMemoryRepositoryPolicyPersistence,
);
test(
  "PostgreSQL saves repository network policy and binds reader markers for both execution modes",
  requiresPostgres,
  persistRepositoryNetworkPolicy,
);
test(
  "PostgreSQL browsing isolates unreadable saved Agent and revision configuration",
  requiresPostgres,
  browseUnreadableState,
);
test(
  "PostgreSQL native admin ignores unreadable older revisions when checking for a successor",
  requiresPostgres,
  selectNativeAdminRevision,
);
test(
  "PostgreSQL deployment refuses with 503 and creates nothing when an earlier revision is unreadable",
  requiresPostgres,
  refuseUnreadableDeployment,
);
test(
  "the PostgreSQL worker reloads exact Namespace restrictions and never dispatches revoked provisioning",
  requiresPostgres,
  recheckNamespaceRestriction,
);
test(
  "API SIGTERM finishes an in-flight keep-alive request and exits within the Pod grace",
  requiresPostgres,
  drainApiOnSigterm,
);
test(
  "PostgreSQL guarded first deployment persists one private receipt and one reconcile work",
  requiresPostgres,
  persistGuardedDeployment,
);

test(
  "PostgreSQL pins managed sources to a durable TokenService instance and keeps OAuth sources unpinned",
  requiresPostgres,
  async (context) => {
    const [{ randomUUID }, { Pool }, { PostgresPlatformState }, { databaseUrl }] =
      await Promise.all([
        import("node:crypto"),
        import("pg"),
        import("../../packages/occ/src/state/postgres-state.ts"),
        import("../helpers/postgres-platform-state.ts"),
      ]);
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const createdAt = new Date().toISOString();
    if (!(await state.loadInstallation())) {
      await state.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Static source persistence",
          createdAt,
        }),
      );
    }
    const namespaceId = `ns_${randomUUID()}`;
    await state.transact((unit) =>
      unit.namespaces.createNamespace({
        id: namespaceId,
        name: `Static source ${randomUUID()}`,
        status: "provisioning",
        createdAt,
      }),
    );
    await state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
    );
    const candidate = {
      id: randomUUID(),
      driverId: "selected-token-service",
      storeIdentity: `store-${randomUUID()}`,
    };
    const selected = await state.transact((unit) =>
      unit.installations.selectTokenServiceInstance(candidate),
    );
    assert.deepEqual(
      await state.transact((unit) =>
        unit.installations.selectTokenServiceInstance({ ...candidate, id: randomUUID() }),
      ),
      selected,
    );
    const sourceId = `cs_${randomUUID()}`;
    await state.transact((unit) =>
      unit.credentialSources.createCredentialSource({
        id: sourceId,
        namespaceId,
        name: "Managed source",
        type: "static",
        config: {},
        secrets: {},
        ownerCapability: "token_service",
        tokenServiceInstanceId: selected.id,
        state: "registering",
        createdAt,
      }),
    );
    const dispatchedAt = new Date().toISOString();
    assert.equal(
      await state.transact((unit) =>
        unit.credentialSources.setCredentialSourceRegistrationDispatch(
          namespaceId,
          sourceId,
          dispatchedAt,
        ),
      ),
      true,
    );
    assert.equal(
      await state.transact((unit) =>
        unit.credentialSources.setCredentialSourceRegistrationDispatch(
          namespaceId,
          sourceId,
          dispatchedAt,
        ),
      ),
      false,
    );
    const ready = await state.transact((unit) =>
      unit.credentialSources.markCredentialSourceReady(namespaceId, sourceId, {}),
    );
    assert.equal(ready?.ownerCapability, "token_service");
    assert.deepEqual(ready?.config, {});
    assert.deepEqual(
      ready?.ownerCapability === "token_service" ? ready.registration : undefined,
      {},
    );
    await assert.rejects(
      state.transact((unit) =>
        unit.installations.selectTokenServiceInstance({
          id: randomUUID(),
          driverId: "replacement",
          storeIdentity: "different-store",
        }),
      ),
      /still has registrations/,
    );
    const oauthId = `cs_${randomUUID()}`;
    // Existing consent first reserves an unpinned OAuth source; adding managed storage must not alter it.
    const oauth = await state.transact((unit) =>
      unit.credentialSources.createCredentialSource({
        id: oauthId,
        namespaceId,
        name: "OAuth reservation",
        type: "oauth2-refresh-token",
        config: {},
        secrets: {},
        ownerCapability: "token_service",
        state: "registering",
        createdAt,
      }),
    );
    assert.equal(
      oauth.ownerCapability === "token_service" ? oauth.tokenServiceInstanceId : undefined,
      undefined,
    );
    await state.transact(async (unit) => {
      await unit.credentialSources.markCredentialSourceDeleting(namespaceId, sourceId);
      assert.equal(
        await unit.credentialSources.deleteCredentialSource(namespaceId, sourceId),
        true,
      );
      await unit.credentialSources.markCredentialSourceDeleting(namespaceId, oauthId);
      await unit.credentialSources.deleteCredentialSource(namespaceId, oauthId);
    });
    const replacement = {
      id: randomUUID(),
      driverId: "replacement",
      storeIdentity: "different-store",
    };
    assert.deepEqual(
      await state.transact((unit) => unit.installations.selectTokenServiceInstance(replacement)),
      replacement,
    );
  },
);
