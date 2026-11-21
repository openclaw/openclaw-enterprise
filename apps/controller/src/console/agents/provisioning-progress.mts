import { element, setHidden, setText } from "../dom.mjs";
import type { ProvisioningJob } from "./provisioning-job.mts";

// One live status line beside Create Agent. It names only the last checkpoint the polled job's
// own reply confirms: the job's `phase` names the last phase the worker completed, so the line
// says, for example, "Configuration and Agent created" once that phase is reported — which does
// not confirm runtime-credential creation has started. Nothing is inferred about the next
// checkpoint from time passed, no percentage is shown (the job reports checkpoints, not
// fractions), and a poll whose phase is unreadable keeps the last confirmed message.
const CHECKPOINTS = [
  "Waiting for the controller worker…",
  "Provisioning request admitted.",
  "Configuration and Agent created.",
  "Runtime credentials created.",
  "First deployment handed off.",
] as const;

// The same checkpoints as a phrase for a terminal heading, so an ending names where the job
// reached without implying the next checkpoint had started.
const CHECKPOINT_PHRASES = [
  "",
  "the request was admitted",
  "Configuration and Agent created",
  "runtime credentials were created",
  "the first deployment was handed off",
] as const;

export type ProvisioningProgressOutcome = "succeeded" | "failed" | "stopped" | "superseded";

export interface ProvisioningProgressView {
  readonly section: HTMLElement;
  /** Shows the line for a new attempt; a retry resets the status and the elapsed time. */
  begin(): void;
  /** Reports one poll's answer, moving the line only as far as the job's own reply does. */
  report(job: ProvisioningJob): void;
  /**
   * Reports the terminal answer and stops the line. The bar shows the safe failure reason
   * and names the last confirmed checkpoint when the reply identifies one. The form keeps
   * the recovery action.
   */
  finish(job: ProvisioningJob, outcome: ProvisioningProgressOutcome): void;
  /** Hides the line when no job answer can drive it. */
  reset(): void;
}

function elapsedText(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `Elapsed ${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function checkpointLabel(checkpoint: number) {
  return CHECKPOINTS[checkpoint] ?? CHECKPOINTS[0];
}

// The last checkpoint the job's own reply confirms. The phase names the last phase the worker
// completed, and a recorded revision confirms handoff even when the reply omits its phase. A
// queued job that reports only admission (or nothing readable) has not started worker
// execution — admission is the request's acceptance, and the worker may still be between
// checks (an unfinished deployment wait, or a retry that retains its outputs) — so it
// confirms nothing. A job the server reports running has passed admission even when the
// reply's phase is unreadable, but a terminal reply without a readable phase confirms nothing
// beyond what earlier polls confirmed.
function checkpointOf(job: ProvisioningJob): number {
  const byPhase =
    job.phase === "admitted"
      ? 1
      : job.phase === "configuration"
        ? 2
        : job.phase === "transport"
          ? 3
          : job.phase === "handoff"
            ? 4
            : 0;
  const byRevision = job.revisionId === undefined ? 0 : 4;
  if (job.status === "queued" && byPhase <= 1 && byRevision === 0) {
    return 0;
  }
  if (byPhase === 0 && byRevision === 0) {
    return job.status === "running" ? 1 : 0;
  }
  return Math.max(byPhase, byRevision);
}

// A terminal heading names the outcome and the last confirmed checkpoint, so the bar the reader
// selected Create Agent from says what ended without waiting for the form's error line. It
// never names a checkpoint the job did not confirm. Supersession keeps its own wording: a
// newer deployment took over, which is not a stop (finding from #3070's recovery explanation).
function outcomeHeading(checkpoint: number, outcome: "failed" | "stopped" | "superseded") {
  const phrase = CHECKPOINT_PHRASES[checkpoint] ?? "";
  if (phrase === "") {
    return outcome === "failed"
      ? "Agent provisioning failed."
      : outcome === "stopped"
        ? "Provisioning stopped."
        : "Superseded by a newer deployment.";
  }
  const lead =
    outcome === "failed"
      ? "Agent provisioning failed"
      : outcome === "stopped"
        ? "Provisioning stopped"
        : "Superseded";
  return `${lead} after ${phrase}.`;
}

/**
 * The provisioning status line for Create Agent. The message comes only from the polled job's
 * status, phase and recorded revision; it is the line's one live region, so a screen reader
 * hears each confirmed checkpoint once. The elapsed line changes every poll and stays silent.
 */
export function createProvisioningProgress(): ProvisioningProgressView {
  const phase = element("p", { className: "provisioning-phase", role: "status" });
  const elapsed = element("p", { className: "provisioning-elapsed", "aria-hidden": "true" });
  // The job's own safe reason for a failure. Not a live region: the form's error line already
  // announces it, and the heading above says that provisioning failed.
  const reason = element("p", { className: "provisioning-reason", hidden: true });
  const section = element(
    "section",
    {
      className: "provisioning-progress",
      "aria-label": "Agent provisioning progress",
      hidden: true,
    },
    element("div", { className: "provisioning-progress-head" }, phase, elapsed),
    reason,
  );
  let startedAt = 0;
  // The furthest checkpoint any poll confirmed. Phases are monotonic per job, so a poll that
  // derives a lower checkpoint carries an unreadable phase: it must not move the message
  // backward or invent one — the last confirmed message stays.
  let confirmed = 0;

  return {
    section,
    begin() {
      startedAt = Date.now();
      confirmed = 0;
      section.removeAttribute("data-outcome");
      setHidden(section, false);
      setHidden(reason, true);
      setText(phase, CHECKPOINTS[0]);
      setText(elapsed, elapsedText(0));
    },
    report(job: ProvisioningJob) {
      // Admission can return a previously finished job. Only finish() interprets its checkpoint.
      if (job.status !== "queued" && job.status !== "running") {
        return;
      }
      setHidden(section, false);
      const checkpoint = checkpointOf(job);
      if (checkpoint > confirmed) {
        confirmed = checkpoint;
        setText(phase, checkpointLabel(checkpoint));
      }
      // A poll that confirms no new checkpoint — including one with an unreadable phase —
      // keeps the last confirmed message, rather than inferring the next checkpoint started.
      setText(elapsed, elapsedText(Date.now() - startedAt));
    },
    finish(job: ProvisioningJob, outcome: ProvisioningProgressOutcome) {
      section.dataset.outcome = outcome;
      if (outcome === "succeeded") {
        setText(phase, "Agent ready.");
        setHidden(reason, true);
        return;
      }
      setText(phase, outcomeHeading(Math.max(confirmed, checkpointOf(job)), outcome));
      // Only a failure carries its reason in the bar; a stop is the owner's choice and a
      // supersession means a newer deployment took over, and the form's line below already
      // says what to do next.
      const message = outcome === "failed" ? job.error?.message : undefined;
      setText(reason, message ?? "");
      setHidden(reason, !message);
    },
    reset() {
      setHidden(section, true);
    },
  };
}
