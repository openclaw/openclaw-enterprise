import { AsyncLocalStorage } from "node:async_hooks";

const observations = [
  "no confirmed device",
  "disconnected",
  "connected without device-token authentication",
  "accepted",
  "unavailable",
] as const;
type Observation = (typeof observations)[number];

interface Decision {
  readonly revisionId: string;
  reads: number;
  observation: Observation;
}

// The installer fixture enables this only during one exact Compute invocation.
export const workspaceNodeDecision = new AsyncLocalStorage<Decision>();
const reading = new AsyncLocalStorage<{ observation?: Observation }>();

export function recordWorkspaceNodeObservation(observation: Observation): void {
  const read = reading.getStore();
  if (read) {
    read.observation =
      read.observation === undefined && observations.includes(observation)
        ? observation
        : "unavailable";
  }
}

export function observeWorkspaceNodeRead(
  revisionId: string,
  effect: () => Promise<boolean>,
): Promise<boolean> {
  const decision = workspaceNodeDecision.getStore();
  if (!decision) {
    return effect();
  }
  decision.reads++;
  decision.observation = "unavailable";
  if (decision.revisionId !== revisionId || decision.reads !== 1) {
    return effect();
  }

  const read: { observation?: Observation } = {};
  return reading.run(read, async () => {
    const ready = await effect();
    if (decision.reads === 1 && read.observation && ready === (read.observation === "accepted")) {
      decision.observation = read.observation;
    }
    return ready;
  });
}
