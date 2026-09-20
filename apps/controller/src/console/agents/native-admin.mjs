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
  const launch = element(
    "a",
    { className: "primary", target: "_blank", rel: "noopener noreferrer", hidden: true },
    "Open native admin UI",
  );
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
    launch.hidden = pending || current?.status !== "available";
    if (launch.hidden) {
      launch.removeAttribute("href");
    } else {
      launch.href = current.url;
    }
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

  void load();
  return section;
}
