import type {
  CredentialSourceReference,
  HarnessAuthBinding,
  InstallationCapabilities,
  SecretMetadata,
  SecretReference,
  ServiceAccount,
} from "@openclaw-enterprise/contracts";
import {
  INSTALLATION_ADMINISTRATION,
  namedDenial,
  requestFailure,
  responseFields,
} from "../api-client.mjs";
import { button, element, replaceChildrenIfChanged, setUnavailable } from "../dom.mjs";
import { describeFailure, message, namespaceListNeed, namespacePath } from "./list.mjs";
import { createSecretReferenceField, renderSecretReference } from "./secret-picker.mjs";
import {
  readCredentialSourceMetadata,
  type CredentialSourceSummary,
} from "../credential-source-metadata.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { createDeviceLogin, deviceLoginOffered, type DeviceLogin } from "./device-login.mjs";

function primaryModel(defaults: Record<string, unknown>, entries: Record<string, unknown>[]) {
  const selection = defaults.model ?? entries.find((entry) => entry.model)?.model;
  const model = typeof selection === "string" ? selection : responseFields(selection).primary;
  return typeof model === "string" ? model : undefined;
}

export function configuredModel(values: unknown) {
  const agents = responseFields(responseFields(values).agents);
  return primaryModel(
    responseFields(agents.defaults),
    Object.values(responseFields(agents.entries)).map(responseFields),
  );
}

