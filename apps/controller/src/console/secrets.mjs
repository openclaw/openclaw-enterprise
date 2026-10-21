import { button, dismissOnBackdrop, element, field, statusBlock, validateFields } from "./dom.mjs";
import { namespaceNameProblem } from "./namespaces.mjs";
import { sorted } from "./shell.mjs";

const REPLACEMENT_NOTICE =
  "Replacing a value keeps the Secret ID and bindings. Deploy consuming Agents again to deliver it. CredentialSources keep a separate copy and require an explicit source update. Existing values cannot be read back.";

export function renderSecrets(context) {
  const path = `/namespaces/${encodeURIComponent(context.namespaceId)}/secrets`;
  const exactPath = (id) => `${path}/${encodeURIComponent(id)}`;
  let items = context.items;
  let modal = null;
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
    element(
      "p",
      { className: "muted" },
      "Manage credentials shared within this Namespace. Secret values are never returned.",
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
    element(
      "div",
      { className: "secrets-toolbar" },
      element("div", { className: "field" }, search),
      create,
    ),
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
    const shown = sorted(items).filter((item) =>
      `${item.name} ${item.id}`.toLocaleLowerCase().includes(query),
    );
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
        "ul",
        { className: "collection secret-rows", "aria-label": "Secrets" },
        ...shown.map((item) =>
          element(
            "li",
            { className: "resource-linked secret-row" },
            element(
              "div",
              {},
              button(item.name, () => void openDetail(item), { tone: "link" }),
              element("p", { className: "resource-id" }, item.id),
            ),
            element("span", { className: "muted" }, "Value hidden"),
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
    current.dialog.querySelectorAll("input, textarea").forEach((input) => {
      input.value = "";
    });
    current.dialog.close();
    current.dialog.remove();
  }

  function openModal(title) {
    closeModal();
    const dialog = element("dialog", {
      className: "dialog secret-dialog",
      "aria-labelledby": "secret-dialog-title",
    });
    const heading = element("h2", { id: "secret-dialog-title", tabindex: "-1" }, title);
    const body = element("div");
    const notice = element("div");
    const close = button("Close", closeModal);
    const actions = element("div", { className: "dialog-actions" }, close);
    const current = { dialog, body, heading, feedback: notice, close, actions, pending: false };
    modal = current;
    dialog.append(heading, body, notice, actions);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeModal();
    });
    dismissOnBackdrop(dialog);
    dialog.addEventListener(
      "close",
      () => {
        // Native close and view teardown also erase entered material, including a retained view.
        dialog.querySelectorAll("input, textarea").forEach((input) => {
          input.value = "";
        });
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

  function isOpen(current) {
    return modal === current && current.dialog.open && context.isCurrent();
  }

  function showError(current, error, description) {
    if (error.status === 401) {
      context.onExpired();
      return;
    }
    current.feedback.replaceChildren(statusBlock("danger", null, description));
    if (error.requestId) {
      current.feedback.append(
        element("p", { className: "request-id" }, `Request ID: ${error.requestId}`),
      );
    }
  }

  async function refreshList() {
    const next = await context.request(path);
    if (context.isCurrent()) {
      items = next;
      renderList();
    }
  }

  async function openDetail(item) {
    const current = openModal(item.name);
    const version = ++readVersion;
    current.body.append(statusBlock("info", null, "Reading Secret metadata and consumers…"));
    try {
      const detail = await context.request(exactPath(item.id));
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
      renderDetail(current, detail);
    } catch (error) {
      if (!isOpen(current) || version !== readVersion) {
        return;
      }
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

  function renderDetail(current, detail) {
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
    ];
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
          "info",
          null,
          "This consumer list is incomplete. More references exist than this response can show.",
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

  function editValue(secret = null) {
    const replacing = secret !== null;
    const current = openModal(replacing ? "Replace Secret value" : "Create Secret");
    const name = element("input", {
      id: "secret-name",
      required: true,
      autocomplete: "off",
      "data-trim": "",
    });
    name.addEventListener("input", () => name.setCustomValidity(namespaceNameProblem(name.value)));
    // A textarea preserves multiline credential material. Browsers without masking support use
    // a native password field and explicitly refuse line-break pastes rather than changing them.
    const multiline = CSS.supports("-webkit-text-security", "disc");
    const value = element(multiline ? "textarea" : "input", {
      id: "secret-value",
      required: true,
      autocomplete: "off",
      spellcheck: "false",
      className: "secret-value secret-value--masked",
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
    if (!multiline) {
      value.addEventListener("paste", (event) => {
        if (/[\r\n]/.test(event.clipboardData.getData("text"))) {
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
        if (!multiline) {
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
      help: "Whitespace is preserved. The value cannot be read back.",
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
      replacing ? element("p", { className: "muted" }, REPLACEMENT_NOTICE) : null,
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
        } catch (error) {
          if (isOpen(current)) {
            showError(
              current,
              error,
              "The save succeeded, but the list could not be refreshed. Close and select Refresh to read the saved state.",
            );
          }
        }
      } catch (error) {
        if (!isOpen(current)) {
          return;
        }
        unknown = ![400, 403, 404, 409, 429].includes(error.status);
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
        showError(current, error, description);
        submit.disabled = unknown || [403, 404].includes(error.status);
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

  function confirmDelete(secret) {
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
      } catch (error) {
        if (!isOpen(current)) {
          return;
        }
        unknown = ![400, 403, 404, 409, 429].includes(error.status);
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
        showError(current, error, description);
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
          current.feedback.replaceChildren(
            statusBlock(
              "info",
              null,
              "The Secret still exists. Close and inspect its consumers before deciding to delete again.",
            ),
          );
          current.body.replaceChildren(element("p", {}, `${detail.name} · ${detail.id}`));
        }
      } catch (error) {
        if (!isOpen(current)) {
          return;
        }
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
