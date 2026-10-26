import type {
  CredentialSourceReference,
  HarnessAuthBinding,
  SecretMetadata,
  SecretReference,
  ServiceAccount,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { element } from "../dom.mjs";
import { message, namespaceListNeed, namespacePath } from "./list.mjs";
import { createSecretReferenceField, renderSecretReference } from "./secret-picker.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { createDeviceLogin, type DeviceLogin } from "./device-login.mjs";

// Display native model policy; deployment admission owns full Configuration validation.
export function configuredHarnessId(values: unknown): "codex" | "openclaw" | undefined {
  const { agents, models } = responseFields(values);
  const agentPolicy = responseFields(agents);
  const defaults = responseFields(agentPolicy.defaults);
  const entries = Object.values(responseFields(agentPolicy.entries)).map(responseFields);
  const selection = defaults.model ?? entries.find((entry) => entry.model)?.model;
  const model = typeof selection === "string" ? selection : responseFields(selection).primary;
  if (typeof model !== "string") {
    return undefined;
  }
  const [providerId = ""] = model.split("/", 1);
  const provider = responseFields(responseFields(models).providers)[providerId];
  const providerModels = responseFields(provider).models;
  const modelId = model.slice(providerId.length + 1);
  const listedModel = Array.isArray(providerModels)
    ? providerModels.find((entry: unknown) => {
        const { id } = responseFields(entry);
        return id === model || id === modelId;
      })
    : undefined;
  const policies = [
    responseFields(defaults.models)[model],
    ...entries.map((entry) => responseFields(entry.models)[model]),
    listedModel,
    provider,
  ];
  const runtimes = new Set(
    policies
      .map((policy) => responseFields(responseFields(policy).agentRuntime).id)
      .filter(Boolean),
  );
  if (runtimes.size === 1) {
    const [runtime] = runtimes;
    return runtime === "codex" || runtime === "openclaw" ? runtime : undefined;
  }
  return runtimes.size === 0 && !provider && !["openai", "codex"].includes(providerId)
    ? "openclaw"
    : undefined;
}

type AuthBinding = HarnessAuthBinding | null | undefined;
type HarnessAuthContext = AgentAccessContext & { agentId?: string | undefined };

export function harnessAuthDescription(binding: AuthBinding) {
  if (!binding) {
    return "None selected";
  }
  if (binding.method === "credential_source") {
    return `Credential Source · ${binding.sourceId}`;
  }
  if (binding.method === "runtime") {
    return "Operator-managed credentials";
  }
  if (binding.method === "codex_pat") {
    return binding.source.kind === "service_account"
      ? `ChatGPT service account · ${binding.source.id}`
      : "Service Accounts · Secret configured";
  }
  return "API key · Secret configured";
}

export function renderHarnessAuthSummary(context: HarnessAuthContext, binding: AuthBinding) {
  if (!binding || !("source" in binding) || binding.source.kind !== "secret") {
    return harnessAuthDescription(binding);
  }
  return element(
    "span",
    {},
    binding.method === "api_key" ? "API key · " : "Service Accounts · ",
    renderSecretReference(context, binding.source),
  );
}

interface HarnessAuthDraft {
  method: string;
  account: string;
  secretSource: SecretReference | null;
  credentialSource: CredentialSourceReference | null;
  changedSecret: SecretMetadata | null;
  oauthLogin: DeviceLogin | null;
}

function issuedAccounts(value: unknown): Pick<ServiceAccount, "id" | "name">[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid service account list");
  }
  return value.flatMap((item: unknown) => {
    const { id, name, credential } = responseFields(item);
    if (responseFields(credential).kind !== "access_token") {
      return [];
    }
    if (typeof id !== "string" || typeof name !== "string") {
      throw new Error("Invalid issued service account");
    }
    return [{ id, name }];
  });
}

