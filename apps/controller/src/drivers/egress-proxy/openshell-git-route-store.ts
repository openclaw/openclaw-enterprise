import { protectedRepositoryGitInstallationSql } from "../repo/credentials/protected-repository-git-installation.ts";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  repositoryWithdrawalStateSql,
  type PostgresClient,
  type PostgresPool,
} from "@openclaw-enterprise/occ";
import type { OpenShellGitRouteBlockReason } from "./openshell-git-runtime.ts";
import type {
  OpenShellPreparedGitGeneration,
  OpenShellPreparedGitInstalled,
} from "./openshell-prepared-git-provider.ts";

/**
 * A revision's OpenShell Git route as the worker holding it last verified it, persisted so
 * a restarted or replacement worker can re-observe the installation and re-adopt the route
 * (finding 2128, migration 0060). Identity and custody facts only: the Sandbox, the binding
 * id the middleware presents, the provider generation this worker wrote, the reference of
 * the material that generation carries and the last verified observation. Never a token.
 *
 * Ownership is a fence: adopt() moves it, every write by the holder carries it, and a
 * worker whose fence is stale writes nothing and stops using the route (the work-queue
 * claim decides which worker prepares a revision; the fence makes that decision stick for
 * the route). A write marked pending when a worker stopped has an unknown outcome, and a
 * blocked route is a tombstone: neither is adopted again.
 */
export interface OpenShellGitRouteIdentity {
  readonly revisionId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly workspace: string;
  readonly sandbox: string;
  readonly bindingId: string;
}

export interface OpenShellGitMaterialReference {
  readonly materialVersion: string;
  readonly preparationAttemptId: string;
}

export type OpenShellGitRouteWrite = "bootstrap" | "rotate";

/** What the holder persists after a verified observation or a completed provider write. */
export interface OpenShellGitRouteSnapshot {
  readonly retainedLaunchHash?: string;
  readonly generation: OpenShellPreparedGitGeneration;
  readonly material: OpenShellGitMaterialReference | undefined;
  readonly observed: OpenShellPreparedGitInstalled | undefined;
}

export interface OpenShellGitRouteRecord extends OpenShellGitRouteIdentity {
  readonly fence: number;
  readonly generation: OpenShellPreparedGitGeneration | undefined;
  readonly material: OpenShellGitMaterialReference | undefined;
  readonly observed: OpenShellPreparedGitInstalled | undefined;
  readonly writePending: OpenShellGitRouteWrite | undefined;
  readonly blocked: OpenShellGitRouteBlockReason | undefined;
}

export type OpenShellGitRouteWithdrawal =
  { readonly revisionId: string } | { readonly namespaceId: string };

export interface OpenShellGitExpiry {
  readonly retainedLaunchHash: string;
  readonly observed: OpenShellPreparedGitInstalled;
  readonly detach?: { readonly requestId: string; readonly epoch?: string };
}

export interface OpenShellGitRouteStore {
  /** Records a route this worker is about to bootstrap: fence 1, bootstrap write pending. */
  open(route: OpenShellGitRouteIdentity, workerInstance: string): Promise<void>;
  /**
   * Takes the route over for this worker: the fence moves, so the previous holder's writes
   * fail from here. A blocked route is answered as it is and never re-fenced; no route
   * answers undefined.
   */
  adopt(revisionId: string, workerInstance: string): Promise<OpenShellGitRouteRecord | undefined>;
  /** Read a known standing installation under current authority; never take its fence or open it. */
  standing(
    revision: Readonly<AgentRevision>,
  ): Promise<
    | { route: OpenShellGitRouteRecord; retainedLaunchHash: string; executionFingerprint: string }
    | undefined
  >;
  /** Marks a provider write in flight. False when the fence is stale. */
  writing(revisionId: string, fence: number, write: OpenShellGitRouteWrite): Promise<boolean>;
  /** Records the route as verified and clears a pending write. False when the fence is stale. */
  record(revisionId: string, fence: number, snapshot: OpenShellGitRouteSnapshot): Promise<boolean>;
  /** Whether the fence still names the holder. */
  owns(revisionId: string, fence: number): Promise<boolean>;
  /** Closes the route for good (the first reason stays). False when the fence is stale. */
  block(revisionId: string, fence: number, reason: OpenShellGitRouteBlockReason): Promise<boolean>;
  /** Tombstones every open route of a withdrawn revision or Namespace, whoever holds it. */
  withdraw(selector: OpenShellGitRouteWithdrawal): Promise<void>;
  /** Irrevocably fences the witnessed Git installation at finite expiry or recorded standing withdrawal. */
  expire(
    revision: Readonly<AgentRevision>,
    workspace: string,
    sandbox: string,
  ): Promise<OpenShellGitExpiry | undefined>;
  beginDetach(
    revision: string,
    launch: string,
    requestId: string,
    resourceVersion: string,
  ): Promise<boolean>;
  confirmDetached(
    revision: string,
    launch: string,
    requestId: string,
    epoch: string,
  ): Promise<boolean>;
}

