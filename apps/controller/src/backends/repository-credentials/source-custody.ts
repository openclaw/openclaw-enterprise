import type { IAMDriver, InstallationSecretStore } from "@openclaw-enterprise/contracts";
import type { PlatformStateStore, PostgresPool } from "@openclaw-enterprise/occ";
import {
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  SOURCE_REPOSITORIES_CONFIG_KEY,
} from "@openclaw-enterprise/contracts";
import { OCCTokenServiceDriver } from "../../drivers/token-service/occ.ts";
import type { MaterialWriteHold } from "../../drivers/repo/access/material-hold.ts";
import type {
  LockedRepositorySource,
  RepositorySourceCustody,
} from "../../drivers/repo/github/access/source-loan.ts";

/** Replacement and retirement wait for a hold at most this long, and a hold waits as long for them. */
const LOCK_TIMEOUT_MS = 2000;
/** A hold whose write never settles ends here; the Provider then sends nothing (guarded at dispatch). */
const HOLD_LIMIT_MS = 60_000;

/**
 * TokenService custody for Source-backed native Git, as the Worker reads it. The catalog row is
 * held FOR SHARE on its own connection from the loan's checks until the Provider write returns:
 * TokenService replaces the value and OCC marks the Source `deleting` under the same row, so
 * neither can interleave with a write that is already decided. The lock pool is separate from
 * the store's pool, so a held row never waits on the transaction that reads it.
 */
export function createRepositorySourceCustody(options: {
  readonly lockPool: PostgresPool;
  readonly state: PlatformStateStore;
  readonly secrets: InstallationSecretStore;
  readonly tokenServiceDriverId: string;
  readonly iam: Pick<IAMDriver, "authorize">;
}): RepositorySourceCustody {
  const { lockPool, state, secrets, tokenServiceDriverId, iam } = options;
  const custody: RepositorySourceCustody = {
    async lock({ namespaceId, sourceId }) {
      const client = await lockPool.connect();
      let open = true;
      let timer: NodeJS.Timeout | undefined;
      const hold: MaterialWriteHold = {
        held: () => open,
        async release() {
          if (!open) {
            return;
          }
          open = false;
          clearTimeout(timer);
          try {
            await client.query("COMMIT");
            client.release();
          } catch (error) {
            client.release(true);
          }
        },
      };
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
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
        timer = setTimeout(() => void hold.release(), HOLD_LIMIT_MS);
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
        await client.query("ROLLBACK").catch(() => {});
        open = false;
        clearTimeout(timer);
        client.release(true);
        throw error;
      }
    },
    async resolve({ namespaceId, sourceId }, source) {
      if (!source.custody) {
        throw new Error("The repository token Source has no TokenService custody.");
      }
      const { installationId, tokenServiceInstanceId } = source.custody;
      // The value is read while the row is held; the driver rechecks owner and state as well.
      const owner = new OCCTokenServiceDriver(
        tokenServiceDriverId,
        installationId,
        secrets,
        tokenServiceInstanceId,
        state,
      );
      const { credential, version } = await owner.resolveCredential(
        {
          sourceRef: { kind: "credential_source", namespaceId, id: sourceId },
          tokenServiceInstanceId,
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
