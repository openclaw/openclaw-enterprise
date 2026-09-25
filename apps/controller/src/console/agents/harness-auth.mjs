import { element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";
import { createSecretReferenceField } from "./secret-picker.mjs";

export function harnessAuthDescription(binding) {
  if (!binding) {
    return "None selected";
  }
  if (binding.method === "runtime") {
    return "Operator-managed credentials";
  }
  if (binding.method === "codex_pat") {
    return "Service Accounts · Secret configured";
  }
  return binding.method === "api_key"
    ? "API key · Secret configured"
    : `ChatGPT service account · ${binding.serviceAccountId}`;
}

export function createHarnessAuthFields(
  context,
  binding = null,
  executionMode = "embedded",
  options = {},
) {
  const method = element(
    "select",
    { id: "harness-auth-method" },
    element("option", { value: "" }, "None"),
    element("option", { value: "api_key" }, "API key"),
    executionMode === "dedicated"
      ? element("option", { value: "codex_pat" }, "Service Accounts")
      : null,
    element("option", { value: "runtime" }, "Operator-managed credentials"),
    element("option", { value: "chatgpt_service_account" }, "ChatGPT service account"),
  );
  method.value = binding?.method ?? "";
  const originalSecretSource =
    ["api_key", "codex_pat"].includes(binding?.method) && binding.source?.kind === "secret"
      ? binding.source
      : null;
  let selectedSecretSource = originalSecretSource;
  let changedSecret = null;
  const account = element(
    "select",
    { id: "service-account-id", disabled: true },
    element("option", { value: "" }, "Select an issued account"),
  );
  if (binding?.method === "chatgpt_service_account") {
    account.append(
      element("option", { value: binding.serviceAccountId }, binding.serviceAccountId),
    );
    account.value = binding.serviceAccountId;
  }
  const draft = options.draft;
  if (draft) {
    method.value = draft.method;
    selectedSecretSource = draft.secretSource ?? null;
    changedSecret = draft.changedSecret ?? null;
    if (draft.account && ![...account.options].some((option) => option.value === draft.account)) {
      account.append(element("option", { value: draft.account }, draft.account));
    }
    account.value = draft.account;
  }
  let previousMethod = method.value;
  let accountsLoaded = false;
  let disabled = false;
  const feedback = element("p", { className: "hint", role: "status" });
  const secretPicker = createSecretReferenceField({
    context,
    id: "harness-auth-secret",
    label: "API key Secret",
    getCurrentSource: () => selectedSecretSource,
    onSecretSelected(secret) {
      selectedSecretSource = secret.ref;
      changedSecret = secret;
    },
    createSecretName: () => {
      const agentName =
        typeof options.agentName === "string" && options.agentName.trim()
          ? options.agentName.trim()
          : "Agent";
      return `${agentName} harness authentication`;
    },
    createDialogTitle: "Create harness authentication Secret",
    metadataLabel: "View harness authentication Secret metadata",
    required: ["api_key", "codex_pat"].includes(method.value),
  });
  const secretField = secretPicker.field;
  const accountField = element(
    "div",
    { className: "form-field" },
    element("label", { for: account.id }, "Issued ChatGPT service account"),
    account,
  );
  const runtimeHint = element(
    "p",
    { className: "hint" },
    "Configured on the runtime host; not validated by OCC.",
  );
  const section = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Harness authentication"),
    element("label", { for: method.id }, "Authentication source"),
    method,
    secretField,
    accountField,
    runtimeHint,
    feedback,
    element(
      "p",
      { className: "hint" },
      "Managed sources are checked during deployment. Operator-managed credentials are not validated by OCC. Selection does not establish provider login or model readiness.",
    ),
  );
  function update() {
    runtimeHint.hidden = method.value !== "runtime";
    const directSecret = ["api_key", "codex_pat"].includes(method.value);
    secretField.hidden = !directSecret;
    secretField.querySelector("label").textContent =
      method.value === "codex_pat" ? "Service account token Secret" : "API key Secret";
    accountField.hidden = method.value !== "chatgpt_service_account";
    const methodChanged = method.value !== previousMethod;
    previousMethod = method.value;
    if (methodChanged && directSecret && method.value === binding?.method) {
      selectedSecretSource = originalSecretSource;
      changedSecret = null;
    } else if (methodChanged && (!directSecret || method.value !== binding?.method)) {
      selectedSecretSource = null;
      changedSecret = null;
    }
    secretPicker.setRequired(directSecret);
    secretPicker.setDisabled(disabled || !directSecret);
    secretPicker.refresh();
    account.required = method.value === "chatgpt_service_account";
  }
  method.addEventListener("change", update);
  update();
  context
    .request(`${namespacePath(context.namespaceId)}/service-accounts`)
    .then((items) => {
      if (!context.isCurrent()) {
        return;
      }
      const issued = items.filter((item) => item.credential?.kind === "access_token");
      accountsLoaded = true;
      account.disabled = disabled;
      const selected = account.value;
      account.replaceChildren(
        element("option", { value: "" }, "Select an issued account"),
        ...issued.map((item) => element("option", { value: item.id }, `${item.name} · ${item.id}`)),
      );
      if (selected && !issued.some((item) => item.id === selected)) {
        account.append(element("option", { value: selected }, `${selected} · unavailable`));
      }
      account.value = selected;
      feedback.textContent = issued.length
        ? "Issued accounts in this Namespace are available."
        : "No issued ChatGPT accounts available in this Namespace.";
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `Service accounts unavailable. ${message(error)}`;
      }
    });
  return {
    section,
    capture: () => ({
      method: method.value,
      secretSource: selectedSecretSource,
      changedSecret,
      account: account.value,
    }),
    setDisabled(value) {
      disabled = value;
      method.disabled = value;
      secretPicker.setDisabled(value || !["api_key", "codex_pat"].includes(method.value));
      account.disabled = value || !accountsLoaded;
    },
    async readBinding() {
      if (!method.value) {
        return null;
      }
      if (method.value === "runtime") {
        return { method: "runtime" };
      }
      if (method.value === "chatgpt_service_account") {
        if (!account.value) {
          throw new Error("Select an issued ChatGPT service account.");
        }
        return { method: "chatgpt_service_account", serviceAccountId: account.value };
      }
      if (!selectedSecretSource?.id) {
        throw new Error("Choose an OCC Secret.");
      }
      return {
        method: method.value,
        source: selectedSecretSource,
      };
    },
    get changedSecret() {
      return changedSecret;
    },
  };
}