const table = "occ.openshell_git_routes";
const columns = `revision_id, namespace_id, agent_id, workspace, sandbox, binding_id, fence,
  provider_id, profile_version, provider_resource_version, credential_state, material_expires_at,
  material_version, preparation_attempt_id, observed, write_pending, blocked`;

interface Row {
  revision_id: string;
  namespace_id: string;
  agent_id: string;
  workspace: string;
  sandbox: string;
  binding_id: string;
  fence: string | number;
  provider_id: string | null;
  profile_version: string | null;
  provider_resource_version: string | null;
  credential_state: "bootstrap" | "active" | null;
  material_expires_at: Date | null;
  material_version: string | null;
  preparation_attempt_id: string | null;
  observed: OpenShellPreparedGitInstalled | null;
  write_pending: OpenShellGitRouteWrite | null;
  blocked: OpenShellGitRouteBlockReason | null;
}

function record(row: Row): OpenShellGitRouteRecord {
  return {
    revisionId: row.revision_id,
    namespaceId: row.namespace_id,
    agentId: row.agent_id,
    workspace: row.workspace,
    sandbox: row.sandbox,
    bindingId: row.binding_id,
    fence: Number(row.fence),
    generation:
      row.provider_id === null ||
      row.profile_version === null ||
      row.provider_resource_version === null ||
      row.credential_state === null
        ? undefined
        : {
            providerId: row.provider_id,
            profileVersion: row.profile_version,
            resourceVersion: row.provider_resource_version,
            credentialState: row.credential_state,
            expiresAt: row.material_expires_at?.toISOString() ?? "",
          },
    material:
      row.material_version === null || row.preparation_attempt_id === null
        ? undefined
        : {
            materialVersion: row.material_version,
            preparationAttemptId: row.preparation_attempt_id,
          },
    observed: row.observed ?? undefined,
    writePending: row.write_pending ?? undefined,
    blocked: row.blocked ?? undefined,
  };
}

export class PostgresOpenShellGitRouteStore implements OpenShellGitRouteStore {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  private async query<T>(work: (c: PostgresClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '4000ms'");
      await c.query("SET LOCAL lock_timeout = '1000ms'");
      const result = await work(c);
      try {
        await c.query("COMMIT");
      } catch (e) {
        discard = true;
        throw e;
      }
      return result;
    } catch (error) {
      if (!discard) {
        try {
          await c.query("ROLLBACK");
        } catch {
          discard = true;
        }
      }
      throw error;
    } finally {
      c.release(discard);
    }
  }

  async open(route: OpenShellGitRouteIdentity, workerInstance: string): Promise<void> {
    await this.query((c) =>
      c.query(
        `INSERT INTO ${table}
          (revision_id, namespace_id, agent_id, workspace, sandbox, binding_id, worker_instance, write_pending)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'bootstrap')`,
        [
          route.revisionId,
          route.namespaceId,
          route.agentId,
          route.workspace,
          route.sandbox,
          route.bindingId,
          workerInstance,
        ],
      ),
    );
  }

  async adopt(
    revisionId: string,
    workerInstance: string,
  ): Promise<OpenShellGitRouteRecord | undefined> {
    return this.query(async (c) => {
      const adopted = await c.query(
        `UPDATE ${table}
        SET fence = fence + 1, worker_instance = $2, adopted_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE revision_id = $1 AND blocked IS NULL
        RETURNING ${columns}`,
        [revisionId, workerInstance],
      );
      const row =
        (adopted.rows[0] as Row | undefined) ??
        ((
          await c.query(
            `SELECT ${columns} FROM ${table} WHERE revision_id = $1 AND blocked IS NOT NULL`,
            [revisionId],
          )
        ).rows[0] as Row | undefined);
      return row === undefined ? undefined : record(row);
    });
  }

