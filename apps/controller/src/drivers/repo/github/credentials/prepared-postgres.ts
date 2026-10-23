import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  issueAttemptDispatchWindowMs,
  issueAttemptLiveBoundMs,
  providerClockSkewMs,
} from "./driver/lifetime.ts";
import type { PreparedGitHubEgressSource, Secret } from "@openclaw-enterprise/contracts";
import { preparedGitHubLive as live, readPreparedGitHubMetadata } from "@openclaw-enterprise/occ";
import type { PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";
import type {
  GitHubPreparationAdmission as Admission,
  GitHubPreparationAttempt as Attempt,
  GitHubPreparationFamily as Family,
  GitHubPreparationStore,
} from "./prepared-contracts.ts";
import type {
  CurrentTokenVersion,
  InstalledTokenVersion,
  TokenMaterialReader,
} from "../../../../backends/token-service/material.ts";

// The provider expiry is an authenticated issuance result. The same clock-skew allowance
// subtracted for use is added before we can conclude that the provider lifetime elapsed.
const standingGitExpiry = `CASE WHEN f.source->>'adoption' IN ('prepared_repository_git',
    'credential_proxy_repository_git','credential_proxy_github_installation')
  AND f.source #>> '{session,standingApprovalId}' IS NOT NULL AND NOT f.enabled
  AND a.state='committed' AND a.material_version IS NOT NULL
  AND a.admission=f.admission AND isfinite(a.provider_expires_at)
  AND a.usable_until < a.provider_expires_at THEN a.provider_expires_at END`;

// An attempt settles when no token from it can still be live: revoked, locally expired, refused
// by an answer that carried no token, or past both bounds: issueAttemptLiveBoundMs after its
// intent, and any verified provider expiry plus skew. 'current' is live custody, never settled
// by time. 'intent', 'retire', 'revoking' and 'unknown' (lost issue or revocation) settle by time.
const settledAfter = (
  a: string,
) => `greatest(${a}.started_at + ${issueAttemptLiveBoundMs} * interval '1 millisecond',
  ${a}.provider_expires_at + ${providerClockSkewMs} * interval '1 millisecond')`;
export const preparedAttemptSettled = (
  a: string,
) => `(${a}.custody IN ('revoked','expired','not_issued')
  OR (${a}.custody <> 'current' AND ${settledAfter(a)} <= clock_timestamp()))`;

const active = live("'ready'");
const enrolling = live("'registering','ready'");
const matching = "f.source_id = $1 AND f.source = $2::jsonb";
const families = "occ.prepared_github_families";
const attempts = "occ.prepared_github_attempts";
type Source = PreparedGitHubEgressSource;
type TokenSource = {
  readonly key: { readonly source: { readonly id: string } };
  readonly grant: Admission["grant"];
};

type FamilyRow = {
  source: Source;
  issuer: Secret;
  admission: Admission;
  enabled: boolean;
  live: boolean;
  observed_at?: string;
};
type AttemptRow = {
  id: string;
  admission: Admission;
  state: Attempt["state"];
  custody: string;
  material_version: string | null;
  provider_expires_at: Date;
  usable_until: Date;
  sealed: Buffer;
  stale: boolean;
};

const aad = (a: Admission, id: string) =>
  Buffer.from(JSON.stringify(["occ:prepared-github:v2", a.issuerAuthority, a.familyId, id]));

type FamilyOwner = Readonly<{
  active: string;
  adoption: readonly string[];
  /** Predicates over family f, and the installation-selected owner bound to each transaction. */
  owns?: string;
  /** Lock the authority that can move to a different family before checking active to record an intent. */
  lockIssuance?: string;
  driver?: import("@openclaw-enterprise/contracts").DriverRegistrationRef;
}>;

export class PreparedGitHubPostgres {
  private readonly pool: PostgresPool;
  private readonly custodyKey: Buffer;
  private readonly issuerAuthority: string;
  // The two admission paths share custody, fencing and retirement, never their permissions.
  private readonly owner: FamilyOwner;
  constructor(
    pool: PostgresPool,
    custodyKey: Buffer,
    issuerAuthority: string,
    owner: FamilyOwner = { active, adoption: ["prepared"] },
  ) {
    this.pool = pool;
    this.custodyKey = custodyKey;
    this.issuerAuthority = issuerAuthority;
    this.owner = owner;
  }

  private seal(bytes: Uint8Array, a: Admission, id: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.custodyKey, nonce);
    cipher.setAAD(aad(a, id));
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }
  protected open(b: Buffer, a: Admission, id: string) {
    const cipher = createDecipheriv("aes-256-gcm", this.custodyKey, b.subarray(0, 12));
    cipher.setAAD(aad(a, id));
    cipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]);
  }

  protected async transaction<T>(work: (c: PostgresClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '4000ms'");
      await c.query("SET LOCAL lock_timeout = '1000ms'");
      if (this.owner.driver) {
        await c.query("SELECT set_config('occ.repository_git_driver', $1, true)", [
          JSON.stringify(this.owner.driver),
        ]);
      }
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
      // Database diagnostics can contain failing row contents. No automatic transaction retries.
      const candidate = (error as { code?: string }).code;
      const code = candidate && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : "guard";
      // eslint-disable-next-line preserve-caught-error -- original errors may contain the secret-bearing row
      throw new Error("Prepared GitHub custody transaction did not complete (" + code + ").");
    } finally {
      c.release(discard);
    }
  }

  async enroll(source: Source, issuer: Readonly<Secret>, admission: Admission) {
    const key = source.key.source.id;
    await this.transaction(async (c) => {
      await c.query(
        `INSERT INTO ${families} (source_id,source,issuer,admission) VALUES ($1,$2,$3,$4)
        ON CONFLICT (source_id) DO NOTHING`,
        [key, source, issuer, admission],
      );
      const { rows } = await c.query(
        `SELECT 1 FROM ${families} f WHERE ${matching}
        AND f.issuer=$3::jsonb AND admission->>'issuerAuthority'=$4 AND enabled AND ${enrolling} FOR UPDATE OF f`,
        [key, source, issuer, this.issuerAuthority],
      );
      if (!rows.length) {
        throw new Error("Source or issuer changed during enrollment.");
      }
    });
  }

  async withdraw(source: Source) {
    const key = source.key.source.id;
    await this.transaction(async (c) => {
      await c.query(`UPDATE ${families} f SET enabled=false,worker_claim=NULL WHERE ${matching}`, [
        key,
        source,
      ]);
      await c.query(
        `UPDATE ${attempts} a SET custody='retire' FROM ${families} f WHERE ${matching}
        AND NOT enabled AND a.source_id=f.source_id AND custody='current'`,
        [key, source],
      );
    });
  }

  /** Settled, or the earliest time every unsettled attempt settles (none for live custody). */
  async withdrawalSettlement(source: Source) {
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::integer AS unsettled, CASE WHEN NOT bool_or(custody='current')
          THEN max(${settledAfter("a")}) END AS "settlesAt"
        FROM ${attempts} a JOIN ${families} f USING (source_id)
        WHERE ${matching} AND NOT enabled AND NOT ${preparedAttemptSettled("a")}`,
        [source.key.source.id, source],
      );
      const { unsettled, settlesAt } = rows[0] as { unsettled: number; settlesAt: Date | null };
      return unsettled === 0
        ? { settled: true as const }
        : {
            settled: false as const,
            ...(settlesAt instanceof Date && Number.isFinite(settlesAt.getTime()) && { settlesAt }),
          };
    });
  }

  async claim(claim: string) {
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        `WITH due AS (SELECT source_id FROM ${families} f
        WHERE enabled AND admission->>'issuerAuthority'=$2 AND next_check_at <= clock_timestamp() AND ${active}
        ORDER BY next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE ${families} f SET next_check_at=clock_timestamp() + interval '60 seconds',worker_claim=$1
        FROM due WHERE f.source_id=due.source_id RETURNING f.source, f.issuer`,
        [claim, this.issuerAuthority],
      );
      return rows[0] as Pick<FamilyRow, "source" | "issuer"> | undefined;
    });
  }

  // The claim fences stale input observations, not unknown issuance. An unfinished attempt
  // stays unfinished across claims, input rotation, and restarts. No provider I/O under a SQL lock.
  async observeInput(source: Source, claim: string, version: string) {
    const key = source.key.source.id;
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        `SELECT admission FROM ${families} f WHERE ${matching}
        AND enabled AND worker_claim=$3 AND admission->>'issuerAuthority'=$4 AND ${active} FOR UPDATE OF f`,
        [key, source, claim, this.issuerAuthority],
      );
      const old = (rows[0] as { admission: Admission } | undefined)?.admission;
      if (!old || old.inputVersion === version) {
        return old;
      }
      const admission: Admission = {
        ...old,
        inputVersion: version,
        ownerEpoch: old.ownerEpoch + 1,
      };
      await c.query(`UPDATE ${families} SET admission=$2 WHERE source_id=$1`, [key, admission]);
      await c.query(
        `UPDATE ${attempts} SET custody='retire' WHERE source_id=$1 AND custody='current'`,
        [key],
      );
      return admission;
    });
  }

  async metadata(source: Source) {
    return this.transaction(async (c) => {
      return (await readPreparedGitHubMetadata(c, source, this.issuerAuthority)) as
        Omit<AttemptRow, "sealed"> | undefined;
    });
  }

  /** Recovery remains available after withdrawal. Inspecting an uncertain issue or retirement
   * neither discloses material nor turns that attempt into permission to try again. */
  async inspectTokenAttempt(familyId: string, attemptId: string) {
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        `SELECT a.state,a.custody,a.material_version AS "materialVersion",a.provider_expires_at AS "providerExpiresAt"
         FROM ${families} f JOIN ${attempts} a USING (source_id)
         WHERE f.source_id=$1 AND a.id=$2 AND a.admission->>'issuerAuthority'=$3 AND f.source->>'adoption'=ANY($4::text[])
           AND ${this.owner.owns ?? "true"}`,
        [familyId, attemptId, this.issuerAuthority, this.owner.adoption],
      );
      return rows[0] as
        | {
            state: Attempt["state"];
            custody:
              | "intent"
              | "current"
              | "retire"
              | "revoking"
              | "revoked"
              | "unknown"
              | "expired"
              | "not_issued";
            materialVersion: string | null;
            providerExpiresAt: Date | null;
          }
        | undefined;
    });
  }

  /** Repo holds the live execution and grant locks in this transaction. Its use record and
   * draft allowance must commit under these same material locks, not after a separate check. */
  protected readonly tokens: TokenMaterialReader<PostgresClient, TokenSource> = {
    readWarm: (c, source) => this.lockMaterial(c, source, null),
    current: async (c, source, installed) =>
      installed?.preparationAttemptId && installed.materialVersion
        ? this.lockMaterial(c, source, installed)
        : undefined,
  };

  private lockMaterial(
    c: PostgresClient,
    source: TokenSource,
    installed: null,
  ): Promise<(CurrentTokenVersion & { open(): Buffer }) | undefined>;
  private lockMaterial(
    c: PostgresClient,
    source: TokenSource,
    installed: InstalledTokenVersion,
  ): Promise<CurrentTokenVersion | undefined>;
  private async lockMaterial(
    c: PostgresClient,
    source: TokenSource,
    installed: InstalledTokenVersion | null,
  ) {
    const warm = installed === null;
    const values = [
      source.key.source.id,
      source,
      this.issuerAuthority,
      ...(warm ? [] : [installed.preparationAttemptId, installed.materialVersion]),
    ];
    const { rows } = await c.query(
      `SELECT a.id,a.admission,a.material_version,a.usable_until${warm ? ",a.sealed" : ""}
       FROM ${families} f JOIN ${attempts} a USING (source_id)
       WHERE ${matching} AND f.enabled AND f.admission->>'issuerAuthority'=$3
         AND a.custody='current' AND a.state='committed' AND a.admission=f.admission
         AND a.usable_until BETWEEN clock_timestamp() AND clock_timestamp() + interval '61 minutes'
         AND a.provider_expires_at >= a.usable_until
         ${warm ? "" : "AND a.id=$4 AND a.material_version=$5"} FOR SHARE OF f,a`,
      values,
    );
    if (rows.length !== 1) {
      return;
    }
    const row = rows[0] as AttemptRow;
    const usableUntil = row.usable_until.getTime();
    if (
      !(usableUntil > Date.now()) ||
      !row.material_version ||
      !isDeepStrictEqual(row.admission.grant, source.grant)
    ) {
      return;
    }
    const version = {
      preparationAttemptId: row.id,
      materialVersion: row.material_version,
      usableUntil,
    };
    if (!warm) {
      return version;
    }
    let opened = false;
    return {
      ...version,
      open: () => {
        if (opened || !(Date.now() < usableUntil)) {
          throw new Error("Prepared material unavailable.");
        }
        opened = true;
        return this.open(row.sealed, row.admission, row.id);
      },
    };
  }

  // Request access pins the selected material and the earlier material/request deadline.
  // Null is background preparation: it may open material no longer eligible for requests.
  store(
    source: { readonly key: { readonly source: { readonly id: string } } },
    access: Readonly<{
      deadlineAt: string;
      attemptId: string;
      materialVersion: string;
      active: () => boolean;
    }> | null,
  ): GitHubPreparationStore {
    const key = source.key.source.id;
    const locked = <T>(
      familyId: string,
      change: boolean,
      update: (f: Family | undefined, allocate: () => string) => T,
    ) =>
      this.transaction(async (c) => {
        if (familyId !== key) {
          throw new Error("Family mismatch.");
        }
        if (change && this.owner.lockIssuance) {
          await c.query(this.owner.lockIssuance, [source]);
        }
        const { rows } = await c.query(
          `SELECT admission, enabled, ${this.owner.active} AS live,
          extract(epoch FROM clock_timestamp()) * 1000 AS observed_at
          FROM ${families} f WHERE ${matching}
          AND admission->>'issuerAuthority'=$3 FOR ${change ? "UPDATE" : "SHARE"} OF f`,
          [key, source, this.issuerAuthority],
        );
        const f = rows[0] as FamilyRow | undefined;
        if (!f || (access && (!f.enabled || !f.live || !access.active()))) {
          return update(undefined, randomUUID);
        }
        // Check the absolute deadline at projection, not transaction or statement start: a
        // query submitted in time may reach this row late. In-flight bytes cannot be recalled.
        const list = (
          await c.query(
            `SELECT id,admission,state,custody,material_version,provider_expires_at,usable_until,
          started_at <= clock_timestamp() - ${issueAttemptDispatchWindowMs} * interval '1 millisecond'
            AS stale,CASE WHEN custody='current' AND admission->>'issuerAuthority'=$2
            AND clock_timestamp() < $3::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM occ.egress_rejected_material r JOIN occ.prepared_github_families f
                ON f.source_id=a.source_id
              WHERE r.namespace_id=f.source #>> '{key,namespaceId}'
                AND r.secret_driver_id=f.source #>> '{key,provider,id}'
                AND r.material_id=f.source_id AND r.material_version=a.material_version::text)
            AND ($4::uuid IS NULL OR (id=$4 AND material_version=$5 AND state='committed'
              AND admission=$6::jsonb AND usable_until > clock_timestamp()
              AND usable_until < clock_timestamp() + interval '61 minutes'))
            THEN sealed END AS sealed FROM ${attempts} a
          WHERE source_id=$1`,
            [
              key,
              this.issuerAuthority,
              access?.deadlineAt ?? "infinity",
              access?.attemptId ?? null,
              access?.materialVersion ?? null,
              f.admission,
            ],
          )
        ).rows as AttemptRow[];
        // Omit rejected material from readiness, but retain every attempt: uncertain issuance
        // must still block replacement.
        const current =
          f.enabled && f.live ? list.find((a) => a.custody === "current" && a.sealed) : undefined;
        const family: Family = {
          admission: f.admission,
          enabled: f.enabled && f.live,
          admittedGrantCount: 1,
          observedAt: Number(f.observed_at),
          attempts: list.map((a) => ({
            id: a.id,
            admission: a.admission,
            state: a.state,
            ...(a.material_version ? { materialVersion: a.material_version } : {}),
            // Settlement assumes no dispatch after this window; the issuer rechecks it.
            ...(a.stale ? { stale: true as const } : {}),
          })),
        };
        if (
          current &&
          (!access || (access.active() && current.usable_until.getTime() > Date.now()))
        ) {
          family.committed = {
            admission: current.admission,
            attemptId: current.id,
            materialVersion: current.material_version!,
            providerExpiresAt: current.provider_expires_at.getTime(),
            usableUntil: current.usable_until.getTime(),
            bytes: this.open(current.sealed, current.admission, current.id),
          };
        }
        const previous = family.committed;
        try {
          const result = update(family, randomUUID);
          if (change) {
            const before = new Map(list.map((r) => [r.id, r]));
            for (const a of family.attempts) {
              const old = before.get(a.id);
              if (!old) {
                await c.query(
                  `INSERT INTO ${attempts} (id,source_id,admission,state) VALUES ($1,$2,$3,$4)`,
                  [a.id, key, a.admission, a.state],
                );
              } else if (old.state !== a.state) {
                const m = a.state === "committed" ? family.committed : undefined;
                if (
                  m &&
                  (m.attemptId !== a.id ||
                    !family.enabled ||
                    !isDeepStrictEqual(m.admission, f.admission))
                ) {
                  throw new Error("Publication fenced.");
                }
                const bytes = m?.bytes ?? a.candidate;
                if (m) {
                  await c.query(
                    `UPDATE ${attempts} SET custody='retire' WHERE source_id=$1 AND custody='current'`,
                    [key],
                  );
                }
                await c.query(
                  `UPDATE ${attempts} SET state=$2,custody=$3,sealed=$4,material_version=$5,
                  provider_expires_at=$6,usable_until=$7 WHERE id=$1 AND source_id=$8`,
                  [
                    a.id,
                    a.state,
                    // Only a provider answer that refused issuance proves no token exists.
                    m ? "current" : bytes ? "retire" : a.notIssued ? "not_issued" : "intent",
                    bytes && this.seal(bytes, a.admission, a.id),
                    m?.materialVersion,
                    m && new Date(m.providerExpiresAt),
                    m && new Date(m.usableUntil),
                    key,
                  ],
                );
              }
            }
          }
          return result;
        } finally {
          previous?.bytes.fill(0);
          if (change) {
            // The writer can install a new plaintext buffer before publication fails.
            if (family.committed !== previous) {
              family.committed?.bytes.fill(0);
            }
            for (const attempt of family.attempts) {
              attempt.candidate?.fill(0);
            }
          }
        }
      });
    return {
      readCurrent: (id, select) => locked(id, false, select),
      transact: (id, update) => locked(id, true, update),
    };
  }

  /** The same custody boundary when scheduling, claiming and recording a retirement. */
  protected retiringFamily(adoption: string, ended?: string) {
    const owns = this.owner.owns ?? "true";
    return `f.source->>'adoption'=ANY(${adoption}::text[]) AND ${owns}${ended ? " AND " + ended : ""}`;
  }

  // Commit possible revocation before contacting GitHub. A missing response leaves 'revoking'
  // or 'unknown' and encrypted cleanup custody, never an automatic replay or a claim of revocation.
  async takeRetirement(key: string | null) {
    let owned: Buffer | undefined;
    const claim = this.transaction(async (c) => {
      // A foreign or absent issuance authority leaves the original custody and outcome intact.
      // Only a matching claim returns ciphertext; this also works after source withdrawal.
      const { rows } = await c.query(
        `WITH due AS (
           SELECT id, (a.admission->>'issuerAuthority' = $2) IS TRUE AS authorized,
             (x.expires <= statement_timestamp()) IS TRUE AS expired
           FROM ${attempts} a JOIN ${families} f USING (source_id),
             LATERAL (SELECT ${standingGitExpiry} AS expires) x
           WHERE custody='retire' AND (source_id=$1 OR $1 IS NULL) AND ${this.retiringFamily("$3")}
             AND (x.expires IS NULL OR x.expires > statement_timestamp()
               OR x.expires <= statement_timestamp() - $4 * interval '1 millisecond')
           ORDER BY authorized DESC LIMIT 1 FOR UPDATE OF a, f SKIP LOCKED
         ), claimed AS (
           UPDATE ${attempts} a SET custody=CASE WHEN d.expired THEN 'expired' ELSE 'revoking' END,
             sealed=CASE WHEN d.expired THEN NULL ELSE a.sealed END
           FROM due d WHERE a.id=d.id AND d.authorized
           RETURNING a.id, a.admission, a.sealed, a.custody
         )
         SELECT d.authorized, c.id, c.admission, c.sealed, c.custody FROM due d LEFT JOIN claimed c USING (id)`,
        [key, this.issuerAuthority, this.owner.adoption, providerClockSkewMs],
      );
      const a = rows[0] as (AttemptRow & { authorized: boolean }) | undefined;
      if (!a || !a.authorized) {
        return a && ("issuer-mismatch" as const);
      }
      // Only a never-dispatched retirement of verified, committed standing material can
      // expire locally. In the skew window we wait; after it we erase the sealed value and
      // make no provider request. A 401, lost response or earlier unknown stays unresolved.
      if (a.custody === "expired") {
        return undefined;
      }
      owned = this.open(a.sealed, a.admission, a.id);
      return { id: a.id, admission: a.admission, bytes: owned };
    });
    try {
      const candidate = await claim;
      owned = undefined; // The retirement caller now owns the live copy.
      return candidate;
    } finally {
      // A lost commit receipt or failed release discards our copy, without retrying the claim.
      owned?.fill(0);
    }
  }

  async finishRetirement(id: string, revoked: boolean) {
    await this.transaction(async (c) => {
      await c.query(
        `UPDATE ${attempts} a SET custody=CASE WHEN $2 THEN 'revoked' ELSE 'unknown' END,
        sealed=CASE WHEN $2 THEN NULL ELSE sealed END FROM ${families} f
        WHERE a.id=$1 AND a.custody='revoking' AND f.source_id=a.source_id
          AND a.admission->>'issuerAuthority'=$3 AND ${this.retiringFamily("$4")}`,
        [id, revoked, this.issuerAuthority, this.owner.adoption],
      );
    });
  }
}
