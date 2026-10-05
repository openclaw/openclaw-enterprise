import { element, dismissOnBackdrop } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

export function secretIdForBinding(binding) {
  return secretIdForSource(binding?.source);
}

export function secretIdForSource(source) {
  return source?.kind === "secret" &&
    typeof source.namespaceId === "string" &&
    typeof source.id === "string"
    ? source.id
    : null;
}

export function secretBinding(secret) {
  return {
    source: secret.ref,
    delivery: { type: "env" },
  };
}

export function sameNamespaceSecretHref(source, namespaceId) {
  const secretId = secretIdForSource(source);
  if (secretId === null || source?.namespaceId !== namespaceId) {
    return null;
  }
  return secretMetadataPath(namespaceId, secretId);
}

export function secretMetadataPath(namespaceId, secretId) {
  return `${namespacePath(namespaceId)}/secrets/${encodeURIComponent(secretId)}`;
}

export function isSecretMetadata(secret, namespaceId) {
  return (
    secret !== null &&
    typeof secret === "object" &&
    !Array.isArray(secret) &&
    typeof secret.id === "string" &&
    typeof secret.name === "string" &&
    secret.namespaceId === namespaceId &&
    secret.ref !== null &&
    typeof secret.ref === "object" &&
    !Array.isArray(secret.ref) &&
    secret.ref.kind === "secret" &&
    secret.ref.namespaceId === namespaceId &&
    secret.ref.id === secret.id
  );
}

// Resolve only the referenced resource: list permission is not required to read a binding.
export function renderSecretReference(context, source) {
  const node = element("span", { className: "secret-reference", role: "status" });
  if (source == null) {
    node.textContent = "No Secret bound";
    return node;
  }
  const href = sameNamespaceSecretHref(source, context.namespaceId);
  if (!href) {
    node.textContent = "Bound Secret · reference unavailable in this Namespace";
    return node;
  }
  const bound = `Bound Secret · ${source.id}`;
  node.textContent = `${bound} · Loading metadata…`;
  if (typeof context.request !== "function") {
    node.textContent = `${bound} · Metadata unavailable`;
    return node;
  }
  context
    .request(href)
    .then((secret) => {
      if (context.isCurrent && !context.isCurrent()) {
        return;
      }
      if (!isSecretMetadata(secret, context.namespaceId) || secret.id !== source.id) {
        node.textContent = `${bound} · Metadata unavailable`;
        return;
      }
      node.replaceChildren(
        element(
          "a",
          {
            href,
            target: "_blank",
            rel: "noopener",
            title: "View Secret metadata (opens in new tab)",
          },
          secretOptionLabel(secret),
        ),
      );
    })
    .catch((error) => {
      if (context.isCurrent && !context.isCurrent()) {
        return;
      }
      node.textContent = `${bound} · Metadata unavailable${error.status === 403 ? " (access denied)" : ""}`;
      if (error.status === 401) {
        context.onExpired?.();
      }
    });
  return node;
}

function credentialLink(href, label) {
  return element("a", { href, target: "_blank", rel: "noopener" }, `${label} (opens in new tab)`);
}

function secretOptionLabel(secret) {
  return secret.name;
}

function credentialMutationError(error) {
  if (error.status === 400) {
    return "Check the Secret fields and try again.";
  }
  if (error.status === 403) {
    return "Access denied. You do not have permission to manage this Secret binding.";
  }
  if (error.status === 404) {
    return "The selected Secret metadata is unavailable.";
  }
  if (error.status === 409) {
    return "The Secret or Configuration changed. Refresh before trying again.";
  }
  if (error.status === 429) {
    return "Too many requests. Wait before trying again.";
  }
  return "Secret binding could not be confirmed. Refresh before trying again.";
}

