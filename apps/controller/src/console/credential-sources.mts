import type { ConnectionTemplate, Namespace, OAuthClient } from "@openclaw-enterprise/contracts";
import { namedDenial, requestFailure, responseFields } from "./api-client.mjs";
import {
  readCredentialSourceMetadata,
  type CredentialSourceSummary,
} from "./credential-source-metadata.mjs";
import {
  button,
  dismissOnBackdrop,
  element,
  field,
  setUnavailable,
  statusBlock,
  validateFields,
} from "./dom.mjs";
import { createDeviceLogin, type DeviceLogin } from "./agents/device-login.mjs";
import {
  authorizeInNewTab,
  consentFailureMessage,
  scopeChoices,
  type ConsentStart,
  type OAuthTemplate,
  isOAuthTemplate,
} from "./credential-consent.mjs";
import { namespaceNameProblem, type NamespacePageContext } from "./namespaces.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import { credentialValueControl } from "./credential-value.mjs";
import { createCredentialSourceActions } from "./credential-source-actions.mjs";

type Context = NamespacePageContext &
  Pick<ConsolePageContext, "drafts"> & {
    namespaceId: string;
    namespace: Pick<Namespace, "name" | "status"> | undefined;
    items: unknown;
    onInventoryAccessRefused(cause: unknown): void;
  };

type UsableTemplate = ConnectionTemplate & {
  current: Extract<
    ConnectionTemplate["current"],
    { mode: "static_bearer" | "manual" | "mcp_discovery" }
  >;
};
type InventorySource =
  | CredentialSourceSummary
  | {
      id: string;
      name: string;
      type: string;
      state: "registering" | "ready" | "deleting";
      ownerCapability: "credential_proxy";
    };
const sourceTypeLabel = new Map<string, string>([
  ["static", "Static"],
  ["oauth2-refresh-token", "OAuth refresh token"],
  ["github-app-installation", "GitHub App installation"],
]);
const sourceStateLabel: Record<InventorySource["state"], string> = {
  registering: "Registering",
  ready: "Ready",
  deleting: "Deleting",
};
const CREATE_DENIED =
  "Creating a Credential Source needs Credential Source create in this Namespace. Ask an Installation administrator for access.";
const CONFLICT_RECOVERY = "source-create-conflict";
const DEVICE_LOGIN_RECOVERY = "source-device-login";

function sourceOrigin(source: InventorySource) {
  if ("ownerCapability" in source) {
    return "—";
  }
  if (source.modelPreset) {
    return source.modelPreset === "openai" ? "OpenAI API key" : "Codex PAT";
  }
  if (source.oauthConsentKind === "builtin_codex") {
    return "Codex OAuth";
  }
  if (source.connectionTemplateId) {
    return `Template: ${source.connectionTemplateId}`;
  }
  return source.type === "static" ? "Static credential" : "—";
}

function readInventorySource(value: unknown, namespaceId: string): InventorySource | null {
  const managed = readCredentialSourceMetadata(value, namespaceId);
  if (managed) {
    return managed;
  }
  const data = responseFields(value);
  const ref = responseFields(data.ref);
  if (
    data.ownerCapability !== "credential_proxy" ||
    typeof data.id !== "string" ||
    !data.id ||
    data.namespaceId !== namespaceId ||
    typeof data.name !== "string" ||
    !data.name ||
    typeof data.type !== "string" ||
    !data.type ||
    (data.state !== "registering" && data.state !== "ready" && data.state !== "deleting") ||
    ref.kind !== "credential_source" ||
    ref.id !== data.id ||
    ref.namespaceId !== namespaceId ||
    Object.keys(ref).length !== 3
  ) {
    return null;
  }
  return {
    id: data.id,
    name: data.name,
    type: data.type,
    state: data.state,
    ownerCapability: "credential_proxy",
  };
}

function sourceList(value: unknown, namespaceId: string) {
  if (!Array.isArray(value)) {
    throw new Error("Invalid Credential Source list");
  }
  const items: InventorySource[] = [];
  let unavailable = 0;
  for (const entry of value) {
    const summary = readInventorySource(entry, namespaceId);
    if (summary === null) {
      unavailable += 1;
    } else {
      items.push(summary);
    }
  }
  return { items, unavailable };
}

