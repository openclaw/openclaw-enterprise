import { element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

const CREATE_SECRET_VALUE = "__openclaw_create_secret__";

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
  return `${secret.name} · ${secret.id}`;
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
  fieldClassName = "form-field",
  selectClassName,
  disabled = false,
  required = false,
}) {
  const select = element("select", {
    id,
    ...(selectClassName ? { className: selectClassName } : {}),
    "aria-describedby": `${id}-status`,
  });
  const status = element("p", { id: `${id}-status`, className: "hint", role: "status" });
  const metadataLink = credentialLink("#", metadataLabel);
  const secrets = [];
  let loaded = false;
  let loading = false;
  let selectedSecret = null;
  let manuallyDisabled = disabled;
  let requiredWhenEnabled = required;

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

  function setSecretOptions() {
    const selectedSecretId = currentSecretId();
    const readableSelected = secrets.find((secret) => secret.id === selectedSecretId);
    const options = [];
    if (selectedSecretId === null) {
      options.push(element("option", { value: "", selected: "" }, noSecretLabel));
    } else if (readableSelected === undefined) {
      options.push(
        element(
          "option",
          { value: selectedSecretId, selected: "" },
          `Bound Secret · ${selectedSecretId}`,
        ),
      );
    }
    for (const secret of secrets) {
      options.push(
        element(
          "option",
          { value: secret.id, ...(secret.id === selectedSecretId ? { selected: "" } : {}) },
          secretOptionLabel(secret),
        ),
      );
    }
    options.push(element("option", { value: CREATE_SECRET_VALUE }, "Create new Secret..."));
    select.replaceChildren(...options);
    select.value = selectedSecretId ?? "";
    updateMetadataLink();
  }

  function updateValidity() {
    select.required = requiredWhenEnabled;
    select.disabled = manuallyDisabled;
    select.setCustomValidity(
      requiredWhenEnabled && !manuallyDisabled && currentSecretId() === null
        ? `${label} is required.`
        : "",
    );
  }

  async function bindSecret(secret) {
    if (secret.id === currentSecretId()) {
      return;
    }
    select.disabled = true;
    status.className = "hint";
    selectedSecret = secret;
    await onSecretSelected(secret);
    if (!secrets.some((item) => item.id === secret.id)) {
      secrets.push(secret);
    }
    setSecretOptions();
    status.textContent = "Secret binding staged. Save changes to apply it.";
    updateValidity();
  }

  function openCreateSecretDialog() {
    const dialog = element("dialog", {
      className: "channel-dialog credential-secret-dialog",
      "aria-label": createDialogTitle ?? `Create ${label} Secret`,
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
        element("label", { for: value.id }, "Secret value"),
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
    const close = () => {
      if (creating) {
        return;
      }
      value.value = "";
      dialog.close();
      dialog.remove();
      select.value = currentSecretId() ?? "";
    };
    form.querySelector(".channel-drawer-head button").addEventListener("click", close);
    cancel.addEventListener("click", close);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (creating || outcomeUnknown || !form.reportValidity()) {
        return;
      }
      creating = true;
      submit.disabled = true;
      cancel.disabled = true;
      value.disabled = true;
      feedback.textContent = "";
      let createdSecret;
      try {
        createdSecret = await context.request(`${namespacePath(context.namespaceId)}/secrets`, {
          method: "POST",
          body: { name: createSecretName(), value: value.value },
        });
        await bindSecret(createdSecret);
        if (currentSecretId() === createdSecret.id) {
          dialog.close();
          dialog.remove();
        } else {
          submit.disabled = false;
          cancel.disabled = false;
          value.disabled = false;
        }
      } catch (error) {
        outcomeUnknown =
          createdSecret !== undefined ||
          error.status === undefined ||
          ![400, 403, 404, 409, 429].includes(error.status);
        feedback.textContent = outcomeUnknown
          ? "Secret creation outcome could not be confirmed. Refresh before trying again."
          : credentialMutationError(error);
        submit.disabled = outcomeUnknown;
        cancel.disabled = false;
        value.disabled = outcomeUnknown;
      } finally {
        creating = false;
        value.value = "";
      }
    });
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!creating) {
        close();
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    value.focus();
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
        secrets.splice(
          0,
          secrets.length,
          ...(Array.isArray(items)
            ? items.filter((item) => isSecretMetadata(item, context.namespaceId))
            : []),
        );
        loaded = true;
        loading = false;
        setSecretOptions();
        status.className = "hint";
        status.textContent = secrets.length
          ? "Choose an existing Secret or create a new one."
          : "No readable Secrets yet. Create a new Secret to bind this field.";
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

  select.addEventListener("change", () => {
    if (select.value === CREATE_SECRET_VALUE) {
      select.value = currentSecretId() ?? "";
      openCreateSecretDialog();
      return;
    }
    const secret = secrets.find((item) => item.id === select.value);
    if (secret) {
      void bindSecret(secret);
    }
    updateValidity();
  });

  const field = element(
    "div",
    { className: fieldClassName },
    element("label", { for: select.id }, label),
    select,
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
