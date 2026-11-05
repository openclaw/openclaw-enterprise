import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, setText } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { message } from "./list.mjs";

const warning =
  "Gateway managed mode restricts administrative changes by default. OCE deployments can overwrite changes made while managed mode is off.";

type Availability =
  | { status: "available"; url: string }
  | { status: "disabled" | "denied" | "stopped" | "unsupported" | "unavailable"; reason?: string };

function readAvailability(value: unknown): Availability {
  const { status, url, reason } = responseFields(value);
  switch (status) {
    case "available":
      if (typeof url === "string" && url) {
        return { status, url };
      }
      break;
    case "disabled":
    case "denied":
    case "stopped":
    case "unsupported":
    case "unavailable":
      return { status, ...(typeof reason === "string" ? { reason } : {}) };
  }
  throw new Error("Invalid native administration access response");
}

function unavailableText(status: Availability["status"], reason?: string) {
  switch (status) {
    case "stopped":
      return "Start this Agent before opening OpenClaw.";
    case "unsupported":
      switch (reason) {
        case "ui_configuration":
          return "OpenClaw’s UI is disabled or does not allow this Agent’s URL. Someone who can edit its Configuration can enable it and deploy a new version.";
        case "role_unavailable":
          return "Your assigned OpenClaw role is missing from this Agent’s current version. An administrator can change your assignment in Sharing or restore the role and deploy.";
        case "device_approval_required":
          return "OpenClaw browser pairing does not approve all permissions in your assigned role. Someone who can edit its Configuration can update device auto-approval and deploy a new version.";
        default:
          return "This Compute Driver does not provide supported OpenClaw browser access for this Agent.";
      }
    case "unavailable":
      return "OpenClaw is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.";
    default:
      return "OpenClaw access is unavailable.";
  }
}

