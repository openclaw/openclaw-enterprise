import { randomUUID } from "node:crypto";
import {
  AuthorizationDeniedError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "../errors.ts";
import type { PlatformUnitOfWork } from "./platform-state.ts";
import type { PersistedNativeIAMPrincipalSeed, PostgresPlatformState } from "./postgres-state.ts";
import type { AuditEvent } from "@openclaw-enterprise/contracts";

export interface HumanAuthenticationActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly principalId: string;
}

export interface HumanAuthenticationAccount {
  readonly userId: string;
  readonly principalId: string;
  readonly version: number;
  readonly disabled: boolean;
  readonly methods: readonly { methodId: string; providerId: string; subject: string }[];
}

/** The single recovery designation: the account whose password the database protects. */
export interface HumanAuthenticationRecovery {
  readonly userId: string;
  readonly principalId: string;
  readonly methodId: string;
}

export interface HumanAuthenticationUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly image: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HumanAuthenticationProof {
  readonly userId: string;
  readonly principalId: string;
  readonly methodId: string;
  readonly version: number;
  readonly methodVersion: number;
  readonly providerId: string;
  readonly subject: string;
  readonly passwordHash?: string;
}

export interface HumanAuthenticationSnapshot {
  readonly user: HumanAuthenticationUser;
  readonly proof: HumanAuthenticationProof;
}

export interface HumanAuthenticationSession {
  readonly id: string;
  readonly token: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface HumanAuthenticationAttemptKey {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly providerId: string;
  readonly callbackURL: string;
}

export interface HumanAuthenticationAttempt extends HumanAuthenticationAttemptKey {
  readonly codeVerifier: string;
  readonly expiresAt: Date;
}

export type HumanAuthenticationDenial =
  | "INVALID_CREDENTIALS"
  | "EXTERNAL_IDENTITY_REJECTED"
  | "SESSION_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "MEMBERSHIP_REQUIRED"
  | "MEMBERSHIP_UNAVAILABLE";

/** A duplicate account email; the caller maps it to its own conflict response. */
export class UserAlreadyExistsError extends ResourceConflictError {
  constructor() {
    super("The requested account already exists.");
    this.name = "UserAlreadyExistsError";
  }
}

// Account creation answers a taken identity with the same message (createAuthAccount route).
const EXTERNAL_IDENTITY_ASSIGNED = "The external identity is already assigned.";

/** The unique violation raised when another account already holds the external identity. */
function isExternalIdentityConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "account_provider_account_unique"
  );
}

/** A validated password account whose hash was computed before the State transaction. */
export interface PreparedPasswordAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly credentialId: string;
}

export type HumanAuthenticationEnrolment =
  | {
      readonly enrolled: true;
      readonly principalId: string;
      readonly version: number;
      /** False when the account was already enrolled. */
      readonly created: boolean;
    }
  | { readonly enrolled: false; readonly reason: "PRINCIPAL_MISSING" | "PASSWORD_METHOD" };

export interface HumanAuthenticationActivation {
  /** Users left unenrolled because they lack a Principal or exactly one password. */
  readonly skipped: readonly string[];
}

/** Lets stopped maintenance run activation inside its exclusivity proof. */
export interface HumanAuthenticationActivationHooks {
  /** Runs after the activation lock and again before commit; throwing rolls back. */
  readonly exclusive?: (unit: PlatformUnitOfWork) => Promise<void>;
  /** Runs before commit only when this call designated the recovery account. */
  readonly activated?: (
    unit: PlatformUnitOfWork,
    activation: HumanAuthenticationActivation & { userId: string; principalId: string },
  ) => Promise<void>;
}

type Row = Record<string, unknown>;

function userFromRow(row: Row): HumanAuthenticationUser {
  return {
    id: row.user_id as string,
    email: row.email as string,
    name: row.name as string,
    emailVerified: row.email_verified as boolean,
    image: row.image as string | null,
    createdAt: row.user_created_at as Date,
    updatedAt: row.user_updated_at as Date,
  };
}

function sessionFromRow(row: Row): HumanAuthenticationSession {
  return {
    id: row.id as string,
    token: row.token as string,
    userId: row.user_id as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
    ipAddress: row.ip_address as string | null,
    userAgent: row.user_agent as string | null,
  };
}

/**
 * The guarded profile's known-device account state: the user, its password method and that
 * method's authentication version, which the database bumps on every password change. A
 * known-device entry issued under one state stops verifying under any other. A disabled
 * account has no state (see `knownDeviceState`). The account version is deliberately left
 * out: attaching or detaching an external identity must not strand a browser's password
 * fallback.
 */
export function knownDeviceAccountState(
  proof: Pick<HumanAuthenticationProof, "userId" | "methodId" | "methodVersion">,
): string {
  return `guarded\0${proof.userId}\0${proof.methodId}\0${proof.methodVersion}`;
}

// Pending external sign-in attempts per Installation. A full table evicts its oldest attempts.
const pendingAttemptCapacity = 1000;

const userColumns = `u.id AS user_id, u.email, u.name, u.email_verified, u.image,
  u.created_at AS user_created_at, u.updated_at AS user_updated_at`;

export interface PostgresHumanAuthenticationOptions {
  /**
   * Provider instance IDs of the external sign-in providers configured now (for example
   * `github:<client id digest>` or `oidc:<issuer and client id digest>`). A session signed in
   * through an external method of any other instance does not authenticate. Absent means no
   * external provider is configured: only password sessions authenticate.
   */
  readonly externalProviderIds?: readonly string[];
}

