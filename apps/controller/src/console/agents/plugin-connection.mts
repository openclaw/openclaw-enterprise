import type { AgentPluginCredentialSlot, SecretReference } from "@openclaw-enterprise/contracts";
import { requestFailure } from "../api-client.mjs";
import { button, dismissOnBackdrop, element, field, validateFields } from "../dom.mjs";
import { namespaceNameProblem } from "../namespaces.mjs";
import { type CredentialRegistration, credentialRegistrationResult } from "./credential-access.mjs";
import { describeFailure, namespacePath } from "./list.mjs";
import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";
import { createSecretReferenceField } from "./secret-picker.mjs";

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
  addToken?(
    slot: AgentPluginCredentialSlot,
    owner: HTMLDialogElement,
    select: (id: string) => void,
  ): void;
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
  currentSourceId?: string,
) {
  const currentSource = slot.sources.find((source) => source.id === currentSourceId);
  const currentName = currentSourceId ? (currentSource?.name ?? "the current account") : undefined;
  const needsConsent = currentSourceId
    ? currentSource?.authorization === "required"
    : slot.sources.some((source) => source.authorization === "required");
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
  const notice = element("p", { className: "hint", role: "status" });
  const panel = element("div");
  let busy = false;
  const connect = slot.tokenSourceConfig ? "Connect with OAuth" : "Choose a connection template";
  const open = button(
    needsConsent
      ? "Authorize for this server"
      : currentName
        ? "Connect a different account"
        : connect,
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

export function openPluginTokenDialog(
  context: PluginDiscoveryContext,
  owner: HTMLDialogElement,
  slot: AgentPluginCredentialSlot,
  onRegistered: (id: string) => void,
  canEdit: () => boolean,
) {
  const config = slot.tokenSourceConfig;
  if (!config || !canEdit()) {
    return;
  }
  const dialog = element("dialog", { className: "dialog", "aria-label": "Add MCP token" });
  const name = element("input", {
    id: "plugin-token-name",
    type: "text",
    required: "",
    "data-trim": "",
    autocomplete: "off",
  });
  let secret: SecretReference | undefined;
  const picker = createSecretReferenceField({
    context,
    id: "plugin-token-secret",
    label: "Token Secret",
    getCurrentSource: () => secret,
    onSecretSelected: (selected) => {
      secret = selected.ref;
    },
    createSecretName: () => name.value.trim() || slot.label,
    createDialogTitle: "Create token Secret",
    metadataLabel: "View token Secret metadata",
    noSecretLabel: "Choose a Secret",
    stagedHint: "Register the token to use this Secret.",
    required: true,
  });
  const notice = element("p", { className: "hint", role: "status" });
  const cancel = button("Cancel", () => dialog.close());
  const submit = element(
    "button",
    { type: "submit", className: "button button--primary" },
    "Register token",
  );
  const form = element(
    "form",
    { className: "stack", novalidate: "" },
    element("h2", {}, "Add MCP token"),
    field({ label: "Token name", control: name }),
    picker.field,
    notice,
    element("div", { className: "dialog-actions" }, cancel, submit),
  );
  dialog.append(form);
  owner.append(dialog);
  dismissOnBackdrop(dialog);
  let pending = false;
  let unconfirmed: CredentialRegistration | undefined;
  dialog.addEventListener("cancel", (event) => {
    if (pending) {
      event.preventDefault();
    }
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || submit.hidden || !dialog.open || !context.isCurrent()) {
      return;
    }
    if (!canEdit()) {
      notice.textContent = "Reopen the editable plugin draft to add a token.";
      return;
    }
    name.setCustomValidity(namespaceNameProblem(name.value));
    if (!unconfirmed && (!validateFields(form.elements) || !secret)) {
      return;
    }
    const registration = unconfirmed ?? {
      name: name.value.trim(),
      type: "bearer-token",
      config,
      secrets: { token: secret! },
    };
    const checking = Boolean(unconfirmed);
    const path = `${namespacePath(context.namespaceId)}/credential-sources`;
    pending = true;
    submit.disabled = true;
    cancel.disabled = true;
    name.disabled = true;
    picker.setDisabled(true);
    notice.textContent = checking ? "Checking registration…" : "Registering token…";
    try {
      let result;
      if (checking) {
        const sources = await context.request(path);
        if (!Array.isArray(sources)) {
          throw new Error("Invalid credential source list.");
        }
        result = sources.find((source) => source?.name === registration.name);
        if (!result) {
          notice.textContent =
            "No credential source with that name is visible. Check again, or close and retry with the same name.";
          return;
        }
      } else {
        result = await context.request(path, {
          method: "POST",
          expectedStatus: 201,
          showsOutcome: true,
          body: registration,
        });
      }
      if (!dialog.open || !context.isCurrent()) {
        return;
      }
      const source = credentialRegistrationResult(result, context.namespaceId, registration);
      if (!source) {
        throw new Error("Credential registration unconfirmed.");
      }
      if (source.state !== "ready") {
        unconfirmed = registration;
        submit.textContent = "Check registration";
        notice.textContent = `The credential source is ${source.state}. Check its status before selecting it.`;
        return;
      }
      submit.hidden = true;
      cancel.textContent = "Done";
      if (canEdit()) {
        onRegistered(source.id);
        notice.textContent = "Token registered. Save plugin selections to attach it to this Agent.";
      } else {
        notice.textContent = "Token registered. Reopen the editable plugin draft to select it.";
      }
    } catch (error) {
      if (!dialog.open || !context.isCurrent()) {
        return;
      }
      const { status } = requestFailure(error);
      if (status === 401) {
        context.onExpired();
        return;
      }
      if (checking || ![400, 403, 404, 409, 429, 501].includes(status ?? 0)) {
        unconfirmed = registration;
        submit.textContent = "Check registration";
        notice.textContent =
          "Registration could not be confirmed. Check the saved credential sources before trying again.";
      } else {
        notice.textContent = describeFailure(error, { mutation: true, form: true });
      }
    } finally {
      pending = false;
      submit.disabled = false;
      cancel.disabled = false;
      name.disabled = submit.hidden || Boolean(unconfirmed);
      picker.setDisabled(name.disabled);
      if (submit.hidden && dialog.open) {
        cancel.focus();
      }
    }
  });
  dialog.showModal();
  name.focus();
}
