import { ActivationPendingError } from "../../packages/occ/src/errors.ts";
import { workspaceNodeDecision } from "../../apps/controller/src/gateway/workspace-node-observation.ts";

type Decision = NonNullable<ReturnType<typeof workspaceNodeDecision.getStore>>;
type Observation = Decision["observation"];

export function createReplacementNodeObservation() {
  let window: { revisionId: Decision["revisionId"]; lastPending: Observation } | undefined;
  return {
    begin(revisionId: Decision["revisionId"]) {
      window = { revisionId, lastPending: "unavailable" };
    },
    finish(): Observation {
      const value = window?.lastPending ?? "unavailable";
      window = undefined;
      return value;
    },
    wrap<Driver extends object>(driver: Driver): Driver {
      return new Proxy(driver, {
        get(target, property): unknown {
          const method: unknown = Reflect.get(target, property, target);
          if (typeof method !== "function") {
            return method;
          }
          if (property !== "prepareRevision" && property !== "activateRevision") {
            return method.bind(target);
          }
          return async (revision: { id: Decision["revisionId"] }, ...args: unknown[]) => {
            const invoke = (): unknown => Reflect.apply(method, target, [revision, ...args]);
            const active = window;
            if (!active || active.revisionId !== revision.id) {
              return invoke();
            }
            const decision: Decision = {
              revisionId: revision.id,
              reads: 0,
              observation: "unavailable",
            };
            try {
              const result: unknown = await workspaceNodeDecision.run(decision, invoke);
              if (
                property === "prepareRevision" &&
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                Reflect.get(result, "ready") === false &&
                Reflect.get(result, "pendingReason") === "WORKSPACE_NODE_PENDING"
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
