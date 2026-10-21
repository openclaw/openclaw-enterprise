import type { Namespace, SecretConsumers, SecretMetadata } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "./api-client.mjs";
import { button, dismissOnBackdrop, element, field, statusBlock, validateFields } from "./dom.mjs";
import { namespaceNameProblem, type NamespacePageContext } from "./namespaces.mjs";
import type { createNavigation } from "./navigation.mjs";

type SecretSummary = Pick<SecretMetadata, "id" | "name">;
type SecretDetail = SecretSummary & { consumers: SecretConsumers };

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

const REPLACEMENT_NOTICE =
  "Replacing a value keeps the Secret ID and bindings. Deploy consuming Agents again to deliver it. CredentialSources keep a separate copy and require an explicit source update. Existing values cannot be read back.";

export function renderSecrets(
  context: NamespacePageContext & {
    namespaceId: string;
    namespace: Pick<Namespace, "name" | "status"> | undefined;
    items: unknown;
    sorted(items: readonly SecretSummary[]): SecretSummary[];
    pageUrl: ReturnType<typeof createNavigation>["pageUrl"];
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
  create.disabled = !ready;
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
    list,
  );
  search.addEventListener("input", renderList);
  context.setLeaveGuard(() => {
    if (modal?.pending) {
      modal.feedback.replaceChildren(
        statusBlock("info", null, "Wait for the current request to finish before leaving."),
      );
      return true;
    }
    closeModal();
    return false;
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
          element("h2", {}, items.length ? "No matching Secrets" : "No Secrets yet"),
          element(
            "p",
            {},
            items.length
              ? "Try another name or ID."
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
      current.feedback.append(
        element("p", { className: "request-id" }, `Request ID: ${error.requestId}`),
      );
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
      const { consumers } = responseFields(detail);
      // Incomplete or unrecognized consumer metadata cannot establish that deletion is safe.
      if (!hasConsumerDetails(consumers)) {
        throw new Error("Invalid Secret detail");
      }
      renderDetail(current, { ...secret, consumers });
    } catch (cause) {
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
      const error = requestFailure(cause);
      current.body.replaceChildren();
      let description = "Could not read this Secret. Close and try again.";
      if (error.status === 403) {
        description = "You do not have permission to read this Secret.";
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
            const link = element(
              "a",
              { href: context.pageUrl(`agents/${id}`, context.namespaceId) },
              id,
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
            return element("li", { className: "resource-id" }, link);
          }),
        ),
      );
    }
    if (consumers.unreadable) {
      current.body.append(
        statusBlock(
          "info",
          null,
          `${consumers.unreadable} additional consumer(s) cannot be shown with your access. Ask an administrator to inspect them.`,
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
        {},
        referenced
          ? "Deletion is blocked while references remain. Remove them from their owning resources first."
          : "No current consumers were found. Deletion checks references again.",
      ),
    );
    const replace = button("Replace value", () => editValue(detail));
    replace.disabled = !ready;
    const remove = button("Delete Secret", () => confirmDelete(detail), { tone: "danger" });
    remove.disabled = referenced;
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
    // A textarea preserves multiline credential material. Browsers without masking support use
    // a native password field and explicitly refuse line-break pastes rather than changing them.
    const multiline = CSS.supports("-webkit-text-security", "disc");
    const valueNoticeId = "secret-value-notice";
    const value = element(multiline ? "textarea" : "input", {
      id: "secret-value",
      required: true,
      autocomplete: "off",
      spellcheck: "false",
      className: "secret-value secret-value--masked",
      "aria-describedby": valueNoticeId,
      "data-secret-value": "",
      ...(multiline ? { rows: "3" } : { type: "password" }),
    });
    value.addEventListener("input", () => {
      let problem = "";
      if (value.value.includes("\0") || /\p{Cs}/u.test(value.value)) {
        problem = "Use valid UTF-8 without NUL characters.";
      } else if (new TextEncoder().encode(value.value).length > 65536) {
        problem = "Use at most 65,536 UTF-8 bytes.";
      }
      value.setCustomValidity(problem);
    });
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
      { tone: "ghost", size: "sm", "aria-pressed": "false", "aria-controls": value.id },
    );
    const valueField = field({
      label: "Value",
      control: value,
      help: multiline ? "Spaces and line breaks are preserved." : "Enter a single-line value.",
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
    let unknown = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        current.pending ||
        unknown ||
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
        unknown = error.status === undefined || ![400, 403, 404, 409, 429].includes(error.status);
        value.value = "";
        let description = "The value was not saved. Check the input and enter it again.";
        if (unknown) {
          description = replacing
            ? "Outcome unknown. The value may have changed and cannot be read back. Close this dialog and verify credential use before deciding to submit a new replacement."
            : "Outcome unknown. The Secret may have been created. Close this dialog and Refresh the list before deciding to create another.";
        } else if (error.status === 403) {
          description =
            "Your access does not include this Secret operation. Ask an administrator for access.";
        } else if (error.status === 409) {
          description = replacing
            ? "This Secret cannot be replaced in its current state. Close and Refresh before trying again."
            : "The name may already be in use, or the Namespace is not ready. Check the list and choose a unique name.";
        } else if (error.status === 404) {
          description =
            "This Secret or Namespace is no longer available. Close and Refresh the list.";
        }
        showError(current, error, description, unknown ? "warning" : "danger");
        submit.disabled = unknown || error.status === 403 || error.status === 404;
        submit.textContent = replacing ? "Replace value" : "Create Secret";
        name.disabled = unknown;
        value.disabled = unknown;
        reveal.disabled = unknown;
        if (!unknown) {
          value.focus();
        }
      } finally {
        current.pending = false;
        current.close.disabled = false;
        if (isOpen(current) && document.activeElement === document.body) {
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
        let description = "Could not delete this Secret. Close and Refresh before trying again.";
        if (unknown) {
          description =
            "Outcome unknown. The Secret may have been deleted. Check its status before deciding to delete again.";
        } else if (error.status === 403) {
          description = "Your access does not include deleting this Secret.";
        } else if (error.status === 409) {
          description =
            "Deletion is blocked by current references or a lifecycle conflict. Close and reopen the Secret to inspect its current consumers.";
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
          showError(
            current,
            error,
            "Could not confirm deletion. Your access may have changed. Close and Refresh the list.",
          );
        }
      } finally {
        current.pending = false;
        current.close.disabled = false;
      }
    }
  }

  renderList();
}
