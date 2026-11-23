import { AsyncLocalStorage } from "node:async_hooks";
import type { Installation } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  PostgresCommitOutcomeUnknownError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type {
  PlatformStateStore,
  PlatformTransactionOptions,
} from "./ports/platform-state-store.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface TransactionScope {
  readonly state: PlatformUnitOfWork;
  readonly rollbacks: (() => Promise<void>)[];
  readonly readCommitted: boolean;
}

interface ControllerTransactionDependencies {
  readonly platformState: PlatformStateStore;
  readonly installation: Readonly<Installation>;
}

export function createControllerTransactions({
  platformState,
  installation,
}: ControllerTransactionDependencies) {
  const transaction = new AsyncLocalStorage<TransactionScope>();

  async function transact<T>(
    work: (state: PlatformUnitOfWork) => Promise<T>,
    options?: PlatformTransactionOptions,
  ): Promise<T> {
    const readCommitted = options?.readCommitted === true;
    const active = transaction.getStore();
    if (active) {
      // A nested caller cannot change the isolation of a transaction that already started.
      if (readCommitted && !active.readCommitted) {
        throw new ResourceConflictError(
          "The outer controller transaction must use Read Committed.",
        );
      }
      return work(active.state);
    }

    const rollbacks: (() => Promise<void>)[] = [];
    try {
      return await platformState.transact(
        async (state) =>
          transaction.run({ state, rollbacks, readCommitted }, async () => {
            const existing = await state.installations.getInstallation();
            if (!existing) {
              await state.installations.createInstallation(installation);
            } else if (existing.id !== installation.id) {
              throw new ScopeViolationError(
                "The controller state belongs to another Installation.",
              );
            }
            return work(state);
          }),
        options,
      );
    } catch (error) {
      if (error instanceof PostgresCommitOutcomeUnknownError) {
        throw error;
      }
      let rollbackFailed = false;
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback();
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new DependencyUnavailableError(
          "A Driver could not roll back a failed resource mutation.",
        );
      }
      throw error;
    }
  }

  function registerRollback(rollback: () => Promise<void>): void {
    const active = transaction.getStore();
    if (active === undefined) {
      throw new DependencyUnavailableError("The platform mutation transaction is unavailable.");
    }
    active.rollbacks.push(rollback);
  }

  async function read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    const active = transaction.getStore();
    return active ? work(active.state) : platformState.read(work);
  }

  function requireIndependentMutation(operation: string): void {
    if (hasContext()) {
      throw new ResourceConflictError(`${operation} cannot run in a controller transaction.`);
    }
  }

  // Async descendants can retain the unit after the transaction closes.
  function hasContext(): boolean {
    return transaction.getStore() !== undefined;
  }

  return { transact, registerRollback, read, hasContext, requireIndependentMutation };
}

export type ControllerTransactions = ReturnType<typeof createControllerTransactions>;
