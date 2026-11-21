import { AsyncLocalStorage } from "node:async_hooks";
import type { Installation } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

interface ControllerTransactionDependencies {
  readonly readSnapshot: <T>(work: (state: PlatformReadView) => Promise<T>) => Promise<T>;
  readonly runTransaction: <T>(work: (state: PlatformUnitOfWork) => Promise<T>) => Promise<T>;
  readonly installation: Readonly<Installation>;
  readonly commitOutcomeUnknown: (error: unknown) => boolean;
}

export function createControllerTransactions({
  readSnapshot,
  runTransaction,
  installation,
  commitOutcomeUnknown,
}: ControllerTransactionDependencies) {
  const unitOfWork = new AsyncLocalStorage<PlatformUnitOfWork>();
  const rollbackStack = new AsyncLocalStorage<(() => Promise<void>)[]>();

  async function transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    const active = unitOfWork.getStore();
    if (active) {
      return work(active);
    }

    const rollbacks: (() => Promise<void>)[] = [];
    try {
      return await runTransaction(async (state) =>
        unitOfWork.run(state, () =>
          rollbackStack.run(rollbacks, async () => {
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
        ),
      );
    } catch (error) {
      if (commitOutcomeUnknown(error)) {
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
    const rollbacks = rollbackStack.getStore();
    if (rollbacks === undefined || unitOfWork.getStore() === undefined) {
      throw new DependencyUnavailableError("The platform mutation transaction is unavailable.");
    }
    rollbacks.push(rollback);
  }

  async function read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T> {
    const active = unitOfWork.getStore();
    return active ? work(active) : readSnapshot(work);
  }

  function requireIndependentMutation(operation: string): void {
    if (hasContext()) {
      throw new ResourceConflictError(`${operation} cannot run in a controller transaction.`);
    }
  }

  // Async descendants can retain the unit after the transaction closes.
  function hasContext(): boolean {
    return unitOfWork.getStore() !== undefined;
  }

  return { transact, registerRollback, read, hasContext, requireIndependentMutation };
}

export type ControllerTransactions = ReturnType<typeof createControllerTransactions>;
