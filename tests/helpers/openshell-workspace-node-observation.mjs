import { ActivationPendingError } from "../../packages/occ/src/errors.ts";
import { workspaceNodeDecision } from "../../apps/controller/src/gateway/workspace-node-observation.ts";

export function createReplacementNodeObservation() {
  let window;
  return {
    begin(revisionId) {
      window = { revisionId, lastPending: "unavailable" };
    },
    finish() {
      const value = window?.lastPending ?? "unavailable";
      window = undefined;
      return value;
    },
    wrap(driver) {
      return new Proxy(driver, {
        get(target, property) {
          const method = Reflect.get(target, property, target);
          if (typeof method !== "function") {
            return method;
          }
          if (property !== "prepareRevision" && property !== "activateRevision") {
            return method.bind(target);
          }
          return async (revision, ...args) => {
            const active = window;
            if (!active || active.revisionId !== revision.id) {
              return method.call(target, revision, ...args);
            }
            const decision = { revisionId: revision.id, reads: 0, observation: "unavailable" };
            try {
              const result = await workspaceNodeDecision.run(decision, () =>
                method.call(target, revision, ...args),
              );
              if (
                property === "prepareRevision" &&
                result?.ready === false &&
                result.pendingReason === "WORKSPACE_NODE_PENDING"
              ) {
                active.lastPending = decision.observation;
              }
              return result;
            } catch (error) {
              if (
                property === "activateRevision" &&
                error instanceof ActivationPendingError &&
                error.code === "WORKSPACE_NODE_PENDING"
              ) {
                active.lastPending = decision.observation;
              }
              throw error;
            }
          };
        },
      });
    },
  };
}
