import type { Namespace } from "@openclaw-enterprise/contracts";
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
import { namespaceNameProblem, type NamespacePageContext } from "./namespaces.mjs";
import { secretValueControl } from "./secrets.mjs";

type Context = NamespacePageContext & {
  namespaceId: string;
  namespace: Pick<Namespace, "name" | "status"> | undefined;
  items: unknown;
};

type StaticTemplate = { id: string; displayName: string };
const sourceTypeLabel: Record<CredentialSourceSummary["type"], string> = {
  static: "Static",
  "oauth2-refresh-token": "OAuth refresh token",
  "github-app-installation": "GitHub App installation",
};
const CREATE_DENIED =
  "Creating a Credential Source needs Credential Source create in this Namespace. Ask an Installation administrator for access.";

function sourcePurpose(source: CredentialSourceSummary) {
  if (source.modelPreset) {
    return `Model preset: ${source.modelPreset}`;
  }
  if (source.connectionTemplateId) {
    return `Template: ${source.connectionTemplateId}`;
  }
  return "—";
}

function sourceList(value: unknown, namespaceId: string) {
  if (!Array.isArray(value)) {
    throw new Error("Invalid Credential Source list");
  }
  const items: CredentialSourceSummary[] = [];
  let unavailable = 0;
  for (const entry of value) {
    // Protected Proxy metadata is outside the managed Source workflow.
    if (Object.hasOwn(responseFields(entry), "ownerCapability")) {
      continue;
    }
    const summary = readCredentialSourceMetadata(entry, namespaceId);
    if (summary === null) {
      unavailable += 1;
    } else {
      items.push(summary);
    }
  }
  return { items, unavailable };
}

function staticTemplates(value: unknown, namespaceId: string): StaticTemplate[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid connection template list");
  }
  const result: StaticTemplate[] = [];
  for (const entry of value) {
    const template = responseFields(entry);
    const current = responseFields(template.current);
    if (current.mode !== "static_bearer") {
      continue;
    }
    if (
      typeof template.id !== "string" ||
      !template.id ||
      typeof template.displayName !== "string" ||
      !template.displayName ||
      (template.namespaceId !== undefined && template.namespaceId !== namespaceId)
    ) {
      throw new Error("Invalid static connection template metadata");
    }
    result.push({ id: template.id, displayName: template.displayName });
  }
  return result;
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
    return "The credential owner is unavailable and the request outcome is unknown. Close this dialog and select Refresh to check the Source inventory before submitting again.";
  }
  if (status === 429) {
    return "The request was rate limited. Try again later.";
  }
  if (status === 400 || status === 404) {
    return "The Source was refused. Check the name, value, and selected purpose.";
  }
  if (status === 409) {
    return "The Source could not be created in its current state. Check the name, Namespace, and selected purpose.";
  }
  return "The request outcome is unknown. Close this dialog and select Refresh to check the Source inventory before submitting again.";
}