export function createHarnessAuthFields(
  context: HarnessAuthContext,
  binding: AuthBinding,
  harnessId: ReturnType<typeof configuredHarnessId>,
  options: { draft?: HarnessAuthDraft | undefined; agentName?: string; onChange?(): void } = {},
) {
  const method = element(
    "select",
    { id: "harness-auth-method" },
    element("option", { value: "" }, "None"),
    element("option", { value: "api_key" }, "API key"),
    harnessId === "codex" ? element("option", { value: "codex_pat" }, "Service Accounts") : null,
    harnessId === "codex" || binding?.method === "credential_source"
      ? element(
          "option",
          { value: "credential_source" },
          binding?.method === "credential_source"
            ? "Credential source"
            : "ChatGPT OAuth (Experimental)",
        )
      : null,
    element("option", { value: "runtime" }, "Operator-managed credentials"),
    harnessId === "codex"
      ? element("option", { value: "service_account" }, "Issued ChatGPT service account")
      : null,
  );
  const source = binding && "source" in binding ? binding.source : undefined;
  const originalMethod =
    source?.kind === "service_account" ? "service_account" : (binding?.method ?? "");
  method.value = originalMethod;
  const originalSecretSource = source?.kind === "secret" ? source : null;
  let selectedSecretSource = originalSecretSource;
  let changedSecret: SecretMetadata | null = null;
  let selectedCredentialSource: CredentialSourceReference | null = null;
  const account = element(
    "select",
    { id: "service-account-id", disabled: true },
    element("option", { value: "" }, "Select an issued account"),
  );
  if (source?.kind === "service_account") {
    account.append(element("option", { value: source.id }, source.id));
    account.value = source.id;
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
  const secretLabel = secretField.querySelector("label")!;
  const oauthLogin = createDeviceLogin({
    context,
    agentId: context.agentId,
    initial: draft?.oauthLogin,
    hint: "Sign in to explicitly replace this Agent's credential. Save authentication source, then deploy a new version. The deployed login stays in use until deployment.",
    onChange(source) {
      if (method.value === "credential_source") {
        selectedCredentialSource = source;
        options.onChange?.();
      }
    },
  });
  const currentOAuth = element(
    "p",
    { className: "hint" },
    "The Agent's current credential source is preserved until you select and save another authentication source.",
  );
  const accountField = element(
    "div",
    { className: "form-field" },
    element("label", { for: account.id }, "Issued ChatGPT service account"),
    account,
    feedback,
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
    element(
      "div",
      { className: "form-field" },
      element("label", { for: method.id }, "Authentication source"),
      method,
    ),
    secretField,
    currentOAuth,
    oauthLogin.section,
    accountField,
    runtimeHint,
    validationHint,
  );
  function update() {
    runtimeHint.hidden = method.value !== "runtime";
    const directSecret = ["api_key", "codex_pat"].includes(method.value);
    const usesOAuth = method.value === "credential_source" && harnessId === "codex";
    feedback.hidden = usesOAuth;
    validationHint.hidden = usesOAuth;
    oauthLogin.setActive(usesOAuth);
    oauthLogin.setDisabled(disabled);
    currentOAuth.hidden =
      method.value !== "credential_source" || binding?.method !== "credential_source";
    secretField.hidden = !directSecret;
    secretLabel.textContent =
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
      selectedCredentialSource = oauthLogin.source;
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
      const issued = issuedAccounts(items);
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
    .catch((error: unknown) => {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `Service Accounts unavailable. ${message(error, false, namespaceListNeed("Service Accounts"))}`;
      }
    });
  return {
    section,
    capture: (): HarnessAuthDraft => ({
      method: method.value,
      secretSource: selectedSecretSource,
      credentialSource: selectedCredentialSource,
      changedSecret,
      account: account.value,
      oauthLogin: oauthLogin.capture(),
    }),
    setDisabled(value: boolean) {
      disabled = value;
      method.disabled = value;
      secretPicker.setDisabled(value || !["api_key", "codex_pat"].includes(method.value));
      account.disabled = value || !accountsLoaded;
      oauthLogin.setDisabled(value);
    },
    async readBinding(): Promise<HarnessAuthBinding | null> {
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
      if (method.value === "credential_source") {
        const sourceId =
          selectedCredentialSource?.id ??
          (binding?.method === "credential_source" ? binding.sourceId : undefined);
        if (!sourceId) {
          throw new Error("Complete ChatGPT sign-in before saving.");
        }
        return { method: "credential_source", sourceId };
      }
      if (
        (method.value !== "api_key" && method.value !== "codex_pat") ||
        !selectedSecretSource?.id
      ) {
        throw new Error("Choose an OCC Secret.");
      }
      return method.value === "api_key"
        ? { method: "api_key", source: selectedSecretSource }
        : { method: "codex_pat", source: selectedSecretSource };
    },
    get changedSecret() {
      return changedSecret;
    },
  };
}
