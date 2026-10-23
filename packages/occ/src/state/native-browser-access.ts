import { randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "./platform-state.ts";
import type { PostgresPlatformState } from "./postgres-state.ts";

export interface NativeBrowserTarget {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly origin: string;
}

export interface NativeBrowserIntent extends NativeBrowserTarget {
  readonly id: string;
  readonly parentSessionId: string;
  readonly principalId: string;
  readonly expiresAt: Date;
}

export interface NativeBrowserParent {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly principalId: string;
}

export interface NativeBrowserAccess extends NativeBrowserTarget {
  readonly parent: NativeBrowserParent;
}

type Row = Record<string, unknown>;

function intent(row: Row): NativeBrowserIntent {
  return {
    id: row.id as string,
    parentSessionId: row.parent_session_id as string,
    principalId: row.principal_id as string,
    namespaceId: row.namespace_id as string,
    agentId: row.agent_id as string,
    revisionId: row.revision_id as string,
    origin: row.origin as string,
    expiresAt: row.expires_at as Date,
  };
}

/** Durable, dependent browser access. Human authentication owns the parent resolver. */
export class PostgresNativeBrowserAccess {
  private readonly state: PostgresPlatformState;
  private readonly installationId: string;
  private readonly parentSession: (
    unit: PlatformUnitOfWork,
    id: string,
  ) => Promise<NativeBrowserParent | undefined>;

  constructor(
    state: PostgresPlatformState,
    installationId: string,
    parentSession: (
      unit: PlatformUnitOfWork,
      id: string,
    ) => Promise<NativeBrowserParent | undefined>,
  ) {
    this.state = state;
    this.installationId = installationId;
    this.parentSession = parentSession;
  }

  private async query(unit: PlatformUnitOfWork, sql: string, values: readonly unknown[] = []) {
    return (await this.state.queryInTransaction(unit, sql, values)).rows as Row[];
  }

  private async lock(unit: PlatformUnitOfWork) {
    // Serializes capacity checks, redemption and same-browser handle replacement.
    await this.query(unit, "SELECT pg_advisory_xact_lock(1868785007, hashtext($1))", [
      this.installationId,
    ]);
  }

  private async parent(
    unit: PlatformUnitOfWork,
    value: Omit<NativeBrowserIntent, "id" | "expiresAt">,
  ) {
    // Resource ancestors precede authentication and child locks. The canonical
    // Agent deletion owner locks Namespace and Agent before removing revisions;
    // immutable revisions themselves deliberately have no application UPDATE grant.
    const resources = [
      ["SELECT id FROM occ.namespaces WHERE id = $1 FOR SHARE", [value.namespaceId]],
      [
        "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR SHARE",
        [value.namespaceId, value.agentId],
      ],
    ] as const;
    for (const [sql, values] of resources) {
      if ((await this.query(unit, sql, values)).length === 0) {
        return undefined;
      }
    }
    const parent = await this.parentSession(unit, value.parentSessionId);
    return parent?.principalId === value.principalId ? parent : undefined;
  }

  private async audit(unit: PlatformUnitOfWork, value: NativeBrowserIntent, action: string) {
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: this.installationId,
      namespaceId: value.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: value.principalId,
      actor: { principalId: value.principalId },
      action,
      resource: { kind: "agent", id: value.agentId, namespaceId: value.namespaceId },
      outcome: "success",
      details: { revisionId: value.revisionId },
    });
  }

  async create(value: Omit<NativeBrowserIntent, "expiresAt">): Promise<NativeBrowserIntent> {
    const created = await this.state.transact(async (unit) => {
      await this.lock(unit);
      const parent = await this.parent(unit, value);
      if (!parent) {
        throw new ScopeViolationError("The parent session is no longer current.");
      }
      for (const table of ["native_browser_intents", "native_browser_handles"]) {
        await this.query(
          unit,
          `DELETE FROM occ.${table} WHERE ctid IN
          (SELECT ctid FROM occ.${table} WHERE installation_id = $1 AND expires_at <= clock_timestamp()
           ORDER BY expires_at LIMIT 100)`,
          [this.installationId],
        );
      }
      const [capacity] = await this.query(
        unit,
        `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE parent_session_id = $2 AND expires_at > clock_timestamp())::int AS parent
        FROM occ.native_browser_intents WHERE installation_id = $1`,
        [this.installationId, value.parentSessionId],
      );
      if ((capacity!.total as number) >= 1000 || (capacity!.parent as number) >= 8) {
        // Commit bounded maintenance even when live capacity refuses admission.
        // The physical total cap also bounds retained expired rows.
        return undefined;
      }
      const [row] = await this.query(
        unit,
        `INSERT INTO occ.native_browser_intents
        (id, installation_id, parent_session_id, principal_id, namespace_id, agent_id, revision_id, origin, created_at, expires_at)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, t.now, LEAST(t.now + interval '60 seconds', $9::timestamptz)
        FROM (SELECT clock_timestamp() AS now) t RETURNING *`,
        [
          value.id,
          this.installationId,
          value.parentSessionId,
          value.principalId,
          value.namespaceId,
          value.agentId,
          value.revisionId,
          value.origin,
          parent.expiresAt,
        ],
      );
      const created = intent(row!);
      await this.audit(unit, created, "authentication.native.launch");
      return created;
    });
    if (!created) {
      throw new ResourceConflictError(
        "Too many pending browser launches. Wait one minute and retry.",
      );
    }
    return created;
  }

  async read(
    id: string,
  ): Promise<(NativeBrowserIntent & { readonly parent: NativeBrowserParent }) | undefined> {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `SELECT * FROM occ.native_browser_intents
        WHERE id = $1 AND installation_id = $2 AND expires_at > clock_timestamp()`,
        [id, this.installationId],
      );
      if (!row) {
        return undefined;
      }
      const value = intent(row);
      const parent = await this.parent(unit, value);
      return parent ? { ...value, parent } : undefined;
    });
  }

  async bind(id: string, origin: string, challengeHash: string): Promise<boolean> {
    return this.state.transact(async (unit) => {
      await this.lock(unit);
      const [candidate] = await this.query(
        unit,
        "SELECT * FROM occ.native_browser_intents WHERE id = $1 AND installation_id = $2 AND origin = $3",
        [id, this.installationId, origin],
      );
      if (!candidate || !(await this.parent(unit, intent(candidate)))) {
        return false;
      }
      const [row] = await this.query(
        unit,
        `UPDATE occ.native_browser_intents SET challenge_hash = $3
        WHERE id = $1 AND installation_id = $2 AND origin = $4 AND challenge_hash IS NULL
        AND expires_at > clock_timestamp() RETURNING id`,
        [id, this.installationId, challengeHash, origin],
      );
      return row !== undefined;
    });
  }

  async confirm(
    id: string,
    parentSessionId: string,
    challengeHash: string,
    exchangeHash: string,
  ): Promise<boolean> {
    return this.state.transact(async (unit) => {
      await this.lock(unit);
      const [row] = await this.query(
        unit,
        `SELECT * FROM occ.native_browser_intents
        WHERE id = $1 AND installation_id = $2 AND parent_session_id = $3
        AND challenge_hash = $4 AND exchange_hash IS NULL AND expires_at > clock_timestamp()`,
        [id, this.installationId, parentSessionId, challengeHash],
      );
      if (!row || !(await this.parent(unit, intent(row)))) {
        return false;
      }
      const [confirmed] = await this.query(
        unit,
        `UPDATE occ.native_browser_intents SET exchange_hash = $2
         WHERE id = $1 AND expires_at > clock_timestamp() RETURNING id`,
        [id, exchangeHash],
      );
      if (!confirmed) {
        return false;
      }
      await this.audit(unit, intent(row), "authentication.native.confirm");
      return true;
    });
  }

  async redeem(input: {
    readonly id: string;
    readonly origin: string;
    readonly challengeHash: string;
    readonly exchangeHash: string;
    readonly handleHash: string;
    readonly previousHandleHash?: string;
  }): Promise<NativeBrowserAccess | undefined> {
    return this.state.transact(async (unit) => {
      await this.lock(unit);
      const [row] = await this.query(
        unit,
        `SELECT * FROM occ.native_browser_intents
        WHERE id = $1 AND installation_id = $2 AND origin = $3 AND challenge_hash = $4
        AND exchange_hash = $5 AND expires_at > clock_timestamp()`,
        [input.id, this.installationId, input.origin, input.challengeHash, input.exchangeHash],
      );
      if (!row) {
        return undefined;
      }
      const value = intent(row);
      const parent = await this.parent(unit, value);
      if (!parent) {
        return undefined;
      }
      const [consumed] = await this.query(
        unit,
        `DELETE FROM occ.native_browser_intents
        WHERE id = $1 AND installation_id = $2 AND origin = $3 AND challenge_hash = $4
        AND exchange_hash = $5 AND expires_at > clock_timestamp() RETURNING id`,
        [input.id, this.installationId, input.origin, input.challengeHash, input.exchangeHash],
      );
      if (!consumed) {
        return undefined;
      }
      if (input.previousHandleHash !== undefined) {
        await this.query(
          unit,
          `DELETE FROM occ.native_browser_handles
          WHERE handle_hash = $1 AND installation_id = $2 AND origin = $3`,
          [input.previousHandleHash, this.installationId, input.origin],
        );
      }
      const [capacity] = await this.query(
        unit,
        `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE parent_session_id = $2 AND expires_at > clock_timestamp())::int AS parent
        FROM occ.native_browser_handles WHERE installation_id = $1`,
        [this.installationId, parent.id],
      );
      if ((capacity!.total as number) >= 10000 || (capacity!.parent as number) >= 64) {
        throw new ResourceConflictError("Too many browser sessions. Sign out and sign in again.");
      }
      await this.query(
        unit,
        `INSERT INTO occ.native_browser_handles
        (handle_hash, installation_id, parent_session_id, principal_id, namespace_id, agent_id, revision_id, origin, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.handleHash,
          this.installationId,
          parent.id,
          value.principalId,
          value.namespaceId,
          value.agentId,
          value.revisionId,
          value.origin,
          parent.expiresAt,
        ],
      );
      await this.audit(unit, value, "authentication.native.issue");
      return { ...value, parent };
    });
  }

  async resolve(handleHash: string, origin: string): Promise<NativeBrowserAccess | undefined> {
    return this.state.transact(async (unit) => {
      const [row] = await this.query(
        unit,
        `SELECT * FROM occ.native_browser_handles
        WHERE handle_hash = $1 AND installation_id = $2 AND origin = $3 AND expires_at > clock_timestamp()`,
        [handleHash, this.installationId, origin],
      );
      if (!row) {
        return undefined;
      }
      const parent = await this.parent(unit, {
        parentSessionId: row.parent_session_id as string,
        principalId: row.principal_id as string,
        namespaceId: row.namespace_id as string,
        agentId: row.agent_id as string,
        revisionId: row.revision_id as string,
        origin,
      });
      return parent
        ? {
            namespaceId: row.namespace_id as string,
            agentId: row.agent_id as string,
            revisionId: row.revision_id as string,
            origin,
            parent,
          }
        : undefined;
    });
  }
}
