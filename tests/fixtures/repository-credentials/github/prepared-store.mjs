/**
 * Transaction fixture, not production durability: connections share committed
 * memory, serialize callbacks, isolate drafts, and model lost commit receipts.
 * Admission mutations use the same lock as owner publication and warm reads.
 */
export function createPreparedStore(admission) {
  let committed = {
    admission: structuredClone(admission),
    admittedGrantCount: 1,
    enabled: true,
    attempts: [],
  };
  let tail = Promise.resolve();
  let failure;
  let version = 0;
  let pause;
  function locked(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  function connect() {
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
      let enter;
      let release;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      pause = { enter, wait };
      return { entered, release };
    },
    failNextCommit: (mode) => {
      failure = mode;
    },
  };
}
