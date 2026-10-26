import type {
  Namespace,
  NamespaceCallerPermissionsResponse,
  SecretConsumers,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import {
  askAdministratorTo,
  SECRET_CREATE_DENIED,
  SECRET_DELETE_DENIED,
  SECRET_LINK_UNLISTED,
  SECRET_READ_DENIED,
  SECRET_UPDATE_DENIED,
} from "./agents/access-reasons.mjs";
import {
  describeFailure,
  explainedConflict,
  NAMESPACE_NOT_READY_MESSAGE,
  readFailureReason,
} from "./agents/list.mjs";
import { requestFailure, responseFields } from "./api-client.mjs";
import {
  button,
  dismissOnBackdrop,
  element,
  field,
  statusBlock,
  validateFields,
  requestIdLine,
} from "./dom.mjs";
import { namespaceNameProblem, type NamespacePageContext } from "./namespaces.mjs";
import type { createNavigation } from "./navigation.mjs";

type SecretSummary = Pick<SecretMetadata, "id" | "name">;
type SecretDetail = SecretSummary & {
  consumers: SecretConsumers;
  // The read's advisory answer; a missing field is unknown and keeps the action.
  callerPermissions: { update?: boolean; delete?: boolean };
  // Agent names by ID from the readable Agent list; null when that read failed.
  agentNames: ReadonlyMap<string, string> | null;
};

function callerPermissions(value: unknown) {
  const fields = responseFields(value);
  return {
    ...(typeof fields.update === "boolean" ? { update: fields.update } : {}),
    ...(typeof fields.delete === "boolean" ? { delete: fields.delete } : {}),
  };
}

function agentNames(value: unknown): ReadonlyMap<string, string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names = new Map<string, string>();
  for (const item of value) {
    const { id, name } = responseFields(item);
    if (typeof id === "string" && typeof name === "string" && name) {
      names.set(id, name);
    }
  }
  return names;
}

function secretSummary(value: unknown, expectedId?: string): SecretSummary {
  const { id, name } = responseFields(value);
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    (expectedId !== undefined && id !== expectedId)
  ) {
    throw new Error("Invalid Secret metadata");
  }
  return { id, name };
}

function secretList(value: unknown): SecretSummary[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid Secret list");
  }
  // Keep only the metadata the page uses. A Secret read never supplies an editable value.
  return value.map((item: unknown) => secretSummary(item));
}

function isIdList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === "string");
}

function hasConsumerDetails(value: unknown): value is SecretConsumers {
  const { agents, configurations, credentialSources, provisioningRequests, unreadable, truncated } =
    responseFields(value);
  return (
    isIdList(agents) &&
    isIdList(configurations) &&
    isIdList(credentialSources) &&
    isIdList(provisioningRequests) &&
    typeof unreadable === "number" &&
    Number.isSafeInteger(unreadable) &&
    unreadable >= 0 &&
    typeof truncated === "boolean"
  );
}

function clearSecretInputs(dialog: HTMLDialogElement) {
  for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  )) {
    input.value = "";
  }
}

// The API's Secret value rule (SecretValue in packages/contracts/src/api/common.ts): nonempty
// UTF-8 without NUL, at most 65,536 UTF-8 bytes. tests/conformance/console-namespace-name.test.mjs
// keeps the two equal.
export const SECRET_VALUE_MAX_BYTES = 65536;

/**
 * Why the API would refuse `value` as a Secret value, or "" when it would accept it. An empty
 * value is the required check's to report. The console sends the value as the browser reports
 * it: a textarea's line endings are normalized to LF.
 */
export function secretValueProblem(value: string) {
  if (value.includes("\0") || /\p{Cs}/u.test(value)) {
    return "Use valid UTF-8 without NUL characters.";
  }
  if (new TextEncoder().encode(value).length > SECRET_VALUE_MAX_BYTES) {
    return "Use at most 65,536 UTF-8 bytes.";
  }
  return "";
}