export function renderCredentialSources(context: Context) {
  const path = `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources`;
  const templatePath = `/namespaces/${encodeURIComponent(context.namespaceId)}/connection-templates`;
  const sources = sourceList(context.items, context.namespaceId);
  let dialog: HTMLDialogElement | null = null;
  let pending = false;
  let notice: HTMLElement | null = null;
  const list = element("div");
  const feedback = element("div", { role: "status" });
  const create = button("Create Source", () => void openCreate(), { tone: "primary" });
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
    statusBlock(
      "info",
      "Credential values stay private",
      "Only readable Source metadata appears here. Creating a Source does not grant an Agent access or deploy it.",
      [],
      { role: null },
    ),
    toolbar,
    ...(notice ? [notice] : []),
    feedback,
    list,
  );
  context.holdWhileWriting({
    writing: () => pending,
    held: () => {
      feedback.replaceChildren(
        statusBlock("info", null, "Wait for the current request to finish before leaving."),
      );
    },
    released: closeDialog,
  });

  function renderList() {
    const rows = sources.items;
    if (!rows.length) {
      list.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          element(
            "h2",
            {},
            sources.unavailable
              ? "Source metadata unavailable"
              : "No readable managed Credential Sources",
          ),
          element(
            "p",
            {},
            sources.unavailable
              ? "Returned Sources could not be shown because their public metadata was unsupported or incomplete."
              : "Managed Credential Sources shared with you in this Namespace appear here.",
          ),
        ),
      );
    } else {
      list.replaceChildren(
        element(
          "section",
          { className: "resource-list oauth-catalog" },
          element(
            "h2",
            { className: "resource-list-header secret-list-heading" },
            "Source library ",
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
                ...["Name", "Source ID", "Type", "Purpose", "State"].map((label) =>
                  element("th", { scope: "col" }, label),
                ),
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
                  element("td", { "data-label": "Type" }, sourceTypeLabel[source.type]),
                  element("td", { "data-label": "Purpose" }, sourcePurpose(source)),
                  element(
                    "td",
                    {},
                    element(
                      "span",
                      { className: "badge" },
                      source.state === "ready" ? "Ready" : "Deleting",
                    ),
                  ),
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
    if (pending || !dialog) {
      return;
    }
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
        element("p", {}, `${context.namespace?.name ?? context.namespaceId} / Sources`),
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
      const templates = staticTemplates(await context.request(templatePath), context.namespaceId);
      if (dialog !== current || !current.open || !context.isCurrent()) {
        return;
      }
      renderForm(current, body, actions, cancel, templates);
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
        renderForm(current, body, actions, cancel, [], true);
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

  function renderForm(
    current: HTMLDialogElement,
    body: HTMLElement,
    actions: HTMLElement,
    cancel: HTMLButtonElement,
    templates: StaticTemplate[],
    templateDiscoveryFailed = false,
  ) {
    const name = element("input", {
      id: "credential-source-name",
      required: true,
      autocomplete: "off",
      "data-trim": "",
    });
    name.addEventListener("input", () => name.setCustomValidity(namespaceNameProblem(name.value)));
    const purpose = element(
      "select",
      { id: "credential-source-purpose", required: true },
      element("option", { value: "" }, "Choose a purpose"),
      element("option", { value: "model:openai" }, "OpenAI model credential"),
      element("option", { value: "model:codex-pat" }, "Codex PAT model credential"),
      ...templates.map((template) =>
        element(
          "option",
          { value: `template:${template.id}` },
          `Static Bearer · ${template.displayName}`,
        ),
      ),
    );
    const { value, reveal, multiline } = secretValueControl("credential-source-value");
    const valueField = field({
      label: "Credential value",
      control: value,
      className: "secret-value-field",
      help: multiline ? "Spaces kept; line breaks normalized." : "Enter a single-line value.",
    });
    value.before(reveal);
    const form = element(
      "form",
      { id: "credential-source-form", novalidate: "" },
      field({ label: "Source name", control: name }),
      field({
        label: "Credential purpose",
        control: purpose,
        help: "The selected owner checks support when you submit. Static Bearer templates are approved for this Namespace.",
      }),
      valueField,
      element(
        "p",
        { className: "muted" },
        "A static Bearer Template Source cannot be used for model authentication or admitted directly to an Agent.",
      ),
      element(
        "p",
        { className: "muted" },
        "The value is write-only and cannot be read back. Agent access and deployment are separate steps.",
      ),
    );
    const result = element("div", { role: "status" });
    const submit = element(
      "button",
      { type: "submit", form: form.id, className: "button button--primary" },
      "Create Source",
    );
    body.replaceChildren(
      ...(templateDiscoveryFailed
        ? [
            statusBlock(
              "warning",
              "Templates unavailable",
              "Unable to discover usable Templates. You can still attempt model Source creation; the Source API checks authorization and owner support when submitted.",
              [],
              { role: null },
            ),
          ]
        : []),
      form,
      result,
    );
    actions.append(submit);
    name.focus();
    let submissionBlocked = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        pending ||
        submissionBlocked ||
        dialog !== current ||
        !validateFields([name, purpose, value])
      ) {
        return;
      }
      const selection = purpose.value;
      const preset =
        selection === "model:openai"
          ? "openai"
          : selection === "model:codex-pat"
            ? "codex-pat"
            : undefined;
      const templateId = selection.startsWith("template:")
        ? selection.slice("template:".length)
        : undefined;
      if (!preset && (!templateId || !templates.some((template) => template.id === templateId))) {
        return;
      }
      const sourceName = name.value.trim();
      pending = true;
      cancel.disabled = true;
      submit.disabled = true;
      name.disabled = true;
      purpose.disabled = true;
      value.disabled = true;
      reveal.disabled = true;
      result.replaceChildren(element("p", {}, "Creating Source…"));
      let created = false;
      let outcomeUnknown = false;
      let denied = false;
      try {
        const request = context.request(path, {
          method: "POST",
          expectedStatus: 201,
          body: {
            name: sourceName,
            type: "static",
            ...(preset
              ? { config: { provider_preset: preset } }
              : { connectionTemplateId: templateId }),
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
        sources.items = [source, ...sources.items.filter((item) => item.id !== source.id)];
        renderList();
        feedback.replaceChildren(
          statusBlock(
            "success",
            "Credential Source created",
            templateId
              ? `${source.name} is ready. This Template Source cannot be used for model authentication or admitted directly to an Agent.`
              : `${source.name} is ready. Agent access and deployment are separate steps.`,
          ),
        );
      } catch (cause) {
        value.value = "";
        if (requestFailure(cause).status === 401) {
          context.onExpired();
        } else if (dialog === current && current.open && context.isCurrent()) {
          result.replaceChildren(
            statusBlock("danger", "Source not confirmed", createFailure(cause)),
          );
          outcomeUnknown = ![400, 403, 404, 409, 429, 501].includes(
            requestFailure(cause).status ?? 0,
          );
          denied = requestFailure(cause).status === 403;
          submissionBlocked = outcomeUnknown || denied;
          if (outcomeUnknown) {
            const checkInventory = element(
              "p",
              { className: "muted", role: "status", id: "source-create-unknown" },
              "Refresh Credential Sources to check the inventory before creating another Source.",
            );
            toolbar.after(checkInventory);
            setUnavailable(create, true, checkInventory);
          }
          if (denied) {
            const denial = element(
              "p",
              { className: "muted", role: "status", id: "source-create-denied" },
              createFailure(cause),
            );
            toolbar.after(denial);
            setUnavailable(create, true, denial);
          }
        }
      } finally {
        pending = false;
        cancel.disabled = false;
        name.disabled = false;
        purpose.disabled = false;
        value.disabled = false;
        reveal.disabled = false;
        if (created) {
          closeDialog();
        } else {
          submit.disabled = outcomeUnknown || denied;
        }
      }
    });
  }

  renderList();
}
