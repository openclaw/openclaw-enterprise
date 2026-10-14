import { randomUUID } from "node:crypto";
import { AuthorizationDeniedError, ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "./platform-state.ts";
import type { PostgresPlatformState } from "./postgres-state.ts";

type Row = Record<string, unknown>;

/** A pending, unexpired device authorization as the approval page sees it. */
export interface CliDeviceAuthorization {
  readonly id: string;
  readonly clientLabel: string;
  readonly requesterAddress: string;
  readonly namespaceId?: string;
  readonly expiresAt: Date;
}

/** A CLI session without its token. */
export interface CliSession {
  readonly id: string;
  readonly userId: string;
  readonly parentSessionId: string;
  readonly namespaceId?: string;
  readonly clientLabel: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly email: string;
  readonly name: string;
}

export interface CliDeviceAuthorizationStart {
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientLabel: string;
  readonly requesterAddress: string;
  readonly namespaceId?: string;
}

/** The browser session that decides an authorization. */
export interface CliSessionApprover {
  readonly userId: string;
  readonly sessionId: string;
}

export type CliSessionExchange =
  | { readonly status: "pending" | "denied" | "expired" | "limit" }
  | { readonly status: "issued"; readonly session: CliSession };

export interface PostgresCliSessionsOptions {
  /**
   * The guarded profile (an external provider is configured): a CLI session also needs its
   * parent's account enabled, its versions current and its provider instance configured.
   */
  readonly guarded: boolean;
  /** Provider instance IDs configured now; see PostgresHumanAuthenticationOptions. */
  readonly externalProviderIds?: readonly string[];
  /** The noncredential key the audit records for a parent session (see session-binding.ts). */
  readonly parentSessionKey?: (sessionId: string) => string;
  /** Pending authorizations kept in total; the oldest are evicted. */
  readonly maxPending?: number;
}

/** Unexpired CLI sessions one browser session may hold. */
export const CLI_SESSIONS_PER_PARENT = 10;
/** A device authorization's lifetime: ten minutes. */
export const CLI_DEVICE_AUTHORIZATION_SECONDS = 600;

const sessionColumns = `c.id, c.user_id, c.parent_session_id, c.namespace_id, c.client_label,
  c.created_at, c.expires_at, u.email, u.name`;

function cliSession(row: Row): CliSession {
  return Object.freeze({
    id: row.id as string,
    userId: row.user_id as string,
    parentSessionId: row.parent_session_id as string,
    ...(row.namespace_id === null ? {} : { namespaceId: row.namespace_id as string }),
    clientLabel: row.client_label as string,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    email: row.email as string,
    name: row.name as string,
  });
}

function authorization(row: Row): CliDeviceAuthorization {
  return Object.freeze({
    id: row.id as string,
    clientLabel: row.client_label as string,
    requesterAddress: row.requester_address as string,
    ...(row.namespace_id === null ? {} : { namespaceId: row.namespace_id as string }),
    expiresAt: row.expires_at as Date,
  });
}

/**
 * RFC-0019 CLI sign-in persistence. It shares the original State transaction and audit
 * writer, so an approval, issue or revoke commits with its audit event or not at all.
 * Hashes are computed by the caller; this class never sees a code or token.
 */
export class PostgresCliSessions {
  private readonly state: PostgresPlatformState;
  private readonly installationId: string;
  private readonly issuer: string;
  private readonly guarded: boolean;
  private readonly externalProviderIds: readonly string[];
  private readonly parentSessionKey: ((sessionId: string) => string) | undefined;
  private readonly maxPending: number;

  constructor(
    state: PostgresPlatformState,
    installationId: string,
    issuer: string,
    options: PostgresCliSessionsOptions,
  ) {
    this.state = state;
    this.installationId = installationId;
    this.issuer = issuer;
    this.guarded = options.guarded;
    this.externalProviderIds = Object.freeze([...new Set(options.externalProviderIds ?? [])]);
    this.parentSessionKey = options.parentSessionKey;
    this.maxPending = options.maxPending ?? 1000;
  }

  private async query(
    unit: PlatformUnitOfWork,
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row[]> {
    return (await this.state.queryInTransaction(unit, sql, parameters)).rows as Row[];
  }

  private async principal(unit: PlatformUnitOfWork, userId: string): Promise<string> {
    const [row] = await this.query(
      unit,
      `SELECT id FROM occ.iam_identities WHERE kind = 'principal' AND issuer = $1 AND subject = $2
       AND namespace_id IS NULL AND agent_id IS NULL`,
      [this.issuer, userId],
    );
    if (row === undefined) {
      throw new AuthorizationDeniedError("The account has no Principal.");
    }
    return row.id as string;
  }

  private async audit(
    unit: PlatformUnitOfWork,
    action: string,
    principalId: string,
    requestId: string | undefined,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installationId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      source: "occ",
      ...(requestId === undefined ? {} : { requestId }),
      actorId: principalId,
      actor: { principalId, issuer: this.issuer },
      action,
      resource: { kind: "installation", id: this.installationId },
      outcome: "success",
      details,
    });
  }

  /** Deletes expired authorizations and expired sessions, at most `limit` of each. */
  private async deleteExpired(unit: PlatformUnitOfWork, limit: number) {
    const authorizations = await this.query(
      unit,
      `DELETE FROM occ.cli_device_authorizations WHERE id IN (
         SELECT id FROM occ.cli_device_authorizations
         WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT $1)
       RETURNING id`,
      [limit],
    );
    const sessions = await this.query(
      unit,
      `DELETE FROM occ.cli_sessions WHERE id IN (
         SELECT id FROM occ.cli_sessions
         WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT $1)
       RETURNING id`,
      [limit],
    );
    return { authorizations: authorizations.length, sessions: sessions.length };
  }

  /**
   * Records a new pending authorization. Expired rows are removed first, the way sign-in
   * attempts are, and the oldest pending ones beyond the total cap are evicted.
   */
  async start(input: CliDeviceAuthorizationStart): Promise<{ id: string; expiresAt: Date }> {
    return this.state.transact(async (unit) => {
      // One starter at a time, so the pending cap holds under concurrency.
      await this.query(
        unit,
        `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('occ.cli_device_authorizations', 0))`,
      );
      await this.deleteExpired(unit, 100);
      await this.query(
        unit,
        `DELETE FROM occ.cli_device_authorizations WHERE id IN (
           SELECT id FROM occ.cli_device_authorizations WHERE state = 'pending'
           ORDER BY created_at DESC OFFSET $1)`,
        [this.maxPending - 1],
      );
      const id = `cda_${randomUUID()}`;
      const [row] = await this.query(
        unit,
        `INSERT INTO occ.cli_device_authorizations
           (id, device_code_hash, user_code_hash, client_label, requester_address, namespace_id,
            created_at, expires_at)
         SELECT $1, $2, $3, $4, $5, $6, t.now, t.now + make_interval(secs => $7)
         FROM (SELECT clock_timestamp() AS now) t
         RETURNING expires_at`,
        [
          id,
          input.deviceCodeHash,
          input.userCodeHash,
          input.clientLabel,
          input.requesterAddress,
          input.namespaceId ?? null,
          CLI_DEVICE_AUTHORIZATION_SECONDS,
        ],
      );
      return { id, expiresAt: row!.expires_at as Date };
    });
  }

  /** The pending, unexpired authorization for a user code. */
  async lookup(userCodeHash: string): Promise<CliDeviceAuthorization | undefined> {
    const [row] = await this.state.readStatement(
      `SELECT id, client_label, requester_address, namespace_id, expires_at
       FROM occ.cli_device_authorizations
       WHERE user_code_hash = $1 AND state = 'pending' AND expires_at > clock_timestamp()`,
      [userCodeHash],
    );
    return row === undefined ? undefined : authorization(row as Row);
  }

  /**
   * Approves or denies a pending authorization for the approving browser session, with its
   * audit event in the same transaction. Undefined when no pending, unexpired authorization
   * has this user code. A denial is final.
   */
  async decide(
    userCodeHash: string,
    decision: "approve" | "deny",
    approver: CliSessionApprover,
    requestId?: string,
  ): Promise<CliDeviceAuthorization | undefined> {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `UPDATE occ.cli_device_authorizations
         SET state = $2, user_id = $3, parent_session_id = $4, decided_at = clock_timestamp()
         WHERE user_code_hash = $1 AND state = 'pending' AND expires_at > clock_timestamp()
         RETURNING id, client_label, requester_address, namespace_id, expires_at`,
        [
          userCodeHash,
          decision === "approve" ? "approved" : "denied",
          approver.userId,
          decision === "approve" ? approver.sessionId : null,
        ],
      );
      if (row === undefined) {
        return undefined;
      }
      const decided = authorization(row);
      const principalId = await this.principal(unit, approver.userId);
      await this.audit(unit, `openclaw.auth.cli-sessions.${decision}`, principalId, requestId, {
        authorizationId: decided.id,
        requesterAddress: decided.requesterAddress,
        clientLabel: decided.clientLabel,
        ...(decided.namespaceId === undefined ? {} : { namespaceId: decided.namespaceId }),
      });
      return decided;
    });
  }

  /**
   * The token exchange: approved to consumed, the CLI session and its `issue` audit event
   * commit together. Two pollers holding the same device code consume it once; an audit
   * failure rolls everything back, so the authorization stays approved.
   */
  async exchange(
    deviceCodeHash: string,
    issue: { readonly tokenHash: string; readonly maxLifetimeSeconds: number },
    requestId?: string,
  ): Promise<CliSessionExchange> {
    return this.state.transact(async (unit) => {
      const [found] = await this.query(
        unit,
        `SELECT a.id, a.state, a.user_id, a.parent_session_id, a.namespace_id, a.client_label,
           a.expires_at > clock_timestamp() AS current
         FROM occ.cli_device_authorizations a WHERE a.device_code_hash = $1 FOR UPDATE`,
        [deviceCodeHash],
      );
      if (found === undefined || found.current !== true || found.state === "consumed") {
        return { status: "expired" };
      }
      if (found.state === "pending" || found.state === "denied") {
        return { status: found.state };
      }
      const [parent] = await this.query(
        unit,
        `SELECT s.id, s.expires_at, b.method_id, b.version, b.method_version,
           (SELECT count(*) FROM occ.cli_sessions c
            WHERE c.parent_session_id = s.id AND c.expires_at > clock_timestamp())::integer AS active
         FROM occ.session s
         LEFT JOIN occ.human_authentication_sessions b ON b.session_id = s.id AND b.user_id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > clock_timestamp()
         FOR NO KEY UPDATE OF s`,
        [found.parent_session_id, found.user_id],
      );
      if (parent === undefined || (this.guarded && parent.method_id === null)) {
        return { status: "expired" };
      }
      if ((parent.active as number) >= CLI_SESSIONS_PER_PARENT) {
        return { status: "limit" };
      }
      const id = `cls_${randomUUID()}`;
      const [inserted] = await this.query(
        unit,
        `WITH inserted AS (
           INSERT INTO occ.cli_sessions (id, token_hash, authorization_id, user_id, parent_session_id,
             namespace_id, client_label, method_id, version, method_version, created_at, expires_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, t.now,
             LEAST($11::timestamptz, t.now + make_interval(secs => $12))
           FROM (SELECT clock_timestamp() AS now) t
           RETURNING *)
         SELECT ${sessionColumns} FROM inserted c JOIN occ."user" u ON u.id = c.user_id`,
        [
          id,
          issue.tokenHash,
          found.id,
          found.user_id,
          found.parent_session_id,
          found.namespace_id,
          found.client_label,
          parent.method_id,
          parent.version,
          parent.method_version,
          parent.expires_at,
          issue.maxLifetimeSeconds,
        ],
      );
      await this.query(
        unit,
        `UPDATE occ.cli_device_authorizations SET state = 'consumed' WHERE id = $1`,
        [found.id],
      );
      const session = cliSession(inserted!);
      const principalId = await this.principal(unit, session.userId);
      await this.audit(unit, "openclaw.auth.cli-sessions.issue", principalId, requestId, {
        cliSessionId: session.id,
        authorizationId: found.id,
        ...(this.parentSessionKey === undefined
          ? {}
          : { parentSessionKey: this.parentSessionKey(session.parentSessionId) }),
        expiresAt: session.expiresAt.toISOString(),
        ...(session.namespaceId === undefined ? {} : { namespaceId: session.namespaceId }),
      });
      return { status: "issued", session };
    });
  }

  /**
   * The CLI session for a token hash while it still authenticates: unexpired, with an
   * unexpired parent session of the same account. In the guarded profile its account must be
   * enabled, its account and method versions current and its provider instance configured,
   * the browser session's own checks. One statement, no transaction.
   */
  async verify(tokenHash: string): Promise<CliSession | undefined> {
    const guardedJoins = this.guarded
      ? `JOIN occ.human_authentication_accounts h ON h.user_id = c.user_id AND h.version = c.version
         JOIN occ.account m ON m.id = c.method_id AND m.user_id = c.user_id
           AND m.authentication_version = c.method_version
         JOIN occ.iam_identities p ON p.id = h.principal_id AND p.kind = 'principal'
           AND p.issuer = $2 AND p.subject = c.user_id`
      : "";
    const guardedConditions = this.guarded
      ? `AND NOT h.disabled AND h.installation_id = $3
         AND ((m.provider_id = 'credential' AND m.password IS NOT NULL AND m.password <> '')
           OR (m.identity_only AND m.provider_id = ANY($4::text[])))`
      : "";
    const [row] = await this.state.readStatement(
      `SELECT ${sessionColumns}
       FROM occ.cli_sessions c
       JOIN occ.session s ON s.id = c.parent_session_id AND s.user_id = c.user_id
       JOIN occ."user" u ON u.id = c.user_id
       ${guardedJoins}
       WHERE c.token_hash = $1 AND c.expires_at > clock_timestamp()
         AND s.expires_at > clock_timestamp() ${guardedConditions}`,
      this.guarded
        ? [tokenHash, this.issuer, this.installationId, this.externalProviderIds]
        : [tokenHash],
    );
    return row === undefined ? undefined : cliSession(row as Row);
  }

  /** The account's unexpired CLI sessions, newest first. */
  async list(userId: string): Promise<CliSession[]> {
    const rows = await this.state.readStatement(
      `SELECT ${sessionColumns}
       FROM occ.cli_sessions c JOIN occ."user" u ON u.id = c.user_id
       WHERE c.user_id = $1 AND c.expires_at > clock_timestamp()
       ORDER BY c.created_at DESC, c.id`,
      [userId],
    );
    return rows.map((row) => cliSession(row as Row));
  }

  /**
   * Ends one of the account's own CLI sessions, with its `revoke` audit event. False when the
   * account has no such session.
   */
  async revoke(
    userId: string,
    sessionId: string,
    reason: "logout" | "console",
    requestId?: string,
  ): Promise<boolean> {
    return this.state.transact(async (unit) => {
      const [deleted] = await this.query(
        unit,
        `DELETE FROM occ.cli_sessions WHERE id = $1 AND user_id = $2 RETURNING id`,
        [sessionId, userId],
      );
      if (deleted === undefined) {
        return false;
      }
      const principalId = await this.principal(unit, userId);
      await this.audit(unit, "openclaw.auth.cli-sessions.revoke", principalId, requestId, {
        cliSessionId: sessionId,
        reason,
      });
      return true;
    });
  }

  /** The bounded periodic sweep: expired authorizations and sessions. */
  async sweep(limit = 1000): Promise<{ authorizations: number; sessions: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ScopeViolationError("The sweep limit is invalid.");
    }
    return this.state.transact((unit) => this.deleteExpired(unit, limit));
  }
}
