import {
  openShellGitDeliveryTransport,
  protectedRepositoryGitInstallationSql,
} from "../repo/credentials/protected-repository-git-installation.ts";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  repositoryWithdrawalStateSql,
  CredentialDeliveryReductions,
  CredentialDeliveries,
  type CredentialDeliveryKey,
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
 * (finding 2128). Identity and custody facts only: the Sandbox, the binding
 * id the middleware presents, the provider generation this worker wrote, the reference of
 * the material that generation carries and the last verified observation. Never a token.
 *
 * OCC stores these facts in its generic delivery state; this adapter interprets the
 * OpenShell policy and recipient. Ownership is a fence: adopt() moves it, every write by the holder carries it, and a
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
  adopt(
    revisionId: string,
    workerInstance: string,
    /** A replacement cannot inherit an observed hook. Take the fence and close it in one commit. */
    disposition?: "close-preview",
  ): Promise<OpenShellGitRouteRecord | undefined>;
  /** Read a known standing installation under current authority; never take its fence or open it. */
  standing(
    revision: Readonly<AgentRevision>,
  ): Promise<
    | { route: OpenShellGitRouteRecord; retainedLaunchHash: string; executionFingerprint: string }
    | undefined
  >;
  /** Reserve a provider write and return its new fence; undefined refuses the write. */
  writing(
    revisionId: string,
    fence: number,
    write: OpenShellGitRouteWrite,
    material?: OpenShellGitMaterialReference,
  ): Promise<number | undefined>;
  /** Clear only a definitely unsent write reserved by this exact holder. */
  cancelWriting(revisionId: string, fence: number): Promise<boolean>;
  /** Records the route as verified and clears a pending write. False when the fence is stale. */
  record(revisionId: string, fence: number, snapshot: OpenShellGitRouteSnapshot): Promise<boolean>;
  /** Whether the fence still names the holder. */
  owns(revisionId: string, fence: number): Promise<boolean>;
  /** Closes the route for good (the first reason stays). False when the fence is stale. */
  block(revisionId: string, fence: number, reason: OpenShellGitRouteBlockReason): Promise<boolean>;
  /** Confirm this exact preview closure, or observe that another owner or terminal reason won. */
  confirmPreviewBlocked(
    revisionId: string,
    workerInstance: string,
    fence: number,
    reason: OpenShellGitRouteBlockReason,
  ): Promise<"confirmed" | "superseded">;
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

const table = "occ.credential_deliveries";
const recognizedGitDelivery = `r.settlement='snapshot' AND r.target->>'transport'='${openShellGitDeliveryTransport}'
  AND (r.namespace_id,r.agent_id)=(v.namespace_id,v.agent_id)
  AND r.binding_id ~ '^[A-Za-z0-9_-]{32}$'
  AND jsonb_typeof(r.target->'workspace')='string' AND jsonb_typeof(r.target->'sandbox')='string'
  AND r.target - 'transport' - 'workspace' - 'sandbox'='{}'::jsonb
  AND (NOT (v.admitted_spec ? 'egress_plan') OR r.binding_id=v.admitted_spec#>>'{egress_plan,execution,executionId}')`;
