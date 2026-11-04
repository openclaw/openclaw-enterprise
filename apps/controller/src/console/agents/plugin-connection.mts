import type { AgentPluginCredentialSlot } from "@openclaw-enterprise/contracts";
import { button, element } from "../dom.mjs";
import { requestFailure } from "../api-client.mjs";

export interface SlotTemplate {
  id: string;
  displayName: string;
  version: number;
}

export interface SlotConnection {
  unavailable(slot: AgentPluginCredentialSlot): string | undefined;
  list(slot: AgentPluginCredentialSlot): Promise<readonly SlotTemplate[]>;
  start(slot: AgentPluginCredentialSlot, template: SlotTemplate): Promise<void>;
}

export function pluginConnectionControl(
  slot: AgentPluginCredentialSlot,
  connections: SlotConnection,
) {
  const notice = element("p", { className: "hint", role: "status" });
  const panel = element("div");
  let busy = false;
  const open = button("Choose a connection template", () => void choose(), {
    tone: "secondary",
    size: "sm",
  });
  const root = element("div", { className: "stack" }, open, panel, notice);
  const unavailable = connections.unavailable(slot);
  if (unavailable) {
    open.hidden = true;
    notice.textContent = unavailable;
  }

  function available() {
    const reason = connections.unavailable(slot);
    if (reason) {
      notice.textContent = reason;
    }
    return !busy && !reason;
  }
  function showError(cause: unknown) {
    const { status } = requestFailure(cause);
    notice.textContent =
      status === 403
        ? "You need permission to update this Agent and connect an account in this Namespace."
        : status === 409
          ? "The template or plugin selection changed. Reload the Agent before connecting."
          : status === 401
            ? "Your session expired. Sign in before connecting an account."
            : "The connection could not start. Check the connection templates and try again.";
  }
  async function choose() {
    if (!available()) {
      return;
    }
    busy = true;
    open.disabled = true;
    panel.replaceChildren();
    notice.textContent = "Loading compatible templates…";
    try {
      const templates = await connections.list(slot);
      if (!templates.length) {
        notice.textContent =
          "No compatible OAuth template is available for this slot in this Namespace.";
        return;
      }
      const picker = element(
        "select",
        { "aria-label": `Connection template for ${slot.label}` },
        element("option", { value: "" }, "Choose a template"),
        ...templates.map((item) => element("option", { value: item.id }, item.displayName)),
      );
      const consent = button(
        "Connect and attach",
        () => {
          const template = templates.find((item) => item.id === picker.value);
          if (template && available()) {
            void start(template, consent);
          }
        },
        { tone: "primary" },
      );
      consent.disabled = true;
      picker.addEventListener("change", () => {
        consent.disabled = !picker.value;
      });
      open.hidden = true;
      panel.replaceChildren(
        element("label", { className: "plugin-control" }, "Connection template", picker),
        element("div", { className: "form-actions" }, consent),
      );
      notice.textContent = `Approving the provider will save your account and attach it to this Agent’s ${slot.label} slot.`;
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      open.disabled = false;
    }
  }
  async function start(template: SlotTemplate, action: HTMLButtonElement) {
    busy = true;
    action.disabled = true;
    open.disabled = true;
    notice.textContent = "Opening the provider for your consent…";
    try {
      await connections.start(slot, template);
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      action.disabled = false;
      open.disabled = false;
    }
  }
  return root;
}
