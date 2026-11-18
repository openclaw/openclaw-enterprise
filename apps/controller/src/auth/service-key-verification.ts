import { AsyncLocalStorage } from "node:async_hooks";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import type { BetterAuthPlugin } from "better-auth";
import type { DBAdapter, DBTransactionAdapter } from "better-auth/adapters";

interface VerificationAttempt {
  failure?: { readonly cause: unknown };
}

/** Keeps an API-key adapter failure attached to the verification that encountered it. */
export function createServiceKeyVerification() {
  const attempts = new AsyncLocalStorage<VerificationAttempt>();

  async function observe<T>(model: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const attempt = attempts.getStore();
      if (model === "apikey" && attempt !== undefined) {
        attempt.failure ??= { cause: error };
      }
      throw error;
    }
  }

  function observeOperations(adapter: DBTransactionAdapter): DBTransactionAdapter {
    return {
      ...adapter,
      findOne<T>(input: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> {
        return observe(input.model, () => adapter.findOne<T>(input));
      },
      update<T>(input: Parameters<DBAdapter["update"]>[0]): Promise<T | null> {
        return observe(input.model, () => adapter.update<T>(input));
      },
      incrementOne<T>(input: Parameters<DBAdapter["incrementOne"]>[0]): Promise<T | null> {
        return observe(input.model, () => adapter.incrementOne<T>(input));
      },
      delete(input: Parameters<DBAdapter["delete"]>[0]): Promise<void> {
        return observe(input.model, () => adapter.delete(input));
      },
    };
  }

  const plugin = {
    id: "occ-service-key-verification",
    init(context) {
      const adapter = context.adapter;
      return {
        context: {
          adapter: {
            ...observeOperations(adapter),
            transaction: (work) =>
              adapter.transaction((transaction) => work(observeOperations(transaction))),
          } satisfies DBAdapter,
        },
      };
    },
  } satisfies BetterAuthPlugin;

  async function verify<T>(work: () => Promise<T>): Promise<T> {
    const attempt: VerificationAttempt = {};
    return attempts.run(attempt, async () => {
      let outcome: { readonly value: T } | { readonly error: unknown };
      try {
        outcome = { value: await work() };
      } catch (error) {
        outcome = { error };
      }
      // Better Auth turns storage exceptions into invalid-key results. Preserve the
      // operation's cause while the HTTP boundary keeps its dependency response generic.
      if (attempt.failure !== undefined) {
        const failure = new DependencyUnavailableError("Service API key storage is unavailable.");
        failure.cause = attempt.failure.cause;
        throw failure;
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    });
  }

  return { plugin, verify };
}
