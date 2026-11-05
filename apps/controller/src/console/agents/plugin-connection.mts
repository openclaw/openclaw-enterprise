import type { AgentPluginCredentialSlot } from "@openclaw-enterprise/contracts";
import { button, element } from "../dom.mjs";
import { requestFailure } from "../api-client.mjs";

export interface SlotTemplate {
  id: string;
  displayName: string;
  version: number;
  mode: "manual" | "mcp_discovery";
  scopes: readonly string[];
  requiredScopes: readonly string[];
  offeredScopes: readonly string[];
}

export interface SlotConnection {
  unavailable(slot: AgentPluginCredentialSlot): string | undefined;
  list(slot: AgentPluginCredentialSlot): Promise<readonly SlotTemplate[]>;
  start(
    slot: AgentPluginCredentialSlot,
    template: SlotTemplate,
    selectedScopes?: readonly string[],
  ): Promise<void>;
}

function consentScopes(template: SlotTemplate, setSelection: (scopes: string[] | null) => void) {
  const unrestricted = template.scopes.length === 0;
  const fieldset = element(
    "fieldset",
    { className: "stack" },
    element("legend", {}, "Permissions for this connection"),
  );
  const suggestions = unrestricted ? template.offeredScopes : template.scopes;
  const choices = [...new Set([...template.requiredScopes, ...suggestions])].map((scope) => {
    const required = template.requiredScopes.includes(scope);
    const input = element("input", { type: "checkbox", value: scope });
    input.checked = input.disabled = required;
    fieldset.append(
      element(
        "label",
        { className: "plugin-toggle" },
        input,
        required ? `${scope} (required)` : scope,
      ),
    );
    return input;
  });
  const extra = unrestricted
    ? element("input", {
        type: "text",
        spellcheck: false,
        autocapitalize: "none",
        autocomplete: "off",
      })
    : null;
  const problem = element("p", { className: "hint", role: "status" });
  if (extra) {
    fieldset.append(
      element("label", { className: "plugin-control" }, "Additional scopes", extra),
      element("p", { className: "hint" }, "Separate scope names with spaces."),
      problem,
    );
    if (template.requiredScopes.length === 0) {
      fieldset.append(
        element("p", { className: "hint" }, "Leave all scopes empty to use the provider defaults."),
      );
    }
  }
  function update() {
    const checked = choices.filter((input) => input.checked).map((input) => input.value);
    const added = extra?.value.trim().split(/\s+/).filter(Boolean) ?? [];
    const invalid = added.some(
      (scope) => scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    );
    const message = invalid
      ? "Use printable ASCII scope names of up to 512 characters, without double quotes or backslashes."
      : "";
    if (extra) {
      extra.setCustomValidity(message);
      extra.setAttribute("aria-invalid", String(invalid));
      problem.textContent = message;
      problem.hidden = !message;
    }
    const selected = [...new Set([...checked, ...added])];
    setSelection(invalid || (!unrestricted && !selected.length) ? null : selected);
  }
  fieldset.addEventListener("input", update);
  update();
  return fieldset;
}

export function pluginConnectionControl(
  slot: AgentPluginCredentialSlot,
  connections: SlotConnection,
  currentName?: string,
) {
  const notice = element("p", { className: "hint", role: "status" });
  const panel = element("div");
  let busy = false;
  const needsConsent = slot.sources.some((source) => source.authorization === "required");
  const open = button(
    needsConsent
      ? "Authorize for this server"
      : currentName
        ? "Connect a different account"
        : "Choose a connection template",
    () => void choose(),
    {
      tone: "secondary",
      size: "sm",
    },
  );
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
          "No compatible OAuth template is available for this slot in this Namespace. Ask an Installation administrator to configure this server.";
        return;
      }
      const picker = element(
        "select",
        { "aria-label": `Connection template for ${slot.label}` },
        element("option", { value: "" }, "Choose a template"),
        ...templates.map((item) => element("option", { value: item.id }, item.displayName)),
      );
      const scopeChoices = element("div");
      let selectedScopes: string[] | null | undefined;
      const consent = button(
        currentName ? "Authorize and replace account" : "Connect and attach",
        () => {
          const template = templates.find((item) => item.id === picker.value);
          if (template && available() && selectedScopes !== null) {
            void start(template, consent, selectedScopes);
          }
        },
        { tone: "primary" },
      );
      consent.disabled = true;
      picker.addEventListener("change", () => {
        const template = templates.find((item) => item.id === picker.value);
        scopeChoices.replaceChildren();
        selectedScopes = undefined;
        consent.disabled = !template;
        if (template && (template.mode === "mcp_discovery" || template.scopes.length === 0)) {
          scopeChoices.append(
            consentScopes(template, (scopes) => {
              selectedScopes = scopes;
              consent.disabled = scopes === null;
            }),
          );
        }
      });
      open.hidden = true;
      panel.replaceChildren(
        element("label", { className: "plugin-control" }, "Connection template", picker),
        scopeChoices,
        element("div", { className: "form-actions" }, consent),
      );
      notice.textContent = currentName
        ? `After you authorize the account at the provider for this server, it will replace ${currentName} in the ${slot.label} slot.`
        : needsConsent
          ? `Choose the account at the provider. After you approve access to this server, OCE will attach the approved account to the ${slot.label} slot.`
          : `Approving the provider will save your account and attach it to this Agent’s ${slot.label} slot.`;
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      open.disabled = false;
    }
  }
  async function start(
    template: SlotTemplate,
    action: HTMLButtonElement,
    selectedScopes?: readonly string[],
  ) {
    busy = true;
    action.disabled = true;
    open.disabled = true;
    notice.textContent = "Opening the provider for your consent…";
    try {
      await connections.start(slot, template, selectedScopes);
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