const columns = `r.revision_id, r.namespace_id, r.agent_id, r.target->>'workspace' AS workspace,
  r.target->>'sandbox' AS sandbox, r.binding_id, r.fence,
  r.desired->>'providerId' AS provider_id, r.desired->>'profileVersion' AS profile_version,
  r.desired->>'resourceVersion' AS provider_resource_version,
  r.desired->>'credentialState' AS credential_state, r.desired->>'expiresAt' AS material_expires_at,
  r.material_version, r.preparation_attempt_id, r.observed, r.write_pending, r.blocked`;

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
  material_expires_at: string | null;
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
            expiresAt: row.material_expires_at ?? "",
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

  private async key(
    c: PostgresClient,
    revisionId: string,
    lock = true,
  ): Promise<
    | (CredentialDeliveryKey & {
        readonly fence: number;
        readonly blocked: string | null;
        readonly retainedPolicyHash: string | null;
      })
    | undefined
  > {
    const { rows } = await c.query(
      `SELECT r.binding_id,r.fence,r.blocked,r.retained_policy_hash,(${recognizedGitDelivery}) AS recognized
       FROM ${table} r JOIN occ.agent_revisions v ON v.id=r.live_revision_id
       WHERE r.revision_id=$1${lock ? " FOR UPDATE OF r" : ""}`,
      [revisionId],
    );
    if (rows.length > 1) {
      throw new Error("OpenShell repository delivery supports one binding per execution.");
    }
    const row = rows[0] as
      | {
          binding_id: string;
          fence: string;
          blocked: string | null;
          retained_policy_hash: string | null;
          recognized: boolean | null;
        }
      | undefined;
    if (!row) {
      return;
    }
    if (row.recognized !== true) {
      throw new Error("Unknown OpenShell repository delivery identity.");
    }
    return {
      revisionId,
      bindingId: row.binding_id,
      fence: Number(row.fence),
      blocked: row.blocked,
      retainedPolicyHash: row.retained_policy_hash,
    };
  }

  async open(route: OpenShellGitRouteIdentity, workerInstance: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(route.bindingId)) {
      throw new Error("Invalid OpenShell binding identity.");
    }
    await this.query((c) =>
      new CredentialDeliveries(c).open(
        route,
        {
          transport: openShellGitDeliveryTransport,
          workspace: route.workspace,
          sandbox: route.sandbox,
        },
        workerInstance,
      ),
    );
  }

  async adopt(
    revisionId: string,
    workerInstance: string,
    disposition?: "close-preview",
  ): Promise<OpenShellGitRouteRecord | undefined> {
    return this.query(async (c) => {
      const key = await this.key(c, revisionId);
      if (!key) {
        return;
      }
      await new CredentialDeliveries(c).adopt(
        key,
        workerInstance,
        disposition === "close-preview" ? "worker_replaced" : undefined,
      );
      const { rows } = await c.query(
        `SELECT ${columns} FROM ${table} r WHERE revision_id=$1 AND binding_id=$2`,
        [key.revisionId, key.bindingId],
      );
      return record(rows[0] as Row);
    });
  }

  async standing(revision: Readonly<AgentRevision>) {
    const credentials = revision.repositoryCredentials;
    if (!credentials?.standingApprovalId) {
      return;
    }
    return this.query(async (c) => {
      const key = await this.key(c, revision.id, false);
      if (!key) {
        return;
      }
      // A cold execution check precedes session renewal and normal route adoption. Require a
      // previously witnessed installation and the exact live approval and execution. This read
      // takes no route ownership and cannot turn a pending write or finite admission into renewal.
      const { rows } = await c.query(
        `SELECT ${columns}, r.retained_policy_hash AS retained_launch_hash, e.fingerprint AS execution_fingerprint FROM ${table} r
         JOIN occ.repository_standing_executions e USING (namespace_id, agent_id, revision_id)
         JOIN occ.agent_revisions v ON v.id = r.live_revision_id AND v.agent_id = r.agent_id AND v.namespace_id = r.namespace_id
         WHERE (r.revision_id, r.namespace_id, r.agent_id) = ($1, $2, $3)
           AND r.binding_id=$5
           AND v.admitted_spec->'repository_credentials' = $4::jsonb
           AND (v.admitted_spec #>> '{execution_admission,version}' NOT IN ('4','5') OR EXISTS (
                SELECT FROM occ.egress_installations p WHERE ${protectedRepositoryGitInstallationSql}
                AND p.installation->'plan'=v.admitted_spec->'egress_plan'
                AND p.installation#>'{plan,repositoryGit}'=$4::jsonb))
           AND e.execution_id = r.revision_id
           AND r.blocked IS NULL AND r.write_pending IS NULL
           AND (r.desired->>'credentialState') = 'active' AND r.material_version IS NOT NULL AND r.preparation_attempt_id IS NOT NULL
           AND r.retained_policy_hash IS NOT NULL AND r.observed->>'executionId' = r.revision_id
           AND r.observed->>'credentialState' = 'active' AND r.observed->>'workspace' = (r.target->>'workspace')
           AND r.observed->>'sandbox' = (r.target->>'sandbox') AND r.observed->>'providerId' = (r.desired->>'providerId')
           AND r.observed->>'providerResourceVersion' = (r.desired->>'resourceVersion') AND r.observed->>'profileVersion' = (r.desired->>'profileVersion')
           AND occ.repository_standing_execution_is_current($4::jsonb, $2, $3, $1)`,
        [
          revision.id,
          revision.namespaceId,
          revision.agentId,
          JSON.stringify(credentials),
          key.bindingId,
        ],
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

  private async held(
    revisionId: string,
    work: (state: CredentialDeliveries, key: CredentialDeliveryKey) => Promise<boolean>,
  ): Promise<boolean> {
    return this.query(async (c) => {
      const key = await this.key(c, revisionId);
      return key ? work(new CredentialDeliveries(c), key) : false;
    });
  }

  async writing(
    revisionId: string,
    fence: number,
    write: OpenShellGitRouteWrite,
    material?: OpenShellGitMaterialReference,
  ): Promise<number | undefined> {
    return this.query(async (c) => {
      const key = await this.key(c, revisionId);
      return key ? new CredentialDeliveries(c).writing(key, fence, write, material) : undefined;
    });
  }

  async cancelWriting(revisionId: string, fence: number): Promise<boolean> {
    return this.held(revisionId, (state, key) => state.cancelWriting(key, fence));
  }

  async record(
    revisionId: string,
    fence: number,
    snapshot: OpenShellGitRouteSnapshot,
  ): Promise<boolean> {
    const { generation, observed } = snapshot;
    if (
      !/^[1-9][0-9]*$/.test(generation.resourceVersion) ||
      !/^[1-9][0-9]*$/.test(generation.profileVersion) ||
      !["bootstrap", "active"].includes(generation.credentialState) ||
      (generation.credentialState === "active" &&
        !Number.isFinite(Date.parse(generation.expiresAt)))
    ) {
      throw new Error("Invalid OpenShell provider generation.");
    }
    // Provider-specific shape validation stays at the adapter. The common durable owner
    // accepts nonsecret delivery facts and does not know the OpenShell wire schema.
    const fields = [
      "workspace",
      "sandbox",
      "sandboxId",
      "executionId",
      "provider",
      "providerId",
      "providerResourceVersion",
      "profileVersion",
      "credentialState",
      "attachmentEpoch",
      "providerEnvRevision",
      "configRevision",
      "policyHash",
      "supervisorSessionId",
      "processInstanceId",
      "networkInstanceId",
    ];
    const hook = observed?.observedHook;
    if (
      observed &&
      (fields.some((field) => !(field in observed)) ||
        Object.keys(observed).some(
          (field) => !fields.includes(field) && field !== "observedHook",
        ) ||
        ("observedHook" in observed &&
          (!hook ||
            Object.keys(hook).length !== 2 ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              hook.startupId,
            ) ||
            !/^[0-9a-f]{64}$/.test(hook.observationId))))
    ) {
      throw new Error("Invalid OpenShell delivery observation.");
    }
    return this.held(revisionId, (state, key) =>
      state.record(key, fence, {
        desired: { ...snapshot.generation },
        ...(snapshot.observed && { observed: { ...snapshot.observed } }),
        ...(snapshot.material && { material: snapshot.material }),
        ...(snapshot.retainedLaunchHash && { retainedPolicyHash: snapshot.retainedLaunchHash }),
      }),
    );
  }

  async owns(revisionId: string, fence: number): Promise<boolean> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      const key = await this.key(c, revisionId, false);
      return key?.fence === fence && key.blocked === null;
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
    return this.held(revisionId, (state, key) => state.block(key, fence, reason));
  }

  async confirmPreviewBlocked(
    revisionId: string,
    workerInstance: string,
    fence: number,
    reason: OpenShellGitRouteBlockReason,
  ): Promise<"confirmed" | "superseded"> {
    return this.query(async (c) => {
      const key = await this.key(c, revisionId);
      if (!key) {
        throw new Error("Missing the OpenShell preview route to close.");
      }
      const { rows } = await c.query(
        `SELECT worker_instance, fence, blocked FROM ${table} WHERE revision_id=$1 AND binding_id=$2`,
        [revisionId, key.bindingId],
      );
      const route = rows[0] as Pick<Row, "fence" | "blocked"> & { worker_instance: string };
      if (route.worker_instance !== workerInstance || Number(route.fence) !== fence) {
        return "superseded";
      }
      if (route.blocked !== null) {
        return route.blocked === reason ? "confirmed" : "superseded";
      }
      return (await new CredentialDeliveries(c).block(key, fence, reason))
        ? "confirmed"
        : "superseded";
    });
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
      const key = await this.key(c, revision.id);
      if (!key) {
        return;
      }
      const { rows } = await c.query(
        `SELECT r.binding_id, r.fence, r.material_version,
          r.retained_policy_hash AS retained_launch_hash, r.observed
        FROM ${table} r JOIN occ.agent_revisions v ON v.id=r.live_revision_id
        JOIN occ.agents a ON a.namespace_id = v.namespace_id AND a.id = v.agent_id
        WHERE r.revision_id = $1 AND r.namespace_id = $2 AND r.agent_id = $3
          AND r.binding_id = $8
          AND (r.target->>'workspace') = $4 AND (r.target->>'sandbox') = $5 AND r.revision_id = v.id
          AND a.id = r.agent_id AND a.namespace_id = r.namespace_id
          AND a.status = 'active' AND a.desired_runtime_state = 'running' AND a.active_revision_id = r.revision_id
          AND v.admitted_spec->'repository_credentials' = $6::jsonb
          AND CASE WHEN $6::jsonb ? 'standingApprovalId'
                THEN ${repositoryWithdrawalStateSql("r")} = 'expiry'
                ELSE clock_timestamp() >= to_timestamp($7::double precision / 1000) END
          AND (r.desired->>'credentialState') = 'active' AND r.write_pending IS NULL AND r.material_version IS NOT NULL
          AND r.retained_policy_hash IS NOT NULL AND r.observed->>'executionId' = v.id
          AND r.observed->>'credentialState' = 'active' AND r.observed->>'workspace' = (r.target->>'workspace')
          AND r.observed->>'sandbox' = (r.target->>'sandbox') AND r.observed->>'providerId' = (r.desired->>'providerId')
          AND r.observed->>'providerResourceVersion' = (r.desired->>'resourceVersion')
          AND r.observed->>'profileVersion' = (r.desired->>'profileVersion')
          AND (r.blocked IS NULL OR r.blocked = 'repository_expired')`,
        [
          revision.id,
          revision.namespaceId,
          revision.agentId,
          workspace,
          sandbox,
          JSON.stringify(revision.repositoryCredentials),
          deadline,
          key.bindingId,
        ],
      );
      const row = rows[0] as
        | {
            observed: OpenShellPreparedGitInstalled;
            retained_launch_hash: string;
            binding_id: string;
            fence: string;
            material_version: string;
          }
        | undefined;
      if (row) {
        if (
          key.blocked === null &&
          !(await new CredentialDeliveries(c).block(key, Number(row.fence), "repository_expired"))
        ) {
          return;
        }
        const progress = await new CredentialDeliveryReductions(c).desire({
          revisionId: revision.id,
          bindingId: row.binding_id,
          fence: Number(row.fence),
          recipient: { ...row.observed },
          materialVersion: row.material_version,
          retainedPolicyHash: row.retained_launch_hash,
        });
        return {
          observed: row.observed,
          retainedLaunchHash: row.retained_launch_hash,
          ...(progress.requestId && {
            detach: {
              requestId: progress.requestId,
              ...(progress.observedGeneration && { epoch: progress.observedGeneration }),
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
    return this.query(async (c) => {
      const key = await this.key(c, revision);
      // A new apply requires the live, exact provider tombstone.
      if (!key || key.blocked !== "repository_expired" || key.retainedPolicyHash !== launch) {
        return false;
      }
      return new CredentialDeliveryReductions(c).begin(
        revision,
        key.bindingId,
        key.fence,
        launch,
        requestId,
        resourceVersion,
      );
    });
  }

  async confirmDetached(
    revision: string,
    launch: string,
    requestId: string,
    epoch: string,
  ): Promise<boolean> {
    return this.query(async (c) => {
      // Terminal evidence is resolved without the live revision. Pin the original
      // owner, recipient and consumed request; this path never grants another apply.
      const { rows } = await c.query(
        `SELECT d.binding_id,d.fence FROM occ.credential_delivery_reductions d
         JOIN ${table} r USING (revision_id,binding_id)
         WHERE d.revision_id=$1 AND d.retained_policy_hash=$2 AND d.request_id=$3
           AND r.target->>'transport'='${openShellGitDeliveryTransport}' AND r.settlement='snapshot'
           AND r.blocked IS NOT NULL AND r.fence=d.fence
           AND r.retained_policy_hash=d.retained_policy_hash
           AND r.material_version=d.material_version AND r.observed=d.recipient
         FOR UPDATE OF r,d`,
        [revision, launch, requestId],
      );
      if (rows.length !== 1) {
        return false;
      }
      const row = rows[0] as { binding_id: string; fence: string };
      return new CredentialDeliveryReductions(c).confirm(
        revision,
        row.binding_id,
        Number(row.fence),
        launch,
        requestId,
        epoch,
      );
    });
  }

  async withdraw(selector: OpenShellGitRouteWithdrawal): Promise<void> {
    const [column, value] =
      "revisionId" in selector
        ? ["revision_id", selector.revisionId]
        : ["namespace_id", selector.namespaceId];
    await this.query(async (c) => {
      const { rows } = await c.query(
        `SELECT r.revision_id,r.binding_id FROM ${table} r
         JOIN occ.agent_revisions v ON v.id=r.live_revision_id
         WHERE r.${column}=$1 AND ${recognizedGitDelivery}
         ORDER BY r.revision_id,r.binding_id FOR UPDATE OF r`,
        [value],
      );
      const keys = rows as { revision_id: string; binding_id: string }[];
      if (new Set(keys.map(({ revision_id }) => revision_id)).size !== keys.length) {
        throw new Error("OpenShell repository delivery supports one binding per execution.");
      }
      await new CredentialDeliveries(c).withdraw(
        keys.map(({ revision_id, binding_id }) => ({
          revisionId: revision_id,
          bindingId: binding_id,
        })),
        "withdrawn",
        "repository_expired",
      );
    });
  }
}
