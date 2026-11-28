import { setTimeout as delay } from "node:timers/promises";

import { readCodexWorkspaceFile } from "./agents.ts";
import { log, type SmokeStep } from "./process.ts";
import type { SmokeAgent, SmokeStack } from "./setup.ts";

const initialDeploy = "channel-proxy-initial-deploy";
const moveDeploy = "channel-proxy-move-deploy";
type ObservedDeployment = typeof initialDeploy | typeof moveDeploy;
const postReadAttempts = 3;
const maxReportedNumber = 2_147_483_647;

export function observeChannelProxyWorkspaceReads(
  smokeStep: SmokeStep,
  stack: Pick<SmokeStack, "api" | "namespaceId">,
  agent: Pick<SmokeAgent, "id">,
  savedEdit: string,
  { intervalMs = 2_000, report = log } = {},
) {
  const completed = new Set<ObservedDeployment>();
  const read = async () => {
    const outcome = await readCodexWorkspaceFile(stack, agent, savedEdit);
    return outcome === "malformed" ? "mismatch" : outcome;
  };
  async function observe<T>(phase: ObservedDeployment, operation: () => T | PromiseLike<T>) {
    const baseline = await read();
    if (baseline !== "confirmed") {
      throw new Error(`${phase}: workspace read baseline ${baseline}`);
    }
    const started = performance.now();
    const during = { confirmed: 0, unconfirmed: 0, mismatch: 0 };
    const after = { confirmed: 0, unconfirmed: 0, mismatch: 0 };
    // A missing observation has no completion offset.
    let firstUnconfirmedReadCompletedMs = -1;
    let firstConfirmedAfterUnconfirmedReadCompletedMs = -1;
    async function sample(counts: typeof during) {
      const outcome = await read();
      const completedMs = Math.min(Math.round(performance.now() - started), maxReportedNumber);
      counts[outcome] = Math.min(counts[outcome] + 1, maxReportedNumber);
      if (outcome === "unconfirmed" && firstUnconfirmedReadCompletedMs < 0) {
        firstUnconfirmedReadCompletedMs = completedMs;
      }
      if (
        outcome === "confirmed" &&
        firstUnconfirmedReadCompletedMs >= 0 &&
        firstConfirmedAfterUnconfirmedReadCompletedMs < 0
      ) {
        firstConfirmedAfterUnconfirmedReadCompletedMs = completedMs;
      }
      return outcome;
    }

    const stop = new AbortController();
    async function sampleDuringAction() {
      while (!stop.signal.aborted) {
        // Count a read by when it starts, even if the response arrives after the action.
        await sample(during);
        // Stop the cadence timer promptly. The API client bounds each in-flight read.
        await delay(intervalMs, undefined, { signal: stop.signal }).catch(() => {});
      }
    }
    let sampling: Promise<void> | undefined;
    try {
      // Keep reads before and after the action outside its existing timing row.
      const result = await smokeStep(phase, async () => {
        try {
          const action = operation();
          sampling = sampleDuringAction();
          return await action;
        } finally {
          stop.abort();
        }
      }).finally(async () => {
        await sampling;
      });

      for (let attempt = 1; attempt <= postReadAttempts; attempt += 1) {
        if ((await sample(after)) !== "unconfirmed") {
          break;
        }
        if (attempt < postReadAttempts) {
          await delay(intervalMs);
        }
      }
      if (during.mismatch > 0 || after.mismatch > 0) {
        throw new Error(`${phase}: workspace read did not match the saved edit`);
      }
      if (after.confirmed === 0) {
        throw new Error(`${phase}: workspace read after deployment could not be confirmed`);
      }
      completed.add(phase);
      return result;
    } finally {
      try {
        report(
          `${phase} workspace reads baselineConfirmed=1 duringConfirmed=${during.confirmed} ` +
            `duringUnconfirmed=${during.unconfirmed} duringMismatch=${during.mismatch} ` +
            `afterConfirmed=${after.confirmed} afterUnconfirmed=${after.unconfirmed} ` +
            `afterMismatch=${after.mismatch} firstUnconfirmedReadCompletedMs=${firstUnconfirmedReadCompletedMs} ` +
            `firstConfirmedAfterUnconfirmedReadCompletedMs=${firstConfirmedAfterUnconfirmedReadCompletedMs}`,
        );
      } catch {
        // Keep any deployment failure as the primary outcome.
      }
    }
  }
  const step: SmokeStep = (phase, operation) => {
    if (phase === initialDeploy || phase === moveDeploy) {
      return observe(phase, operation);
    }
    return smokeStep(phase, operation);
  };
  return {
    step,
    assertComplete() {
      if (!completed.has(initialDeploy) || !completed.has(moveDeploy)) {
        throw new Error("Channel proxy deployment workspace reads did not exercise both phases");
      }
    },
  };
}
