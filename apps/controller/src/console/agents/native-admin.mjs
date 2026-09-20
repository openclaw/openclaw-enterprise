import { button, element } from "../dom.mjs";
import { message } from "./list.mjs";

const warning =
  "Native admin access can change this gateway outside OCE. Do not change configuration here; use OCE. Native changes are not recorded in AgentRevisions and may be overwritten by deployment. You can access the conversations and credentials available to this gateway.";

function unavailableText(status) {
  switch (status) {
    case "stopped":
      return "Start this Agent before opening its native admin UI.";
    case "unsupported":
      return "This Agent does not expose a supported native admin UI endpoint.";
    case "unavailable":
      return "Native admin UI access is unavailable. Check gateway routing and try again.";
    default:
      return "Native admin UI access is unavailable.";
  }
}

export function renderNativeAdminAccess(context, path) {
  const status = element("p", { className: "hint", role: "status" }, "Checking access…");
  const error = element("p", { className: "error", role: "alert" });
  const launch = button("Open native admin UI", () => void startLaunch(), {
    className: "primary",
    disabled: true,
    hidden: true,
  });
  const reload = button("Refresh access", () => void load());
  const section = element(
    "section",
    { className: "agent-card native-admin-access" },
    element("h2", {}, "Native admin UI"),
    element("p", { className: "notice" }, warning),
    status,
    error,
    element("div", { className: "form-actions" }, reload, launch),
  );

  let current;
  let pending = false;

  function updateControls() {
    reload.disabled = pending;
    launch.hidden = current?.status !== "available";
    launch.disabled = pending || launch.hidden;
    section.hidden =
      current === undefined || current.status === "disabled" || current.status === "denied";
  }

  async function load() {
    if (!context.isCurrent() || pending) {
      return;
    }
    pending = true;
    error.textContent = "";
    status.textContent = "Checking access…";
    updateControls();
    try {
      current = await context.request(`${path}/native-admin`);
      if (!context.isCurrent()) {
        return;
      }
      if (current.status === "available") {
        status.textContent = "Native admin UI is available for the selected AgentRevision.";
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
      current = undefined;
      status.textContent = "";
      error.textContent = message(cause);
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  }

  async function startLaunch() {
    if (pending || current?.status !== "available") {
      return;
    }
    pending = true;
    status.textContent = "Opening native admin UI…";
    error.textContent = "";
    updateControls();
    try {
      const url = new URL(current.bootstrapUrl, location.href);
      window.open(url.href, "_blank", "noopener,noreferrer");
      status.textContent = "Native admin UI opened in a new tab.";
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      status.textContent = "";
      error.textContent = message(cause, true);
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  }

  void load();
  return section;
}
