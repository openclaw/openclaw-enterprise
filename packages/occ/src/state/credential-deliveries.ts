import type { PostgresClient } from "./postgres-state.ts";

export interface CredentialDeliveryKey {
  readonly revisionId: string;
  readonly bindingId: string;
}

/** Delivery facts, never issuer material. The selected Driver interprets target and
 * policy observations; OCC owns their identity, write fence and unknown outcome. */
export interface CredentialDeliverySnapshot {
  readonly desired: Readonly<Record<string, unknown>>;
  readonly observed?: Readonly<Record<string, unknown>>;
  readonly material?: { readonly materialVersion: string; readonly preparationAttemptId: string };
  readonly retainedPolicyHash?: string;
}

export class CredentialDeliveries {
  private readonly client: PostgresClient;

  constructor(client: PostgresClient) {
    this.client = client;
  }

  async open(
    key: CredentialDeliveryKey & { readonly namespaceId: string; readonly agentId: string },
    target: Readonly<Record<string, unknown>>,
    worker: string,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO occ.credential_deliveries
        (revision_id,live_revision_id,binding_id,namespace_id,agent_id,target,worker_instance,settlement,write_pending)
       VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6,'snapshot','bootstrap')`,
      [key.revisionId, key.bindingId, key.namespaceId, key.agentId, JSON.stringify(target), worker],
    );
  }

  /** Register an independently authenticated recipient already checked against release.
   * The immutable target includes the selected Driver, policy and exact execution. */
  async observe(
    key: CredentialDeliveryKey & { readonly namespaceId: string; readonly agentId: string },
    target: Readonly<Record<string, unknown>>,
    worker: string,
  ): Promise<number | undefined> {
    const values = [
      key.revisionId,
      key.bindingId,
      key.namespaceId,
      key.agentId,
      JSON.stringify(target),
      worker,
    ];
    await this.client.query(
      `INSERT INTO occ.credential_deliveries
        (revision_id,live_revision_id,binding_id,namespace_id,agent_id,target,worker_instance,settlement)
       VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6,'witness')
       ON CONFLICT (revision_id,binding_id) DO NOTHING`,
      values,
    );
    const { rows } = await this.client.query(
      `SELECT fence FROM occ.credential_deliveries WHERE revision_id=$1 AND binding_id=$2
       AND namespace_id=$3 AND agent_id=$4 AND target=$5::jsonb
       AND settlement='witness' AND write_pending IS NULL AND blocked IS NULL AND live_revision_id IS NOT NULL`,
      values.slice(0, 5),
    );
    return rows.length === 1 ? Number((rows[0] as { fence: string }).fence) : undefined;
  }

  /** Reserve exactly one installation. A pending operation is never adopted as a new send. */
  async beginInstall(
    key: CredentialDeliveryKey,
    fence: number,
    target: Readonly<Record<string, unknown>>,
    material: NonNullable<CredentialDeliverySnapshot["material"]>,
  ): Promise<number | undefined> {
    const { rows } = await this.client.query(
      `UPDATE occ.credential_deliveries SET write_pending='rotate',fence=fence+1,
         operation_fence=fence+1,
         target_preparation_attempt_id=$5,target_material_version=$6,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND target=$4::jsonb
         AND settlement='witness' AND live_revision_id IS NOT NULL AND blocked IS NULL AND write_pending IS NULL
         AND (preparation_attempt_id,material_version) IS DISTINCT FROM ($5::uuid,$6::uuid)
       RETURNING fence`,
      [
        key.revisionId,
        key.bindingId,
        fence,
        JSON.stringify(target),
        material.preparationAttemptId,
        material.materialVersion,
      ],
    );
    return rows.length === 1 ? Number((rows[0] as { fence: string }).fence) : undefined;
  }

  /** An authenticated readback settles the original operation, even after withdrawal,
   * lease replacement or execution deletion. It cannot reopen the delivery. */
  async confirmInstall(
    key: CredentialDeliveryKey,
    operationFence: number,
    target: Readonly<Record<string, unknown>>,
    material: NonNullable<CredentialDeliverySnapshot["material"]>,
  ): Promise<number | undefined> {
    const { rows } = await this.client.query(
      `UPDATE occ.credential_deliveries SET preparation_attempt_id=target_preparation_attempt_id,material_version=target_material_version,
         write_pending=NULL,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND operation_fence=$3 AND target=$4::jsonb
         AND settlement='witness' AND write_pending='rotate'
         AND (target_preparation_attempt_id,target_material_version)=($5::uuid,$6::uuid)
       RETURNING fence`,
      [
        key.revisionId,
        key.bindingId,
        operationFence,
        JSON.stringify(target),
        material.preparationAttemptId,
        material.materialVersion,
      ],
    );
    return rows.length === 1 ? Number((rows[0] as { fence: string }).fence) : undefined;
  }

  async adopt(key: CredentialDeliveryKey, worker: string, closeReason?: string): Promise<void> {
    // A pending write stays pending. A replacement can inspect it, but cannot turn
    // an unknown provider outcome into another installation attempt.
    await this.client.query(
      `UPDATE occ.credential_deliveries SET fence=fence+1, worker_instance=$3,
         adopted_at=clock_timestamp(), updated_at=clock_timestamp(),
         blocked=coalesce($4,blocked)
       WHERE revision_id=$1 AND binding_id=$2 AND blocked IS NULL AND live_revision_id IS NOT NULL`,
      [key.revisionId, key.bindingId, worker, closeReason ?? null],
    );
  }

  async writing(
    key: CredentialDeliveryKey,
    fence: number,
    operation: "bootstrap" | "rotate",
    material?: CredentialDeliverySnapshot["material"],
  ): Promise<number | undefined> {
    const { rows } = await this.client.query(
      `UPDATE occ.credential_deliveries SET write_pending=$4,target_material_version=$5,target_preparation_attempt_id=$6,
         fence=fence+1,operation_fence=fence+1,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND blocked IS NULL
         AND settlement='snapshot' AND write_pending IS NULL AND live_revision_id IS NOT NULL
         AND ($4 <> 'rotate' OR $5::uuid IS NOT NULL)
       RETURNING fence`,
      [
        key.revisionId,
        key.bindingId,
        fence,
        operation,
        material?.materialVersion ?? null,
        material?.preparationAttemptId ?? null,
      ],
    );
    return rows.length === 1 ? Number((rows[0] as { fence: string }).fence) : undefined;
  }

  /** The reserving worker proved that no external write was sent. Never use after
   * a lost reply or worker replacement; retain the last committed snapshot. */
  async cancelWriting(key: CredentialDeliveryKey, fence: number): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE occ.credential_deliveries SET write_pending=NULL,
         target_material_version=NULL,target_preparation_attempt_id=NULL,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND operation_fence=$3
         AND settlement='snapshot' AND write_pending IS NOT NULL
         AND blocked IS NULL AND live_revision_id IS NOT NULL`,
      [key.revisionId, key.bindingId, fence],
    );
    return result.rowCount === 1;
  }

  // A replacement lease cannot settle a material write from a snapshot alone.
  // Only confirmInstall accepts an independent witness of the original operation.
  async record(
    key: CredentialDeliveryKey,
    fence: number,
    snapshot: CredentialDeliverySnapshot,
  ): Promise<boolean> {
    return (
      (
        await this.client.query(
          `UPDATE occ.credential_deliveries SET desired=$4::jsonb,observed=$5::jsonb,
         material_version=$6,preparation_attempt_id=$7,write_pending=NULL,
         target_material_version=NULL,target_preparation_attempt_id=NULL,
         retained_policy_hash=coalesce(retained_policy_hash,$8),updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND blocked IS NULL
         AND settlement='snapshot' AND live_revision_id IS NOT NULL
         AND (write_pending IS NULL OR operation_fence=fence)
         AND (CASE WHEN write_pending IS NOT NULL
           THEN (target_material_version,target_preparation_attempt_id) IS NOT DISTINCT FROM ($6::uuid,$7::uuid)
           ELSE (material_version,preparation_attempt_id) IS NOT DISTINCT FROM ($6::uuid,$7::uuid) END)
         AND ($8::text IS NULL OR retained_policy_hash IS NULL OR retained_policy_hash=$8)`,
          [
            key.revisionId,
            key.bindingId,
            fence,
            JSON.stringify(snapshot.desired),
            snapshot.observed ? JSON.stringify(snapshot.observed) : null,
            snapshot.material?.materialVersion ?? null,
            snapshot.material?.preparationAttemptId ?? null,
            snapshot.retainedPolicyHash ?? null,
          ],
        )
      ).rowCount === 1
    );
  }

  async block(key: CredentialDeliveryKey, fence: number, reason: string): Promise<boolean> {
    return (
      (
        await this.client.query(
          `UPDATE occ.credential_deliveries SET blocked=$4,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND blocked IS NULL AND live_revision_id IS NOT NULL`,
          [key.revisionId, key.bindingId, fence, reason],
        )
      ).rowCount === 1
    );
  }

  async withdraw(
    keys: readonly CredentialDeliveryKey[],
    reason: string,
    replacing?: string,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.client.query(
      `UPDATE occ.credential_deliveries d SET blocked=$3,updated_at=clock_timestamp()
       FROM unnest($1::text[],$2::text[]) AS selected(revision_id,binding_id)
       WHERE d.revision_id=selected.revision_id AND d.binding_id=selected.binding_id
         AND (d.blocked IS NULL OR d.blocked=$4)`,
      [
        keys.map(({ revisionId }) => revisionId),
        keys.map(({ bindingId }) => bindingId),
        reason,
        replacing ?? null,
      ],
    );
  }
}
