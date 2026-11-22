import type { AgentRevision, ComputeDriver } from "@openclaw-enterprise/contracts";
import {
  SANDBOX_DELETION_UNCONFIRMED,
  TransientDependencyError,
  type ClaimedWork,
  type PostgresPlatformState,
  type PostgresWorkQueue,
} from "@openclaw-enterprise/occ";
import { withComputeAbortSignal } from "../drivers/compute/operation-context.ts";

interface HarnessExposureSweepOptions {
  readonly state: Pick<PostgresPlatformState, "read">;
  readonly queue: Pick<PostgresWorkQueue, "findWork">;
  readonly compute: Pick<ComputeDriver, "id" | "implementation" | "withdrawHarnessExposure">;
  readonly signal: AbortSignal;
  readonly emit: (event: Readonly<Record<string, unknown>>) => void;
}

// Attempts are immediate, then after 30 s, 1 min, 2 min, and 4 min.
const MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS = 5;
const HARNESS_EXPOSURE_WITHDRAWAL_RETRY_BASE_MS = 30_000;

interface PendingHarnessExposureWithdrawal {
  readonly revision: Readonly<AgentRevision>;
  attempts: number;
  dueAt: number;
}

/** The code a failed exposure withdrawal is logged with; never the provider's text. */
function harnessExposureWithdrawalCode(error: unknown): string {
  if (error instanceof TransientDependencyError) {
    return error.code;
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code
    : "HARNESS_EXPOSURE_WITHDRAWAL_FAILED";
}

/** A revision whose Sandbox Driver may hold a native Harness exposure for this Compute. */
function holdsNativeHarnessExposure(
  revision: Readonly<AgentRevision>,
  compute: Pick<ComputeDriver, "id" | "implementation">,
): boolean {
  return (
    revision.harness.mode === "dedicated" &&
    revision.harness.id === "openclaw" &&
    revision.sandboxDriverId !== undefined &&
    revision.compute.id === compute.id &&
    revision.compute.implementation === compute.implementation
  );
}

export class HarnessExposureSweep {
  private readonly pending = new Map<string, PendingHarnessExposureWithdrawal>();
  private listed = false;
  private listingFailures = 0;

  private readonly options: HarnessExposureSweepOptions;

  constructor(options: HarnessExposureSweepOptions) {
    this.options = options;
  }

  /** List once at startup, then withdraw for at most one due revision per step. */
  async step(): Promise<void> {
    const { compute, signal, emit } = this.options;
    if (compute.withdrawHarnessExposure === undefined || signal.aborted) {
      return;
    }
    // Listed once per start, with bounded retries; candidates handed over by terminal
    // failures share the map and are withdrawn whether or not the listing succeeded.
    if (!this.listed && this.listingFailures < MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS) {
      let revisions: readonly Readonly<AgentRevision>[] | undefined;
      try {
        revisions = await this.listRevisions();
      } catch {
        if (signal.aborted) {
          return;
        }
        this.listingFailures += 1;
        emit({
          event: "worker.harness-exposure-sweep-failed",
          code: "WORKER_UNAVAILABLE",
          attempt: this.listingFailures,
        });
      }
      if (revisions !== undefined) {
        this.listed = true;
        for (const revision of revisions) {
          this.remember(revision);
        }
        if (this.pending.size > 0) {
          emit({
            event: "worker.harness-exposure-sweep",
            pending: this.pending.size,
          });
        }
      }
    }
    const now = Date.now();
    for (const candidate of this.pending.values()) {
      if (candidate.dueAt <= now) {
        await this.withdraw(candidate);
        return;
      }
    }
  }

  private async withdraw(pending: PendingHarnessExposureWithdrawal): Promise<void> {
    const { compute, signal, emit } = this.options;
    const { revision } = pending;
    const fields = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    try {
      await withComputeAbortSignal(signal, () =>
        compute.withdrawHarnessExposure!(revision, signal),
      );
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      pending.attempts += 1;
      const permanent = pending.attempts >= MAX_HARNESS_EXPOSURE_WITHDRAWAL_ATTEMPTS;
      if (permanent) {
        this.pending.delete(revision.id);
      } else {
        pending.dueAt =
          Date.now() + HARNESS_EXPOSURE_WITHDRAWAL_RETRY_BASE_MS * 2 ** (pending.attempts - 1);
      }
      const code = harnessExposureWithdrawalCode(error);
      // An unconfirmed delete retries through the Driver's absence check. The last
      // failure drops the exposure from this sweep until the worker restarts.
      emit({
        event:
          code === SANDBOX_DELETION_UNCONFIRMED && !permanent
            ? "worker.harness-exposure-withdrawal-unconfirmed"
            : "worker.harness-exposure-withdrawal-failed",
        ...fields,
        code,
        attempt: pending.attempts,
        outcome: permanent ? "permanent" : "retry",
      });
      return;
    }
    this.pending.delete(revision.id);
    emit({ event: "worker.harness-exposure-withdrawn", ...fields });
  }

  /** A terminal deployment can leave its revision's exposure available for diagnosis. */
  async enqueueFailedCandidate(
    claim: Pick<ClaimedWork, "namespaceId" | "agentId" | "revisionId">,
  ): Promise<void> {
    const { compute, state } = this.options;
    const { namespaceId, agentId, revisionId } = claim;
    if (
      compute.withdrawHarnessExposure === undefined ||
      agentId === undefined ||
      revisionId === undefined
    ) {
      return;
    }
    const { agent, revision } = await state.read(async (view) => ({
      agent: await view.agents.findAgent(namespaceId, agentId),
      revision: await view.revisions.findRevision(namespaceId, agentId, revisionId),
    }));
    if (
      revision === undefined ||
      agent?.activeRevisionId === revision.id ||
      !holdsNativeHarnessExposure(revision, compute)
    ) {
      return;
    }
    this.remember(revision);
  }

  private remember(revision: Readonly<AgentRevision>): void {
    if (!this.pending.has(revision.id)) {
      this.pending.set(revision.id, { revision, attempts: 0, dueAt: 0 });
    }
  }

  private async listRevisions(): Promise<readonly Readonly<AgentRevision>[]> {
    const { compute, state, queue } = this.options;
    const listed = await state.read(async (view) => {
      const found: { readonly revision: Readonly<AgentRevision>; readonly active: boolean }[] = [];
      for (const namespace of await view.namespaces.listNamespaces()) {
        // A Namespace fails only from `provisioning` (no Agent ran in it), and `deleting`
        // releases the provider Workspace with every Sandbox in it.
        if (namespace.status !== "ready") {
          continue;
        }
        for (const agent of await view.agents.listAgents(namespace.id)) {
          const revisions = await view.revisions.listRevisions(namespace.id, agent.id);
          const active = revisions.find(({ id }) => id === agent.activeRevisionId);
          // Older revisions were retired when the active one activated; a newer candidate
          // that failed keeps its Sandbox until the next activation retires it.
          for (const revision of revisions) {
            if (
              holdsNativeHarnessExposure(revision, compute) &&
              (active === undefined ||
                revision.id === active.id ||
                revision.revision > active.revision)
            ) {
              found.push({ revision, active: revision.id === agent.activeRevisionId });
            }
          }
        }
      }
      return found;
    });
    const pending: Readonly<AgentRevision>[] = [];
    for (const { active, revision } of listed) {
      // Check the candidate's deployment outside the read transaction.
      if (
        active ||
        (await queue.findWork(`agent_revision:${revision.id}:reconcile`))?.state ===
          "failed_permanent"
      ) {
        pending.push(revision);
      }
    }
    return pending;
  }
}