export function renderRuntimeAccess(
  context: Omit<AgentAccessContext, "namespaceId"> & {
    installationAdmin?: boolean | null;
    deniedReads?: {
      has(path: string): boolean;
      remember(path: string): void;
      forget(path: string): void;
    };
  },
  path: string,
  options?: {
    versionLabel(): string;
    recovery(status: Availability["status"]): HTMLElement | null;
  },
) {
  const statusPath = `${path}/native-admin`;
  const status = element(
    "p",
    { id: "native-admin-availability", className: "hint", role: "status" },
    "Checking access…",
  );
  const error = element("p", { id: "native-admin-error", className: "error", role: "alert" });
  const target = element("p", { id: "native-admin-target", className: "native-admin-target" });
  // aria-disabled, not disabled: the control stays in the Tab order, so a keyboard user reaches
  // the reason it describes (finding 2714). It has no action.
  const unavailable = button("Open Agent UI", () => {}, {
    tone: "primary",
    className: "agent-ui-unavailable",
    "aria-disabled": "true",
    hidden: true,
    "aria-describedby": `${status.id} ${error.id}`,
  });
  const recovery = element("div", { className: "native-admin-recovery" });
  const launch = element(
    "a",
    {
      className: "button button--primary agent-ui-launch",
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-describedby": "native-admin-target native-admin-scope native-admin-warning",
      hidden: true,
    },
    "Open Agent UI",
    element("span", { "aria-hidden": "true" }, "↗"),
  );
  const reload = button(
    "Refresh access",
    () => {
      context.deniedReads?.forget(statusPath);
      void load();
    },
    { className: "overview-text-button" },
  );
  const scope = element(
    "p",
    { id: "native-admin-scope" },
    "Your assigned OpenClaw role controls access to conversations, tools and settings.",
  );
  const caution = element("p", { id: "native-admin-warning" }, warning);
  const section = element(
    "section",
    { className: "native-admin-access", "aria-label": "OpenClaw access" },
    target,
    scope,
    caution,
    status,
    error,
    reload,
    recovery,
  );

  let current: Availability | undefined;
  // A failed read other than a denial keeps the card, its error and Refresh visible.
  let failed = false;
  let assignmentRequired = false;
  let pending = false;
  // A refresh that arrives during a read may predate the change it reports; read once more.
  let rereadAfterPending = false;

  function updateControls() {
    // aria-disabled, not disabled: disabling the focused button drops keyboard focus to the page.
    // load() already ignores activation while a read is pending.
    reload.setAttribute("aria-disabled", String(pending));
    // The launch link and the unavailable button take turns in one place. A swap would hide the
    // one with focus and drop focus to the page, so the other takes it (finding 2880).
    const focused = [launch, unavailable].find((control) => control === document.activeElement);
    const url = !pending && current?.status === "available" ? current.url : undefined;
    launch.hidden = url === undefined;
    if (url === undefined) {
      launch.removeAttribute("href");
    } else {
      launch.href = url;
    }
    scope.hidden = launch.hidden;
    caution.hidden = launch.hidden;
    status.hidden = !launch.hidden;
    section.hidden =
      !failed &&
      !assignmentRequired &&
      (current === undefined || current.status === "disabled" || current.status === "denied");
    unavailable.hidden = section.hidden || !launch.hidden;
    const replacement = focused === launch ? unavailable : launch;
    if (focused?.hidden && !replacement.hidden) {
      replacement.focus({ preventScroll: true });
    }
    target.hidden = launch.hidden;
    updateTarget();
    const nextRecovery = current && launch.hidden ? options?.recovery(current.status) : null;
    // An unchanged recovery link keeps focus if the reader moved there during the access read.
    const shownRecovery = recovery.firstElementChild;
    if (nextRecovery ? !nextRecovery.isEqualNode(shownRecovery) : shownRecovery !== null) {
      recovery.replaceChildren(...(nextRecovery ? [nextRecovery] : []));
    }
  }
  function updateTarget() {
    // Deployment polls call this too; an unchanged line is left untouched.
    setText(
      target,
      `Opens selected version · ${options?.versionLabel() ?? "current version"} in a new tab.`,
    );
  }

  function showDeniedAccess() {
    current = undefined;
    failed = false;
    assignmentRequired = context.installationAdmin === true;
    status.textContent = assignmentRequired
      ? "To open OpenClaw, assign your Principal ID an OpenClaw role in Share Agent below, then select Refresh access."
      : "";
    error.textContent = "";
  }

  async function load() {
    if (!context.isCurrent() || pending) {
      return;
    }
    // Automatic reads retain audited denials; an explicit Refresh checks access again.
    if (context.deniedReads?.has(statusPath)) {
      showDeniedAccess();
      updateControls();
      return;
    }
    pending = true;
    error.textContent = "";
    status.textContent = "Checking access…";
    updateControls();
    try {
      if (!context.isCurrent()) {
        return;
      }
      const result = await context.request(statusPath);
      if (!context.isCurrent()) {
        return;
      }
      current = readAvailability(result);
      failed = false;
      assignmentRequired = false;
      if (current.status === "available") {
        status.textContent = "OpenClaw is available for this Agent’s current version.";
      } else if (current.status === "disabled" || current.status === "denied") {
        status.textContent = "";
      } else {
        status.textContent = unavailableText(current.status, current.reason);
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const { status: failureStatus } = requestFailure(cause);
      if (failureStatus === 401) {
        context.onExpired();
        return;
      }
      if (failureStatus === 403) {
        context.deniedReads?.remember(statusPath);
        showDeniedAccess();
      } else {
        failed = true;
        assignmentRequired = false;
        current = undefined;
        status.textContent = "";
        error.textContent = message(cause);
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
        if (rereadAfterPending) {
          rereadAfterPending = false;
          void load();
        }
      }
    }
  }

  return {
    section,
    launch,
    unavailable,
    updateTarget,
    ready: load(),
    // Rereads access once, for example after the active version or runtime state changes.
    refresh() {
      if (pending) {
        rereadAfterPending = true;
        return;
      }
      void load();
    },
  };
}
