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
} from "../../drivers/repo/github/access/source-loan.ts";

/** Replacement and retirement wait for a hold at most this long, and a hold waits as long for them. */
const LOCK_TIMEOUT_MS = 2000;
/** One statement on the holding session, its COMMIT included, ends here. */
const STATEMENT_TIMEOUT_MS = 5000;
/**
 * A hold ends this long after it was taken. The Worker commits then; if it cannot (frozen,
 * partitioned), PostgreSQL ends the idle session itself, which releases the row.
 */
const HOLD_LIMIT_MS = 60_000;

/** pg's client also reports `end` when the server closes the session. */
type HoldingClient = Omit<PostgresClient, "on" | "removeListener"> & {
  on?(event: "error" | "end", listener: () => void): unknown;
  removeListener?(event: "error" | "end", listener: () => void): unknown;
};

/**
 * TokenService custody for Source-backed native Git, as the Worker reads it. The catalog row is
 * held FOR SHARE on its own connection from the loan's checks until the Provider write returns:
 * TokenService replaces the value and OCC marks the Source `deleting` under the same row, so
 * neither can interleave with a write that is already decided. The lock pool is separate from
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
    async lock({ namespaceId, sourceId }) {
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
          if (returned) {
            open = false;
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
        return { source, hold };
      } catch (error) {
        if (!returned) {
          await client.query("ROLLBACK").catch(() => {});
        }
        end(true);
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
  };
  return Object.freeze(custody);
}
