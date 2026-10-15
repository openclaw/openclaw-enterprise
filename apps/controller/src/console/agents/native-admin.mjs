import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

const warning =
  "Manage configuration in OCE. Changes in the admin console aren’t saved to Agent versions and can be overwritten by deployment.";

function unavailableText(status) {
  switch (status) {
    case "stopped":
      return "Start this Agent before opening its native admin UI.";
    case "unsupported":
      return "Native admin UI is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.";
    case "unavailable":
      return "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.";
    default:
      return "Native admin UI access is unavailable.";
  }
}

export function renderNativeAdminAccess(context, path) {
  const statusPath = `${path}/native-admin`;
  const status = element("p", { className: "hint", role: "status" }, "Checking access…");
  const error = element("p", { className: "error", role: "alert" });
  const launch = element(
    "a",
    {
      className: "overview-primary",
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-describedby": "native-admin-scope native-admin-warning",
      hidden: true,
    },
    "Open admin console",
    element("span", { "aria-hidden": "true" }, "↗"),
  );
  const reload = button("Refresh access", () => void load(), { className: "overview-text-button" });
  const scope = element(
    "p",
    { id: "native-admin-scope" },
    "Full native administration, including gateway conversations and credentials.",
  );
  const caution = element("p", { id: "native-admin-warning" }, warning);
  const section = element(
    "section",
    { className: "native-admin-access", "aria-label": "Native admin UI" },
    element(
      "div",
      { className: "native-admin-heading" },
      element("h2", {}, "Gateway administration"),
      launch,
    ),
    scope,
    caution,
    status,
    error,
    reload,
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
    scope.hidden = launch.hidden;
    caution.hidden = launch.hidden;
    status.hidden = !launch.hidden;
    section.hidden =
      !failed &&
      (current === undefined || current.status === "disabled" || current.status === "denied");
  }

  async function load() {
    if (!context.isCurrent() || pending) {
      return;
    }
    // Native admin needs Agent administer; a 403 is audited, so this tab asks once per Agent.
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
        status.textContent = "Native admin UI is available for this Agent’s current version.";
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

  return {
    section,
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
