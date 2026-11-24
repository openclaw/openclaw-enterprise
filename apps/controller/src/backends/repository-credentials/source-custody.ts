import type { IAMDriver, TokenServiceDriver } from "@openclaw-enterprise/contracts";
import type { PlatformStateStore, PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";
import {
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  SOURCE_REPOSITORIES_CONFIG_KEY,
} from "@openclaw-enterprise/contracts";
import type { MaterialWriteHold } from "../../drivers/repo/access/material-hold.ts";
import type {
  LockedRepositorySource,
  RepositorySourceCustody,
  RepositorySourceWriteFence,
} from "../../drivers/repo/github/access/source-loan.ts";

/** Maximum wait to acquire a Source row lock. */
const LOCK_TIMEOUT_MS = 2000;
/** One statement on the holding session, its COMMIT included, ends here. */
const STATEMENT_TIMEOUT_MS = 5000;
/**
 * A hold ends this long after it was taken. The Worker commits then; if it cannot (frozen,
 * partitioned), PostgreSQL ends the idle session itself, which releases the row.
 */
const HOLD_LIMIT_MS = 60_000;
/** PostgreSQL's code for a lock wait that reached `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** pg's client also reports `end` when the server closes the session. */
type HoldingClient = Omit<PostgresClient, "on" | "removeListener"> & {
  on?(event: "error" | "end", listener: () => void): unknown;
  removeListener?(event: "error" | "end", listener: () => void): unknown;
};

/**
 * TokenService custody for Source-backed native Git, as the Worker reads it. The catalog row is
 * held FOR SHARE on its own connection from the loan's checks until the Provider write returns:
 * TokenService replaces the value and OCC marks the Source `deleting` under the same row, so
 * neither can proceed while the hold stands. The lock pool is separate from
 * the store's pool, so a held row never waits on the transaction that reads it.
 *
 * The hold is bounded on both sides. The Worker ends it at the hold limit, and the session's
 * `idle_in_transaction_session_timeout` makes PostgreSQL end it as well when the Worker cannot.
 * `held()` turns false at the limit, when the client reports the session lost, and when a
 * round trip on the holding session (`confirm`) fails, so a resumed Worker sends nothing.
 */
export function createRepositorySourceCustody(options: {
  readonly lockPool: PostgresPool;
  readonly state: PlatformStateStore;
  /** The selected TokenService driver; only its Sources are lent. */
  readonly tokenServiceDriverId: string;
  /** That driver for the Source's own instance and Installation, as the row names them. */
  readonly tokenService: (
    custody: NonNullable<LockedRepositorySource["custody"]>,
  ) => Pick<TokenServiceDriver, "resolveCredential">;
  readonly iam: Pick<IAMDriver, "authorize">;
  /** The hold limit; tests shorten it. */
  readonly holdLimitMs?: number;
}): RepositorySourceCustody {
  const { lockPool, state, tokenServiceDriverId, tokenService, iam } = options;
  const holdLimitMs = options.holdLimitMs ?? HOLD_LIMIT_MS;
  const custody: RepositorySourceCustody = {
    async lock({ namespaceId, sourceId }, caller) {
      // The caller's transaction holds the Namespace row, which replacement and retirement lock
      // before this one: without the same limit a frozen Worker would hold them past the hold.
      await caller?.limitIdle(holdLimitMs);
      const client: HoldingClient = await lockPool.connect();
      const deadline = performance.now() + holdLimitMs;
      let open = true;
      let returned = false;
      let timer: NodeJS.Timeout | undefined;
      const end = (discard: boolean) => {
        open = false;
        clearTimeout(timer);
        if (returned) {
          return;
        }
        returned = true;
        try {
          client.release(discard);
        } catch {
          // The connection is lost either way.
        }
        client.removeListener?.("error", lost);
        client.removeListener?.("end", lost);
      };
      // The database ended the session (its idle limit, a failover, a terminated backend):
      // the row is no longer held, so nothing may be written under this hold.
      const lost = () => end(true);
      client.on?.("error", lost);
      client.on?.("end", lost);
      const hold: MaterialWriteHold = {
        held: () => open && performance.now() < deadline,
        async confirm() {
          if (hold.held()) {
            try {
              // A round trip on the holding session: it fails once PostgreSQL has ended the
              // session, and it lets the session go idle only for the rest of the hold limit.
              const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
              await client.query(
                "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
                [`${remaining}ms`],
              );
              if (hold.held()) {
                return true;
              }
            } catch {
              // Not held: released below.
            }
          }
          await hold.release();
          return false;
        },
        async release() {
          if (!open) {
            return;
          }
          open = false;
          clearTimeout(timer);
          try {
            await client.query("COMMIT");
            end(false);
          } catch {
            end(true);
          }
        },
      };
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('lock_timeout', $1, true),
             set_config('statement_timeout', $2, true),
             set_config('idle_in_transaction_session_timeout', $3, true)`,
          [`${LOCK_TIMEOUT_MS}ms`, `${STATEMENT_TIMEOUT_MS}ms`, `${holdLimitMs}ms`],
        );
        const { rows } = await client.query(
          `SELECT cs.state, cs.config, cs.owner_capability = 'token_service' AND t.id IS NOT NULL AS owned,
             t.installation_id, t.id AS token_service_instance_id
           FROM occ.credential_sources cs
           LEFT JOIN occ.token_service_instances t
             ON t.id = cs.token_service_instance_id AND t.driver_id = $3
           WHERE cs.namespace_id = $1 AND cs.id = $2
           FOR SHARE OF cs`,
          [namespaceId, sourceId, tokenServiceDriverId],
        );
        timer = setTimeout(() => void hold.release(), Math.max(0, deadline - performance.now()));
        timer.unref();
        const row = rows[0] as
          | {
              state: string;
              config: Record<string, unknown> | null;
              owned: boolean;
              installation_id: string | null;
              token_service_instance_id: string | null;
            }
          | undefined;
        const text = (key: string) =>
          typeof row?.config?.[key] === "string" ? (row.config[key] as string) : undefined;
        const source: LockedRepositorySource | undefined = row && {
          state: row.state,
          owned: row.owned === true,
          preset: text(SOURCE_PROVIDER_PRESET_CONFIG_KEY),
          repositories: text(SOURCE_REPOSITORIES_CONFIG_KEY),
          ...(row.installation_id &&
            row.token_service_instance_id && {
              custody: {
                installationId: row.installation_id,
                tokenServiceInstanceId: row.token_service_instance_id,
              },
            }),
        };
        // The record the deployment wrote in its admitting transaction (0093); the Worker
        // retires it only after reading back that the revision's Provider is gone.
        const recorded = async (revisionId: string) => {
          if (!hold.held()) {
            throw new Error("The repository token Source is no longer held.");
          }
          const copies = await client.query(
            `SELECT 1 FROM occ.repository_source_copies
             WHERE revision_id = $1 AND namespace_id = $2 AND credential_source_id = $3
               AND retired_at IS NULL`,
            [revisionId, namespaceId, sourceId],
          );
          return copies.rows.length === 1;
        };
        // The fence of one Provider write of this Source's value for a revision (0093). Each
        // statement commits on its own connection: the holding session commits only when the
        // hold ends, and a record that died with it would not fence anything.
        const fenced = async <T>(
          work: (c: Pick<PostgresClient, "query">) => Promise<T>,
        ): Promise<T> => {
          const c = await lockPool.connect();
          try {
            await c.query("BEGIN");
            await c.query(
              `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
              [`${LOCK_TIMEOUT_MS}ms`, `${STATEMENT_TIMEOUT_MS}ms`],
            );
            const result = await work(c);
            await c.query("COMMIT");
            c.release();
            return result;
          } catch (error) {
            await c.query("ROLLBACK").catch(() => {});
            c.release(true);
            throw error;
          }
        };
        const write = (revisionId: string, version: string) => {
          const copy = [revisionId, namespaceId, sourceId] as const;
          const where = `revision_id = $1 AND namespace_id = $2 AND credential_source_id = $3
            AND retired_at IS NULL`;
          // Whether this write made the record: an earlier uncertain write's record is kept.
          let made = false;
          const fence: RepositorySourceWriteFence = {
            async dispatching() {
              if (!hold.held()) {
                return false;
              }
              return fenced(async (c) => {
                const { rows } = await c.query(
                  `SELECT unknown_write_version FROM occ.repository_source_copies
                   WHERE ${where} FOR UPDATE`,
                  [...copy],
                );
                if (rows.length !== 1) {
                  return false;
                }
                made =
                  (rows[0] as { unknown_write_version: string | null }).unknown_write_version ===
                  null;
                if (made) {
                  await c.query(
                    `UPDATE occ.repository_source_copies
                     SET unknown_write_version = $4, unknown_write_at = clock_timestamp()
                     WHERE ${where}`,
                    [...copy, version],
                  );
                }
                return true;
              });
            },
            async settled(outcome) {
              // A failure rejects and leaves the record: the Source stays fenced until
              // reconciliation settles it. The loan reports it.
              if (outcome === "applied") {
                // A confirmed conditional write also settles an earlier uncertain one: that was
                // conditional on an older Provider resource version, which never recurs.
                await fenced((c) =>
                  c.query(
                    `UPDATE occ.repository_source_copies
                     SET confirmed_source_version = $4, confirmed_at = clock_timestamp(),
                       unknown_write_version = NULL, unknown_write_at = NULL
                     WHERE ${where}`,
                    [...copy, version],
                  ),
                );
              } else if (made) {
                await fenced((c) =>
                  c.query(
                    `UPDATE occ.repository_source_copies
                     SET unknown_write_version = NULL, unknown_write_at = NULL
                     WHERE ${where} AND unknown_write_version = $4`,
                    [...copy, version],
                  ),
                );
              }
              made = false;
            },
          };
          return fence;
        };
        return { source, hold, recorded, write };
      } catch (error) {
        if (!returned) {
          await client.query("ROLLBACK").catch(() => {});
        }
        end(true);
        if ((error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) {
          return undefined;
        }
        throw error;
      }
    },
    async resolve({ namespaceId, sourceId }, source) {
      if (!source.custody) {
        throw new Error("The repository token Source has no TokenService custody.");
      }
      // The value is read while the row is held; the driver rechecks owner and state as well.
      const { credential, version } = await tokenService(source.custody).resolveCredential(
        {
          sourceRef: { kind: "credential_source", namespaceId, id: sourceId },
          tokenServiceInstanceId: source.custody.tokenServiceInstanceId,
        },
        AbortSignal.timeout(5000),
      );
      if (!version) {
        throw new Error("The repository token Source has no custody version.");
      }
      return { credential, version };
    },
    async operate({ namespaceId, agentId }, { sourceId }) {
      const agent = await state.read(({ agents }) => agents.findAgent(namespaceId, agentId));
      if (agent?.status !== "active" || !agent.servicePrincipalId) {
        return false;
      }
      const decision = await iam.authorize({
        principalId: agent.servicePrincipalId,
        action: "operate",
        resource: { kind: "credential_source", namespaceId, id: sourceId },
      });
      return decision?.allowed === true;
    },
    async admitted({ namespaceId, agentId, revisionId }) {
      // Revisions are immutable: the saved policy is the one admitted at deploy.
      const revision = await state.read(({ revisions }) =>
        revisions.findRevision(namespaceId, agentId, revisionId),
      );
      return revision?.sandboxPolicy?.repositoryNetworkPolicy?.grants;
    },
  };
  return Object.freeze(custody);
}