/**
 * A masked Secret value control and its Show value toggle, shared by the Secrets page and every
 * inline Create Secret dialog (finding 2339). Put `reveal` just before `value` in a
 * `.secret-value-field`. A textarea keeps multiline credential material, with CRLF as LF. Browsers
 * without masking support get a native password field that refuses a line-break paste rather
 * than dropping its line breaks. Each edit checks the value against the API's rule.
 */
export function secretValueControl(id: string, attributes: Record<string, string> = {}) {
  const multiline = CSS.supports("-webkit-text-security", "disc");
  const value = element(multiline ? "textarea" : "input", {
    id,
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    className: "secret-value secret-value--masked",
    "data-secret-value": "",
    ...attributes,
    ...(multiline ? { rows: "3" } : { type: "password" }),
  });
  value.addEventListener("input", () => value.setCustomValidity(secretValueProblem(value.value)));
  if (value instanceof HTMLInputElement) {
    value.addEventListener("paste", (event) => {
      if (/[\r\n]/.test(event.clipboardData?.getData("text") ?? "")) {
        event.preventDefault();
        value.setCustomValidity(
          "This browser cannot mask multiline values. Use a browser with multiline masking support.",
        );
        validateFields([value]);
      }
    });
  }
  const reveal = button(
    "Show value",
    () => {
      const masked = value.classList.toggle("secret-value--masked");
      if (value instanceof HTMLInputElement) {
        value.type = masked ? "password" : "text";
      }
      reveal.textContent = masked ? "Show value" : "Hide value";
      reveal.setAttribute("aria-pressed", String(!masked));
    },
    { tone: "ghost", size: "sm", "aria-pressed": "false", "aria-controls": id },
  );
  return { value, reveal, multiline };
}

const REPLACEMENT_NOTICE =
  "Replacing a value keeps the Secret ID and bindings. Deploy consuming Agents again to deliver it. CredentialSources keep a separate copy and require an explicit source update. Existing values cannot be read back.";