// Display native model policy; deployment admission owns full Configuration validation.
export function configuredHarnessId(values: unknown): "codex" | "openclaw" | undefined {
  const { agents, models } = responseFields(values);
  const agentPolicy = responseFields(agents);
  const defaults = responseFields(agentPolicy.defaults);
  const entries = Object.values(responseFields(agentPolicy.entries)).map(responseFields);
  const model = primaryModel(defaults, entries);
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
type ModelSourcePreset = "openai" | "codex-pat";

export const CODEX_SOURCE_DESTINATION_HINT =
  "An OpenAI Source requires the OpenAI Responses destination. The Console cannot check Codex's effective destination before saving; deployment checks it. If the Installation default differs, set Harness destination to an override with Provider base URL https://api.openai.com/v1 and Provider protocol Responses.";

/** Return the configured model provider only when its approved static Source presets can apply. */
export function modelSourceProvider(
  configuration: unknown,
  harnessId: string | undefined,
  executionMode: string | undefined,
): "openai" | "codex" | undefined {
  if (executionMode !== "dedicated") {
    return undefined;
  }
  const selection = responseFields(
    responseFields(responseFields(configuration).agents).defaults,
  ).model;
  const primary = typeof selection === "string" ? selection : responseFields(selection).primary;
  const providerId = typeof primary === "string" ? primary.split("/", 1)[0] : undefined;
  if (harnessId === "codex" && (providerId === "codex" || providerId === "openai")) {
    return providerId;
  }
  const provider = responseFields(
    responseFields(responseFields(configuration).models).providers,
  ).openai;
  const nativeOpenAI = responseFields(provider);
  return harnessId === "openclaw" &&
    providerId === "openai" &&
    nativeOpenAI.api === "openai-responses" &&
    typeof nativeOpenAI.baseUrl === "string" &&
    /^https:\/\/api\.openai\.com(?::443)?\/v1\/?$/.test(nativeOpenAI.baseUrl)
    ? "openai"
    : undefined;
}

export function credentialSourceOperateDenial(cause: unknown, id: string, current = false) {
  const denial = namedDenial(cause);
  const target = `CredentialSource ${id}`;
  const qualification = current
    ? ", the Agent's current Harness authentication: every update checks it, even one that replaces it"
    : "";
  return denial ===
    `Not authorized: this needs CredentialSource operate on ${target}${qualification}. Ask an Installation administrator to grant it.`
    ? denial
    : undefined;
}

/** A readable Source is a candidate; Agent save confirms operate permission. */
export function createModelCredentialSourceField(
  context: Pick<HarnessAuthContext, "namespaceId" | "request" | "isCurrent" | "onExpired">,
  options: {
    id: string;
    initial?: CredentialSourceReference | null;
    currentId?: string;
    preset?: ModelSourcePreset;
    onChange(source: CredentialSourceReference | null): void;
  },
) {
  let selected = options.initial ?? null;
  let preset = options.preset;
  let sources: CredentialSourceSummary[] = [];
  let loaded = false;
  let loading = false;
  let attempted = false;
  let active = false;
  let disabled = false;
  const select = element("select", { id: options.id });
  const hint = element("p", { className: "hint", role: "status" });
  const retry = button("Retry Source list", () => void load(true), { tone: "ghost", size: "sm" });
  retry.hidden = true;
  const field = element(
    "div",
    { className: "form-field", hidden: true },
    element("label", { for: select.id }, "Existing Credential Source"),
    select,
    hint,
    retry,
  );
  function eligibleSource(source: CredentialSourceSummary) {
    return (
      source.type === "static" &&
      source.state === "ready" &&
      source.connectionTemplateId === undefined &&
      source.modelPreset !== undefined &&
      (preset === undefined || source.modelPreset === preset)
    );
  }
  function acceptedSelection() {
    return selected &&
      (selected.id === options.currentId ||
        (loaded && sources.some((source) => source.id === selected!.id && eligibleSource(source))))
      ? selected
      : null;
  }
  function showListStatus() {
    hint.textContent = sources.some(eligibleSource)
      ? "Listing confirms read access. Saving the Agent checks Credential Source operate permission."
      : "No matching ready static model Credential Sources are readable in this Namespace.";
  }
  function renderOptions() {
    const eligible = sources.filter(eligibleSource);
    const choices = [
      element("option", { value: "" }, "Choose a Credential Source"),
      ...eligible.map((source) =>
        element("option", { value: source.id }, `${source.name} · ${source.id}`),
      ),
    ];
    if (
      selected &&
      selected.id === options.currentId &&
      !eligible.some((source) => source.id === selected!.id)
    ) {
      choices.push(
        element("option", { value: selected.id }, `Current Credential Source · ${selected.id}`),
      );
    }
    replaceChildrenIfChanged(select, choices);
    select.value = selected?.id ?? "";
    select.disabled = disabled || (!loaded && !selected);
    select.required = active;
  }
  async function load(force = false) {
    if (loading || (!force && (loaded || attempted))) {
      return;
    }
    attempted = true;
    loading = true;
    const wasLoaded = loaded;
    if (force) {
      retry.textContent = "Refreshing Source list…";
      retry.setAttribute("aria-busy", "true");
    }
    hint.textContent = "Loading readable Credential Sources…";
    renderOptions();
    try {
      const result = await context.request(
        `${namespacePath(context.namespaceId)}/credential-sources`,
      );
      if (!context.isCurrent()) {
        return;
      }
      if (!Array.isArray(result)) {
        throw new Error("The API did not return a Credential Source list.");
      }
      sources = result.flatMap((value) => {
        const source = readCredentialSourceMetadata(value, context.namespaceId);
        return source ? [source] : [];
      });
      loaded = true;
      if (selected && selected.id !== options.currentId) {
        const accepted = acceptedSelection();
        if (!wasLoaded || accepted?.id !== selected.id) {
          selected = accepted;
          options.onChange(selected);
        }
      }
      showListStatus();
      retry.textContent = "Refresh Source list";
      retry.hidden = false;
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
        return;
      }
      retry.textContent = "Retry Source list";
      retry.hidden = false;
      hint.textContent = describeFailure(error, {
        need: {
          task: "listing Credential Sources",
          grant: "Namespace read and Credential Source read",
        },
      });
    } finally {
      loading = false;
      retry.removeAttribute("aria-busy");
      if (context.isCurrent()) {
        renderOptions();
      }
    }
  }
  select.addEventListener("change", () => {
    selected =
      sources.find((source) => source.id === select.value)?.ref ??
      (selected?.id === select.value ? selected : null);
    options.onChange(selected);
  });
  renderOptions();
  return {
    field,
    setActive(value: boolean, nextPreset = preset) {
      active = value;
      field.hidden = !value;
      if (nextPreset !== preset) {
        preset = nextPreset;
        if (
          selected &&
          sources.some((source) => source.id === selected!.id && source.modelPreset !== preset)
        ) {
          selected = null;
          options.onChange(null);
        }
        if (loaded && !loading) {
          showListStatus();
        }
      }
      renderOptions();
      if (value) {
        void load();
      }
    },
    setDisabled(value: boolean) {
      disabled = value;
      retry.disabled = value;
      renderOptions();
    },
    reset() {
      selected = null;
      renderOptions();
    },
    get source() {
      return acceptedSelection();
    },
  };
}
type HarnessAuthContext = AgentAccessContext & {
  agentId?: string | undefined;
  installationAdmin?: boolean | null;
};

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

