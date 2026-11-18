import type {
  GitHubPreparationAdmission,
  GitHubPreparationFamily,
  GitHubPreparationStore,
} from "../../../../apps/controller/src/drivers/repo/github/access/prepared-contracts.ts";

type CommitFailure = "before" | "after";
type CommitPause = { enter: () => void; wait: Promise<void> };

/**
 * Transaction fixture, not production durability: connections share committed
 * memory, serialize callbacks, isolate drafts, and model lost commit receipts.
 * Admission mutations use the same lock as owner publication and warm reads.
 */
export function createPreparedStore(admission: GitHubPreparationAdmission) {
  let committed: GitHubPreparationFamily = {
    admission: structuredClone(admission),
    admittedGrantCount: 1,
    enabled: true,
    attempts: [],
  };
  let tail = Promise.resolve();
  let failure: CommitFailure | undefined;
  let version = 0;
  let pause: CommitPause | undefined;
  function locked<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function connect(): GitHubPreparationStore {
    return {
      readCurrent(familyId, select) {
        return locked(() =>
          select(
            familyId === committed.admission.familyId ? structuredClone(committed) : undefined,
          ),
        );
      },
      transact(familyId, update) {
        return locked(async () => {
          const draft = structuredClone(committed);
          const result = update(
            familyId === draft.admission.familyId ? draft : undefined,
            () => "fixture-material-" + ++version,
          );
          const mode = failure;
          failure = undefined;
          if (mode === "before") {
            throw new Error("fixture commit unavailable");
          }
          const gate = pause;
          pause = undefined;
          if (gate) {
            gate.enter();
            await gate.wait;
          }
          committed = draft;
          if (mode === "after") {
            throw new Error("fixture commit receipt lost");
          }
          return result;
        });
      },
    };
  }
  return {
    connect,
    pauseNextCommit() {
      const entered = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      pause = { enter: entered.resolve, wait: waiting.promise };
      return { entered: entered.promise, release: waiting.resolve };
    },
    failNextCommit: (mode: CommitFailure) => {
      failure = mode;
    },
  };
}