export function createSecretReferenceField({
  context,
  id,
  label,
  getCurrentSource,
  onSecretSelected,
  createSecretName,
  createDialogTitle,
  createFixedKey,
  metadataLabel = `View ${label} Secret metadata`,
  noSecretLabel = "No Secret bound",
  // Callers whose form applies the binding with another control name it here.
  stagedHint = "Secret binding staged. Save changes to apply it.",
  fieldClassName = "form-field",
  selectClassName,
  disabled = false,
  required = false,
}) {
  const inputClassName = ["secret-typeahead-input", selectClassName].filter(Boolean).join(" ");
  const input = element("input", {
    id,
    type: "text",
    role: "combobox",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: noSecretLabel,
    ...(inputClassName ? { className: inputClassName } : {}),
    "aria-describedby": `${id}-status`,
    "aria-controls": `${id}-listbox`,
    "aria-expanded": "false",
    "aria-autocomplete": "list",
  });
  const listbox = element("div", {
    id: `${id}-listbox`,
    className: "secret-typeahead-listbox",
    role: "listbox",
    "aria-label": "Available Secrets",
    hidden: "",
  });
  const status = element("p", { id: `${id}-status`, className: "hint", role: "status" });
  const metadataLink = credentialLink("#", metadataLabel);
  const secrets = [];
  let loaded = false;
  let loading = false;
  let selectedSecret = null;
  // Set once a binding is staged, so a Secret list that arrives later keeps its hint.
  let staged = false;
  let manuallyDisabled = disabled;
  let requiredWhenEnabled = required;
  let listboxOpen = false;
  let activeOptionIndex = -1;
  let searchQuery = "";
  // Closing the create dialog returns focus to the input; that must not reopen the listbox.
  let suppressFocusOpen = false;

  function isCurrent() {
    return typeof context.isCurrent !== "function" || context.isCurrent();
  }

  function currentSecretId() {
    const source = getCurrentSource?.();
    return source?.namespaceId === context.namespaceId ? secretIdForSource(source) : null;
  }

  function updateMetadataLink() {
    const href = sameNamespaceSecretHref(getCurrentSource?.(), context.namespaceId);
    if (href === null) {
      metadataLink.hidden = true;
      metadataLink.removeAttribute("href");
      return;
    }
    metadataLink.hidden = false;
    metadataLink.href = href;
  }

  function currentSecretLabel() {
    const selectedSecretId = currentSecretId();
    const readableSelected = secrets.find((secret) => secret.id === selectedSecretId);
    if (selectedSecretId === null) {
      return "";
    }
    return readableSelected === undefined ? "Bound Secret" : secretOptionLabel(readableSelected);
  }

  function allSecretOptions() {
    const selectedSecretId = currentSecretId();
    const readableSelected = secrets.find((secret) => secret.id === selectedSecretId);
    const options = [];
    // Accessible names collapse whitespace, so compare synthetic labels the same way.
    const normalizeLabel = (label) => label.trim().replace(/\s+/g, " ");
    const usedLabels = new Set(secrets.map((secret) => normalizeLabel(secretOptionLabel(secret))));
    function syntheticLabel(label, qualifier) {
      let candidate = label;
      while (usedLabels.has(normalizeLabel(candidate))) {
        candidate += ` (${qualifier})`;
      }
      usedLabels.add(normalizeLabel(candidate));
      return candidate;
    }
    if (selectedSecretId === null) {
      options.push({
        kind: "none",
        label: syntheticLabel(noSecretLabel, "no binding"),
        searchText: noSecretLabel,
      });
    } else if (readableSelected === undefined) {
      options.push({
        kind: "current",
        label: syntheticLabel("Bound Secret", "current binding"),
        searchText: selectedSecretId,
      });
    }
    for (const secret of secrets) {
      options.push({
        kind: "secret",
        label: secretOptionLabel(secret),
        searchText: `${secret.name} ${secret.id}`,
        secret,
      });
    }
    options.push({
      kind: "create",
      label: syntheticLabel("Create new Secret...", "action"),
      searchText: "create new secret",
    });
    return options;
  }

  function filteredSecretOptions() {
    const query = searchQuery.trim().toLowerCase();
    return allSecretOptions().filter((option) => {
      return (
        option.kind === "create" || query === "" || option.searchText.toLowerCase().includes(query)
      );
    });
  }

  function setActiveOption(index) {
    activeOptionIndex = index;
    for (const [optionIndex, option] of [
      ...listbox.querySelectorAll("[role='option']"),
    ].entries()) {
      const active = optionIndex === activeOptionIndex;
      option.classList.toggle("secret-typeahead-active", active);
      if (active) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (activeOptionIndex < 0) {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function closeListbox({ restoreSelection = true } = {}) {
    listboxOpen = false;
    listbox.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActiveOption(-1);
    if (restoreSelection) {
      searchQuery = "";
      input.value = currentSecretLabel();
    }
  }

  function renderListbox() {
    const options = filteredSecretOptions();
    const selectedSecretId = currentSecretId();
    const hasReadableMatches = options.some((option) =>
      ["none", "current", "secret"].includes(option.kind),
    );
    const nodes = [
      ...(hasReadableMatches || input.value.trim() === ""
        ? []
        : [element("div", { className: "secret-typeahead-empty" }, "No matching Secrets.")]),
      ...options.map((option, index) => {
        const selected =
          (option.kind === "secret" && option.secret.id === selectedSecretId) ||
          (option.kind === "current" && selectedSecretId !== null);
        const node = element(
          "div",
          {
            id: `${id}-option-${index}`,
            role: "option",
            className: option.kind === "create" ? "secret-typeahead-create" : "",
            "aria-selected": selected ? "true" : "false",
          },
          option.label,
        );
        node.addEventListener("pointerdown", (event) => event.preventDefault());
        node.addEventListener("click", () => selectOption(option));
        return node;
      }),
    ];
    listbox.replaceChildren(...nodes);
    if (activeOptionIndex >= options.length) {
      activeOptionIndex = options.length - 1;
    }
    setActiveOption(activeOptionIndex);
  }

  function openListbox() {
    if (manuallyDisabled) {
      return;
    }
    listboxOpen = true;
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    renderListbox();
  }

  function setSecretOptions({ preserveSearch = false } = {}) {
    if (!preserveSearch || !listboxOpen) {
      searchQuery = "";
      input.value = currentSecretLabel();
    }
    if (listboxOpen) {
      renderListbox();
    }
    updateMetadataLink();
  }

  function updateValidity() {
    input.required = requiredWhenEnabled;
    input.disabled = manuallyDisabled;
    input.setCustomValidity(
      requiredWhenEnabled && !manuallyDisabled && currentSecretId() === null
        ? `${label} is required.`
        : "",
    );
    if (manuallyDisabled) {
      closeListbox({ restoreSelection: true });
    }
  }

  async function bindSecret(secret) {
    if (secret.id === currentSecretId()) {
      return;
    }
    input.disabled = true;
    closeListbox({ restoreSelection: false });
    status.className = "hint";
    selectedSecret = secret;
    try {
      await onSecretSelected(secret);
      if (!secrets.some((item) => item.id === secret.id)) {
        secrets.push(secret);
      }
      setSecretOptions();
      staged = true;
      status.textContent = stagedHint;
    } finally {
      updateValidity();
    }
  }

  // Typing a Secret's exact name selects it, as clicking its suggestion would; names are
  // unique in a Namespace. Anything else still restores the current binding.
  function typedSecret() {
    const query = searchQuery.trim();
    return query === "" ? undefined : secrets.find((secret) => secret.name === query);
  }

  function selectOption(option) {
    if (option.kind === "create") {
      closeListbox({ restoreSelection: true });
      openCreateSecretDialog();
      return;
    }
    if (option.kind === "secret") {
      closeListbox({ restoreSelection: true });
      void bindSecret(option.secret);
      return;
    }
    closeListbox({ restoreSelection: true });
    updateValidity();
  }

  function openCreateSecretDialog() {
    const dialog = element("dialog", {
      className: "channel-dialog credential-secret-dialog",
      "aria-label": createDialogTitle ?? `Create ${label} Secret`,
    });
    const name = element("input", {
      id: `create-${id}-name`,
      type: "text",
      required: "",
      autocomplete: "off",
      value: createSecretName(),
    });
    const value = element("input", {
      id: `create-${id}-value`,
      type: "password",
      required: "",
      autocomplete: "off",
    });
    const feedback = element("p", { className: "error", role: "alert" });
    const cancel = element("button", { type: "button" }, "Cancel");
    const submit = element("button", { type: "submit", className: "primary" }, "Create Secret");
    let creating = false;
    let outcomeUnknown = false;
    const fixedKey = createFixedKey
      ? element("input", {
          id: `create-${id}-key`,
          value: createFixedKey.value,
          readonly: "",
        })
      : null;
    const form = element(
      "form",
      { method: "dialog", className: "channel-drawer-form" },
      element(
        "div",
        { className: "channel-drawer-head" },
        element("h2", {}, createDialogTitle ?? `Create ${label} Secret`),
        element("button", { type: "button" }, "Close"),
      ),
      fixedKey
        ? element(
            "div",
            { className: "form-field" },
            element("label", { for: fixedKey.id }, createFixedKey.label),
            fixedKey,
            element("p", { className: "hint" }, createFixedKey.hint),
          )
        : null,
      element(
        "div",
        { className: "form-field" },
        element("label", { for: name.id }, "Name"),
        name,
        element("p", { className: "hint" }, "Unique within this Namespace."),
      ),
      element(
        "div",
        { className: "form-field" },
        element("label", { for: value.id }, "Value"),
        value,
        element(
          "p",
          { className: "hint" },
          "Stored as a Namespace Secret. The value is never read back.",
        ),
      ),
      feedback,
      element("div", { className: "form-actions" }, cancel, submit),
    );
    const dismiss = () => {
      suppressFocusOpen = true;
      dialog.close();
      dialog.remove();
      setTimeout(() => {
        suppressFocusOpen = false;
      }, 0);
    };
    const close = () => {
      if (creating) {
        return;
      }
      value.value = "";
      dismiss();
      input.value = currentSecretLabel();
    };
    form.querySelector(".channel-drawer-head button").addEventListener("click", close);
    cancel.addEventListener("click", close);
    name.addEventListener("input", () => name.setCustomValidity(""));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (creating || outcomeUnknown || !form.reportValidity()) {
        return;
      }
      const secretName = name.value.trim();
      if (!secretName) {
        name.setCustomValidity("Name is required.");
        form.reportValidity();
        return;
      }
      creating = true;
      submit.disabled = true;
      cancel.disabled = true;
      name.disabled = true;
      value.disabled = true;
      feedback.textContent = "";
      let createdSecret;
      try {
        createdSecret = await context.request(`${namespacePath(context.namespaceId)}/secrets`, {
          method: "POST",
          body: { name: secretName, value: value.value },
        });
        await bindSecret(createdSecret);
        if (currentSecretId() === createdSecret.id) {
          dismiss();
        } else {
          submit.disabled = false;
          cancel.disabled = false;
          name.disabled = false;
          value.disabled = false;
        }
      } catch (error) {
        outcomeUnknown =
          createdSecret !== undefined ||
          error.status === undefined ||
          ![400, 403, 404, 409, 429].includes(error.status);
        if (outcomeUnknown) {
          feedback.textContent =
            "Secret creation outcome could not be confirmed. Refresh before trying again.";
        } else if (error.status === 409 && error.code === "NAMESPACE_NOT_READY") {
          feedback.textContent =
            "This Namespace is not ready, so it cannot store Secrets yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings).";
        } else if (error.status === 409) {
          feedback.textContent =
            "Secret creation conflicted. A Secret with this name may already exist in this Namespace. Check the name and Namespace state before trying again.";
        } else {
          feedback.textContent = credentialMutationError(error);
        }
        submit.disabled = outcomeUnknown;
        cancel.disabled = false;
        name.disabled = outcomeUnknown;
        value.disabled = outcomeUnknown;
        if (error.status === 409 && error.code !== "NAMESPACE_NOT_READY") {
          name.focus();
        }
      } finally {
        creating = false;
        if (outcomeUnknown || createdSecret !== undefined) {
          value.value = "";
        }
      }
    });
    dialog.append(form);
    dismissOnBackdrop(dialog);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!creating) {
        close();
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    name.focus();
  }

  if (!context.namespaceId || typeof context.request !== "function") {
    setSecretOptions();
    status.textContent =
      currentSecretId() === null
        ? "No Secret is bound."
        : "Secret metadata is bound. Values are never shown.";
    manuallyDisabled = true;
    updateValidity();
  } else {
    setSecretOptions();
    status.textContent = "Loading available Secrets...";
    loading = true;
    context
      .request(`${namespacePath(context.namespaceId)}/secrets`)
      .then((items) => {
        if (!isCurrent()) {
          return;
        }
        const listed = Array.isArray(items)
          ? items.filter((item) => isSecretMetadata(item, context.namespaceId))
          : [];
        // A Secret created or chosen while this read was pending is newer than the list.
        const added = secrets.filter((secret) => !listed.some((item) => item.id === secret.id));
        secrets.splice(0, secrets.length, ...listed, ...added);
        loaded = true;
        loading = false;
        setSecretOptions({ preserveSearch: true });
        if (!staged) {
          status.className = "hint";
          status.textContent = secrets.length
            ? "Choose an existing Secret or create a new one."
            : "No readable Secrets yet. Create a new Secret to bind this field.";
        }
        updateValidity();
      })
      .catch((error) => {
        if (!isCurrent()) {
          return;
        }
        loading = false;
        status.className = "error";
        status.textContent =
          error.status === 401
            ? "Your session has expired."
            : `Secrets unavailable. ${message(error)}`;
        if (error.status === 401) {
          context.onExpired?.();
        }
      });
  }

  input.addEventListener("focus", () => {
    searchQuery = "";
    input.select();
    if (suppressFocusOpen) {
      suppressFocusOpen = false;
      return;
    }
    openListbox();
  });
  input.addEventListener("input", () => {
    searchQuery = input.value;
    activeOptionIndex = -1;
    openListbox();
    updateValidity();
  });
  input.addEventListener("keydown", (event) => {
    const options = filteredSecretOptions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!listboxOpen) {
        openListbox();
      }
      setActiveOption(options.length ? Math.min(activeOptionIndex + 1, options.length - 1) : -1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!listboxOpen) {
        openListbox();
      }
      setActiveOption(options.length ? Math.max(activeOptionIndex - 1, 0) : -1);
      return;
    }
    if (event.key === "Enter" && listboxOpen) {
      event.preventDefault();
      if (activeOptionIndex >= 0) {
        selectOption(options[activeOptionIndex]);
      } else if (typedSecret() !== undefined) {
        selectOption({ kind: "secret", secret: typedSecret() });
      }
      return;
    }
    if (event.key === "Escape" && listboxOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeListbox({ restoreSelection: true });
    }
  });
  input.addEventListener("blur", () => {
    const typed = listboxOpen && !manuallyDisabled ? typedSecret() : undefined;
    if (typed !== undefined) {
      selectOption({ kind: "secret", secret: typed });
      return;
    }
    closeListbox({ restoreSelection: true });
  });

  const field = element(
    "div",
    { className: fieldClassName },
    element("label", { for: input.id }, label),
    element("div", { className: "secret-typeahead" }, input, listbox),
    metadataLink,
    status,
  );
  updateMetadataLink();
  updateValidity();

  return {
    field,
    setDisabled(value) {
      manuallyDisabled = value;
      updateValidity();
    },
    setRequired(value) {
      requiredWhenEnabled = value;
      updateValidity();
    },
    refresh() {
      setSecretOptions();
      updateValidity();
    },
    get selectedSecret() {
      return selectedSecret;
    },
    get selectedSecretId() {
      return currentSecretId();
    },
    get loaded() {
      return loaded;
    },
    get loading() {
      return loading;
    },
  };
}