  async standing(revision: Readonly<AgentRevision>) {
    const credentials = revision.repositoryCredentials;
    if (!credentials?.standingApprovalId) {
      return;
    }
    return this.query(async (c) => {
      // A cold execution check precedes session renewal and normal route adoption. Require a
      // previously witnessed installation and the exact live approval and execution. This read
      // takes no route ownership and cannot turn a pending write or finite admission into renewal.
      const { rows } = await c.query(
        `SELECT r.*, e.fingerprint AS execution_fingerprint FROM ${table} r
         JOIN occ.repository_standing_executions e USING (namespace_id, agent_id, revision_id)
         JOIN occ.agent_revisions v ON v.id = r.revision_id AND v.agent_id = r.agent_id AND v.namespace_id = r.namespace_id
         WHERE (r.revision_id, r.namespace_id, r.agent_id) = ($1, $2, $3)
           AND v.admitted_spec->'repository_credentials' = $4::jsonb
           AND (v.admitted_spec #>> '{execution_admission,version}' <> '4' OR EXISTS (
                SELECT FROM occ.egress_installations p WHERE ${protectedRepositoryGitInstallationSql}
                AND p.installation->'plan'=v.admitted_spec->'egress_plan'
                AND p.installation#>'{plan,repositoryGit}'=$4::jsonb))
           AND e.execution_id = r.revision_id
           AND r.blocked IS NULL AND r.write_pending IS NULL AND r.detach_request_id IS NULL
           AND r.credential_state = 'active' AND r.material_version IS NOT NULL AND r.preparation_attempt_id IS NOT NULL
           AND r.retained_launch_hash IS NOT NULL AND r.observed->>'executionId' = r.revision_id
           AND r.observed->>'credentialState' = 'active' AND r.observed->>'workspace' = r.workspace
           AND r.observed->>'sandbox' = r.sandbox AND r.observed->>'providerId' = r.provider_id
           AND r.observed->>'providerResourceVersion' = r.provider_resource_version AND r.observed->>'profileVersion' = r.profile_version
           AND occ.repository_standing_execution_is_current($4::jsonb, $2, $3, $1)`,
        [revision.id, revision.namespaceId, revision.agentId, JSON.stringify(credentials)],
      );
      const row = rows[0] as
        (Row & { retained_launch_hash: string; execution_fingerprint: string }) | undefined;
      return (
        row && {
          route: record(row),
          retainedLaunchHash: row.retained_launch_hash,
          executionFingerprint: row.execution_fingerprint,
        }
      );
    });
  }

  async writing(
    revisionId: string,
    fence: number,
    write: OpenShellGitRouteWrite,
  ): Promise<boolean> {
    return this.query(
      async (c) =>
        (
          await c.query(
            `UPDATE ${table} SET write_pending = $3, updated_at = clock_timestamp()
            WHERE revision_id = $1 AND fence = $2 AND blocked IS NULL`,
            [revisionId, fence, write],
          )
        ).rowCount === 1,
    );
  }

  async record(
    revisionId: string,
    fence: number,
    snapshot: OpenShellGitRouteSnapshot,
  ): Promise<boolean> {
    const { generation, material, observed } = snapshot;
    return this.query(
      async (c) =>
        (
          await c.query(
            `UPDATE ${table} SET provider_id = $3, profile_version = $4, provider_resource_version = $5,
              credential_state = $6, material_expires_at = $7, material_version = $8,
              preparation_attempt_id = $9, observed = $10::jsonb, write_pending = NULL,
              retained_launch_hash = coalesce(retained_launch_hash, $11), updated_at = clock_timestamp()
            WHERE revision_id = $1 AND fence = $2 AND blocked IS NULL
              AND ($11::text IS NULL OR retained_launch_hash IS NULL OR retained_launch_hash = $11)`,
            [
              revisionId,
              fence,
              generation.providerId,
              generation.profileVersion,
              generation.resourceVersion,
              generation.credentialState,
              generation.credentialState === "active" ? new Date(generation.expiresAt) : null,
              material?.materialVersion ?? null,
              material?.preparationAttemptId ?? null,
              observed === undefined ? null : JSON.stringify(observed),
              snapshot.retainedLaunchHash ?? null,
            ],
          )
        ).rowCount === 1,
    );
  }

  async owns(revisionId: string, fence: number): Promise<boolean> {
    // Asked on every Git request: one primary-key read, no transaction (the request's own
    // budget bounds it; a store that does not answer denies that request only).
    const c = await this.pool.connect();
    let discard = false;
    try {
      const result = await c.query(
        `SELECT 1 FROM ${table} WHERE revision_id = $1 AND fence = $2 AND blocked IS NULL`,
        [revisionId, fence],
      );
      return result.rowCount === 1;
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      c.release(discard);
    }
  }

  async block(
    revisionId: string,
    fence: number,
    reason: OpenShellGitRouteBlockReason,
  ): Promise<boolean> {
    return this.query(
      async (c) =>
        (
          await c.query(
            `UPDATE ${table} SET blocked = $3, write_pending = NULL, updated_at = clock_timestamp()
            WHERE revision_id = $1 AND fence = $2 AND blocked IS NULL`,
            [revisionId, fence, reason],
          )
        ).rowCount === 1,
    );
  }

