import { element, setHidden, setText } from "../dom.mjs";
import type { ProvisioningJob } from "./provisioning-job.mts";

// One step per phase the provisioning job reports, plus the ready end state. The job's `phase`
// names the last phase the worker completed, so a step is done only once the API says its phase
// completed, and the step after it is the current one. No step is inferred from time passed, and
// no percentage is shown, because the job reports phases, not fractions.
const STEP_LABELS = [
  "Waiting for the controller worker",
  "Creating the Configuration and Agent",
  "Creating runtime credentials",
  "Starting the first deployment",
  "Agent ready",
] as const;

export type ProvisioningProgressOutcome = "succeeded" | "failed" | "stopped" | "superseded";

export interface ProvisioningProgressView {
  readonly section: HTMLElement;
  /** Shows the meter for a new attempt; a retry resets the steps and the elapsed time. */
  begin(): void;
  /** Reports one poll's answer, advancing steps only as far as the job's own phase does. */
  report(job: ProvisioningJob): void;
  /**
   * Reports the terminal answer and stops the meter. A failure names the step it failed on
   * and the job's own safe reason, so the sticky bar shows the outcome without scrolling; the
   * form's error line below keeps the recovery action and its links (finding 2423).
   */
  finish(job: ProvisioningJob, outcome: ProvisioningProgressOutcome): void;
  /** Hides the meter when no job answer can drive it. */
  reset(): void;
}

function elapsedText(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `Elapsed ${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function stepLabel(step: number) {
  return STEP_LABELS[step] ?? STEP_LABELS.at(-1) ?? "";
}

// A terminal heading names the outcome and the step it happened on, so the bar the reader
// selected Create Agent from says what ended without waiting for the form's error line.
// Supersession keeps its own wording: a newer deployment took over, which is not a stop
// (finding from #3070's recovery explanation).
function outcomeHeading(label: string, outcome: "failed" | "stopped" | "superseded") {
  const step = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const lead = outcome === "failed" ? "Failed" : outcome === "stopped" ? "Stopped" : "Superseded";
  return `${lead} while ${step}.`;
}

// The step the job is on. `phase` names the last completed phase, so the step after it is
// current. An unreadable phase keeps the meter on the worker step, and a recorded revision
// means the deployment step even without a readable phase. A queued job that has completed a
// phase or recorded a revision is deferred between worker checks (an unfinished deployment
// wait, or a retry that retains its outputs), so it stays on the step it reached; only
// genuinely unstarted work shows the initial waiting layout.
function stepOf(job: ProvisioningJob): number {
  const byPhase =
    job.phase === "admitted"
      ? 1
      : job.phase === "configuration"
        ? 2
        : job.phase === undefined
          ? 1
          : 3;
  const progressed = Math.max(byPhase, job.revisionId === undefined ? 0 : 3);
  if (
    job.status === "queued" &&
    (job.phase === undefined || job.phase === "admitted") &&
    job.revisionId === undefined
  ) {
    return 0;
  }
  return progressed;
}

/**
 * The provisioning step meter for Create Agent. Steps come only from the polled job's status,
 * phase and recorded revision; the current step's marker is an indeterminate throbber, static
 * under reduced motion. The current step line is the meter's one live region, so a screen
 * reader hears each phase change once; the elapsed line changes every poll and stays silent.
 */
export function createProvisioningProgress(): ProvisioningProgressView {
  const steps = STEP_LABELS.map((label) =>
    element(
      "li",
      { className: "provisioning-step" },
      element("span", { className: "provisioning-step-marker", "aria-hidden": "true" }),
      element("span", { className: "provisioning-step-label" }, label),
    ),
  );
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
    element("ol", { className: "provisioning-steps" }, ...steps),
  );
  let startedAt = 0;
  // The most steps any poll confirmed. Phases are monotonic per job, so a poll that derives a
  // lower step carries an unreadable phase: it must not repaint confirmed steps pending or
  // move the heading backward — the heading goes generic and the steps stay.
  let confirmedStep = 0;

  function paint(step: number, outcome?: ProvisioningProgressOutcome) {
    steps.forEach((item, index) => {
      const state =
        outcome === "succeeded" || index < step
          ? "done"
          : index === step && outcome !== undefined
            ? outcome
            : index === step
              ? "current"
              : "pending";
      if (item.dataset.state !== state) {
        item.dataset.state = state;
      }
      if (state === "current") {
        item.setAttribute("aria-current", "step");
      } else if (item.hasAttribute("aria-current")) {
        item.removeAttribute("aria-current");
      }
    });
  }

  return {
    section,
    begin() {
      startedAt = Date.now();
      confirmedStep = 0;
      section.removeAttribute("data-outcome");
      setHidden(section, false);
      setHidden(reason, true);
      paint(0);
      setText(phase, `${stepLabel(0)}…`);
      setText(elapsed, elapsedText(0));
    },
    report(job: ProvisioningJob) {
      setHidden(section, false);
      const step = stepOf(job);
      if (step >= confirmedStep) {
        confirmedStep = step;
        paint(step);
        setText(phase, `${stepLabel(step)}…`);
      } else {
        // An unreadable phase on a job that already confirmed progress: the steps stay and
        // the heading goes generic, instead of naming an earlier step again.
        setText(phase, "Provisioning Agent…");
      }
      setText(elapsed, elapsedText(Date.now() - startedAt));
    },
    finish(job: ProvisioningJob, outcome: ProvisioningProgressOutcome) {
      section.dataset.outcome = outcome;
      if (outcome === "succeeded") {
        paint(steps.length);
        setText(phase, stepLabel(steps.length - 1));
        setHidden(reason, true);
        return;
      }
      const step = Math.max(stepOf(job), confirmedStep);
      paint(step, outcome);
      setText(phase, outcomeHeading(stepLabel(step), outcome));
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
