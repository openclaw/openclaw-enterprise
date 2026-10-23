import { isDeepStrictEqual } from "node:util";
import type {
  PreparedTokenCurrentProof,
  PreparedTokenSource,
} from "@openclaw-enterprise/contracts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

// Do not trust enrollment alone. A tombstone, an in-place change to the grant or a different
// issuer reference fences use even if management crashed before reaching this repository.
// The grant names one Agent: once its deletion begins (one-way), nothing renews or uses it.
export const preparedGitHubLive = (states: "'ready'" | "'registering','ready'") => `EXISTS (
 SELECT 1 FROM occ.credential_sources s JOIN occ.credential_source_secrets r
 ON r.namespace_id=s.namespace_id AND r.credential_source_id=s.id AND r.field='private_key'
 JOIN occ.secrets k ON k.namespace_id=r.namespace_id AND k.id=r.secret_id
 JOIN occ.installation i ON i.id=f.source #>> '{key,installationId}'
 JOIN occ.agents g ON g.namespace_id=s.namespace_id AND g.id=f.source #>> '{grant,isolationId}'
 AND g.status='active'
 WHERE s.id=f.source_id AND s.egress=f.source AND s.config->>'authority'='execution' AND s.state IN (${states})
 AND k.id=f.issuer->>'id' AND k.driver_id=f.issuer->>'driverId'
 AND k.backend_uid=f.issuer #>> '{backendRef,uid}' AND s.namespace_id=f.source #>> '{key,namespaceId}')`;

interface Metadata {
  admission: {
    familyId: string;
    generation: number;
    ownerEpoch: number;
    inputVersion: string;
    grant: { id: string; isolationId: string };
  };
  id: string;
  material_version: string;
  provider_expires_at: Date;
  usable_until: Date;
}

/** Shared authoritative selection for custody reads and transaction-bound proof. Never projects bytes. */
export async function readPreparedGitHubMetadata(
  client: PostgresQueryClient,
  source: PreparedTokenSource,
  issuerAuthority: string,
): Promise<Metadata | undefined> {
  const { rows } = await client.query(
    `SELECT f.admission,id,material_version,provider_expires_at,usable_until
    FROM occ.prepared_github_families f JOIN occ.prepared_github_attempts a USING(source_id)
    WHERE f.source_id=$1 AND f.source=$2::jsonb AND enabled AND ${preparedGitHubLive("'ready'")}
    AND custody='current' AND a.admission=f.admission AND a.admission->>'issuerAuthority'=$3
    AND NOT EXISTS (SELECT 1 FROM occ.egress_rejected_material r
      WHERE r.namespace_id=f.source #>> '{key,namespaceId}'
        AND r.secret_driver_id=f.source #>> '{key,provider,id}'
        AND r.material_id=f.source_id AND r.material_version=a.material_version::text)
    AND usable_until > clock_timestamp()
    AND usable_until < clock_timestamp() + interval '61 minutes' FOR SHARE OF f,a`,
    [source.key.source.id, source, issuerAuthority],
  );
  return rows[0] as Metadata | undefined;
}

export function postgresPreparedGitHubProof(
  client: PostgresQueryClient,
): PreparedTokenCurrentProof {
  return {
    async current(source, evidence, issuerAuthority, lifetime) {
      const until = Math.min(Date.parse(lifetime.deadlineAt), Date.parse(evidence.usableUntil));
      const active = () => !lifetime.signal.aborted && Date.now() < until;
      if (
        source.schemaVersion !== 2 ||
        source.grant.kind !== "github_repository_metadata" ||
        !active()
      ) {
        return false;
      }
      const { rows } = await client.query(
        `SELECT name, setting, pg_catalog.current_setting(name) AS original
         FROM pg_catalog.pg_settings WHERE name IN ('statement_timeout', 'lock_timeout')`,
      );
      const settings = rows as { name: string; setting: string; original: string }[];
      const statement = settings.find((row) => row.name === "statement_timeout")!;
      const lock = settings.find((row) => row.name === "lock_timeout")!;
      const bounded = (setting: string, cap: number) =>
        String(Math.max(1, Math.min(Number(setting) || Infinity, cap, until - Date.now())));
      if (!active()) {
        return false;
      }
      // These settings use milliseconds in pg_settings. Preserve tighter caller limits.
      await client.query(
        "SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)",
        [bounded(statement.setting, 4000), bounded(lock.setting, 1000)],
      );
      const m = active()
        ? await readPreparedGitHubMetadata(client, source, issuerAuthority)
        : undefined;
      // Successful SQL must not change later work in this unit. SQL errors leave the
      // transaction aborted: let its owner roll back without masking the original error.
      await client.query(
        "SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)",
        [statement.original, lock.original],
      );
      if (!m || !active()) {
        return false;
      }
      const a = m.admission;
      return (
        isDeepStrictEqual(evidence.family, { id: a.familyId, generation: a.generation }) &&
        evidence.ownerEpoch === a.ownerEpoch &&
        evidence.inputVersion === a.inputVersion &&
        evidence.grantHash === a.grant.id &&
        evidence.isolationId === a.grant.isolationId &&
        evidence.preparationAttemptId === m.id &&
        evidence.materialId === a.familyId &&
        evidence.materialVersion === m.material_version &&
        evidence.providerExpiresAt === m.provider_expires_at.toISOString() &&
        Date.parse(evidence.usableUntil) <= m.usable_until.getTime()
      );
    },
  };
}
