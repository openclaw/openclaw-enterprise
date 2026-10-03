import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

const warning =
  "OpenClaw uses your assigned role to control conversations, tools and settings. Use OCE for durable configuration; native changes are not recorded in Agent versions and may be overwritten by deployment.";

function unavailableText(status) {
  switch (status) {
    case "stopped":
      return "Start this Agent before opening OpenClaw.";
    case "unsupported":
      return "OpenClaw is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.";
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
  const reload = button("Refresh access", () => void load());
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
      (current === undefined || current.status === "disabled" || current.status === "denied");
  }

  async function load() {
    if (!context.isCurrent() || pending) {
      return;
    }
    // OpenClaw needs an exact Agent use grant and runtime assignment; a 403 is audited, so this tab asks once per Agent.
    if (context.deniedReads?.has(statusPath)) {
      current = undefined;
      failed = false;
      status.textContent = "";
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
      if (current.status === "available") {
        status.textContent = "OpenClaw is available for this Agent’s active revision.";
      } else if (current.status === "disabled" || current.status === "denied") {
        status.textContent = "";
      } else {
        status.textContent = unavailableText(current.status);
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
      }
      failed = cause.status !== 403;
      current = undefined;
      status.textContent = "";
      error.textContent = message(cause);
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
