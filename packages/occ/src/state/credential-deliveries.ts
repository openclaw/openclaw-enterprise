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
        (revision_id,binding_id,namespace_id,agent_id,target,worker_instance,write_pending)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'bootstrap')`,
      [key.revisionId, key.bindingId, key.namespaceId, key.agentId, JSON.stringify(target), worker],
    );
  }

  async adopt(key: CredentialDeliveryKey, worker: string, closeReason?: string): Promise<void> {
    // A pending write stays pending. A replacement can inspect it, but cannot turn
    // an unknown provider outcome into another installation attempt.
    await this.client.query(
      `UPDATE occ.credential_deliveries SET fence=fence+1, worker_instance=$3,
         adopted_at=clock_timestamp(), updated_at=clock_timestamp(),
         blocked=coalesce($4,blocked), write_pending=CASE WHEN $4::text IS NULL THEN write_pending ELSE NULL END
       WHERE revision_id=$1 AND binding_id=$2 AND blocked IS NULL`,
      [key.revisionId, key.bindingId, worker, closeReason ?? null],
    );
  }

  async writing(
    key: CredentialDeliveryKey,
    fence: number,
    operation: "bootstrap" | "rotate",
    material?: CredentialDeliverySnapshot["material"],
  ): Promise<boolean> {
    return (
      (
        await this.client.query(
          `UPDATE occ.credential_deliveries SET write_pending=$4,target_material_version=$5,target_preparation_attempt_id=$6,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND blocked IS NULL AND write_pending IS NULL`,
          [
            key.revisionId,
            key.bindingId,
            fence,
            operation,
            material?.materialVersion ?? null,
            material?.preparationAttemptId ?? null,
          ],
        )
      ).rowCount === 1
    );
  }

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
          `UPDATE occ.credential_deliveries SET blocked=$4,write_pending=NULL,updated_at=clock_timestamp()
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND blocked IS NULL`,
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
      `UPDATE occ.credential_deliveries d SET blocked=$3,write_pending=NULL,updated_at=clock_timestamp()
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
