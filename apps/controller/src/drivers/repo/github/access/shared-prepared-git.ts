import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { DriverRegistrationRef } from "@openclaw-enterprise/contracts";
import type { PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";
import type { InstalledTokenVersion } from "../../../../backends/token-service/material.ts";
import type { GitHubPreparationAdmission } from "./prepared-contracts.ts";
import { PreparedGitHubPostgres, preparedAttemptSettled } from "./prepared-postgres.ts";
import type { PreparedRepositoryGitSource } from "./prepared-repository-git.ts";
import { prepareProviderScope, type ProviderScope } from "./provider-transport/request-options.ts";
import type { GitHubRepositoryGrant } from "./repository-grant.ts";

export const sharedRepositoryGitAdoption = "credential_proxy_shared_github_repository";

const families = "occ.prepared_github_families";
const attempts = "occ.prepared_github_attempts";
const members = "occ.prepared_github_shared_members";
const issuers = "occ.prepared_github_shared_issuers";
const sharedIssuer = { kind: "worker-mounted-github-app-key" } as const;

interface SharedGitHubOwner {
  readonly pool: PostgresPool;
  readonly custodyKey: Buffer;
  readonly issuerAuthority: string;
  readonly apiOrigin: string;
  readonly driver: DriverRegistrationRef;
  readonly repositoryBackendId: string;
  readonly providerInstanceId: string;
  readonly issuerGeneration: number;
  /** The existing server-owned query for current selected Git sessions. */
  readonly liveSessions: string;
}

type SharedGitHubSource = Readonly<{
  adoption: typeof sharedRepositoryGitAdoption;
  key: Readonly<{ source: Readonly<{ id: string }> }>;
  enrollment: Readonly<{
    issuerId: string;
    installationId: string;
    namespaceId: string;
    repositoryBackendId: string;
    providerInstanceId: string;
    driver: DriverRegistrationRef;
  }>;
  issuance: Extract<ProviderScope["issuance"], { kind: "selected" }>;
  grant: GitHubRepositoryGrant;
}>;

const ownerScope =
  "f.source #> '{enrollment,driver}' = current_setting('occ.repository_git_driver', true)::jsonb";
const hasLiveMember = (liveSessions: string) => `EXISTS (
  SELECT FROM ${members} m JOIN (${liveSessions}) l ON l.session=m.source->'session'
  WHERE m.family_id=f.source_id)`;

function scopeFamilyId(
  enrollment: SharedGitHubSource["enrollment"],
  issuance: SharedGitHubSource["issuance"],
): string {
  const digest = createHash("sha256")
    .update("occ:shared-github-repository:family:v1\0")
    .update(JSON.stringify([enrollment, issuance]))
    .digest("hex");
  return "repository-git-shared:" + digest;
}

/**
 * Shared material custody for explicitly selected repository sets. Each source stays attached
 * to its own session. Callers must independently lock and check that session before attaching
 * or reading a member; family identity is never an authorization for a Git request.
 */
export class SharedPreparedRepositoryGit extends PreparedGitHubPostgres {
  readonly #options: SharedGitHubOwner;
  readonly #live: string;

  constructor(options: SharedGitHubOwner) {
    const live = hasLiveMember(options.liveSessions);
    super(options.pool, options.custodyKey, options.issuerAuthority, {
      active: live,
      adoption: [sharedRepositoryGitAdoption],
      owns: ownerScope,
      driver: options.driver,
      omitSettledAttempts: true,
    });
    this.#options = options;
    this.#live = live;
  }

  private async installation(c: PostgresClient) {
    const { rows } = await c.query("SELECT id FROM occ.installation");
    const [installation] = rows as { id?: unknown }[];
    if (rows.length !== 1 || typeof installation?.id !== "string") {
      return undefined;
    }
    const { repositoryBackendId, providerInstanceId, driver } = this.#options;
    const issuerId = createHash("sha256")
      .update("occ:shared-github-repository:issuer:v1\0")
      .update(
        JSON.stringify([
          installation.id,
          repositoryBackendId,
          providerInstanceId,
          driver.id,
          driver.implementation,
          driver.configurationId,
        ]),
      )
      .digest("hex");
    return { installationId: installation.id, issuerId };
  }

  /** Advance the Worker-selected generation before binding the Git listener. The ledger lock
   * orders this change against both material selection and attachment, even for new families. */
  async observeIssuer(inputVersion: string) {
    const { issuerGeneration, issuerAuthority } = this.#options;
    return this.transaction(async (c) => {
      const installation = await this.installation(c);
      if (!installation) {
        return false;
      }
      const { issuerId } = installation;
      await c.query(
        `INSERT INTO ${issuers} (issuer_id, generation, authority, input_version)
         VALUES ($1,$2,$3,$4) ON CONFLICT (issuer_id) DO NOTHING`,
        [issuerId, issuerGeneration, issuerAuthority, inputVersion],
      );
      const { rows } = await c.query(
        `SELECT generation::text, authority, input_version FROM ${issuers}
          WHERE issuer_id=$1 FOR UPDATE`,
        [issuerId],
      );
      const [current] = rows as { generation: string; authority: string; input_version: string }[];
      if (!current) {
        return false;
      }
      const generation = Number(current.generation);
      if (issuerGeneration <= generation) {
        return (
          issuerGeneration === generation &&
          current.authority === issuerAuthority &&
          current.input_version === inputVersion
        );
      }
      await c.query(
        `UPDATE ${issuers} SET generation=$2, authority=$3, input_version=$4 WHERE issuer_id=$1`,
        [issuerId, issuerGeneration, issuerAuthority, inputVersion],
      );
      await c.query(
        `WITH stopped AS (
           UPDATE ${families} SET enabled=false, worker_claim=NULL
           WHERE source #>> '{enrollment,issuerId}'=$1 AND enabled
           RETURNING source_id)
         UPDATE ${attempts} a SET custody='retire'
         FROM stopped s WHERE a.source_id=s.source_id AND a.custody='current'`,
        [issuerId],
      );
      return true;
    });
  }

  private async currentIssuer(c: PostgresClient, issuerId: string, inputVersion?: string) {
    const { issuerGeneration, issuerAuthority } = this.#options;
    const result = await c.query(
      `SELECT FROM ${issuers} WHERE issuer_id=$1 AND generation=$2 AND authority=$3
       AND ($4::text IS NULL OR input_version=$4) FOR SHARE`,
      [issuerId, issuerGeneration, issuerAuthority, inputVersion ?? null],
    );
    return result.rowCount === 1;
  }

  private async source(c: PostgresClient, member: PreparedRepositoryGitSource) {
    const { grant, session } = member;
    if (
      member.adoption !== "credential_proxy_github_repository" ||
      grant.profile !== "github-repository" ||
      session.binding.profile !== "github-repository" ||
      session.binding.grant.providerInstanceId !== this.#options.providerInstanceId
    ) {
      return undefined;
    }
    const installation = await this.installation(c);
    if (!installation) {
      return undefined;
    }
    const scope = prepareProviderScope(this.#options.apiOrigin, grant);
    if (scope.issuance.kind !== "selected" || scope.kind !== "selected") {
      return undefined;
    }
    const enrollment = {
      ...installation,
      namespaceId: session.namespaceId,
      repositoryBackendId: this.#options.repositoryBackendId,
      providerInstanceId: session.binding.grant.providerInstanceId,
      driver: {
        id: this.#options.driver.id,
        implementation: this.#options.driver.implementation,
        configurationId: this.#options.driver.configurationId,
      },
    };
    const familyId = scopeFamilyId(enrollment, scope.issuance);
    return {
      adoption: sharedRepositoryGitAdoption,
      key: { source: { id: familyId } },
      enrollment,
      issuance: scope.issuance,
      grant: {
        profile: "github-repository",
        id: familyId,
        isolationId: enrollment.namespaceId,
        appId: grant.appId,
        installationId: grant.installationId,
        repositories: scope.repositories.map(({ id, name }) => ({
          repositoryId: String(id),
          repository: name,
        })),
        permissions: scope.issuance.permissions,
      },
    } satisfies SharedGitHubSource;
  }

  /** Attach only after the caller has locked and verified the originating live Git session. */
  async attach(c: PostgresClient, member: PreparedRepositoryGitSource, inputVersion: string) {
    const source = await this.source(c, member);
    if (!source || !(await this.currentIssuer(c, source.enrollment.issuerId, inputVersion))) {
      return undefined;
    }
    const familyId = source.key.source.id;
    const proposed: GitHubPreparationAdmission = {
      familyId,
      issuerAuthority: this.#options.issuerAuthority,
      generation: 1,
      ownerEpoch: this.#options.issuerGeneration,
      inputVersion,
      grant: source.grant,
    };
    await c.query(
      `INSERT INTO ${families} (source_id,source,issuer,admission) VALUES ($1,$2,$3,$4)
      ON CONFLICT (source_id) DO NOTHING`,
      [familyId, source, sharedIssuer, proposed],
    );
    const { rows } = await c.query(
      `SELECT admission, enabled FROM ${families} f WHERE source_id=$1 AND source=$2::jsonb
      AND issuer=$3::jsonb AND ${ownerScope} FOR UPDATE OF f`,
      [familyId, source, sharedIssuer],
    );
    const row = rows[0] as { admission: GitHubPreparationAdmission; enabled: boolean } | undefined;
    if (!row) {
      return undefined;
    }
    const old = row.admission;
    // The ledger has already fenced any superseded generation. Re-enroll only once
    // the old material has left this family and every attempt is settled.
    if (
      old.issuerAuthority !== proposed.issuerAuthority ||
      old.inputVersion !== proposed.inputVersion ||
      old.ownerEpoch !== proposed.ownerEpoch ||
      !row.enabled
    ) {
      if (row.enabled) {
        return undefined;
      }
      const restored = await c.query(
        `UPDATE ${families} SET admission=$2, enabled=true WHERE source_id=$1 AND NOT EXISTS (
           SELECT FROM ${attempts} a WHERE a.source_id=$1 AND NOT ${preparedAttemptSettled("a")})
         RETURNING source_id`,
        [familyId, { ...proposed, generation: old.generation + 1 }],
      );
      if (restored.rowCount !== 1) {
        return undefined;
      }
    }
    await c.query(
      `INSERT INTO ${members} (admission_id, family_id, source) VALUES ($1,$2,$3)
       ON CONFLICT (admission_id) DO NOTHING`,
      [member.session.admissionId, familyId, member],
    );
    const linked = await c.query(
      `SELECT f.admission FROM ${members} m JOIN ${families} f ON f.source_id=m.family_id
       WHERE m.admission_id=$1 AND m.family_id=$2 AND m.source=$3::jsonb`,
      [member.session.admissionId, familyId, member],
    );
    const [selected] = linked.rows as { admission?: GitHubPreparationAdmission }[];
    const admission = selected?.admission;
    if (linked.rowCount !== 1 || !admission || !isDeepStrictEqual(admission.grant, source.grant)) {
      return undefined;
    }
    return { admission, store: this.store(source, null) };
  }

  private async boundSource(c: PostgresClient, member: PreparedRepositoryGitSource) {
    const source = await this.source(c, member);
    if (!source || !(await this.currentIssuer(c, source.enrollment.issuerId))) {
      return undefined;
    }
    const linked = await c.query(
      `SELECT FROM ${members}
       WHERE admission_id=$1 AND family_id=$2 AND source=$3::jsonb`,
      [member.session.admissionId, source.key.source.id, member],
    );
    return linked.rowCount === 1 ? source : undefined;
  }

  /** Poll only an existing live intent. A quarantined or lost answer remains in custody. */
  async waitForVersion(
    admission: GitHubPreparationAdmission,
    deadline: number,
    signal: AbortSignal,
  ): Promise<InstalledTokenVersion | undefined> {
    while (!signal.aborted && Date.now() < deadline) {
      const row = await this.transaction(async (c) => {
        const { rows } = await c.query(
          `SELECT material.id AS "preparationAttemptId", material.material_version AS "materialVersion",
             EXISTS (
               SELECT FROM ${attempts} a WHERE a.source_id=f.source_id
                 AND a.admission=f.admission AND a.state='issuing'
                 AND NOT ${preparedAttemptSettled("a")}
             ) AS waiting
           FROM ${families} f
           LEFT JOIN ${attempts} material ON material.source_id=f.source_id
             AND material.admission=f.admission AND material.state='committed'
             AND material.custody='current' AND material.usable_until > clock_timestamp()
           WHERE f.source_id=$1 AND f.admission=$2::jsonb AND f.enabled AND ${ownerScope}`,
          [admission.familyId, admission],
        );
        return rows[0] as (InstalledTokenVersion & { waiting: boolean }) | undefined;
      });
      if (signal.aborted || Date.now() >= deadline) {
        return undefined;
      }
      if (row?.preparationAttemptId && row.materialVersion) {
        return {
          preparationAttemptId: row.preparationAttemptId,
          materialVersion: row.materialVersion,
        };
      }
      if (!row?.waiting) {
        return undefined;
      }
      await delay(Math.min(25, deadline - Date.now()), undefined, { signal });
    }
    return undefined;
  }

  async readMember(
    c: PostgresClient,
    member: PreparedRepositoryGitSource,
    installed: InstalledTokenVersion,
  ) {
    const source = await this.boundSource(c, member);
    const selected = source && (await this.tokens.readWarm(c, source));
    return selected?.preparationAttemptId === installed.preparationAttemptId &&
      selected.materialVersion === installed.materialVersion
      ? selected
      : undefined;
  }

  /** Keep material when any independently admitted member is still live. */
  async retireUnused() {
    await this.transaction(async (c) => {
      // Link insertion locks the family first. Recheck liveness with a fresh snapshot after
      // taking those locks so concurrent enrollment cannot retire material underneath a member.
      const { rows } = await c.query(
        `SELECT source_id FROM ${families} f
         WHERE enabled AND ${this.retiringFamily("$1", `NOT ${this.#live}`)}
         LIMIT 32 FOR UPDATE OF f SKIP LOCKED`,
        [[sharedRepositoryGitAdoption]],
      );
      const ids = (rows as { source_id: string }[]).map((r) => r.source_id);
      if (ids.length > 0) {
        await c.query(
          `WITH stopped AS (
             UPDATE ${families} f SET enabled=false
             WHERE source_id=ANY($1::text[]) AND NOT ${this.#live}
             RETURNING source_id)
           UPDATE ${attempts} a SET custody='retire'
           FROM stopped s WHERE a.source_id=s.source_id AND a.custody='current'`,
          [ids],
        );
      }
    });
  }
}
