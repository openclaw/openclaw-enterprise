import type { AgentPluginCredentialSlot } from "@openclaw-enterprise/contracts";
import { button, dismissOnBackdrop, element, mayReturnFocus } from "../dom.mjs";
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
    accountName?: string,
  ): Promise<void>;
}

function consentScopes(template: SlotTemplate, setSelection: (scopes: string[] | null) => void) {
  const unrestricted = template.scopes.length === 0;
  const fieldset = element(
    "fieldset",
    { className: "plugin-tool" },
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
  currentSourceIds: readonly string[],
  pluginName: string,
  editor: HTMLDialogElement,
) {
  const needsConsent = slot.sources.some(
    (source) =>
      source.authorization === "required" &&
      (!currentSourceIds.length || currentSourceIds.includes(source.id)),
  );
  if (!slot.connectAccount) {
    return needsConsent
      ? element(
          "p",
          { className: "hint" },
          connections.unavailable(slot) ??
            "This slot needs a connection template and permission to start consent for this server.",
        )
      : null;
  }
  const open = button(
    "Connect new account",
    () => {
      const unavailable = connections.unavailable(slot);
      if (unavailable) {
        reason.textContent = unavailable;
        return;
      }
      showConnectionDialog(slot, connections, pluginName, editor, open);
    },
    { tone: "secondary", size: "sm" },
  );
  open.dataset.connectSlot = slot.id;
  const unavailable = connections.unavailable(slot);
  const reason = element("p", { className: "hint", role: "status" }, unavailable ?? "");
  open.dataset.policyUnsupported = String(Boolean(unavailable));
  open.disabled = Boolean(unavailable);
  return element("div", { className: "plugin-account-action" }, open, reason);
}

function showConnectionDialog(
  slot: AgentPluginCredentialSlot,
  connections: SlotConnection,
  pluginName: string,
  editor: HTMLDialogElement,
  opener: HTMLButtonElement,
) {
  const dialog = element("dialog", {
    className: "dialog dialog--framed",
    "aria-label": "Connect new account",
  });
  dismissOnBackdrop(dialog);
  const fields = element("fieldset", {
    className: "connection-template-fields plugin-connection-fields",
  });
  const notice = element("p", { className: "hint", role: "status" });
  const cancel = button("Cancel", () => dialog.close());
  const connect = button("Connect and attach", () => void start(), { tone: "primary" });
  connect.disabled = true;
  let submitting = false;
  let template: SlotTemplate | undefined;
  let selectedScopes: string[] | null | undefined;
  const accountName = element("input", { type: "text", maxLength: 200, placeholder: "e.g. Work" });
  dialog.append(
    element(
      "div",
      { className: "dialog-header" },
      element("h2", { tabindex: "-1", autofocus: true }, "Connect new account"),
      element("p", {}, pluginName + " · " + slot.label),
    ),
    element("div", { className: "dialog-body" }, fields, notice),
    element("div", { className: "dialog-actions" }, cancel, connect),
  );
  dialog.addEventListener("cancel", (event) => {
    if (submitting) {
      event.preventDefault();
    }
  });
  dialog.addEventListener(
    "close",
    () => {
      const restore = mayReturnFocus(dialog);
      dialog.remove();
      if (restore && editor.open) {
        const target = opener.isConnected
          ? opener
          : editor.querySelector<HTMLButtonElement>(
              `[data-plugin="${CSS.escape(slot.pluginId)}"] [data-connect-slot="${CSS.escape(slot.id)}"]`,
            );
        target?.focus();
      }
    },
    { once: true },
  );
  // The editor replaces the plugin card during background discovery. Keep the open form
  // beside the card so a refresh cannot discard the template or permissions being chosen.
  editor.append(dialog);
  dialog.showModal();
  void loadTemplates();

  function showError(cause: unknown) {
    const { status, serverMessage } = requestFailure(cause);
    notice.textContent =
      status === 403
        ? "You need permission to update this Agent and connect an account in this Namespace."
        : status === 409
          ? (serverMessage ??
            "The template or plugin selection changed. Reload the Agent before connecting.")
          : status === 401
            ? "Your session expired. Sign in before connecting an account."
            : "The connection could not start. Check the connection templates and try again.";
  }

  async function loadTemplates() {
    fields.replaceChildren();
    notice.textContent = "Loading compatible templates…";
    try {
      const templates = await connections.list(slot);
      if (!dialog.open) {
        return;
      }
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
      picker.addEventListener("change", () => {
        template = templates.find((item) => item.id === picker.value);
        scopeChoices.replaceChildren();
        selectedScopes = undefined;
        connect.disabled = !template;
        if (!template) {
          return;
        }
        if (template.mode === "manual" && template.scopes.length) {
          scopeChoices.append(
            element(
              "fieldset",
              { className: "plugin-tool" },
              element("legend", {}, "Permissions set by this template"),
              ...template.scopes.map((scope) => element("div", {}, scope)),
            ),
          );
        } else {
          scopeChoices.append(
            consentScopes(template, (scopes) => {
              selectedScopes = scopes;
              connect.disabled = scopes === null;
            }),
          );
        }
      });
      fields.append(
        element("label", { className: "plugin-control" }, "Connection template", picker),
        element("label", { className: "plugin-control" }, "Account name (optional)", accountName),
        scopeChoices,
      );
      notice.textContent = `After you approve access at the provider, OCE will add the account to the ${slot.label} slot.`;
    } catch (error) {
      if (!dialog.open) {
        return;
      }
      showError(error);
      fields.append(button("Retry loading templates", () => void loadTemplates()));
    }
  }

  async function start() {
    if (submitting || !template || selectedScopes === null) {
      return;
    }
    const unavailable = connections.unavailable(slot);
    if (unavailable) {
      notice.textContent = unavailable;
      return;
    }
    submitting = true;
    fields.disabled = cancel.disabled = connect.disabled = true;
    notice.textContent = "Opening the provider for your consent…";
    try {
      await connections.start(
        slot,
        template,
        selectedScopes,
        accountName.value.trim() || undefined,
      );
      dialog.close();
    } catch (error) {
      showError(error);
    } finally {
      submitting = false;
      fields.disabled = cancel.disabled = connect.disabled = false;
    }
  }
}
