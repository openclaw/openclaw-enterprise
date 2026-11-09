import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, setText } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { message } from "./list.mjs";

const warning =
  "Gateway managed mode restricts administrative changes by default. OCE deployments can overwrite changes made while managed mode is off.";

type Availability =
  | { status: "available"; url: string; mode: "admin" | "chat" }
  | { status: "disabled" | "denied" | "stopped" | "unsupported" | "unavailable" };

function readAvailability(value: unknown): Availability {
  const { status, url, mode } = responseFields(value);
  switch (status) {
    case "available":
      if (typeof url === "string" && url && (mode === "admin" || mode === "chat")) {
        return { status, url, mode };
      }
      break;
    case "disabled":
    case "denied":
    case "stopped":
    case "unsupported":
    case "unavailable":
      return { status };
  }
  throw new Error("Invalid native administration access response");
}

function unavailableText(status: Availability["status"]) {
  switch (status) {
    case "stopped":
      return "Start this Agent before opening its browser UI.";
    case "unsupported":
      return "Browser access is not supported by this Agent’s current version. Ask someone who can edit its Configuration to check browser access and Compute support, then deploy a supported version.";
    case "unavailable":
      return "Browser access is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.";
    default:
      return "Browser access is unavailable.";
  }
}

export function renderNativeAdminAccess(
  context: Omit<AgentAccessContext, "namespaceId"> & {
    deniedReads?: { has(path: string): boolean; remember(path: string): void };
  },
  path: string,
  // The caller's latest advisory Agent operate/administer answer; undefined when unknown.
  browserAccessAllowed?: () => Promise<boolean | undefined>,
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
      "aria-describedby": "native-admin-target native-admin-scope",
      hidden: true,
    },
    "Open Agent UI",
    element("span", { "aria-hidden": "true" }, "↗"),
  );
  const reload = button("Refresh access", () => void load(), { className: "overview-text-button" });
  const scope = element(
    "p",
    { id: "native-admin-scope" },
    "Full Agent administration, including conversations and accessible credentials.",
  );
  const caution = element("p", { id: "native-admin-warning" }, warning);
  const section = element(
    "section",
    { className: "native-admin-access", "aria-label": "Agent browser access" },
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
    const chat = current?.status === "available" && current.mode === "chat";
    launch.replaceChildren(
      document.createTextNode(chat ? "Open chat" : "Open Agent UI"),
      element("span", { "aria-hidden": "true" }, "↗"),
    );
    setText(
      scope,
      chat
        ? "Chat with this Agent and manage its conversations. Conversations use the Agent’s shared workspace."
        : "Full Agent administration, including conversations and accessible credentials.",
    );
    caution.hidden = launch.hidden || chat;
    launch.setAttribute(
      "aria-describedby",
      chat
        ? "native-admin-target native-admin-scope"
        : "native-admin-target native-admin-scope native-admin-warning",
    );
    status.hidden = !launch.hidden;
    section.hidden =
      !failed &&
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

  async function load() {
    if (!context.isCurrent() || pending) {
      return;
    }
    // Browser access needs Agent operate or administer; a 403 is audited, so ask once per Agent.
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
      // A caller whose permission answer says no is not asked: the probe's 403 would be a
      // console error and an audited denial for each Agent page. An unknown answer still asks.
      if ((await browserAccessAllowed?.()) === false) {
        if (!context.isCurrent()) {
          return;
        }
        current = undefined;
        failed = false;
        status.textContent = "";
        return;
      }
      if (!context.isCurrent()) {
        return;
      }
      const result = await context.request(statusPath);
      if (!context.isCurrent()) {
        return;
      }
      current = readAvailability(result);
      failed = false;
      if (current.status === "available") {
        status.textContent = "Browser access is available for this Agent’s current version.";
      } else if (current.status === "disabled" || current.status === "denied") {
        status.textContent = "";
      } else {
        status.textContent = unavailableText(current.status);
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
      }
      failed = failureStatus !== 403;
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
