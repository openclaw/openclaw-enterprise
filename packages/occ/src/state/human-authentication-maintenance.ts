import { createHash, randomUUID } from "node:crypto";
import { ResourceStateConflictError, ScopeViolationError } from "../errors.ts";
import {
  attachExternalAuthenticationMethod,
  PostgresHumanAuthentication,
  type HumanAuthenticationActivationHooks,
} from "./human-authentication.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type { PostgresPlatformState } from "./postgres-state.ts";

/** Another client backend connected to the database during stopped maintenance. */
export interface HumanAuthenticationMaintenanceBackend {
  readonly pid: number;
  readonly user: string | null;
  readonly application: string | null;
}

export interface HumanAuthenticationMaintenanceAccount {
  readonly userId: string;
  readonly email: string;
}

export interface HumanAuthenticationMaintenanceStatus {
  readonly installationId: string;
  readonly profile: "legacy" | "guarded";
  readonly designation?: { userId: string; email: string; principalId: string; methodId: string };
  readonly users: number;
  readonly enrolled: number;
  readonly disabled: readonly HumanAuthenticationMaintenanceAccount[];
  readonly unenrolled: readonly HumanAuthenticationMaintenanceAccount[];
  readonly sessions: number;
  readonly unboundSessions: number;
  readonly externalMethods: Readonly<Record<string, number>>;
  readonly otherBackends: readonly HumanAuthenticationMaintenanceBackend[];
}

export type HumanAuthenticationMaintenanceRefusal =
  | "ACTIVATION_REFUSED"
  | "NOT_ACTIVATED"
  | "USER_NOT_FOUND"
  | "PRINCIPAL_MISSING"
  | "PASSWORD_METHOD_COUNT"
  | "ALREADY_ENROLLED"
  | "DISABLED_ACCOUNTS"
  | "OIDC_MAPPING_INVALID"
  | "OIDC_SOURCE_UNAVAILABLE"
  | "OIDC_VERSION_CHANGED"
  | "OIDC_TARGET_CONFLICT"
  | "OIDC_OPERATION_CONFLICT";

export interface HumanAuthenticationOidcLinkMapping {
  readonly operationId: string;
  readonly installationId: string;
  readonly sourceProviderId: string;
  readonly oidcProviderId: string;
  readonly entries: readonly {
    readonly sourceSubject: string;
    readonly oidcSubject: string;
    readonly expectedVersion: number;
  }[];
}

interface OidcLinkReceipt {
  readonly operationId: string;
  readonly mappingDigest: string;
  readonly accountCount: number;
}

type OidcLinkResult =
  | { readonly status: "ready"; readonly accountCount: number }
  | ({ readonly status: "applied" | "already-applied" } & OidcLinkReceipt);

const OIDC_LINK_ACTION = "authentication.methods.link-oidc";

function isIdentityKeyPart(value: string): boolean {
  // An unpaired surrogate would be replaced when encoded for PostgreSQL.
  return value.length > 0 && !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0");
}

/** A stopped-maintenance precondition failed; the transaction rolled back. */
export class HumanAuthenticationMaintenanceRefusedError extends Error {
  readonly reason: HumanAuthenticationMaintenanceRefusal;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: HumanAuthenticationMaintenanceRefusal,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HumanAuthenticationMaintenanceRefusedError";
    this.reason = reason;
    this.details = details;
  }
}

/** The database still has other clients, so the API and worker are not proven stopped. */
export class WritersNotStoppedError extends Error {
  readonly backends: readonly HumanAuthenticationMaintenanceBackend[];

  constructor(backends: readonly HumanAuthenticationMaintenanceBackend[]) {
    super("Other database clients are connected; stop the API and worker before maintenance.");
    this.name = "WritersNotStoppedError";
    this.backends = backends;
  }
}

type Row = Record<string, unknown>;

// Shared with PostgresHumanAuthentication.activateRecovery so maintenance and
// controller activation serialize on the same Installation key.
const ACTIVATION_LOCK = 1868785005;

