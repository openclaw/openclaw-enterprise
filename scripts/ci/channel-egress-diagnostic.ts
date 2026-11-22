import type { TestContext } from "node:test";

export const channelEgressCase = {
  file: "tests/integration/channel-egress-kubernetes-real.test.ts",
  title: "channel egress isolates current Driver generations and retires real Agent bindings",
};

export const channelEgressStages = [
  "topology-and-initial-binding",
  "initial-model-turn",
  "allocation-rejection",
  "listener-capacity",
  "connect-routing",
  "dns-isolation",
  "active-tunnel",
  "retirement-and-reuse",
  "replacement-model-turn",
] as const;

type Stage = (typeof channelEgressStages)[number];

export function withChannelEgressStage(
  run: (context: TestContext, setStage: (stage: Stage) => void) => Promise<void>,
) {
  return async (context: TestContext) => {
    let stage: Stage = "topology-and-initial-binding";
    try {
      await run(context, (next) => {
        stage = next;
      });
    } catch (error) {
      try {
        if (error instanceof Error && !Object.hasOwn(error, "openclawCiDiagnostic")) {
          Object.defineProperty(error, "openclawCiDiagnostic", {
            value: { kind: "channel-egress", stage },
            enumerable: true,
          });
        }
      } catch {
        // A non-extensible error still reports the original failure.
      }
      throw error;
    }
  };
}