  /** Old as well as new holders check blocked IS NULL on use, adoption and every write.
   * Never turn an earlier tombstone or an outstanding provider write into deadline expiry. */
  async expire(
    revision: Readonly<AgentRevision>,
    workspace: string,
    sandbox: string,
  ): Promise<OpenShellGitExpiry | undefined> {
    const deadline = revision.repositoryCredentials?.deadlineWallMs;
    if (!Number.isSafeInteger(deadline)) {
      return;
    }
    return this.query(async (c) => {
      const { rows } = await c.query(
        `UPDATE ${table} r SET blocked = 'repository_expired'
        FROM occ.agent_revisions v JOIN occ.agents a ON a.namespace_id = v.namespace_id AND a.id = v.agent_id
        WHERE r.revision_id = $1 AND r.namespace_id = $2 AND r.agent_id = $3
          AND r.workspace = $4 AND r.sandbox = $5 AND r.revision_id = v.id
          AND a.id = r.agent_id AND a.namespace_id = r.namespace_id
          AND a.status = 'active' AND a.desired_runtime_state = 'running' AND a.active_revision_id = r.revision_id
          AND v.admitted_spec->'repository_credentials' = $6::jsonb
          AND CASE WHEN $6::jsonb ? 'standingApprovalId'
                THEN ${repositoryWithdrawalStateSql("r")} = 'expiry'
                ELSE clock_timestamp() >= to_timestamp($7::double precision / 1000) END
          AND r.credential_state = 'active' AND r.write_pending IS NULL AND r.material_version IS NOT NULL
          AND r.retained_launch_hash IS NOT NULL AND r.observed->>'executionId' = v.id
          AND r.observed->>'credentialState' = 'active' AND r.observed->>'workspace' = r.workspace
          AND r.observed->>'sandbox' = r.sandbox AND r.observed->>'providerId' = r.provider_id
          AND r.observed->>'providerResourceVersion' = r.provider_resource_version
          AND r.observed->>'profileVersion' = r.profile_version
          AND (r.blocked IS NULL OR r.blocked = 'repository_expired')
        RETURNING retained_launch_hash, observed, detach_request_id, detached_epoch`,
        [
          revision.id,
          revision.namespaceId,
          revision.agentId,
          workspace,
          sandbox,
          JSON.stringify(revision.repositoryCredentials),
          deadline,
        ],
      );
      const row = rows[0] as
        | {
            observed: OpenShellPreparedGitInstalled;
            retained_launch_hash: string;
            detach_request_id: string | null;
            detached_epoch: string | null;
          }
        | undefined;
      if (row) {
        return {
          observed: row.observed,
          retainedLaunchHash: row.retained_launch_hash,
          ...(row.detach_request_id && {
            detach: {
              requestId: row.detach_request_id,
              ...(row.detached_epoch && { epoch: row.detached_epoch }),
            },
          }),
        };
      }
      return undefined;
    });
  }

  async beginDetach(
    revision: string,
    launch: string,
    requestId: string,
    resourceVersion: string,
  ): Promise<boolean> {
    return this.query(
      async (c) =>
        (
          await c.query(
            `UPDATE ${table} SET detach_request_id = $3, detach_resource_version = $4, updated_at = clock_timestamp()
       WHERE revision_id = $1 AND retained_launch_hash = $2 AND blocked = 'repository_expired' AND detach_request_id IS NULL`,
            [revision, launch, requestId, resourceVersion],
          )
        ).rowCount === 1,
    );
  }

  async confirmDetached(
    revision: string,
    launch: string,
    requestId: string,
    epoch: string,
  ): Promise<boolean> {
    return this.query(
      async (c) =>
        (
          await c.query(
            `UPDATE ${table} SET detached_epoch = $4, updated_at = clock_timestamp()
       WHERE revision_id = $1 AND retained_launch_hash = $2 AND detach_request_id = $3 AND blocked = 'repository_expired'
         AND (detached_epoch IS NULL OR detached_epoch = $4)`,
            [revision, launch, requestId, epoch],
          )
        ).rowCount === 1,
    );
  }

  async withdraw(selector: OpenShellGitRouteWithdrawal): Promise<void> {
    const [column, value] =
      "revisionId" in selector
        ? ["revision_id", selector.revisionId]
        : ["namespace_id", selector.namespaceId];
    await this.query((c) =>
      c.query(
        `UPDATE ${table} SET blocked = 'withdrawn', write_pending = NULL, updated_at = clock_timestamp()
        WHERE ${column} = $1 AND (blocked IS NULL OR blocked = 'repository_expired')`,
        [value],
      ),
    );
  }
}