function usableTemplates(value: unknown, namespaceId: string): UsableTemplate[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid connection template list");
  }
  return value.flatMap((entry) => {
    const template = responseFields(entry);
    const current = responseFields(template.current);
    if (!["static_bearer", "manual", "mcp_discovery"].includes(String(current.mode))) {
      return [];
    }
    if (
      typeof template.id !== "string" ||
      !template.id ||
      typeof template.displayName !== "string" ||
      !template.displayName ||
      (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
    ) {
      throw new Error("Invalid connection template metadata");
    }
    return [entry as UsableTemplate];
  });
}

function createFailure(cause: unknown): string {
  const { status } = requestFailure(cause);
  if (status === 403) {
    return namedDenial(cause) ?? CREATE_DENIED;
  }
  if (status === 501) {
    return "The selected credential owner does not support this operation.";
  }
  if (status === 503) {
    return "A required dependency is unavailable and the request outcome is unknown. Close this dialog and select Refresh to check the Source inventory before submitting again.";
  }
  if (status === 429) {
    return "The request was rate limited. Try again later.";
  }
  if (status === 400 || status === 404) {
    return "The Source was refused. Check the name, value, and selected preset or Template.";
  }
  if (status === 409) {
    return "The request outcome is unknown. The credential owner may already hold the value. Close this dialog and select Refresh to check the Source inventory. If the Source is absent, ask an operator to check the credential owner before trying again.";
  }
  return "The request outcome is unknown. Close this dialog and select Refresh to check the Source inventory before submitting again.";
}