export function renderSecrets(
  context: NamespacePageContext & {
    namespaceId: string;
    namespace: Pick<Namespace, "name" | "status"> | undefined;
    items: unknown;
    sorted(items: readonly SecretSummary[]): SecretSummary[];
    pageUrl: ReturnType<typeof createNavigation>["pageUrl"];
    permissions?: Static<typeof NamespaceCallerPermissionsResponse>["data"] | null;
    // A listed Secret to open, from the `secret` parameter an Agent page's link sets.
    openSecretId?: string | null;
  },
) {
  const path = `/namespaces/${encodeURIComponent(context.namespaceId)}/secrets`;
  const exactPath = (id: string) => `${path}/${encodeURIComponent(id)}`;
  let items = secretList(context.items);
  type SecretModal = ReturnType<typeof openModal>;
  let modal: SecretModal | null = null;
  let readVersion = 0;
  const search = element("input", {
    type: "search",
    id: "secret-search",
    placeholder: "Search by name or ID",
    "aria-label": "Search Secrets",
  });
  const list = element("div");
  const create = button("Create Secret", () => editValue(), { tone: "primary" });
  const ready = context.namespace?.status === "ready";
  // The page paints with the caller's permission answer, so Create Secret is never offered and
  // then refused after the dialog is filled in (finding 2365). Gating only: the API still
  // authorizes creation, so an unknown answer keeps the control.
  const createDenied = context.permissions?.secrets?.create === false;
  create.disabled = !ready || createDenied;
  if (createDenied) {
    create.setAttribute("aria-describedby", "secrets-create-denied");
  }
  context.view.replaceChildren(
    statusBlock(
      "info",
      "Secret values stay private",
      "Manage credentials shared within this Namespace. Stored values cannot be read back.",
      [],
      { role: null },
    ),
    ...(!ready
      ? [
          statusBlock(
            "info",
            null,
            "Secrets can be created or replaced after this Namespace is ready.",
          ),
        ]
      : []),
    element("div", { className: "collection-toolbar" }, search, create),
    ...(createDenied
      ? [
          element(
            "p",
            { className: "muted", role: "status", id: "secrets-create-denied" },
            SECRET_CREATE_DENIED,
          ),
        ]
      : []),
    list,
  );
  search.addEventListener("input", renderList);
  context.holdWhileWriting({
    writing: () => Boolean(modal?.pending),
    held: () =>
      modal?.feedback.replaceChildren(
        statusBlock("info", null, "Wait for the current request to finish before leaving."),
      ),
    released: closeModal,
  });

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const shown = context
      .sorted(items)
      .filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(query));
    if (!shown.length) {
      list.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          // A reader without create sees only Secrets shared with them, not every Secret here.
          element(
            "h2",
            {},
            items.length
              ? "No matching Secrets"
              : createDenied
                ? "No Secrets are shared with you"
                : "No Secrets yet",
          ),
          element(
            "p",
            {},
            items.length
              ? "Try another name or ID."
              : createDenied
                ? "Secrets in this Namespace that are shared with you appear here."
                : "Create a Secret here, then select it when configuring an Agent.",
          ),
        ),
      );
      return;
    }
    list.replaceChildren(
      element(
        "section",
        { className: "resource-list" },
        element(
          "h2",
          { className: "resource-list-header secret-list-heading" },
          "Secret library ",
          element("span", { className: "badge" }, String(shown.length)),
        ),
        element(
          "ul",
          { className: "collection", "aria-label": "Secrets" },
          ...shown.map((item) =>
            element(
              "li",
              { className: "resource-linked secret-row" },
              element(
                "p",
                { className: "resource-name" },
                button(item.name, () => void openDetail(item), { tone: "link" }),
              ),
              element("span", { className: "resource-id" }, item.id),
            ),
          ),
        ),
      ),
    );
  }

  function closeModal() {
    if (!modal || modal.pending) {
      return;
    }
    const current = modal;
    modal = null;
    readVersion += 1;
    clearSecretInputs(current.dialog);
    current.dialog.close();
    current.dialog.remove();
  }

  function openModal(title: string) {
    closeModal();
    const dialog = element("dialog", {
      className: "dialog dialog--framed secret-dialog",
      "aria-labelledby": "secret-dialog-title",
    });
    const heading = element("h2", { id: "secret-dialog-title", tabindex: "-1" }, title);
    const body = element("div");
    const notice = element("div");
    const close = button("Close", closeModal);
    const actions = element("div", { className: "dialog-actions" }, close);
    const current = { dialog, body, heading, feedback: notice, close, actions, pending: false };
    modal = current;
    const header = element(
      "header",
      { className: "dialog-header" },
      element("p", {}, `${context.namespace?.name ?? context.namespaceId} / Secrets`),
      heading,
    );
    dialog.append(header, element("div", { className: "dialog-body" }, body, notice), actions);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeModal();
    });
    dismissOnBackdrop(dialog);
    dialog.addEventListener(
      "close",
      () => {
        // Native close and view teardown also erase entered material, including a retained view.
        clearSecretInputs(dialog);
        if (modal === current) {
          modal = null;
          readVersion += 1;
        }
        dialog.remove();
        if (context.isCurrent() && document.activeElement === document.body) {
          search.focus();
        }
      },
      { once: true },
    );
    context.view.append(dialog);
    dialog.showModal();
    heading.focus();
    return current;
  }

  function isOpen(current: SecretModal) {
    return modal === current && current.dialog.open && context.isCurrent();
  }

  function showError(
    current: SecretModal,
    error: ReturnType<typeof requestFailure>,
    description: string,
    tone: "danger" | "warning" = "danger",
  ) {
    if (error.status === 401) {
      context.onExpired();
      return;
    }
    current.feedback.replaceChildren(statusBlock(tone, null, description));
    if (error.requestId) {
      current.feedback.append(requestIdLine(error.requestId));
    }
  }

  async function refreshList() {
    const next = await context.request(path);
    if (context.isCurrent()) {
      items = secretList(next);
      renderList();
    }
  }

  async function openDetail(item: SecretSummary) {
    const current = openModal(item.name);
    const version = ++readVersion;
    current.body.append(statusBlock("info", null, "Reading Secret metadata and consumers…"));
    try {
      const detail = await context.request(exactPath(item.id));
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
      const secret = secretSummary(detail, item.id);
      const fields = responseFields(detail);
      const { consumers } = fields;
      // Incomplete or unrecognized consumer metadata cannot establish that deletion is safe.
      if (!hasConsumerDetails(consumers)) {
        throw new Error("Invalid Secret detail");
      }
      // Consumers name the Agents the caller may read; the readable Agent list gives their names,
      // and audits nothing it leaves out (finding D761). A failed list read keeps the IDs.
      const names = consumers.agents.length
        ? agentNames(
            await context
              .request(`/namespaces/${encodeURIComponent(context.namespaceId)}/agents`)
              .catch(() => null),
          )
        : new Map<string, string>();
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
      renderDetail(current, {
        ...secret,
        consumers,
        callerPermissions: callerPermissions(fields.callerPermissions),
        agentNames: names,
      });
    } catch (cause) {
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
      const error = requestFailure(cause);
      current.body.replaceChildren();
      let description = "Could not read this Secret. Close and try again.";
      if (error.status === 403) {
        description = SECRET_READ_DENIED;
      } else if (error.status === 404) {
        description =
          "This Secret is no longer available in this Namespace. Close and Refresh the list.";
      }
      showError(current, error, description);
    }
  }

  function renderDetail(current: SecretModal, detail: SecretDetail) {
    const consumers = detail.consumers;
    current.body.replaceChildren(
      element("p", { className: "resource-id" }, detail.id),
      element(
        "p",
        { className: "muted" },
        "The value is hidden and cannot be retrieved. The name cannot be changed.",
      ),
      element("h3", {}, "Consumers"),
    );
    const groups = [
      ["Agents", consumers.agents],
      ["Configurations", consumers.configurations],
      ["CredentialSources", consumers.credentialSources],
      ["Pending provisioning requests", consumers.provisioningRequests],
    ] as const;
    const count = groups.reduce((total, [, ids]) => total + ids.length, 0);
    for (const [label, ids] of groups) {
      if (!ids.length) {
        continue;
      }
      current.body.append(element("h4", {}, label));
      current.body.append(
        element(
          "ul",
          { className: "secret-consumers" },
          ...ids.map((id) => {
            if (label !== "Agents") {
              return element("li", { className: "resource-id" }, id);
            }
            const name = detail.agentNames?.get(id);
            if (detail.agentNames && name === undefined) {
              // The Secret read lists only Agents the caller may read; one the list leaves out
              // was deleted or changed access since.
              return element(
                "li",
                {},
                "An Agent you cannot read ",
                element("span", { className: "resource-id" }, id),
              );
            }
            const link = element(
              "a",
              { href: context.pageUrl(`agents/${id}`, context.namespaceId) },
              name ?? id,
            );
            link.addEventListener("click", (event) => {
              if (
                event.button ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              closeModal();
              context.navigate(`agents/${id}`, context.namespaceId);
            });
            return name === undefined
              ? element("li", { className: "resource-id" }, link)
              : element("li", {}, link, " ", element("span", { className: "resource-id" }, id));
          }),
        ),
      );
    }
    if (consumers.unreadable) {
      current.body.append(
        statusBlock(
          "info",
          null,
          `${consumers.unreadable} additional consumer(s) cannot be shown with your access. ${askAdministratorTo("inspect them")}`,
        ),
      );
    }
    if (consumers.truncated) {
      current.body.append(
        statusBlock(
          "warning",
          null,
          "This consumer list is incomplete. More references exist than this response can show.",
          [],
          { role: "status" },
        ),
      );
    }
    const referenced = count > 0 || consumers.unreadable > 0 || consumers.truncated;
    current.body.append(
      element(
        "p",
        referenced ? { id: "secret-delete-blocked" } : {},
        referenced
          ? "Deletion is blocked while references remain. Remove them from their owning resources first."
          : "No current consumers were found. Deletion checks references again.",
      ),
    );
    // The read's advisory answer disables what the API would refuse, with the reason, instead of
    // refusing a replacement after the value is typed (finding D761). Gating only: the API still
    // authorizes each write, and an unknown answer keeps the action.
    const replaceDenied = detail.callerPermissions.update === false;
    const deleteDenied = detail.callerPermissions.delete === false;
    if (replaceDenied) {
      current.body.append(
        element("p", { className: "muted", id: "secret-replace-denied" }, SECRET_UPDATE_DENIED),
      );
    }
    if (deleteDenied) {
      current.body.append(
        element("p", { className: "muted", id: "secret-delete-denied" }, SECRET_DELETE_DENIED),
      );
    }
    const replace = button("Replace value", () => editValue(detail));
    replace.disabled = !ready || replaceDenied;
    if (replaceDenied) {
      replace.setAttribute("aria-describedby", "secret-replace-denied");
    }
    const remove = button("Delete Secret", () => confirmDelete(detail), { tone: "danger" });
    remove.disabled = referenced || deleteDenied;
    const deleteReasons = [
      ...(referenced ? ["secret-delete-blocked"] : []),
      ...(deleteDenied ? ["secret-delete-denied"] : []),
    ];
    if (deleteReasons.length) {
      remove.setAttribute("aria-describedby", deleteReasons.join(" "));
    }
    current.actions.append(replace, remove);
  }

  function editValue(secret: SecretSummary | null = null) {
    const replacing = secret !== null;
    const current = openModal(replacing ? "Replace Secret value" : "Create Secret");
    const name = element("input", {
      id: "secret-name",
      required: true,
      placeholder: "e.g. model-api-key",
      autocomplete: "off",
      "data-trim": "",
    });
    name.addEventListener("input", () => name.setCustomValidity(namespaceNameProblem(name.value)));
    const valueNoticeId = "secret-value-notice";
    const { value, reveal, multiline } = secretValueControl("secret-value", {
      "aria-describedby": valueNoticeId,
    });
    const valueField = field({
      label: "Value",
      control: value,
      help: multiline ? "Spaces kept; line breaks normalized." : "Enter a single-line value.",
      className: "secret-value-field",
    });
    value.before(reveal);
    const form = element(
      "form",
      { id: "secret-value-form", novalidate: "" },
      replacing
        ? element("p", {}, `Secret: ${secret.name} · ${secret.id}`)
        : field({
            label: "Secret name",
            control: name,
            help: "Unique within this Namespace. Names cannot be changed.",
          }),
      valueField,
      statusBlock(
        "info",
        null,
        replacing
          ? REPLACEMENT_NOTICE
          : "You can replace this value later, but you cannot read it back.",
        [],
        { id: valueNoticeId, role: null },
      ),
    );
    const submit = element(
      "button",
      { type: "submit", form: form.id, className: "button button--primary" },
      replacing ? "Replace value" : "Create Secret",
    );
    current.body.append(form);
    current.actions.append(submit);
    (replacing ? value : name).focus();
    let canSubmit = true;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        current.pending ||
        !canSubmit ||
        !isOpen(current) ||
        !validateFields(replacing ? [value] : [name, value])
      ) {
        return;
      }
      current.pending = true;
      current.close.disabled = true;
      submit.disabled = true;
      name.disabled = true;
      value.disabled = true;
      reveal.disabled = true;
      submit.textContent = "Saving…";
      current.feedback.replaceChildren();
      try {
        await context.request(replacing ? exactPath(secret.id) : path, {
          method: replacing ? "PATCH" : "POST",
          body: replacing
            ? { value: value.value }
            : { name: name.value.trim(), value: value.value },
          expectedStatus: replacing ? 200 : 201,
        });
        if (!isOpen(current)) {
          return;
        }
        value.value = "";
        submit.remove();
        current.heading.textContent = replacing ? "Secret value replaced" : "Secret created";
        current.body.replaceChildren(
          statusBlock(
            "success",
            null,
            replacing
              ? REPLACEMENT_NOTICE
              : "The Secret is available to authorized Agent credential pickers in this Namespace.",
          ),
        );
        try {
          await refreshList();
        } catch (cause) {
          if (isOpen(current)) {
            showError(
              current,
              requestFailure(cause),
              "The save succeeded, but the list could not be refreshed. Close and select Refresh to read the saved state.",
            );
          }
        }
      } catch (cause) {
        if (!isOpen(current)) {
          return;
        }
        const error = requestFailure(cause);
        const { status, code } = error;
        // A name conflict can be corrected here; a changed Secret or Namespace needs a fresh read.
        const nameConflict = !replacing && status === 409 && code === "RESOURCE_CONFLICT";
        canSubmit = status === 400 || status === 429 || nameConflict;
        const unknown = !canSubmit && status !== 403 && status !== 404 && status !== 409;
        value.value = "";
        // A 400 shows the API's sentence naming the field to fix; a 429 says how long to wait.
        let description =
          status === 400 && error.serverMessage === undefined
            ? "The value was not saved. Check the input and enter it again."
            : `The value was not saved. ${describeFailure(cause, { mutation: true, form: true })} Enter the value again.`;
        if (unknown) {
          description = replacing
            ? "Outcome unknown. The value may have changed and cannot be read back. Close this dialog and verify credential use before deciding to submit a new replacement."
            : "Outcome unknown. The Secret may have been created. Close this dialog and Refresh the list before deciding to create another.";
        } else if (status === 403) {
          // Create is checked on the Namespace, which no Namespace Role grants; replace is Secret
          // update on this Secret.
          description = replacing ? SECRET_UPDATE_DENIED : SECRET_CREATE_DENIED;
        } else if (nameConflict) {
          // The API names the taken name's rule; the generic conflict keeps the hedge.
          const explained = explainedConflict(cause);
          description =
            explained === undefined
              ? "The name may already be in use. Check the list, choose a unique name, and enter the value again."
              : `The value was not saved. ${explained} Enter the value again.`;
        } else if (status === 409) {
          description =
            code === "NAMESPACE_NOT_READY"
              ? NAMESPACE_NOT_READY_MESSAGE
              : describeFailure(cause, {
                  mutation: true,
                  conflict: "The Secret cannot be saved in its current state.",
                  next: "Close and Refresh before trying again.",
                });
        } else if (status === 404) {
          description =
            "This Secret or Namespace is no longer available. Close and Refresh the list.";
        }
        showError(current, error, description, unknown ? "warning" : "danger");
        submit.disabled = !canSubmit;
        submit.textContent = replacing ? "Replace value" : "Create Secret";
        name.disabled = !canSubmit;
        value.disabled = !canSubmit;
        reveal.disabled = !canSubmit;
        if (canSubmit) {
          (nameConflict ? name : value).focus();
        }
      } finally {
        current.pending = false;
        current.close.disabled = false;
        if (isOpen(current) && (!canSubmit || document.activeElement === document.body)) {
          current.close.focus();
        }
      }
    });
  }

  function confirmDelete(secret: SecretSummary) {
    const current = openModal("Delete Secret");
    current.body.append(
      element(
        "p",
        {},
        `Permanently delete ${secret.name}? The stored value cannot be recovered. Deletion does not revoke the credential at its provider or erase values already delivered to workloads.`,
      ),
    );
    const confirm = button("Permanently delete Secret", () => void remove(), { tone: "danger" });
    current.actions.append(confirm);
    current.close.focus();
    let unknown = false;
    async function remove() {
      if (current.pending || unknown || !isOpen(current)) {
        return;
      }
      current.pending = true;
      confirm.disabled = true;
      current.close.disabled = true;
      confirm.textContent = "Deleting…";
      current.feedback.replaceChildren();
      try {
        await context.request(exactPath(secret.id), { method: "DELETE", expectedStatus: 204 });
        if (!isOpen(current)) {
          return;
        }
        items = items.filter((item) => item.id !== secret.id);
        renderList();
        confirm.remove();
        current.heading.textContent = "Secret deleted";
        current.body.replaceChildren(statusBlock("success", null, "The Secret was deleted."));
      } catch (cause) {
        if (!isOpen(current)) {
          return;
        }
        const error = requestFailure(cause);
        unknown = error.status === undefined || ![400, 403, 404, 409, 429].includes(error.status);
        let description = `Could not delete this Secret. ${describeFailure(cause, { mutation: true })}`;
        if (unknown) {
          description =
            "Outcome unknown. The Secret may have been deleted. Check its status before deciding to delete again.";
        } else if (error.status === 403) {
          description = SECRET_DELETE_DENIED;
        } else if (error.status === 409) {
          // The API names what still uses the Secret, or the change that raced this deletion.
          description = `Could not delete this Secret. ${describeFailure(cause, {
            mutation: true,
            conflict: "Deletion is blocked by current references or a lifecycle conflict.",
            next: "Close and reopen the Secret to inspect its current consumers.",
          })}`;
        } else if (error.status === 404) {
          description = "The Secret is no longer available. Close and Refresh the list.";
        }
        showError(current, error, description, unknown ? "warning" : "danger");
        confirm.textContent = "Permanently delete Secret";
        // A new confirmation starts with a fresh consumer read. This dialog never replays DELETE.
        confirm.disabled = true;
        if (unknown) {
          current.feedback.append(button("Check deletion status", () => void checkDeletion()));
        }
      } finally {
        current.pending = false;
        current.close.disabled = false;
        if (isOpen(current) && document.activeElement === document.body) {
          current.close.focus();
        }
      }
    }
    async function checkDeletion() {
      if (current.pending || !isOpen(current)) {
        return;
      }
      current.pending = true;
      current.close.disabled = true;
      confirm.remove();
      current.feedback.replaceChildren(statusBlock("info", null, "Checking Secret status…"));
      try {
        const detail = await context.request(exactPath(secret.id));
        if (isOpen(current)) {
          const { id, name } = secretSummary(detail, secret.id);
          current.feedback.replaceChildren(
            statusBlock(
              "info",
              null,
              "The Secret still exists. Close and inspect its consumers before deciding to delete again.",
            ),
          );
          current.body.replaceChildren(element("p", {}, `${name} · ${id}`));
        }
      } catch (cause) {
        if (!isOpen(current)) {
          return;
        }
        const error = requestFailure(cause);
        if (error.status === 404) {
          items = items.filter((item) => item.id !== secret.id);
          renderList();
          current.body.replaceChildren();
          current.feedback.replaceChildren(
            statusBlock(
              "info",
              null,
              "The Secret is no longer available. Refresh the list to check your current access.",
            ),
          );
        } else {
          // A refused or failed read says which, instead of guessing that access changed.
          showError(
            current,
            error,
            `Could not confirm deletion. ${
              error.status === 403 ? SECRET_READ_DENIED : readFailureReason(cause)
            }`,
          );
        }
      } finally {
        current.pending = false;
        current.close.disabled = false;
      }
    }
  }

  renderList();
  // An Agent page links a bound Secret here, with its metadata and consumers open (finding D757).
  // A Secret the list leaves out opens nothing, and says why without reading it: the caller may
  // not read it, or it does not exist (finding D761).
  const linked = items.find((item) => item.id === context.openSecretId);
  if (linked) {
    void openDetail(linked);
  } else if (context.openSecretId) {
    list.before(statusBlock("warning", null, SECRET_LINK_UNLISTED, [], { role: "status" }));
  }
}
