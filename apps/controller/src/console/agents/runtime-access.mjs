import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

const warning =
  "OpenClaw uses your assigned role to control conversations, tools and settings. Use OCE for durable configuration; native changes are not recorded in Agent versions and may be overwritten by deployment.";

function unavailableText(status, reason) {
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

export function renderRuntimeAccess(context, path) {
  const statusPath = `${path}/native-admin`;
  const status = element("p", { className: "hint", role: "status" }, "Checking access…");
  const error = element("p", { className: "error", role: "alert" });
  const launch = element(
    "a",
    { className: "primary", target: "_blank", rel: "noopener noreferrer", hidden: true },
    "Open OpenClaw",
  );
  const reload = button("Refresh access", () => {
    context.deniedReads?.forget(statusPath);
    void load();
  });
  const section = element(
    "section",
    { className: "agent-card native-admin-access" },
    element("h2", {}, "OpenClaw"),
    element("p", { className: "notice" }, warning),
    status,
    error,
    element("div", { className: "form-actions" }, reload, launch),
  );

  let current;
  // A failed read other than a denial keeps the card, its error and Refresh visible.
  let failed = false;
  let assignmentRequired = false;
  let pending = false;
  // A refresh that arrives during a read may predate the change it reports; read once more.
  let rereadAfterPending = false;

  function updateControls() {
    reload.disabled = pending;
    launch.hidden = pending || current?.status !== "available";
    if (launch.hidden) {
      launch.removeAttribute("href");
    } else {
      launch.href = current.url;
    }
    section.hidden =
      !failed &&
      !assignmentRequired &&
      (current === undefined || current.status === "disabled" || current.status === "denied");
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
      current = await context.request(statusPath);
      if (!context.isCurrent()) {
        return;
      }
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
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      if (cause.status === 403) {
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

  void load();
  return {
    section,
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
