import type { GithubRosterMapping } from "../ports/github-roster.ts";
import { ResourceStateConflictError, ScopeViolationError } from "../errors.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

export type { GithubRosterMapping } from "../ports/github-roster.ts";

export interface GithubRosterSignInClaim {
  readonly mapping: GithubRosterMapping;
  readonly generation: string;
  readonly methodId: string;
  readonly subject: string;
  readonly version: string;
}

export interface GithubRosterRefreshClaim {
  readonly mapping: GithubRosterMapping;
  readonly generation: string;
  readonly claimId: string;
  readonly subjects: readonly string[];
}

export type GithubRosterObservation =
  | {
      readonly status: "complete";
      readonly presentSubjects: readonly string[];
      readonly confirmedAbsentSubjects: readonly string[];
    }
  | { readonly status: "unavailable" };

export interface GithubRosterStatus {
  readonly status: "pending" | "running" | "complete" | "unavailable";
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulAt: string | null;
}

export function mappingParameters(mapping: GithubRosterMapping): readonly string[] {
  return [mapping.id, mapping.providerId, mapping.organizationId, mapping.teamId, mapping.groupId];
}

// Every observation must still name precisely the active target at settlement.
export const activeRosterMapping = `mapping_id = $1 AND provider_id = $2 AND
  organization_id = $3 AND team_id = $4 AND group_id = $5 AND generation IS NOT NULL`;

/** Called under the Installation IAM configuration lock, after its Group changes. */
export async function syncGithubRosterMappings(
  client: PostgresQueryClient,
  desired: readonly GithubRosterMapping[],
): Promise<void> {
  const retiring = await client.query(
    `UPDATE occ.github_roster_mappings m SET generation=NULL, refresh_id=NULL
     WHERE generation IS NOT NULL AND NOT EXISTS (
       SELECT FROM jsonb_to_recordset($1::jsonb) d(id text, "providerId" text, "organizationId" text, "teamId" text, "groupId" text)
       WHERE (m.mapping_id,m.provider_id,m.organization_id,m.team_id,m.group_id) =
         (d.id,d."providerId",d."organizationId",d."teamId",d."groupId"))
     RETURNING key`,
    [JSON.stringify(desired)],
  );
  for (const { key } of retiring.rows as { key: string }[]) {
    await client.query(
      `DELETE FROM occ.iam_group_memberships g USING occ.github_roster_sources s
      WHERE g.roster_source_id=s.id AND s.mapping_key=$1`,
      [key],
    );
  }
  for (const mapping of desired) {
    const valid = await client.query(
      `SELECT id FROM occ.iam_groups WHERE id=$1 AND namespace_id IS NULL`,
      [mapping.groupId],
    );
    if (!valid.rowCount) {
      throw new ScopeViolationError(
        "A GitHub roster mapping requires a configured Installation Group.",
      );
    }
    await client.query(
      `INSERT INTO occ.github_roster_mappings
      (mapping_id,provider_id,organization_id,team_id,group_id,generation)
      VALUES ($1,$2,$3,$4,$5,gen_random_uuid()) ON CONFLICT
      (mapping_id,provider_id,organization_id,team_id,group_id) DO UPDATE SET
        generation=EXCLUDED.generation,refresh_id=NULL,status='pending',next_refresh_at=clock_timestamp(),
        last_attempt_at=NULL,last_successful_at=NULL WHERE github_roster_mappings.generation IS NULL`,
      mappingParameters(mapping),
    );
  }
}

export function unavailableMapping(): ResourceStateConflictError {
  return new ResourceStateConflictError("The configured GitHub roster mapping has changed.");
}
