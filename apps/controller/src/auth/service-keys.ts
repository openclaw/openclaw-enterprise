import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { DBAdapterInstance, DBTransactionAdapter } from "better-auth";
import type { AuditEvent } from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork, PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { ServiceKey } from "./index.ts";

export type ServiceKeyAudit = (
  receipt: Pick<ServiceKey, "id" | "name" | "servicePrincipalId">,
) => AuditEvent;

export function createServiceKeyMutations(
  state: PostgresPlatformState,
  installationId: string,
  configId: string,
) {
  const issueScope = new AsyncLocalStorage<{
    readonly unit: PlatformUnitOfWork;
    inserted: boolean;
  }>();

  function database(original: DBAdapterInstance): DBAdapterInstance {
    return (options) => {
      const adapter = original(options);
      return {
        ...adapter,
        create<T extends Record<string, unknown>, R = T>(input: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }): Promise<R> {
          const scope = issueScope.getStore();
          if (scope === undefined || input.model !== "apikey") {
            return adapter.create<T, R>(input);
          }
          // Better Auth performs validation, credential generation, and hashing before this
          // call. Use its existing database adapter on the connection that commits the audit.
          return state.withAuthDatabase(scope.unit, async ({ database, schema }) => {
            const transactionAdapter = drizzleAdapter(database, {
              provider: "pg",
              schema,
              camelCase: true,
              transaction: false,
            })(options);
            const receipt = await transactionAdapter.create<T, R>(input);
            scope.inserted = true;
            return receipt;
          });
        },
        transaction<T>(work: (transaction: DBTransactionAdapter) => Promise<T>): Promise<T> {
          if (issueScope.getStore() !== undefined) {
            throw new Error(
              "Service key issuance requires the original audited State transaction.",
            );
          }
          return adapter.transaction(work);
        },
      };
    };
  }

  return {
    database,
    issue<T extends ServiceKey>(audit: ServiceKeyAudit, create: () => Promise<T>): Promise<T> {
      return state.transact(async (unit) => {
        const scope = { unit, inserted: false };
        const receipt = await issueScope.run(scope, create);
        if (!scope.inserted) {
          throw new Error("Service key issuance did not use the audited State transaction.");
        }
        await unit.audit.append(
          audit({
            id: receipt.id,
            name: receipt.name,
            servicePrincipalId: receipt.servicePrincipalId,
          }),
        );
        return receipt;
      });
    },
    revoke(key: ServiceKey, event: AuditEvent): Promise<boolean> {
      return state.transactReadCommitted(async (unit) => {
        // Use a conditional delete. A concurrent verifier can never recreate a deleted key.
        const removed = await state.queryInTransaction(
          unit,
          `DELETE FROM occ.apikey
           WHERE id = $1 AND config_id = $2 AND reference_id = $3
             AND metadata::jsonb->>'installationId' = $4
             AND (metadata::jsonb->>'namespaceId') IS NOT DISTINCT FROM $5`,
          [key.id, configId, key.servicePrincipalId, installationId, key.namespaceId ?? null],
        );
        if (removed.rowCount !== 1) {
          return false;
        }
        await unit.audit.append(event);
        return true;
      });
    },
  };
}