/** Authentication persistence shares the original State transaction and audit writer. */
export class PostgresHumanAuthentication {
  private readonly state: PostgresPlatformState;
  private readonly installationId: string;
  private readonly issuer: string;
  private readonly externalProviderIds: readonly string[];

  constructor(
    state: PostgresPlatformState,
    installationId: string,
    issuer: string,
    options: PostgresHumanAuthenticationOptions = {},
  ) {
    this.state = state;
    this.installationId = installationId;
    this.issuer = issuer;
    const externalProviderIds = options.externalProviderIds ?? [];
    if (
      !Array.isArray(externalProviderIds) ||
      externalProviderIds.some(
        (providerId) =>
          typeof providerId !== "string" || providerId.length === 0 || providerId === "credential",
      )
    ) {
      throw new ScopeViolationError("The configured external sign-in providers are invalid.");
    }
    this.externalProviderIds = Object.freeze([...new Set(externalProviderIds)]);
  }

  private async query(
    unit: PlatformUnitOfWork,
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row[]> {
    return (await this.state.queryInTransaction(unit, sql, parameters)).rows as Row[];
  }

  private async lockUser(unit: PlatformUnitOfWork, userId: string): Promise<Row> {
    const [user] = await this.query(
      unit,
      `SELECT ${userColumns} FROM occ."user" u WHERE u.id = $1 FOR UPDATE`,
      [userId],
    );
    if (user === undefined) {
      throw new ScopeViolationError("The authentication account is unavailable.");
    }
    return user;
  }

  private async findPrincipal(
    unit: PlatformUnitOfWork,
    userId: string,
  ): Promise<string | undefined> {
    const [principal] = await this.query(
      unit,
      `SELECT id FROM occ.iam_identities WHERE kind = 'principal' AND issuer = $1 AND subject = $2
       AND namespace_id IS NULL AND agent_id IS NULL`,
      [this.issuer, userId],
    );
    return principal === undefined ? undefined : (principal.id as string);
  }

  private async principal(unit: PlatformUnitOfWork, userId: string): Promise<string> {
    const principal = await this.findPrincipal(unit, userId);
    if (principal === undefined) {
      throw new ScopeViolationError("The authentication Principal is unavailable.");
    }
    return principal;
  }

  /**
   * Enrols one existing user that has a Principal and exactly one password method. The one
   * enrolment rule for activation, online repair (enrolAccount) and stopped maintenance; it
   * runs inside the caller's State transaction and is idempotent.
   */
  async enrolUser(unit: PlatformUnitOfWork, userId: string): Promise<HumanAuthenticationEnrolment> {
    await this.lockUser(unit, userId);
    const principal = await this.findPrincipal(unit, userId);
    if (principal === undefined) {
      return { enrolled: false, reason: "PRINCIPAL_MISSING" };
    }
    const methods = await this.query(
      unit,
      `SELECT id FROM occ.account WHERE user_id = $1 AND provider_id = 'credential'
       AND password IS NOT NULL AND password <> '' FOR SHARE`,
      [userId],
    );
    if (methods.length !== 1) {
      return { enrolled: false, reason: "PASSWORD_METHOD" };
    }
    const [inserted] = await this.query(
      unit,
      `INSERT INTO occ.human_authentication_accounts (user_id, installation_id, principal_id)
       VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, this.installationId, principal],
    );
    const account = await this.enrolled(unit, userId);
    return {
      enrolled: true,
      principalId: principal,
      version: account.version as number,
      created: inserted !== undefined,
    };
  }

  private async enrolled(unit: PlatformUnitOfWork, userId: string): Promise<Row> {
    const principalId = await this.principal(unit, userId);
    const [account] = await this.query(
      unit,
      `SELECT * FROM occ.human_authentication_accounts
       WHERE user_id = $1 AND installation_id = $2 AND principal_id = $3 FOR UPDATE`,
      [userId, this.installationId, principalId],
    );
    if (account === undefined) {
      throw new ScopeViolationError("The authentication account association is invalid.");
    }
    return account;
  }

  private async audit(
    unit: PlatformUnitOfWork,
    action: string,
    actorId: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installationId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId,
      actor: { principalId: actorId },
      action,
      resource: { kind: "installation", id: this.installationId },
      outcome: "success",
      ...(details === undefined ? {} : { details }),
    });
  }

  async recoveryDesignation(): Promise<
    { userId: string; principalId: string; email: string } | undefined
  > {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `SELECT r.user_id, r.principal_id, u.email
         FROM occ.human_authentication_recovery r
         JOIN occ."user" u ON u.id = r.user_id
         WHERE r.installation_id = $1`,
        [this.installationId],
      );
      return row === undefined
        ? undefined
        : {
            userId: row.user_id as string,
            principalId: row.principal_id as string,
            email: row.email as string,
          };
    });
  }

  /**
   * Enabled, enrolled accounts other than the recovery account that have no identity for any
   * of `providerIds`. With recovery-only password sign-in they cannot sign in until an
   * administrator attaches one. Ordered by user ID.
   */
  async accountsWithoutExternalIdentity(providerIds: readonly string[]): Promise<string[]> {
    return this.state.transact(async (unit) => {
      const rows = await this.query(
        unit,
        `SELECT h.user_id FROM occ.human_authentication_accounts h
         WHERE h.installation_id = $1 AND h.disabled = false
         AND NOT EXISTS (SELECT 1 FROM occ.human_authentication_recovery r
                         WHERE r.installation_id = $1 AND r.user_id = h.user_id)
         AND NOT EXISTS (SELECT 1 FROM occ.account m
                         WHERE m.user_id = h.user_id AND m.identity_only
                         AND m.provider_id = ANY($2::text[]))
         ORDER BY h.user_id`,
        [this.installationId, [...providerIds]],
      );
      return rows.map((row) => row.user_id as string);
    });
  }

  /**
   * The known-device account state (see `knownDeviceAccountState`) for an enrolled, enabled
   * account of this Installation with a password, by normalized email; undefined otherwise,
   * so a disabled account's entries verify nothing while it stays disabled. A plain read
   * outside any transaction (it runs before password admission, once per attempt): one
   * statement that locks nothing and writes no audit.
   */
  async knownDeviceState(email: string): Promise<string | undefined> {
    const rows = await this.state.readStatement(
      `SELECT u.id AS user_id, m.id AS method_id, m.authentication_version
       FROM occ."user" u
       JOIN occ.human_authentication_accounts h
         ON h.user_id = u.id AND h.installation_id = $2 AND NOT h.disabled
       JOIN occ.account m ON m.user_id = u.id AND m.provider_id = 'credential'
         AND m.password IS NOT NULL AND m.password <> ''
       WHERE u.email = $1`,
      [email, this.installationId],
    );
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) {
      return undefined;
    }
    return knownDeviceAccountState({
      userId: row.user_id as string,
      methodId: row.method_id as string,
      methodVersion: row.authentication_version as number,
    });
  }

  /** The caller must first authorize this exact Principal through the selected IAM Driver. */
  async activateRecovery(
    userId: string,
    principalId: string,
    hooks: HumanAuthenticationActivationHooks = {},
  ): Promise<HumanAuthenticationActivation> {
    return this.state.transact(async (unit) => {
      // Serialize the one-time designation and legacy-session invalidation across controllers.
      await this.query(unit, `SELECT pg_advisory_xact_lock(1868785005, hashtext($1))`, [
        this.installationId,
      ]);
      await hooks.exclusive?.(unit);
      const [designation] = await this.query(
        unit,
        `SELECT user_id, principal_id FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [this.installationId],
      );
      const skipped: string[] = [];
      if (designation === undefined) {
        // Maintenance excludes old writers. Enrol every qualifying account before enabling
        // admission; the rest stay unenrolled and cannot sign in until repaired.
        const users = await this.query(unit, `SELECT id FROM occ."user" ORDER BY id FOR UPDATE`);
        for (const user of users) {
          const enrolment = await this.enrolUser(unit, user.id as string);
          if (!enrolment.enrolled) {
            skipped.push(user.id as string);
          }
        }
      }
      await this.lockUser(unit, userId);
      const account = await this.enrolled(unit, userId);
      if (account.principal_id !== principalId || account.disabled !== false) {
        throw new ScopeViolationError("The recovery account is unavailable.");
      }
      const [method] = await this.query(
        unit,
        `SELECT id FROM occ.account WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL AND password <> '' FOR SHARE`,
        [userId],
      );
      if (method === undefined) {
        throw new ScopeViolationError("The recovery account requires a password.");
      }
      const [existing] = await this.query(
        unit,
        `SELECT user_id, principal_id FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [this.installationId],
      );
      if (existing !== undefined) {
        if (existing.user_id !== userId || existing.principal_id !== principalId) {
          throw new ScopeViolationError("The recovery designation cannot be changed.");
        }
        await hooks.exclusive?.(unit);
        return { skipped: [] };
      }
      await this.query(
        unit,
        `INSERT INTO occ.human_authentication_recovery (installation_id, user_id, principal_id, method_id) VALUES ($1, $2, $3, $4)`,
        [this.installationId, userId, principalId, method.id],
      );
      await this.query(
        unit,
        `DELETE FROM occ.session s WHERE NOT EXISTS (SELECT 1 FROM occ.human_authentication_sessions b WHERE b.session_id = s.id)`,
      );
      await this.audit(unit, "authentication.recovery.activate", principalId, {
        userId,
        skipped,
      });
      await hooks.activated?.(unit, { userId, principalId, skipped });
      await hooks.exclusive?.(unit);
      return { skipped };
    });
  }

  /**
   * Writes a password account, its Principal and bindings, and its enrolment in one
   * State transaction, so a failure leaves no partial account.
   */
  async provisionPasswordAccount(
    prepared: PreparedPasswordAccount,
    seed: PersistedNativeIAMPrincipalSeed,
    auditEvent?: AuditEvent,
    external?: { readonly providerId: string; readonly subject: string },
  ): Promise<void> {
    if (seed.principal.issuer !== this.issuer || seed.principal.subject !== prepared.id) {
      throw new ScopeViolationError("The account Principal must identify the new account.");
    }
    if (external?.providerId === "credential") {
      throw new ScopeViolationError("An external method cannot replace a password.");
    }
    await this.state.transact(async (unit) => {
      try {
        await this.query(
          unit,
          `INSERT INTO occ."user" (id, name, email, email_verified, image, created_at, updated_at)
           SELECT $1, $2, $3, true, NULL, t.now, t.now FROM (SELECT clock_timestamp() AS now) t`,
          [prepared.id, prepared.name, prepared.email],
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "23505" &&
          "constraint" in error &&
          error.constraint === "user_email_key"
        ) {
          throw new UserAlreadyExistsError();
        }
        throw error;
      }
      await this.query(
        unit,
        `INSERT INTO occ.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         SELECT $1, $2, 'credential', $2, $3, t.now, t.now FROM (SELECT clock_timestamp() AS now) t`,
        [prepared.credentialId, prepared.id, prepared.passwordHash],
      );
      const installationId = await this.state.insertNativeIAMPrincipal(unit, seed);
      if (installationId !== this.installationId) {
        throw new ScopeViolationError("The account belongs to a different Installation.");
      }
      await this.query(
        unit,
        `INSERT INTO occ.human_authentication_accounts (user_id, installation_id, principal_id)
         VALUES ($1, $2, $3)`,
        [prepared.id, this.installationId, seed.principal.id],
      );
      await this.enrolled(unit, prepared.id);
      if (external !== undefined) {
        // The optional external identity attaches in the same transaction as the account.
        const methodId = randomUUID();
        try {
          await this.query(
            unit,
            `INSERT INTO occ.account (id, account_id, provider_id, user_id, created_at, updated_at, identity_only)
             VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), true)`,
            [methodId, external.subject, external.providerId, prepared.id],
          );
        } catch (error) {
          if (isExternalIdentityConflict(error)) {
            throw new ResourceConflictError(EXTERNAL_IDENTITY_ASSIGNED);
          }
          throw error;
        }
        await this.audit(unit, "authentication.method.attach", auditEvent?.actorId ?? prepared.id, {
          userId: prepared.id,
          methodId,
          principalId: seed.principal.id,
        });
      }
      if (auditEvent !== undefined) {
        await unit.audit.append(auditEvent);
      }
    });
  }

  async snapshotPassword(email: string): Promise<HumanAuthenticationSnapshot | undefined> {
    return this.state.transact(async (unit) => {
      const [user] = await this.query(
        unit,
        `SELECT ${userColumns} FROM occ."user" u WHERE u.email = $1 FOR UPDATE`,
        [email],
      );
      if (user === undefined) {
        return undefined;
      }
      return this.snapshot(unit, user, "credential");
    });
  }

  async snapshotExternal(
    providerId: string,
    subject: string,
    attemptCreatedAt?: Date,
  ): Promise<HumanAuthenticationSnapshot | undefined> {
    if (providerId === "credential") {
      return undefined;
    }
    return this.state.transact(async (unit) => {
      const [method] = await this.query(
        unit,
        `SELECT user_id FROM occ.account WHERE provider_id = $1 AND account_id = $2 AND identity_only`,
        [providerId, subject],
      );
      if (method === undefined) {
        return undefined;
      }
      const user = await this.lockUser(unit, method.user_id as string);
      return this.snapshot(unit, user, providerId, subject, attemptCreatedAt);
    });
  }

  private async snapshot(
    unit: PlatformUnitOfWork,
    user: Row,
    providerId: string,
    subject?: string,
    attemptCreatedAt?: Date,
  ): Promise<HumanAuthenticationSnapshot | undefined> {
    const [association] = await this.query(
      unit,
      `SELECT 1 FROM occ.human_authentication_accounts WHERE user_id = $1`,
      [user.user_id],
    );
    if (association === undefined) {
      // Accounts skipped at activation stay unenrolled and are refused like bad credentials.
      return undefined;
    }
    const account = await this.enrolled(unit, user.user_id as string);
    if (account.disabled !== false) {
      return undefined;
    }
    const methods = await this.query(
      unit,
      `SELECT m.* FROM occ.account m
       JOIN occ.human_authentication_accounts h ON h.user_id = m.user_id
       WHERE m.user_id = $1 AND m.provider_id = $2 AND ($3::text IS NULL OR m.account_id = $3)
       AND ($4::timestamptz IS NULL OR (h.changed_at <= $4 AND m.updated_at <= $4)) FOR SHARE OF m`,
      [user.user_id, providerId, subject ?? null, attemptCreatedAt ?? null],
    );
    const method = methods[0];
    if (
      methods.length !== 1 ||
      method === undefined ||
      (providerId === "credential"
        ? typeof method.password !== "string" || method.password.length === 0
        : method.identity_only !== true)
    ) {
      return undefined;
    }
    const password = providerId === "credential" ? { passwordHash: method.password as string } : {};
    return {
      user: userFromRow(user),
      proof: {
        userId: user.user_id as string,
        principalId: account.principal_id as string,
        methodId: method.id as string,
        version: account.version as number,
        methodVersion: method.authentication_version as number,
        providerId,
        subject: method.account_id as string,
        ...password,
      },
    };
  }

  async issueSession(
    proof: HumanAuthenticationProof,
    session: Pick<
      HumanAuthenticationSession,
      "id" | "token" | "userId" | "ipAddress" | "userAgent"
    >,
  ): Promise<HumanAuthenticationSession> {
    return this.state.transact(async (unit) => {
      const user = await this.lockUser(unit, proof.userId);
      const current = await this.snapshot(unit, user, proof.providerId, proof.subject);
      if (
        (proof.providerId !== "credential" &&
          !this.externalProviderIds.includes(proof.providerId)) ||
        session.userId !== proof.userId ||
        current === undefined ||
        current.proof.principalId !== proof.principalId ||
        current.proof.methodId !== proof.methodId ||
        current.proof.version !== proof.version ||
        current.proof.methodVersion !== proof.methodVersion ||
        current.proof.passwordHash !== proof.passwordHash
      ) {
        throw new ScopeViolationError("The authentication proof is no longer current.");
      }
      const [inserted] = await this.query(
        unit,
        `INSERT INTO occ.session (id, token, user_id, created_at, updated_at, expires_at, ip_address, user_agent)
         SELECT $1, $2, $3, t.now, t.now, t.now + interval '8 hours', $4, $5
         FROM (SELECT clock_timestamp() AS now) t RETURNING *`,
        [
          session.id,
          session.token,
          session.userId,
          session.ipAddress ?? null,
          session.userAgent ?? null,
        ],
      );
      if (inserted === undefined) {
        throw new ScopeViolationError("The session lifetime is invalid.");
      }
      await this.query(
        unit,
        `INSERT INTO occ.human_authentication_sessions (session_id, user_id, method_id, version, method_version)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.id, proof.userId, proof.methodId, proof.version, proof.methodVersion],
      );
      await this.audit(unit, "authentication.login", proof.principalId, {
        userId: proof.userId,
        methodId: proof.methodId,
      });
      return sessionFromRow(inserted);
    });
  }

  /**
   * The session for `token` when it still authenticates. A session whose external sign-in
   * method belongs to a provider instance that is no longer configured (the provider was
   * removed, or its issuer or client ID changed) is ended here and audited once; password
   * sessions do not depend on provider configuration. The check is part of the one session
   * query, so it adds no round trip and never calls an identity provider.
   */
  async currentSession(
    token: string,
  ): Promise<(HumanAuthenticationSession & { user: HumanAuthenticationUser }) | undefined> {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `SELECT s.*, ${userColumns}, h.principal_id AS session_principal_id,
           m.id AS session_method_id, m.provider_id AS session_provider_id,
           (NOT m.identity_only OR m.provider_id = ANY($4::text[])) AS provider_configured
         FROM occ.session s
         JOIN occ.human_authentication_sessions b ON b.session_id = s.id AND b.user_id = s.user_id
         JOIN occ.human_authentication_accounts h ON h.user_id = s.user_id AND h.version = b.version
         JOIN occ.account m ON m.id = b.method_id AND m.user_id = s.user_id AND m.authentication_version = b.method_version
         JOIN occ."user" u ON u.id = s.user_id
         JOIN occ.iam_identities p ON p.id = h.principal_id AND p.kind = 'principal' AND p.issuer = $2 AND p.subject = s.user_id
         WHERE s.token = $1 AND s.expires_at > clock_timestamp() AND NOT h.disabled AND h.installation_id = $3
         AND ((m.provider_id = 'credential' AND m.password IS NOT NULL AND m.password <> '') OR m.identity_only)`,
        [token, this.issuer, this.installationId, this.externalProviderIds],
      );
      if (row === undefined) {
        return undefined;
      }
      if (row.provider_configured !== true) {
        await this.endUnconfiguredSession(unit, row);
        return undefined;
      }
      return { ...sessionFromRow(row), user: userFromRow(row) };
    });
  }

  /** Ends one session whose sign-in provider instance is gone; only the deleting call audits. */
  private async endUnconfiguredSession(unit: PlatformUnitOfWork, row: Row): Promise<void> {
    const userId = row.user_id as string;
    await this.lockUser(unit, userId);
    const [deleted] = await this.query(
      unit,
      `DELETE FROM occ.session WHERE id = $1 AND user_id = $2 RETURNING id`,
      [row.id, userId],
    );
    if (deleted === undefined) {
      return;
    }
    await this.audit(unit, "authentication.session.end", row.session_principal_id as string, {
      userId,
      methodId: row.session_method_id,
      providerId: row.session_provider_id,
      reason: "PROVIDER_NOT_CONFIGURED",
    });
  }

  async revokeSession(token: string): Promise<void> {
    await this.state.transact(async (unit) => {
      const [found] = await this.query(unit, `SELECT user_id FROM occ.session WHERE token = $1`, [
        token,
      ]);
      if (found === undefined) {
        return;
      }
      await this.lockUser(unit, found.user_id as string);
      const [deleted] = await this.query(
        unit,
        `DELETE FROM occ.session WHERE token = $1 RETURNING user_id`,
        [token],
      );
      if (deleted === undefined) {
        return;
      }
      const [account] = await this.query(
        unit,
        `SELECT principal_id FROM occ.human_authentication_accounts WHERE user_id = $1 AND installation_id = $2`,
        [deleted.user_id, this.installationId],
      );
      if (account === undefined) {
        throw new ScopeViolationError("The session account is unavailable.");
      }
      await this.audit(unit, "authentication.logout", account.principal_id as string, {
        userId: deleted.user_id,
      });
    });
  }

  private async guardAccounts(
    unit: PlatformUnitOfWork,
    userId: string,
    actor: HumanAuthenticationActor,
    expectedVersion?: number,
  ): Promise<Row> {
    await this.guardActor(unit, actor, [userId]);
    const account = await this.enrolled(unit, userId);
    if (
      expectedVersion !== undefined &&
      (!Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        account.version !== expectedVersion)
    ) {
      throw new ResourceStateConflictError(
        "The authentication account version changed. Read its current state before a new action.",
      );
    }
    return account;
  }

  /** Locks the actor and the named users in one order, then requires the actor's session to be current. */
  private async guardActor(
    unit: PlatformUnitOfWork,
    actor: HumanAuthenticationActor,
    userIds: readonly string[],
  ): Promise<void> {
    await this.query(unit, `SET LOCAL lock_timeout = '5s'`);
    await this.query(unit, `SET LOCAL statement_timeout = '10s'`);
    for (const id of [...new Set([...userIds, actor.userId])].sort()) {
      await this.lockUser(unit, id);
    }
    const [current] = await this.query(
      unit,
      `SELECT s.id FROM occ.session s
       JOIN occ.human_authentication_sessions b ON b.session_id = s.id AND b.user_id = s.user_id
       JOIN occ.human_authentication_accounts h ON h.user_id = s.user_id AND h.version = b.version
       JOIN occ.account m ON m.id = b.method_id AND m.user_id = s.user_id AND m.authentication_version = b.method_version
       JOIN occ.iam_identities p ON p.id = h.principal_id AND p.kind = 'principal' AND p.issuer = $4 AND p.subject = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND h.principal_id = $3 AND h.installation_id = $5
       AND s.expires_at > clock_timestamp() AND NOT h.disabled
       AND ((m.provider_id = 'credential' AND m.password IS NOT NULL AND m.password <> '')
         OR (m.identity_only AND m.provider_id = ANY($6::text[])))`,
      [
        actor.sessionId,
        actor.userId,
        actor.principalId,
        this.issuer,
        this.installationId,
        this.externalProviderIds,
      ],
    );
    if (current === undefined) {
      throw new AuthorizationDeniedError("The human administrator session is no longer current.");
    }
  }

  /** Present state under the same guards; this is not an operation-result receipt. */
  async readAccount(
    userId: string,
    actor: HumanAuthenticationActor,
  ): Promise<HumanAuthenticationAccount> {
    return this.state.transact(async (unit) => {
      const account = await this.guardAccounts(unit, userId, actor);
      const methods = await this.query(
        unit,
        `SELECT id, provider_id, account_id FROM occ.account WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
      return {
        userId,
        principalId: account.principal_id as string,
        version: account.version as number,
        disabled: account.disabled as boolean,
        methods: methods.map((method) => ({
          methodId: method.id as string,
          providerId: method.provider_id as string,
          subject: method.account_id as string,
        })),
      };
    });
  }

  async attachExternal(
    userId: string,
    providerId: string,
    subject: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<{ methodId: string; created: boolean }> {
    if (providerId === "credential") {
      throw new ScopeViolationError("An external method cannot replace a password.");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ResourceStateConflictError("A current account version is required.");
    }
    return this.state.transact(async (unit) => {
      const account = await this.guardAccounts(unit, userId, actor, expectedVersion);
      if (account.disabled !== false) {
        throw new ResourceStateConflictError("The authentication account is disabled.");
      }
      const [existing] = await this.query(
        unit,
        `SELECT id, user_id, identity_only FROM occ.account WHERE provider_id = $1 AND account_id = $2 FOR SHARE`,
        [providerId, subject],
      );
      if (existing !== undefined) {
        // The route admits only an Installation administrator covering the target Principal
        // (controller humanAccountActor), who can already list every account's sign-in
        // methods, so naming the conflict discloses nothing new. Keep that gate in front.
        if (existing.user_id !== userId || existing.identity_only !== true) {
          throw new ResourceStateConflictError(EXTERNAL_IDENTITY_ASSIGNED);
        }
        return { methodId: existing.id as string, created: false };
      }
      const methodId = randomUUID();
      try {
        await this.query(
          unit,
          `INSERT INTO occ.account (id, account_id, provider_id, user_id, created_at, updated_at, identity_only) VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), true)`,
          [methodId, subject, providerId, userId],
        );
      } catch (error) {
        // A concurrent attach of the same identity committed first.
        if (isExternalIdentityConflict(error)) {
          throw new ResourceStateConflictError(EXTERNAL_IDENTITY_ASSIGNED);
        }
        throw error;
      }
      await this.query(
        unit,
        `UPDATE occ.human_authentication_accounts SET version = version + 1, changed_at = clock_timestamp() WHERE user_id = $1`,
        [userId],
      );
      await this.query(unit, `DELETE FROM occ.session WHERE user_id = $1`, [userId]);
      await this.audit(unit, "authentication.method.attach", actor.principalId, {
        userId,
        methodId,
        principalId: account.principal_id,
      });
      return { methodId, created: true };
    });
  }

  /** Removes one external identity; the password method and recovery credential stay. */
  async detachExternal(
    userId: string,
    methodId: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<{ methodId: string; providerId: string }> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ResourceStateConflictError("A current account version is required.");
    }
    return this.state.transact(async (unit) => {
      const account = await this.guardAccounts(unit, userId, actor, expectedVersion);
      const [method] = await this.query(
        unit,
        `SELECT id, provider_id, user_id, identity_only FROM occ.account WHERE id = $1 FOR UPDATE`,
        [methodId],
      );
      if (
        method === undefined ||
        method.user_id !== userId ||
        method.identity_only !== true ||
        method.provider_id === "credential"
      ) {
        throw new ResourceStateConflictError("Only an attached external identity can be detached.");
      }
      // Bindings cascade with the method; the recovery credential is never identity-only.
      await this.query(unit, `DELETE FROM occ.account WHERE id = $1`, [methodId]);
      await this.query(
        unit,
        `UPDATE occ.human_authentication_accounts SET version = version + 1, changed_at = clock_timestamp() WHERE user_id = $1`,
        [userId],
      );
      await this.query(unit, `DELETE FROM occ.session WHERE user_id = $1`, [userId]);
      const providerId = method.provider_id as string;
      await this.audit(unit, "authentication.method.detach", actor.principalId, {
        userId,
        methodId,
        providerId,
        principalId: account.principal_id,
      });
      return { methodId, providerId };
    });
  }

  async changeAccount(
    userId: string,
    operation: "disable" | "enable" | "revoke",
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ResourceStateConflictError("A current account version is required.");
    }
    await this.state.transact(async (unit) => {
      const account = await this.guardAccounts(unit, userId, actor, expectedVersion);
      if (operation === "disable") {
        const [recovery] = await this.query(
          unit,
          `SELECT user_id FROM occ.human_authentication_recovery WHERE user_id = $1`,
          [userId],
        );
        if (recovery !== undefined) {
          throw new ResourceStateConflictError("The recovery account cannot be disabled.");
        }
      }
      if (operation === "enable" && account.disabled !== true) {
        throw new ResourceStateConflictError("The authentication account is not disabled.");
      }
      await this.query(
        unit,
        `UPDATE occ.human_authentication_accounts SET disabled = CASE $2::text
           WHEN 'disable' THEN true WHEN 'enable' THEN false ELSE disabled END,
         version = version + 1, changed_at = clock_timestamp() WHERE user_id = $1`,
        [userId, operation],
      );
      await this.query(unit, `DELETE FROM occ.session WHERE user_id = $1`, [userId]);
      await this.audit(unit, `authentication.account.${operation}`, actor.principalId, { userId });
    });
  }

  /** Present designation under the administrator guards; this is not an operation-result receipt. */
  async readRecovery(actor: HumanAuthenticationActor): Promise<HumanAuthenticationRecovery> {
    return this.state.transact(async (unit) => {
      await this.guardActor(unit, actor, []);
      const [row] = await this.query(
        unit,
        `SELECT user_id, principal_id, method_id FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [this.installationId],
      );
      if (row === undefined) {
        throw new ScopeViolationError("The recovery designation is unavailable.");
      }
      return {
        userId: row.user_id as string,
        principalId: row.principal_id as string,
        methodId: row.method_id as string,
      };
    });
  }

  /**
   * Moves the one designation to another enrolled administrator. The caller must first authorize
   * this exact Principal through the selected IAM Driver. The row is updated, never deleted, so a
   * designation always exists and the credential guard follows it to the new password.
   */
  async replaceRecovery(
    userId: string,
    principalId: string,
    expectedCurrentUserId: string,
    actor: HumanAuthenticationActor,
    expectedVersion: number,
  ): Promise<HumanAuthenticationRecovery & { changed: boolean; email: string }> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ResourceStateConflictError("A current account version is required.");
    }
    return this.state.transact(async (unit) => {
      // The same lock serializes activation, so a designation cannot appear or move concurrently.
      await this.query(unit, `SELECT pg_advisory_xact_lock(1868785005, hashtext($1))`, [
        this.installationId,
      ]);
      const [designation] = await this.query(
        unit,
        `SELECT user_id, principal_id, method_id FROM occ.human_authentication_recovery WHERE installation_id = $1`,
        [this.installationId],
      );
      if (designation === undefined) {
        throw new ScopeViolationError("The recovery designation is unavailable.");
      }
      if (designation.user_id !== expectedCurrentUserId) {
        throw new ResourceStateConflictError(
          "The recovery designation changed. Read its current state before a new action.",
        );
      }
      await this.guardActor(unit, actor, [userId, designation.user_id as string]);
      const account = await this.guardAccounts(unit, userId, actor, expectedVersion);
      if (account.principal_id !== principalId) {
        throw new ScopeViolationError("The recovery account is unavailable.");
      }
      if (account.disabled !== false) {
        throw new ResourceStateConflictError("The authentication account is disabled.");
      }
      // The database has no composite key tying method_id to user_id, so the method is only
      // ever derived here from the target's own credential rows, never taken from input.
      const methods = await this.query(
        unit,
        `SELECT id FROM occ.account WHERE user_id = $1 AND provider_id = 'credential'
         AND password IS NOT NULL AND password <> '' FOR SHARE`,
        [userId],
      );
      const method = methods[0];
      if (methods.length !== 1 || method === undefined) {
        throw new ScopeViolationError("The recovery account requires exactly one password.");
      }
      // The holder's email keys the reserved password lane; guardActor locked this row, so the
      // email is read in the same transaction that commits the designation.
      const email = (await this.lockUser(unit, userId)).email as string;
      if (designation.user_id === userId) {
        if (designation.principal_id !== principalId || designation.method_id !== method.id) {
          throw new ScopeViolationError("The recovery designation is inconsistent.");
        }
        return { userId, principalId, methodId: method.id as string, changed: false, email };
      }
      const [updated] = await this.query(
        unit,
        `UPDATE occ.human_authentication_recovery SET user_id = $2, principal_id = $3, method_id = $4
         WHERE installation_id = $1 AND user_id = $5 RETURNING user_id`,
        [this.installationId, userId, principalId, method.id, designation.user_id],
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError(
          "The recovery designation changed. Read its current state before a new action.",
        );
      }
      await this.audit(unit, "authentication.recovery.replace", actor.principalId, {
        userId,
        principalId,
        previousUserId: designation.user_id,
        previousPrincipalId: designation.principal_id,
      });
      return { userId, principalId, methodId: method.id as string, changed: true, email };
    });
  }

  /**
   * Enrols one existing account that activation could not qualify, once an administrator has
   * provisioned its Principal and single password. Enrolment never grants access by itself.
   */
  async enrolAccount(
    userId: string,
    actor: HumanAuthenticationActor,
  ): Promise<{ principalId: string; version: number; created: boolean }> {
    return this.state.transact(async (unit) => {
      await this.guardActor(unit, actor, [userId]);
      const enrolment = await this.enrolUser(unit, userId);
      if (!enrolment.enrolled) {
        throw enrolment.reason === "PRINCIPAL_MISSING"
          ? new ScopeViolationError("The authentication Principal is unavailable.")
          : new ResourceStateConflictError("The account requires exactly one password method.");
      }
      const { principalId, version, created } = enrolment;
      if (created) {
        await this.audit(unit, "authentication.account.enrol", actor.principalId, {
          userId,
          principalId,
        });
      }
      return { principalId, version, created };
    });
  }

  async createAttempt(
    attempt: Omit<HumanAuthenticationAttempt, "expiresAt">,
  ): Promise<{ createdAt: Date; expiresAt: Date }> {
    return this.state.transact(async (unit) => {
      await this.query(unit, `SELECT pg_advisory_xact_lock(1868785006, hashtext($1))`, [
        this.installationId,
      ]);
      await this.query(
        unit,
        `DELETE FROM occ.human_authentication_attempts WHERE state_hash IN
         (SELECT state_hash FROM occ.human_authentication_attempts WHERE installation_id = $1
          AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100)`,
        [this.installationId],
      );
      const [capacity] = await this.query(
        unit,
        `SELECT count(*)::integer AS count FROM occ.human_authentication_attempts WHERE installation_id = $1`,
        [this.installationId],
      );
      // Any client can start an attempt, so a full table must not refuse new starts: that would
      // let one client block provider sign-in for everyone. Evict the oldest pending attempts.
      const excess = (capacity!.count as number) - (pendingAttemptCapacity - 1);
      if (excess > 0) {
        await this.query(
          unit,
          `DELETE FROM occ.human_authentication_attempts WHERE state_hash IN
           (SELECT state_hash FROM occ.human_authentication_attempts WHERE installation_id = $1
            ORDER BY expires_at, state_hash LIMIT $2)`,
          [this.installationId, excess],
        );
      }
      const [row] = await this.query(
        unit,
        `INSERT INTO occ.human_authentication_attempts
         (state_hash, browser_hash, installation_id, provider_id, callback_url, code_verifier, created_at, expires_at)
         SELECT $1, $2, $3, $4, $5, $6, t.now, t.now + interval '5 minutes'
         FROM (SELECT clock_timestamp() AS now) t RETURNING created_at, expires_at`,
        [
          attempt.stateHash,
          attempt.browserHash,
          this.installationId,
          attempt.providerId,
          attempt.callbackURL,
          attempt.codeVerifier,
        ],
      );
      return { createdAt: row!.created_at as Date, expiresAt: row!.expires_at as Date };
    });
  }

  async consumeAttempt(
    key: HumanAuthenticationAttemptKey,
  ): Promise<(HumanAuthenticationAttempt & { createdAt: Date }) | undefined> {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `DELETE FROM occ.human_authentication_attempts WHERE state_hash = $1 AND browser_hash = $2
         AND installation_id = $3 AND provider_id = $4 AND callback_url = $5 AND expires_at > clock_timestamp() RETURNING *`,
        [key.stateHash, key.browserHash, this.installationId, key.providerId, key.callbackURL],
      );
      return row === undefined
        ? undefined
        : {
            ...key,
            codeVerifier: row.code_verifier as string,
            expiresAt: row.expires_at as Date,
            createdAt: row.created_at as Date,
          };
    });
  }

  /**
   * Password-only profile: audits a password sign-in that Better Auth already accepted. The
   * guarded profile audits in the session's own transaction (issueSession); this profile's
   * sessions are written by Better Auth, so the caller revokes the session if this fails.
   */
  async recordPasswordLogin(userId: string): Promise<void> {
    await this.state.transact(async (unit) => {
      const principalId = await this.findPrincipal(unit, userId);
      await unit.audit.append({
        id: `aud_${randomUUID()}`,
        installationId: this.installationId,
        occurredAt: new Date().toISOString(),
        kind: "mutation",
        actorId: principalId ?? "unresolved",
        actor: principalId === undefined ? { unresolved: true } : { principalId },
        action: "authentication.login",
        resource: { kind: "installation", id: this.installationId },
        outcome: "success",
        details: { userId },
      });
    });
  }

  /**
   * `provider` names the external sign-in provider whose callback was refused. A GitHub
   * membership denial (RFC-0061) also records the numeric GitHub `subject` that provider
   * authenticated, so an administrator can tell whose sign-in the allowlist refused.
   */
  async recordDenied(
    reason: HumanAuthenticationDenial,
    provider?: "github" | "google" | "oidc",
    identity?: { readonly subject: string },
  ): Promise<void> {
    const membership = reason === "MEMBERSHIP_REQUIRED" || reason === "MEMBERSHIP_UNAVAILABLE";
    const githubSubject =
      provider === "github" &&
      typeof identity?.subject === "string" &&
      /^[1-9][0-9]{0,19}$/.test(identity.subject);
    if (
      ![
        "INVALID_CREDENTIALS",
        "EXTERNAL_IDENTITY_REJECTED",
        "SESSION_REJECTED",
        "PROVIDER_UNAVAILABLE",
        "MEMBERSHIP_REQUIRED",
        "MEMBERSHIP_UNAVAILABLE",
      ].includes(reason) ||
      (provider !== undefined && !["github", "google", "oidc"].includes(provider)) ||
      (membership ? !githubSubject : identity !== undefined)
    ) {
      throw new ScopeViolationError("The authentication denial classification is invalid.");
    }
    await this.state.transact(async (unit) =>
      unit.audit.append({
        id: `aud_${randomUUID()}`,
        installationId: this.installationId,
        occurredAt: new Date().toISOString(),
        kind: "authorization_denial",
        actorId: "unresolved",
        actor: { unresolved: true },
        action: "authentication.login",
        resource: { kind: "installation", id: this.installationId },
        outcome: "denied",
        reasonCode: reason,
        ...(provider === undefined
          ? {}
          : {
              details:
                identity === undefined ? { provider } : { provider, subject: identity.subject },
            }),
      }),
    );
  }
}