/**
 * Operations that change the human-authentication profile outside the online API.
 * They run as the schema owner, only while no other client uses the database.
 */
export class PostgresHumanAuthenticationMaintenance {
  private readonly state: PostgresPlatformState;
  private readonly installationId: string;
  private readonly issuer: string;

  constructor(state: PostgresPlatformState, installationId: string, issuer: string) {
    this.state = state;
    this.installationId = installationId;
    this.issuer = issuer;
  }

  private async query(
    unit: PlatformUnitOfWork,
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row[]> {
    return (await this.state.queryInTransaction(unit, sql, parameters)).rows as Row[];
  }

  /** The application role cannot run maintenance; require the owner of the occ schema. */
  async assertSchemaOwner(): Promise<string> {
    return this.state.transact((unit) => this.schemaOwner(unit));
  }

  private async schemaOwner(unit: PlatformUnitOfWork): Promise<string> {
    const [row] = await this.query(
      unit,
      `SELECT current_user AS role, pg_has_role(current_user, n.nspowner, 'MEMBER') AS owner
       FROM pg_namespace n WHERE n.nspname = 'occ'`,
    );
    if (row === undefined || row.owner !== true) {
      throw new ScopeViolationError(
        "Authentication maintenance requires the migration role that owns the occ schema.",
      );
    }
    return row.role as string;
  }

  private async otherBackends(
    unit: PlatformUnitOfWork,
  ): Promise<HumanAuthenticationMaintenanceBackend[]> {
    // pg_stat_activity is a per-transaction snapshot; refresh it for each check.
    // Without pg_read_all_stats, other roles' backend_type reads as NULL.
    await this.query(unit, `SELECT pg_stat_clear_snapshot()`);
    const rows = await this.query(
      unit,
      `SELECT pid, usename, application_name FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL
       AND coalesce(backend_type, 'client backend') = 'client backend' ORDER BY pid`,
    );
    return rows.map((row) => ({
      pid: row.pid as number,
      user: (row.usename as string | null) ?? null,
      application: (row.application_name as string | null) || null,
    }));
  }

  private async assertWritersStopped(unit: PlatformUnitOfWork): Promise<void> {
    const backends = await this.otherBackends(unit);
    if (backends.length !== 0) {
      throw new WritersNotStoppedError(backends);
    }
  }

  /** Verify, in a separate transaction, that no other client is connected. */
  async requireWritersStopped(): Promise<void> {
    await this.state.transact((unit) => this.assertWritersStopped(unit));
  }

  private async maintain<T>(
    action: string,
    work: (unit: PlatformUnitOfWork) => Promise<{ result: T; details?: Record<string, unknown> }>,
    auditId?: string,
  ): Promise<T> {
    return this.state.transactReadCommitted(async (unit) => {
      await this.schemaOwner(unit);
      await this.query(unit, `SET LOCAL lock_timeout = '5s'`);
      const [lock] = await this.query(
        unit,
        `SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS locked`,
        [ACTIVATION_LOCK, this.installationId],
      );
      if (lock?.locked !== true) {
        throw new WritersNotStoppedError([]);
      }
      await this.assertWritersStopped(unit);
      const { result, details } = await work(unit);
      if (details !== undefined) {
        await this.appendAudit(unit, action, details, auditId);
      }
      await this.schemaOwner(unit);
      // A client that connected during the operation voids the proof; roll back.
      await this.assertWritersStopped(unit);
      return result;
    });
  }

  private async appendAudit(
    unit: PlatformUnitOfWork,
    action: string,
    details: Record<string, unknown>,
    id = `aud_${randomUUID()}`,
  ): Promise<void> {
    const actorId = `maintenance:${await this.schemaOwner(unit)}`;
    await unit.audit.append({
      id,
      installationId: this.installationId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId,
      actor: { id: actorId },
      source: "occ",
      action,
      resource: { kind: "installation", id: this.installationId },
      outcome: "success",
      details: { source: "auth-maintain", ...details },
    });
  }

  /**
   * Hooks for PostgresHumanAuthentication.activateRecovery: the writer check runs
   * after its activation lock and again before commit, and a designation it makes
   * is also audited as this maintenance role.
   */
  activationHooks(): HumanAuthenticationActivationHooks {
    return {
      exclusive: (unit) => this.assertWritersStopped(unit),
      activated: (unit, activation) =>
        this.appendAudit(unit, "authentication.recovery.activate", {
          userId: activation.userId,
          principalId: activation.principalId,
          skipped: activation.skipped,
        }),
    };
  }

  private async designation(unit: PlatformUnitOfWork): Promise<Row> {
    const [row] = await this.query(
      unit,
      `SELECT r.user_id, r.principal_id, r.method_id FROM occ.human_authentication_recovery r
       WHERE r.installation_id = $1 FOR UPDATE`,
      [this.installationId],
    );
    if (row === undefined) {
      throw new HumanAuthenticationMaintenanceRefusedError(
        "NOT_ACTIVATED",
        "Human sign-in is not activated for this Installation.",
      );
    }
    return row;
  }

  async status(): Promise<HumanAuthenticationMaintenanceStatus> {
    return this.state.transact(async (unit) => {
      await this.query(unit, `SET TRANSACTION READ ONLY`);
      const [designation] = await this.query(
        unit,
        `SELECT r.user_id, u.email, r.principal_id, r.method_id FROM occ.human_authentication_recovery r
         JOIN occ."user" u ON u.id = r.user_id WHERE r.installation_id = $1`,
        [this.installationId],
      );
      const [counts] = await this.query(
        unit,
        `SELECT (SELECT count(*)::integer FROM occ."user") AS users,
          (SELECT count(*)::integer FROM occ.human_authentication_accounts WHERE installation_id = $1) AS enrolled,
          (SELECT count(*)::integer FROM occ.session) AS sessions,
          (SELECT count(*)::integer FROM occ.session s WHERE NOT EXISTS
            (SELECT 1 FROM occ.human_authentication_sessions b WHERE b.session_id = s.id)) AS unbound`,
        [this.installationId],
      );
      const disabled = await this.query(
        unit,
        `SELECT u.id, u.email FROM occ.human_authentication_accounts h JOIN occ."user" u ON u.id = h.user_id
         WHERE h.installation_id = $1 AND h.disabled ORDER BY u.id`,
        [this.installationId],
      );
      const unenrolled = designation
        ? await this.query(
            unit,
            `SELECT u.id, u.email FROM occ."user" u WHERE NOT EXISTS
             (SELECT 1 FROM occ.human_authentication_accounts h WHERE h.user_id = u.id) ORDER BY u.id`,
          )
        : [];
      const methods = await this.query(
        unit,
        `SELECT provider_id, count(*)::integer AS count FROM occ.account WHERE identity_only
         GROUP BY provider_id ORDER BY provider_id`,
      );
      const account = (row: Row) => ({ userId: row.id as string, email: row.email as string });
      return {
        installationId: this.installationId,
        profile: designation ? "guarded" : "legacy",
        ...(designation
          ? {
              designation: {
                userId: designation.user_id as string,
                email: designation.email as string,
                principalId: designation.principal_id as string,
                methodId: designation.method_id as string,
              },
            }
          : {}),
        users: counts!.users as number,
        enrolled: counts!.enrolled as number,
        disabled: disabled.map(account),
        unenrolled: unenrolled.map(account),
        sessions: counts!.sessions as number,
        unboundSessions: counts!.unbound as number,
        externalMethods: Object.fromEntries(
          methods.map((row) => [row.provider_id as string, row.count as number]),
        ),
        otherBackends: await this.otherBackends(unit),
      };
    });
  }

  /** Link existing guarded accounts from a trusted operator mapping while writers are stopped. */
  async linkOidc(
    mapping: HumanAuthenticationOidcLinkMapping,
    { dryRun }: { readonly dryRun: boolean },
  ): Promise<OidcLinkResult> {
    const { operationId, installationId, sourceProviderId, oidcProviderId } = mapping;
    if (
      installationId !== this.installationId ||
      !isIdentityKeyPart(sourceProviderId) ||
      sourceProviderId === "credential" ||
      sourceProviderId === oidcProviderId ||
      !/^oidc:[0-9a-f]{64}$/.test(oidcProviderId)
    ) {
      throw new HumanAuthenticationMaintenanceRefusedError(
        "OIDC_MAPPING_INVALID",
        "The mapping must name this Installation and distinct external source and OIDC provider instances.",
      );
    }
    const sourceSubjects = new Set<string>();
    const oidcSubjects = new Set<string>();
    for (const { sourceSubject, oidcSubject } of mapping.entries) {
      if (
        !isIdentityKeyPart(sourceSubject) ||
        sourceSubjects.has(sourceSubject) ||
        oidcSubjects.has(oidcSubject)
      ) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "OIDC_MAPPING_INVALID",
          "Each mapping entry needs a distinct source subject and a distinct OIDC subject.",
        );
      }
      sourceSubjects.add(sourceSubject);
      oidcSubjects.add(oidcSubject);
    }
    // Hash the interpreted mapping in source-subject order so whitespace and row reordering
    // do not change the operation. Identity details stay out of output and audit.
    const entries = mapping.entries
      .map(
        ({ sourceSubject, oidcSubject, expectedVersion }) =>
          [sourceSubject, oidcSubject, expectedVersion] as const,
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const receipt = {
      operationId,
      mappingDigest: createHash("sha256")
        .update(
          JSON.stringify([operationId, installationId, sourceProviderId, oidcProviderId, entries]),
        )
        .digest("hex"),
      accountCount: entries.length,
    };
    const auditId = `aud_${operationId}`;
    const inspect = async (unit: PlatformUnitOfWork, lock: boolean) => {
      const [recorded] = await this.query(
        unit,
        `SELECT action, actor_id, kind, outcome, resource_kind, resource_id,
                details->>'source' AS source, details->>'operationId' AS operation_id,
                details->>'mappingDigest' AS digest, details->'accountCount' AS account_count
         FROM occ.audit_events WHERE id = $1`,
        [auditId],
      );
      if (recorded !== undefined) {
        if (
          recorded.action !== OIDC_LINK_ACTION ||
          typeof recorded.actor_id !== "string" ||
          !recorded.actor_id.startsWith("maintenance:") ||
          recorded.kind !== "mutation" ||
          recorded.outcome !== "success" ||
          recorded.resource_kind !== "installation" ||
          recorded.resource_id !== installationId ||
          recorded.source !== "auth-maintain" ||
          recorded.operation_id !== operationId ||
          recorded.digest !== receipt.mappingDigest ||
          recorded.account_count !== receipt.accountCount
        ) {
          throw new HumanAuthenticationMaintenanceRefusedError(
            "OIDC_OPERATION_CONFLICT",
            "The operation ID already identifies different audit evidence.",
          );
        }
        return { completed: true } as const;
      }
      const [recovery] = await this.query(
        unit,
        `SELECT 1 FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [installationId],
      );
      if (recovery === undefined) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "NOT_ACTIVATED",
          "Human sign-in is not activated for this Installation.",
        );
      }
      const accounts = await this.query(
        unit,
        `SELECT account.user_id, account.version, requested.oidc_subject, requested.expected_version,
                EXISTS (
                  SELECT 1 FROM occ.account target
                  WHERE target.provider_id = $2
                    AND (target.account_id = requested.oidc_subject OR target.user_id = account.user_id)
                ) AS target_exists
         FROM unnest($3::text[], $4::text[], $5::integer[])
              AS requested(source_subject, oidc_subject, expected_version)
         JOIN occ.account source ON source.provider_id = $1
              AND source.account_id = requested.source_subject AND source.identity_only
         JOIN occ.human_authentication_accounts account ON account.user_id = source.user_id
              AND account.installation_id = $6 AND NOT account.disabled
         JOIN occ.iam_identities principal ON principal.id = account.principal_id
              AND principal.kind = 'principal' AND principal.issuer = $7
              AND principal.subject = account.user_id
              AND principal.namespace_id IS NULL AND principal.agent_id IS NULL
         ORDER BY account.user_id
         ${lock ? "FOR UPDATE OF account FOR SHARE OF source, principal" : ""}`,
        [
          sourceProviderId,
          oidcProviderId,
          entries.map(([sourceSubject]) => sourceSubject),
          entries.map(([, subject]) => subject),
          entries.map(([, , version]) => version),
          installationId,
          this.issuer,
        ],
      );
      if (
        accounts.length !== entries.length ||
        new Set(accounts.map(({ user_id }) => user_id)).size !== accounts.length
      ) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "OIDC_SOURCE_UNAVAILABLE",
          "Each source identity must resolve to a distinct enabled account enrolled in this Installation.",
        );
      }
      if (accounts.some((row) => row.version !== row.expected_version)) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "OIDC_VERSION_CHANGED",
          "An authentication account version changed. Use a current mapping.",
        );
      }
      if (accounts.some((row) => row.target_exists !== false)) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "OIDC_TARGET_CONFLICT",
          "An OIDC subject or account already has a method for the target provider.",
        );
      }
      return { completed: false, accounts } as const;
    };

    if (dryRun) {
      return this.state.transact(async (unit) => {
        await this.query(unit, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        await this.schemaOwner(unit);
        const plan = await inspect(unit, false);
        return plan.completed
          ? { status: "already-applied", ...receipt }
          : { status: "ready", accountCount: receipt.accountCount };
      });
    }
    return this.maintain<OidcLinkResult>(
      OIDC_LINK_ACTION,
      async (unit) => {
        const plan = await inspect(unit, true);
        if (plan.completed) {
          return { result: { status: "already-applied", ...receipt } };
        }
        for (const row of plan.accounts) {
          try {
            await attachExternalAuthenticationMethod(
              this.state,
              unit,
              row.user_id as string,
              oidcProviderId,
              row.oidc_subject as string,
            );
          } catch (error) {
            if (error instanceof ResourceStateConflictError) {
              throw new HumanAuthenticationMaintenanceRefusedError(
                "OIDC_TARGET_CONFLICT",
                "An OIDC subject is already attached to another authentication method.",
              );
            }
            throw error;
          }
        }
        return { result: { status: "applied", ...receipt }, details: receipt };
      },
      auditId,
    );
  }

  /** Repair an account that exists without enrolment in an activated profile. */
  async enrol(userId: string): Promise<{ userId: string; principalId: string }> {
    return this.maintain("authentication.account.enrol", async (unit) => {
      await this.designation(unit);
      const [user] = await this.query(unit, `SELECT id FROM occ."user" WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);
      if (user === undefined) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "USER_NOT_FOUND",
          "The account does not exist.",
        );
      }
      const [enrolled] = await this.query(
        unit,
        `SELECT user_id FROM occ.human_authentication_accounts WHERE user_id = $1`,
        [userId],
      );
      if (enrolled !== undefined) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "ALREADY_ENROLLED",
          "The account is already enrolled.",
        );
      }
      // The same rule as activation and online repair (POST /api/auth/accounts/:userId/enrol).
      const enrolment = await new PostgresHumanAuthentication(
        this.state,
        this.installationId,
        this.issuer,
      ).enrolUser(unit, userId);
      if (!enrolment.enrolled) {
        throw enrolment.reason === "PRINCIPAL_MISSING"
          ? new HumanAuthenticationMaintenanceRefusedError(
              "PRINCIPAL_MISSING",
              "The account has no provisioned Principal.",
            )
          : new HumanAuthenticationMaintenanceRefusedError(
              "PASSWORD_METHOD_COUNT",
              "Enrolment requires exactly one password method.",
            );
      }
      // Sessions an older controller issued for this account were never bound.
      await this.query(unit, `DELETE FROM occ.session WHERE user_id = $1`, [userId]);
      const { principalId } = enrolment;
      return { result: { userId, principalId }, details: { userId, principalId } };
    });
  }

  /** Replace the recovery password hash; the method trigger invalidates bound sessions. */
  async resetRecoveryPassword(passwordHash: string): Promise<{ userId: string }> {
    return this.maintain("authentication.recovery.password-reset", async (unit) => {
      const recovery = await this.designation(unit);
      const userId = recovery.user_id as string;
      await this.query(
        unit,
        `UPDATE occ.account SET password = $2 WHERE id = $1 AND provider_id = 'credential'`,
        [recovery.method_id, passwordHash],
      );
      const deleted = await this.query(
        unit,
        `DELETE FROM occ.session WHERE user_id = $1 RETURNING id`,
        [userId],
      );
      return {
        result: { userId },
        details: { userId, deletedSessionCount: deleted.length },
      };
    });
  }

  async purgeSessions(userId?: string): Promise<{ deletedSessionCount: number }> {
    return this.maintain("authentication.sessions.purge", async (unit) => {
      if (userId !== undefined) {
        const [user] = await this.query(unit, `SELECT id FROM occ."user" WHERE id = $1`, [userId]);
        if (user === undefined) {
          throw new HumanAuthenticationMaintenanceRefusedError(
            "USER_NOT_FOUND",
            "The account does not exist.",
          );
        }
      }
      const deleted = await this.query(
        unit,
        `DELETE FROM occ.session WHERE $1::text IS NULL OR user_id = $1 RETURNING id`,
        [userId ?? null],
      );
      return {
        result: { deletedSessionCount: deleted.length },
        details: {
          ...(userId === undefined ? {} : { userId }),
          deletedSessionCount: deleted.length,
        },
      };
    });
  }

  /**
   * Return to the legacy password profile. Legacy sign-in ignores `disabled`, so
   * disabled accounts block deactivation unless their passwords are removed.
   */
  async deactivate(options: { purgeDisabled?: boolean } = {}): Promise<{
    recoveryUserId: string;
    passwordRemovedUserIds: readonly string[];
    deletedSessionCount: number;
  }> {
    return this.maintain("authentication.recovery.deactivate", async (unit) => {
      const recovery = await this.designation(unit);
      const disabled = (
        await this.query(
          unit,
          `SELECT user_id FROM occ.human_authentication_accounts WHERE installation_id = $1 AND disabled
           ORDER BY user_id FOR UPDATE`,
          [this.installationId],
        )
      ).map((row) => row.user_id as string);
      if (disabled.length !== 0 && options.purgeDisabled !== true) {
        throw new HumanAuthenticationMaintenanceRefusedError(
          "DISABLED_ACCOUNTS",
          "Disabled accounts would regain password sign-in in the legacy profile.",
          { disabledUserIds: disabled },
        );
      }
      if (disabled.length !== 0) {
        await this.query(
          unit,
          `UPDATE occ.account SET password = NULL WHERE user_id = ANY($1::text[]) AND provider_id = 'credential'`,
          [disabled],
        );
      }
      await this.query(
        unit,
        `DELETE FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [this.installationId],
      );
      await this.query(
        unit,
        `DELETE FROM occ.human_authentication_attempts WHERE installation_id = $1`,
        [this.installationId],
      );
      const sessions = await this.query(unit, `DELETE FROM occ.session RETURNING id`);
      await this.query(unit, `DELETE FROM occ.human_authentication_sessions`);
      await this.query(
        unit,
        `DELETE FROM occ.human_authentication_accounts WHERE installation_id = $1`,
        [this.installationId],
      );
      const recoveryUserId = recovery.user_id as string;
      return {
        result: {
          recoveryUserId,
          passwordRemovedUserIds: disabled,
          deletedSessionCount: sessions.length,
        },
        details: {
          recoveryUserId,
          passwordRemovedUserIds: disabled,
          deletedSessionCount: sessions.length,
        },
      };
    });
  }
}