export function renderCredentialSources(context: Context) {
  const path = `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources`;
  const templatePath = `/namespaces/${encodeURIComponent(context.namespaceId)}/connection-templates`;
  const sources = sourceList(context.items, context.namespaceId);
  let dialog: HTMLDialogElement | null = null;
  let pending = false;
  let consentAttempt: AbortController | null = null;
  let device: ReturnType<typeof createDeviceLogin> | null = null;
  let deviceBusy = false;
  let deviceState = (context.drafts.get(DEVICE_LOGIN_RECOVERY) as DeviceLogin | undefined) ?? null;
  const captureDevice = () => deviceState ?? undefined;
  context.drafts.track(DEVICE_LOGIN_RECOVERY, captureDevice);
  let notice: HTMLElement | null = null;
  const list = element("div");
  const feedback = element("div", { role: "status", tabindex: "-1" });
  let deviceNotice: HTMLElement | null = null;
  function updateDeviceNotice() {
    deviceNotice?.remove();
    deviceNotice = null;
    if (!deviceState || deviceState.status === "ready") {
      return;
    }
    deviceNotice = statusBlock(
      "warning",
      "Codex sign-in pending",
      deviceState.status === "start_unconfirmed"
        ? "The sign-in start could not be confirmed. Ask an Installation administrator to investigate before starting another sign-in."
        : "Select Create Credential Source to resume or cancel the pending sign-in.",
    );
    feedback.append(deviceNotice);
  }
  const sourceActions = createCredentialSourceActions({
    context,
    onChanged: async (message) => {
      try {
        const inventory = sourceList(await context.request(path), context.namespaceId);
        sources.items = inventory.items;
        sources.unavailable = inventory.unavailable;
        renderList();
        feedback.replaceChildren(statusBlock("success", null, message));
        feedback.focus();
      } catch (cause) {
        const { status } = requestFailure(cause);
        if (status === 401) {
          context.onExpired();
        } else if (status === 400 || status === 403 || status === 404) {
          context.onInventoryAccessRefused(cause);
        } else {
          feedback.replaceChildren(
            statusBlock(
              "warning",
              null,
              `${message} The inventory could not be refreshed. Select Refresh to check it.`,
            ),
          );
        }
      }
    },
  });
  updateDeviceNotice();
  const conflictName = context.drafts.get(CONFLICT_RECOVERY);
  if (typeof conflictName === "string") {
    if (sources.items.some((source) => source.name === conflictName)) {
      context.drafts.forget(CONFLICT_RECOVERY);
    } else {
      feedback.append(
        statusBlock(
          "warning",
          "Check the credential owner before retrying",
          `The Source "${conflictName}" is not in your readable inventory. The credential owner may already hold its value. Ask an operator to check the owner before trying again.`,
        ),
      );
    }
  }
  const create = button("Create Credential Source", () => void openCreate(), { tone: "primary" });
  const toolbar = element("div", { className: "collection-toolbar" }, create);
  if (context.namespace?.status !== "ready") {
    notice = element(
      "p",
      { className: "muted", id: "sources-not-ready" },
      "Credential Sources can be created after this Namespace is ready.",
    );
    setUnavailable(create, true, notice);
  }
  context.view.replaceChildren(
    element(
      "p",
      { className: "hint" },
      "Credential values are private. Agent access and deployment are separate steps.",
    ),
    toolbar,
    ...(notice ? [notice] : []),
    feedback,
    list,
  );
  context.holdWhileWriting({
    writing: () => pending || deviceBusy || sourceActions.writing(),
    held: () => {
      feedback.replaceChildren(
        statusBlock("info", null, "Wait for the current request to finish before leaving."),
      );
    },
    released: () => {
      closeDialog();
      sourceActions.close();
    },
  });

  function renderList() {
    const rows = sources.items;
    const actions = new Map(
      rows.flatMap((source) => {
        if ("ownerCapability" in source) {
          return [];
        }
        const controls = sourceActions.forSource(source);
        return controls ? [[source.id, controls] as const] : [];
      }),
    );
    if (!rows.length) {
      list.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          element(
            "h2",
            {},
            sources.unavailable ? "Source metadata unavailable" : "No readable Credential Sources",
          ),
          element(
            "p",
            {},
            sources.unavailable
              ? "Returned Sources could not be shown because their public metadata was unsupported or incomplete."
              : "Credential Sources shared with you in this Namespace appear here.",
          ),
        ),
      );
    } else {
      list.replaceChildren(
        element(
          "section",
          { className: "resource-list oauth-catalog credential-source-catalog" },
          element(
            "h2",
            { className: "resource-list-header secret-list-heading" },
            "Credential Sources ",
            element("span", { className: "badge" }, String(rows.length)),
          ),
          element(
            "table",
            { className: "oauth-catalog-table", "aria-label": "Credential Sources" },
            element(
              "thead",
              {},
              element(
                "tr",
                {},
                ...[
                  "Name",
                  "Source ID",
                  "Type",
                  "Preset or Template",
                  "State",
                  ...(actions.size ? ["Actions"] : []),
                ].map((label) => element("th", { scope: "col" }, label)),
              ),
            ),
            element(
              "tbody",
              {},
              ...rows.map((source) =>
                element(
                  "tr",
                  {},
                  element("th", { scope: "row" }, source.name),
                  element(
                    "td",
                    { "data-label": "Source ID" },
                    element("code", { className: "resource-id" }, source.id),
                  ),
                  element(
                    "td",
                    { "data-label": "Type" },
                    sourceTypeLabel.get(source.type) ?? source.type,
                  ),
                  element("td", { "data-label": "Preset or Template" }, sourceOrigin(source)),
                  element(
                    "td",
                    {},
                    element("span", { className: "badge" }, sourceStateLabel[source.state]),
                  ),
                  ...(actions.size
                    ? [
                        element(
                          "td",
                          { "data-label": "Actions" },
                          ...(actions.get(source.id) ? [actions.get(source.id)!] : []),
                        ),
                      ]
                    : []),
                ),
              ),
            ),
          ),
        ),
      );
      if (sources.unavailable) {
        list.append(
          element(
            "p",
            { className: "muted", role: "status" },
            "Some returned Sources could not be shown because their public metadata was unsupported or incomplete.",
          ),
        );
      }
    }
  }

  function closeDialog() {
    if (consentAttempt) {
      consentAttempt.abort();
      return;
    }
    if (pending || deviceBusy || !dialog) {
      return;
    }
    deviceState = device?.capture() ?? deviceState;
    device?.setActive(false);
    dialog.close();
  }

  async function openCreate() {
    if (create.getAttribute("aria-disabled") === "true" || dialog) {
      return;
    }
    const current = element("dialog", {
      className: "dialog dialog--framed secret-dialog",
      "aria-labelledby": "source-dialog-title",
    });
    dialog = current;
    const heading = element(
      "h2",
      { id: "source-dialog-title", tabindex: "-1" },
      "Create Credential Source",
    );
    const body = element("div", { className: "dialog-body" });
    const cancel = button("Cancel", closeDialog);
    const actions = element("div", { className: "dialog-actions" }, cancel);
    current.append(
      element(
        "header",
        { className: "dialog-header" },
        element("p", {}, `${context.namespace?.name ?? context.namespaceId} / Credentials`),
        heading,
      ),
      body,
      actions,
    );
    current.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    dismissOnBackdrop(current);
    current.addEventListener(
      "close",
      () => {
        for (const input of current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        )) {
          input.value = "";
        }
        current.remove();
        if (dialog === current) {
          dialog = null;
        }
        if (context.isCurrent()) {
          create.focus();
        }
      },
      { once: true },
    );
    context.view.append(current);
    current.showModal();
    heading.focus();
    body.append(
      element("p", { role: "status" }, "Checking Source creation access and available templates…"),
    );
    try {
      const templates = usableTemplates(await context.request(templatePath), context.namespaceId);
      if (dialog !== current || !current.open || !context.isCurrent()) {
        return;
      }
      renderForm(current, heading, body, actions, cancel, templates);
    } catch (cause) {
      if (dialog !== current || !current.open || !context.isCurrent()) {
        return;
      }
      const failure = requestFailure(cause);
      if (failure.status === 401) {
        context.onExpired();
        return;
      }
      if (failure.status !== 403) {
        renderForm(current, heading, body, actions, cancel, [], true);
        return;
      }
      body.replaceChildren(
        statusBlock("danger", "Source creation unavailable", createFailure(cause)),
      );
      const denial = element(
        "p",
        { className: "muted", role: "status", id: "source-create-denied" },
        createFailure(cause),
      );
      toolbar.after(denial);
      setUnavailable(create, true, denial);
    }
  }

  async function refreshCreated(sourceId: string, description: string) {
    let listed = false;
    let refreshed = false;
    try {
      const inventory = sourceList(await context.request(path), context.namespaceId);
      sources.items = inventory.items;
      sources.unavailable = inventory.unavailable;
      listed = inventory.items.some((item) => item.id === sourceId);
      refreshed = true;
      renderList();
    } catch (cause) {
      const { status } = requestFailure(cause);
      if (status === 401) {
        context.onExpired();
        return;
      }
      if (status === 400 || status === 403 || status === 404) {
        context.onInventoryAccessRefused(cause);
        return;
      }
    }
    feedback.replaceChildren(statusBlock("success", "Credential Source created", description));
    if (!listed) {
      feedback.append(
        statusBlock(
          "warning",
          null,
          refreshed
            ? "The created Source is not in your readable inventory. Ask an administrator for exact Source read access before reusing it."
            : "The Source was created, but the readable inventory could not be refreshed. Select Refresh to check it.",
        ),
      );
    }
  }

  function renderForm(
    current: HTMLDialogElement,
    heading: HTMLHeadingElement,
    body: HTMLElement,
    actions: HTMLElement,
    cancel: HTMLButtonElement,
    templates: UsableTemplate[],
    templateDiscoveryFailed = false,
  ) {
    const choice = element(
      "select",
      { id: "credential-source-choice", required: true },
      element("option", { value: "" }, "Choose a preset or Template"),
      element(
        "optgroup",
        { label: "Built-in presets" },
        element("option", { value: "model:openai" }, "OpenAI API key"),
        element("option", { value: "model:codex-pat" }, "Codex PAT"),
        element("option", { value: "builtin:codex-oauth" }, "Codex OAuth"),
        element("option", { value: "plain" }, "Static credential"),
      ),
      ...(templates.length
        ? [
            element(
              "optgroup",
              { label: "Connection Templates" },
              ...templates.map((template) =>
                element("option", { value: `template:${template.id}` }, template.displayName),
              ),
            ),
          ]
        : []),
    );
    const name = element("input", {
      id: "credential-source-name",
      required: true,
      autocomplete: "off",
      "data-trim": "",
    });
    name.addEventListener("input", () => name.setCustomValidity(namespaceNameProblem(name.value)));
    const { value, reveal, multiline, reset } = credentialValueControl("credential-source-value");
    const valueField = field({
      label: "Credential value",
      control: value,
      className: "secret-value-field",
      help: multiline ? "Spaces kept; line breaks normalized." : "Enter a single-line value.",
    });
    value.before(reveal);
    const staticFields = element(
      "div",
      { className: "stack" },
      field({ label: "Source name", control: name }),
      valueField,
      element("p", { className: "hint" }, "The value is write-only and cannot be read back."),
    );
    const details = element("div", { className: "stack" });
    const result = element("div", { role: "status" });
    const form = element(
      "form",
      { id: "credential-source-form", novalidate: "" },
      field({ label: "Preset or Connection Template", control: choice }),
      details,
    );
    const submit = element(
      "button",
      { type: "submit", form: form.id, className: "button button--primary" },
      "Create Source",
    );
    submit.hidden = true;
    actions.append(submit);
    body.replaceChildren(
      ...(templateDiscoveryFailed
        ? [
            statusBlock(
              "warning",
              "Templates unavailable",
              "Unable to discover Templates. You can still try a built-in preset; the API checks authorization and support.",
              [],
              { role: null },
            ),
          ]
        : []),
      form,
      result,
    );
    if (document.activeElement === heading) {
      choice.focus();
    }
    let client: HTMLSelectElement | null = null;
    let selectedScopes: string[] | null | undefined;
    let selectionNumber = 0;
    let submissionBlocked = false;
    const selectedTemplate = () =>
      templates.find((template) => `template:${template.id}` === choice.value);
    const updateSubmit = () => {
      const template = selectedTemplate();
      submit.disabled =
        pending ||
        submissionBlocked ||
        (template && isOAuthTemplate(template) ? !client?.value || selectedScopes === null : false);
    };
    function renderCodexLogin() {
      const hint =
        "This sign-in needs Agent create and Credential Source create in this Namespace.";
      const control = createDeviceLogin({
        context,
        initial: deviceState,
        hint,
        onStateChange(login, busy) {
          deviceState = login;
          updateDeviceNotice();
          deviceBusy = busy;
          choice.disabled = busy || (login !== null && login.status !== "start_unconfirmed");
          cancel.disabled = busy;
          context.drafts.record(DEVICE_LOGIN_RECOVERY, captureDevice);
        },
        onChange(source) {
          if (source && !pending) {
            pending = true;
            void refreshCreated(
              source.id,
              "Codex OAuth sign-in completed. Agent access and deployment are separate steps.",
            ).finally(() => {
              pending = false;
              control.setActive(false);
              if (device === control) {
                device = null;
              }
              deviceState = null;
              context.drafts.record(DEVICE_LOGIN_RECOVERY, captureDevice);
              closeDialog();
            });
          }
        },
      });
      device = control;
      details.append(device.section);
    }

    async function renderOAuthTemplate(template: OAuthTemplate, number: number) {
      submit.textContent = "Continue to sign in";
      submit.disabled = true;
      if (!template.current.issuerVerification) {
        details.append(
          element(
            "p",
            { role: "status" },
            "This Template is not verified. Ask an administrator to verify it before signing in.",
          ),
        );
        return;
      }
      const clientArea = element("div");
      const scopes = scopeChoices(template, (selection) => {
        selectedScopes = selection;
        updateSubmit();
      });
      details.append(clientArea, scopes);
      clientArea.append(element("p", { role: "status" }, "Loading compatible Credential Clients…"));
      try {
        const answer = await context.request(
          `/namespaces/${encodeURIComponent(context.namespaceId)}/connections/oauth-clients?connectionTemplateId=${encodeURIComponent(template.id)}`,
        );
        if (number !== selectionNumber || !current.open || !context.isCurrent()) {
          return;
        }
        if (
          !Array.isArray(answer) ||
          !answer.every(
            (entry) =>
              typeof responseFields(entry).id === "string" &&
              typeof responseFields(entry).displayName === "string",
          )
        ) {
          throw new Error("Invalid Credential Client list");
        }
        const clients = answer as OAuthClient[];
        if (!clients.length) {
          clientArea.replaceChildren(
            element(
              "p",
              { role: "status" },
              "No compatible Credential Client is available. Ask an administrator to register one for this Template’s issuer.",
            ),
          );
          return;
        }
        client = element(
          "select",
          { id: "credential-source-client", required: true },
          element("option", { value: "" }, "Choose a Credential Client"),
          ...clients.map((item) => element("option", { value: item.id }, item.displayName)),
        );
        client.addEventListener("change", updateSubmit);
        clientArea.replaceChildren(field({ label: "Credential Client", control: client }));
        updateSubmit();
      } catch (cause) {
        if (number !== selectionNumber || !current.open || !context.isCurrent()) {
          return;
        }
        if (requestFailure(cause).status === 401) {
          context.onExpired();
        } else {
          clientArea.replaceChildren(
            statusBlock(
              "danger",
              null,
              requestFailure(cause).status === 403
                ? createFailure(cause)
                : "Could not load compatible Credential Clients. Choose the Template again to retry.",
            ),
          );
        }
      }
    }

    async function selectionChanged() {
      const number = ++selectionNumber;
      reset();
      client = null;
      selectedScopes = undefined;
      device?.setActive(false);
      device = null;
      details.replaceChildren();
      result.replaceChildren();
      submit.hidden = !choice.value || choice.value === "builtin:codex-oauth";
      submit.textContent = "Create Source";
      const template = selectedTemplate();
      if (!choice.value) {
        return;
      }
      if (choice.value === "builtin:codex-oauth") {
        renderCodexLogin();
        return;
      }
      if (!template || template.current.mode === "static_bearer") {
        details.append(staticFields);
        if (template) {
          details.append(
            element(
              "p",
              { className: "hint" },
              "This Source uses the selected Connection Template.",
            ),
          );
        }
        updateSubmit();
        return;
      }
      if (!isOAuthTemplate(template)) {
        return;
      }
      await renderOAuthTemplate(template, number);
    }
    choice.addEventListener("change", () => void selectionChanged());
    if (deviceState) {
      choice.value = "builtin:codex-oauth";
      void selectionChanged();
    }
    async function startOAuthConsent(template: OAuthTemplate) {
      if (!client || !client.value || selectedScopes === null || !validateFields([client])) {
        return;
      }
      const active = new AbortController();
      consentAttempt = active;
      pending = true;
      choice.disabled = true;
      submit.disabled = true;
      result.replaceChildren(element("p", {}, "Opening sign-in…"));
      try {
        const response = await authorizeInNewTab(
          () =>
            context.request(`/namespaces/${encodeURIComponent(context.namespaceId)}/connections`, {
              method: "POST",
              signal: active.signal,
              body: {
                connectionTemplateId: template.id,
                oauthClientId: client!.value,
                ...(selectedScopes === undefined ? {} : { selectedScopes }),
              },
            }) as Promise<ConsentStart>,
          active.signal,
          () =>
            result.replaceChildren(
              element(
                "p",
                {},
                "Finish sign-in in the new tab. A Source is created only after the callback succeeds.",
              ),
            ),
        );
        if (active.signal.aborted || !context.isCurrent()) {
          return;
        }
        if (response.outcome === "failed") {
          result.replaceChildren(
            statusBlock(
              "danger",
              "Sign-in did not finish",
              consentFailureMessage(response.reason) ?? "Try signing in again.",
            ),
          );
        } else {
          await refreshCreated(
            response.sourceId,
            "Sign-in completed and the Credential Source was created.",
          );
          consentAttempt = null;
          pending = false;
          closeDialog();
        }
      } catch (cause) {
        if (!active.signal.aborted && context.isCurrent()) {
          const failure = requestFailure(cause);
          if (failure.status === 401) {
            context.onExpired();
          } else {
            result.replaceChildren(
              statusBlock(
                "danger",
                "Sign-in did not finish",
                failure.status === 403
                  ? createFailure(cause)
                  : (failure.serverMessage ??
                      (cause instanceof Error
                        ? cause.message
                        : "Could not start or finish sign-in.")),
              ),
            );
          }
        }
      } finally {
        consentAttempt = null;
        pending = false;
        choice.disabled = false;
        updateSubmit();
        if (active.signal.aborted) {
          closeDialog();
        }
      }
    }

    async function createStaticSource(template: UsableTemplate | undefined) {
      const preset =
        choice.value === "model:openai"
          ? "openai"
          : choice.value === "model:codex-pat"
            ? "codex-pat"
            : undefined;
      const templateId = template?.current.mode === "static_bearer" ? template.id : undefined;
      if ((!preset && !templateId && choice.value !== "plain") || !validateFields([name, value])) {
        return;
      }
      const sourceName = name.value.trim();
      pending = true;
      cancel.disabled = true;
      submit.disabled = true;
      name.disabled = true;
      choice.disabled = true;
      value.disabled = true;
      reveal.disabled = true;
      result.replaceChildren(element("p", {}, "Creating Source…"));
      let created = false;
      try {
        const request = context.request(path, {
          method: "POST",
          expectedStatus: 201,
          body: {
            name: sourceName,
            type: "static",
            ...(preset
              ? { config: { provider_preset: preset } }
              : templateId
                ? { connectionTemplateId: templateId }
                : {}),
            secret: value.value,
          },
        });
        value.value = "";
        const response = await request;
        const source = readCredentialSourceMetadata(response, context.namespaceId);
        const returnedPreset = responseFields(responseFields(response).config).provider_preset;
        if (
          !source ||
          source.name !== sourceName ||
          source.type !== "static" ||
          source.state !== "ready" ||
          source.modelPreset !== preset ||
          returnedPreset !== preset ||
          source.connectionTemplateId !== templateId
        ) {
          throw new Error("Unconfirmed Credential Source creation");
        }
        created = true;
        await refreshCreated(
          source.id,
          `${source.name} is ready. Agent access and deployment are separate steps.`,
        );
      } catch (cause) {
        value.value = "";
        const failure = requestFailure(cause);
        if (failure.status === 401) {
          context.onExpired();
        } else if (current.open && context.isCurrent()) {
          result.replaceChildren(
            statusBlock("danger", "Source not confirmed", createFailure(cause)),
          );
          const outcomeUnknown = ![400, 403, 404, 429, 501].includes(failure.status ?? 0);
          const denied = failure.status === 403;
          submissionBlocked = outcomeUnknown || denied;
          if (failure.status === 409) {
            const capture = () => sourceName;
            context.drafts.track(CONFLICT_RECOVERY, capture);
            context.drafts.unsavedWhen(CONFLICT_RECOVERY, () => false);
            context.drafts.record(CONFLICT_RECOVERY, capture);
          }
          if (outcomeUnknown || denied) {
            const notice = element(
              "p",
              {
                className: "muted",
                role: "status",
                id: denied ? "source-create-denied" : "source-create-unknown",
              },
              denied
                ? createFailure(cause)
                : "Refresh Credential Sources to check the inventory before creating another Source.",
            );
            toolbar.after(notice);
            setUnavailable(create, true, notice);
          }
        }
      } finally {
        pending = false;
        cancel.disabled = false;
        name.disabled = false;
        choice.disabled = false;
        value.disabled = false;
        reveal.disabled = false;
        if (created) {
          closeDialog();
        } else {
          updateSubmit();
        }
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || submissionBlocked || dialog !== current || !validateFields([choice])) {
        return;
      }
      const template = selectedTemplate();
      if (template && isOAuthTemplate(template)) {
        await startOAuthConsent(template);
      } else {
        await createStaticSource(template);
      }
    });
  }

  renderList();
}
