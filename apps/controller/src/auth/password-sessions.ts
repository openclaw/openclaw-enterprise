import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresHumanAuthentication } from "@openclaw-enterprise/occ";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { DBAdapterInstance, DBTransactionAdapter } from "better-auth";
import { generateRandomString } from "better-auth/crypto";

export function createPasswordSessions(state: PostgresHumanAuthentication) {
  const requestIds = new AsyncLocalStorage<string>();

  function database(original: DBAdapterInstance): DBAdapterInstance {
    return (options) => {
      const adapter = original(options);
      return {
        ...adapter,
        async create<T extends Record<string, unknown>, R = T>(input: {
          model: string;
          data: Omit<T, "id">;
          select?: string[] | undefined;
          forceAllowId?: boolean | undefined;
        }): Promise<R> {
          if (input.model !== "session") {
            return adapter.create<T, R>(input);
          }
          // Better Auth selects the account, checks the password, and supplies the
          // cookie's token and expiration. State owns the session and audit commit.
          const data = input.data as Record<string, unknown>;
          if (
            !isNonEmptyString(data.userId) ||
            !isNonEmptyString(data.token) ||
            !(data.createdAt instanceof Date) ||
            !(data.updatedAt instanceof Date) ||
            !(data.expiresAt instanceof Date) ||
            input.select !== undefined
          ) {
            throw new Error("Invalid password session data.");
          }
          const session = await state.issuePasswordSession(
            {
              id:
                input.forceAllowId === true && isNonEmptyString(data.id)
                  ? data.id
                  : generateRandomString(32, "a-z", "A-Z", "0-9"),
              userId: data.userId,
              token: data.token,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              expiresAt: data.expiresAt,
              ipAddress: typeof data.ipAddress === "string" ? data.ipAddress : null,
              userAgent: typeof data.userAgent === "string" ? data.userAgent : null,
            },
            requestIds.getStore(),
          );
          return session as R;
        },
        transaction<T>(work: (transaction: DBTransactionAdapter) => Promise<T>): Promise<T> {
          return adapter.transaction((tx) =>
            work({
              ...tx,
              create(input) {
                // One owner must commit the session and audit. Other Better Auth
                // transactions retain their original adapter.
                if (input.model === "session") {
                  throw new Error("A password session requires an audited State transaction.");
                }
                return tx.create(input);
              },
            }),
          );
        },
      };
    };
  }

  return {
    database,
    run: <T>(requestId: string, work: () => T): T => requestIds.run(requestId, work),
    revoke: (token: string) => state.revokePasswordSession(token, requestIds.getStore()),
  };
}