function issuedAccounts(
  value: unknown,
): (Pick<ServiceAccount, "id" | "name"> & { sourceId: string })[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid service account list");
  }
  return value.flatMap((item: unknown) => {
    const { id, name, credential } = responseFields(item);
    const issued = responseFields(credential);
    if (issued.kind !== "access_token" || typeof issued.sourceId !== "string" || !issued.sourceId) {
      return [];
    }
    if (typeof id !== "string" || typeof name !== "string") {
      throw new Error("Invalid issued service account");
    }
    return [{ id, name, sourceId: issued.sourceId }];
  });
}

export function createHarnessAuthFields(
  context: HarnessAuthContext,
  binding: AuthBinding,
  harnessId: ReturnType<typeof configuredHarnessId>,
  options: {
    draft?: HarnessAuthDraft | undefined;
    agentName?: string;
    executionMode?: string;
    configuration?: unknown;
    onChange?(): void;
    onStartSettled?(): void;
  } = {},
) {
  const providerId = modelSourceProvider(options.configuration, harnessId, options.executionMode);
  const sourceCompatible = providerId !== undefined;
  const method = element(
    "select",
    { id: "harness-auth-method" },
    element("option", { value: "" }, "None"),
    element("option", { value: "api_key" }, "API key"),
    sourceCompatible || binding?.method === "credential_source"
      ? element("option", { value: "credential_source" }, "Credential Source")
      : null,
    harnessId === "codex"
      ? element("option", { value: "device_login" }, "ChatGPT OAuth (Experimental)")
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
  let selectedCredentialSource: CredentialSourceReference | null =
    (options.draft?.method === "credential_source" ? options.draft.credentialSource : null) ??
    (binding?.method === "credential_source"
      ? { kind: "credential_source", namespaceId: context.namespaceId, id: binding.sourceId }
      : null);
  let clearingReplacement = false;
  const issuedSources = new Map<string, string>();
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
  let disabledReason: HTMLElement | null = null;
  const feedback = element("p", { className: "hint", role: "status" });
  // An account select that cannot be used stays in the Tab order while its reason shows (findings
  // 2899, 2925): the form's update denial, or the failed Service Account read. While the accounts
  // load there is no reason to read, so it is natively disabled.
  function updateAccount() {
    setUnavailable(account, disabled || !accountsLoaded, disabled ? disabledReason : feedback);
  }
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
    required: method.value === "api_key",
  });
  const secretField = secretPicker.field;
  const secretLabel = secretField.querySelector("label")!;
  const sourcePicker = createModelCredentialSourceField(context, {
    id: "harness-auth-existing-source",
    initial: selectedCredentialSource,
    ...(binding?.method === "credential_source" ? { currentId: binding.sourceId } : {}),
    ...(harnessId !== "codex" || providerId !== "codex" ? { preset: "openai" as const } : {}),
    onChange(source) {
      selectedCredentialSource = source;
      options.onChange?.();
    },
  });
  const oauthLogin = createDeviceLogin({
    context,
    agentId: context.agentId,
    initial: draft?.oauthLogin,
    hint: "Sign in to replace this Agent's credential, then save the authentication source. If this Agent has an active revision, complete Stop before deploying the replacement.",
    onChange(source) {
      if (method.value === "device_login") {
        const cleared = selectedCredentialSource !== null && source === null;
        selectedCredentialSource = source;
        if (cleared && binding?.method === "credential_source") {
          clearingReplacement = true;
          method.value = "credential_source";
          update();
          method.focus();
        }
        options.onChange?.();
      } else if (clearingReplacement && source) {
        // A refused discard restores the staged login and its visible replacement choice.
        clearingReplacement = false;
        method.value = "device_login";
        selectedCredentialSource = source;
        update();
        options.onChange?.();
      }
    },
    onStartSettled: () => options.onStartSettled?.(),
  });
  // Only an Installation administrator reads the Installation, which says whether its Drivers
  // offer a device login at all (finding 2991). Read once, when ChatGPT OAuth is first chosen; a
  // failed read leaves Sign in offered.
  let offerRead = false;
  function readOffer() {
    if (offerRead || context.installationAdmin !== true) {
      return;
    }
    offerRead = true;
    context.request("/installation", INSTALLATION_ADMINISTRATION).then(
      (installation) => {
        if (context.isCurrent()) {
          const { capabilities } = responseFields(installation);
          oauthLogin.setOffered(deviceLoginOffered(capabilities as InstallationCapabilities));
        }
      },
      (error: unknown) => {
        if (context.isCurrent() && requestFailure(error).status === 401) {
          context.onExpired();
        }
      },
    );
  }
  let currentSourceText =
    "If this Agent has an active revision, complete Stop before deploying this managed Source.";
  if (binding?.method === "credential_source") {
    currentSourceText = sourceCompatible
      ? "The Agent's current credential source is preserved until you select and save another authentication source. If this Agent has an active revision, complete Stop before deploying the replacement."
      : "The Agent's current credential source is preserved. Source replacement is unavailable for the configured model provider or destination.";
  }
  const currentSourceHint = element("p", { className: "hint" }, currentSourceText);
  const codexSourceHint = element("p", { className: "hint" }, CODEX_SOURCE_DESTINATION_HINT);
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
    "Configured on the runtime host; OpenClaw Enterprise does not check it.",
  );
  const validationHint = element(
    "p",
    { className: "hint" },
    "Managed sources are checked during deployment. OpenClaw Enterprise does not check operator-managed credentials. Selection does not establish provider login or model readiness.",
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
    sourcePicker.field,
    currentSourceHint,
    codexSourceHint,
    oauthLogin.section,
    accountField,
    runtimeHint,
    validationHint,
  );
  function update() {
    runtimeHint.hidden = method.value !== "runtime";
    const directSecret = method.value === "api_key";
    const usesOAuth = method.value === "device_login" && harnessId === "codex";
    feedback.hidden = usesOAuth;
    validationHint.hidden = usesOAuth;
    oauthLogin.setActive(usesOAuth);
    oauthLogin.setDisabled(disabled);
    if (usesOAuth) {
      readOffer();
    }
    currentSourceHint.hidden = method.value !== "credential_source";
    codexSourceHint.hidden = method.value !== "credential_source" || harnessId !== "codex";
    sourcePicker.setActive(method.value === "credential_source" && sourceCompatible);
    sourcePicker.setDisabled(disabled);
    secretField.hidden = !directSecret;
    secretLabel.textContent = "API key Secret";
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
    } else if (method.value === "credential_source") {
      selectedCredentialSource = sourcePicker.source;
    } else {
      selectedCredentialSource = null;
    }
    secretPicker.setRequired(directSecret);
    secretPicker.setDisabled(disabled || !directSecret);
    secretPicker.refresh();
    account.required = method.value === "service_account";
    // The read's failure shows only beside this select's own method.
    updateAccount();
  }
  method.addEventListener("change", () => {
    clearingReplacement = false;
    update();
  });
  update();
  context
    .request(`${namespacePath(context.namespaceId)}/service-accounts`)
    .then((items) => {
      if (!context.isCurrent()) {
        return;
      }
      const issued = issuedAccounts(items);
      issuedSources.clear();
      for (const item of issued) {
        issuedSources.set(item.id, item.sourceId);
      }
      accountsLoaded = true;
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
      updateAccount();
    })
    .catch((error: unknown) => {
      if (!context.isCurrent()) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `Service Accounts unavailable. ${message(error, false, namespaceListNeed("Service Accounts"))}`;
        updateAccount();
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
    // A disabled method or account select with a shown `reason` stays in the Tab order
    // (findings 2899, 2925).
    setDisabled(value: boolean, reason: HTMLElement | null = null) {
      disabled = value;
      disabledReason = reason;
      setUnavailable(method, value, reason);
      secretPicker.setDisabled(value || method.value !== "api_key");
      sourcePicker.setDisabled(value || method.value !== "credential_source");
      updateAccount();
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
        const sourceId = issuedSources.get(account.value);
        if (!sourceId) {
          throw new Error("Select an issued ChatGPT service account.");
        }
        return { method: "credential_source", sourceId };
      }
      if (method.value === "credential_source") {
        if (!selectedCredentialSource) {
          throw new Error("Choose an existing Credential Source.");
        }
        return { method: "credential_source", sourceId: selectedCredentialSource.id };
      }
      if (method.value === "device_login") {
        const sourceId = selectedCredentialSource?.id;
        if (!sourceId) {
          throw new Error("Complete ChatGPT sign-in before saving.");
        }
        return { method: "credential_source", sourceId };
      }
      if (method.value !== "api_key" || !selectedSecretSource?.id) {
        throw new Error("Choose a Secret.");
      }
      return { method: "api_key", source: selectedSecretSource };
    },
    get changedSecret() {
      return changedSecret;
    },
  };
}
