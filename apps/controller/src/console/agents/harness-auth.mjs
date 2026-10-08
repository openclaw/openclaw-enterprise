import { element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";
import { createSecretReferenceField, renderSecretReference } from "./secret-picker.mjs";
import { createDeviceLogin } from "./device-login.mjs";

// Display native model policy; deployment admission owns full Configuration validation.
export function configuredHarnessId(values) {
  const defaults = values?.agents?.defaults;
  const entries = Object.values(values?.agents?.entries ?? {});
  const selection = defaults?.model ?? entries.find((entry) => entry?.model)?.model;
  const model = typeof selection === "string" ? selection : selection?.primary;
  if (typeof model !== "string") {
    return undefined;
  }
  const providerId = model.split("/", 1)[0];
  const provider = values?.models?.providers?.[providerId];
  const providerModels = Array.isArray(provider?.models) ? provider.models : [];
  const policies = [
    defaults?.models?.[model],
    ...entries.map((entry) => entry?.models?.[model]),
    providerModels.find(
      (entry) => entry?.id === model || entry?.id === model.slice(providerId.length + 1),
    ),
    provider,
  ];
  const runtimes = new Set(policies.map((policy) => policy?.agentRuntime?.id).filter(Boolean));
  if (runtimes.size === 1) {
    const [runtime] = runtimes;
    return ["codex", "openclaw"].includes(runtime) ? runtime : undefined;
  }
  return runtimes.size === 0 && !provider && !["openai", "codex"].includes(providerId)
    ? "openclaw"
    : undefined;
}

export function harnessAuthDescription(binding) {
  if (!binding) {
    return "None selected";
  }
  if (binding.method === "runtime") {
    return "Operator-managed credentials";
  }
  if (binding.method === "codex_pat") {
    return binding.source.kind === "service_account"
      ? `ChatGPT service account · ${binding.source.id}`
      : "Service Accounts · Secret configured";
  }
  if (binding.method === "oauth") {
    return "ChatGPT OAuth (Experimental) · Agent login configured";
  }
  return "API key · Secret configured";
}

export function renderHarnessAuthSummary(context, binding) {
  if (binding?.source?.kind !== "secret") {
    return harnessAuthDescription(binding);
  }
  return element(
    "span",
    {},
    binding.method === "api_key"
      ? "API key · "
      : binding.method === "oauth"
        ? "ChatGPT OAuth (Experimental) · "
        : "Service Accounts · ",
    renderSecretReference(context, binding.source),
  );
}

export function createHarnessAuthFields(context, binding = null, harnessId, options = {}) {
  const method = element(
    "select",
    { id: "harness-auth-method" },
    element("option", { value: "" }, "None"),
    element("option", { value: "api_key" }, "API key"),
    harnessId === "codex" ? element("option", { value: "codex_pat" }, "Service Accounts") : null,
    harnessId === "codex"
      ? element("option", { value: "oauth" }, "ChatGPT OAuth (Experimental)")
      : null,
    element("option", { value: "runtime" }, "Operator-managed credentials"),
    harnessId === "codex"
      ? element("option", { value: "service_account" }, "Issued ChatGPT service account")
      : null,
  );
  const originalMethod =
    binding?.method === "codex_pat" && binding.source.kind === "service_account"
      ? "service_account"
      : (binding?.method ?? "");
  method.value = originalMethod;
  const originalSecretSource =
    ["api_key", "codex_pat", "oauth"].includes(binding?.method) && binding.source?.kind === "secret"
      ? binding.source
      : null;
  let selectedSecretSource = originalSecretSource;
  let changedSecret = null;
  const account = element(
    "select",
    { id: "service-account-id", disabled: true },
    element("option", { value: "" }, "Select an issued account"),
  );
  if (originalMethod === "service_account") {
    account.append(element("option", { value: binding.source.id }, binding.source.id));
    account.value = binding.source.id;
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
      options.onChange?.();
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
  const oauthLogin = createDeviceLogin({
    context,
    agentId: context.agentId,
    initial: draft?.oauthLogin,
    hint: "Sign in to explicitly replace this Agent's credential. Save authentication source, then deploy a new version. The deployed login stays in use until deployment.",
    onChange(source) {
      if (method.value === "oauth") {
        selectedSecretSource =
          source ?? (binding?.method === "oauth" ? originalSecretSource : null);
      }
    },
  });
  const currentOAuth = element(
    "p",
    { className: "hint" },
    "The Agent's current ChatGPT login is preserved unless you complete a new login and save it.",
  );
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
  const validationHint = element(
    "p",
    { className: "hint" },
    "Managed sources are checked during deployment. Operator-managed credentials are not validated by OCC. Selection does not establish provider login or model readiness.",
  );
  const section = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Harness authentication"),
    element("label", { for: method.id }, "Authentication source"),
    method,
    secretField,
    currentOAuth,
    oauthLogin.section,
    accountField,
    runtimeHint,
    feedback,
    validationHint,
  );
  function update() {
    runtimeHint.hidden = method.value !== "runtime";
    const directSecret = ["api_key", "codex_pat"].includes(method.value);
    const usesOAuth = method.value === "oauth";
    feedback.hidden = usesOAuth;
    validationHint.hidden = usesOAuth;
    oauthLogin.setActive(usesOAuth);
    oauthLogin.setDisabled(disabled);
    currentOAuth.hidden = !usesOAuth || binding?.method !== "oauth";
    secretField.hidden = !directSecret;
    secretField.querySelector("label").textContent =
      method.value === "codex_pat" ? "Service account token Secret" : "API key Secret";
    accountField.hidden = method.value !== "service_account";
    const methodChanged = method.value !== previousMethod;
    previousMethod = method.value;
    if (methodChanged && directSecret && method.value === originalMethod) {
      selectedSecretSource = originalSecretSource;
      changedSecret = null;
    } else if (methodChanged && (!directSecret || method.value !== originalMethod)) {
      selectedSecretSource = null;
      changedSecret = null;
    }
    if (usesOAuth) {
      selectedSecretSource =
        oauthLogin.source ?? (binding?.method === "oauth" ? originalSecretSource : null);
    }
    secretPicker.setRequired(directSecret);
    secretPicker.setDisabled(disabled || !directSecret);
    secretPicker.refresh();
    account.required = method.value === "service_account";
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
      oauthLogin: oauthLogin.capture(),
    }),
    setDisabled(value) {
      disabled = value;
      method.disabled = value;
      secretPicker.setDisabled(value || !["api_key", "codex_pat"].includes(method.value));
      account.disabled = value || !accountsLoaded;
      oauthLogin.setDisabled(value);
    },
    async readBinding() {
      if (!method.value) {
        return null;
      }
      if (method.value === "runtime") {
        return { method: "runtime" };
      }
      if (method.value === "service_account") {
        if (!account.value) {
          throw new Error("Select an issued ChatGPT service account.");
        }
        return {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: context.namespaceId, id: account.value },
        };
      }
      if (!selectedSecretSource?.id) {
        throw new Error(
          method.value === "oauth"
            ? "Complete ChatGPT sign-in before saving."
            : "Choose an OCC Secret.",
        );
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
