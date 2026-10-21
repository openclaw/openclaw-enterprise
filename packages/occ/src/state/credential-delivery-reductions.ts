import type { PostgresClient } from "./postgres-state.ts";

/** Public, nonsecret identity of the delivery being reduced. The Driver owns the
 * recipient shape; OCC compares it exactly and never interprets provider fields. */
export interface CredentialDeliveryReduction {
  readonly revisionId: string;
  readonly bindingId: string;
  readonly fence: number;
  readonly recipient: Readonly<Record<string, unknown>>;
  readonly materialVersion: string;
  readonly retainedPolicyHash: string;
}

export interface CredentialDeliveryReductionProgress {
  readonly requestId?: string;
  readonly observedGeneration?: string;
}

/** Use the caller's transaction so authorization withdrawal and its delivery intent
 * commit together. An uncertain send consumes its one opportunity even across restart. */
export class CredentialDeliveryReductions {
  private readonly client: PostgresClient;

  constructor(client: PostgresClient) {
    this.client = client;
  }

  async desire(
    identity: CredentialDeliveryReduction,
  ): Promise<CredentialDeliveryReductionProgress> {
    const values = [
      identity.revisionId,
      identity.bindingId,
      identity.fence,
      JSON.stringify(identity.recipient),
      identity.materialVersion,
      identity.retainedPolicyHash,
    ];
    await this.client.query(
      `INSERT INTO occ.credential_delivery_reductions
         (revision_id, binding_id, fence, recipient, material_version, retained_policy_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (revision_id,binding_id) DO NOTHING`,
      values,
    );
    const { rows } = await this.client.query(
      `SELECT request_id, observed_generation FROM occ.credential_delivery_reductions
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND recipient=$4::jsonb
         AND material_version=$5 AND retained_policy_hash=$6`,
      values,
    );
    if (rows.length !== 1) {
      throw new Error("Credential delivery reduction identity changed.");
    }
    const row = rows[0] as { request_id: string | null; observed_generation: string | null };
    return {
      ...(row.request_id && { requestId: row.request_id }),
      ...(row.observed_generation && { observedGeneration: row.observed_generation as string }),
    };
  }

  async begin(
    revisionId: string,
    bindingId: string,
    fence: number,
    retainedPolicyHash: string,
    requestId: string,
    expectedVersion: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE occ.credential_delivery_reductions SET request_id=$5, expected_version=$6
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND retained_policy_hash=$4
         AND request_id IS NULL`,
      [revisionId, bindingId, fence, retainedPolicyHash, requestId, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async confirm(
    revisionId: string,
    bindingId: string,
    fence: number,
    retainedPolicyHash: string,
    requestId: string,
    generation: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE occ.credential_delivery_reductions SET observed_generation=$6
       WHERE revision_id=$1 AND binding_id=$2 AND fence=$3 AND retained_policy_hash=$4
         AND request_id=$5 AND (observed_generation IS NULL OR observed_generation=$6)`,
      [revisionId, bindingId, fence, retainedPolicyHash, requestId, generation],
    );
    return result.rowCount === 1;
  }
}
