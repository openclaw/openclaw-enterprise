import { element } from "../dom.mjs";
import { namespacePath } from "../agents/list.mjs";
import {
  SLACK_SECRET_BINDINGS,
  secretBinding,
  secretIdForBinding,
} from "../agents/credentials.mjs";
import {
  isRecord,
  refsEqual,
  providerConfig,
  withProvider,
  field,
  input,
  checkbox,
  uniqueList,
  arrayOfStrings,
} from "./shared-ui.mjs";

const STANDARD_REFS = {
  slack: {
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  },
};

const DM_POLICIES = ["pairing", "allowlist", "open", "disabled"];

const CREATE_SECRET_VALUE = "__openclaw_create_secret__";

function channelUsers(channel) {
  const users = uniqueList(channel?.users ?? []);
  return users.includes("*") ? [] : users.sort();
}

function supportSlack(values) {
  if (values?.channels !== undefined && !isRecord(values.channels)) {
    return {
      supported: false,
      reason: "Native channels configuration is not an object.",
      config: values.channels,
    };
  }
  const config = providerConfig(values, "slack");
  if (config === undefined) {
    return { supported: true, config: {} };
  }
  if (!isRecord(config)) {
    return { supported: false, reason: "Slack configuration is not an object.", config };
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { supported: false, reason: "Slack enabled state is not boolean.", config };
  }
  if (config.account !== undefined || config.accounts !== undefined) {
    return {
      supported: false,
      reason: "Only the default Slack account is supported by this editor.",
      config,
    };
  }
  if (config.mode !== undefined && config.mode !== "socket") {
    return {
      supported: false,
      reason: "Only Slack Socket Mode is supported by this editor.",
      config,
    };
  }
  if (config.appToken !== undefined && !refsEqual(config.appToken, STANDARD_REFS.slack.appToken)) {
    return {
      supported: false,
      reason: "Slack app token uses a non-standard credential reference.",
      config,
    };
  }
  if (config.botToken !== undefined && !refsEqual(config.botToken, STANDARD_REFS.slack.botToken)) {
    return {
      supported: false,
      reason: "Slack bot token uses a non-standard credential reference.",
      config,
    };
  }
  if (config.channels !== undefined && !isRecord(config.channels)) {
    return { supported: false, reason: "Slack channels are not stored as a channel map.", config };
  }
  if (config.dmPolicy !== undefined && !DM_POLICIES.includes(config.dmPolicy)) {
    return { supported: false, reason: "Slack direct-message policy is unsupported.", config };
  }
  const channelEntries = Object.entries(config.channels ?? {});
  if (channelEntries.some(([, value]) => !isRecord(value))) {
    return {
      supported: false,
      reason: "At least one Slack channel entry is not an object.",
      config,
    };
  }
  if (
    config.allowFrom !== undefined &&
    (!arrayOfStrings(config.allowFrom) || config.allowFrom.some((user) => /[,\r\n]/.test(user)))
  ) {
    return {
      supported: false,
      reason: "Slack allowed users are not stored as string IDs.",
      config,
    };
  }
  if (
    channelEntries.some(
      ([, value]) =>
        (value.users !== undefined &&
          (!arrayOfStrings(value.users) || value.users.some((user) => /[,\r\n]/.test(user)))) ||
        (value.requireMention !== undefined && typeof value.requireMention !== "boolean"),
    )
  ) {
    return {
      supported: false,
      reason: "Slack channel users or Require mention values use an unsupported native shape.",
      config,
    };
  }
  const mentions = [...new Set(channelEntries.map(([, value]) => value.requireMention))];
  if (mentions.length > 1) {
    return {
      supported: false,
      reason: "Existing Slack channels use mixed Require mention values.",
      config,
    };
  }
  if (Object.hasOwn(config.channels ?? {}, "*")) {
    return {
      supported: false,
      reason: "Slack wildcard channels must be edited in native Configuration JSON.",
      config,
    };
  }
  const senderLists = new Set(
    channelEntries.map(([, value]) => JSON.stringify(channelUsers(value))),
  );
  if (senderLists.size > 1) {
    return {
      supported: false,
      reason:
        "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
      config,
    };
  }
  return { supported: true, config };
}

function updatedSlack(values, body) {
  const current = supportSlack(values).config;
  const existingConfig = providerConfig(values, "slack");
  const ids = uniqueList(body.querySelector("#slack-channel-ids").value.split(","));
  const users = uniqueList(body.querySelector("#slack-allowed-user-ids").value.split(","));
  const allowEveryone = body.querySelector("#slack-allow-everyone").checked;
  const requireMention = body.querySelector("#slack-require-mention").checked;
  const existing = isRecord(current.channels) ? current.channels : {};
  const channels = {};
  for (const id of ids) {
    const entry = isRecord(existing[id]) ? { ...existing[id] } : {};
    channels[id] = { ...entry, requireMention, users: allowEveryone ? ["*"] : users };
  }
  const config = {
    ...current,
    enabled: body.querySelector("#slack-enabled").checked,
    mode: "socket",
    appToken: STANDARD_REFS.slack.appToken,
    botToken: STANDARD_REFS.slack.botToken,
    channels,
  };
  if (!isRecord(existingConfig)) {
    config.groupPolicy = "allowlist";
    config.replyToModeByChatType = { channel: "all" };
  }
  const dmPolicy = body.querySelector("#slack-dm-policy").value;
  if (dmPolicy !== "") {
    config.dmPolicy = dmPolicy;
  }
  const dmUsers = body.querySelector("#slack-dm-user-ids").value;
  if (dmPolicy === "open" && current.dmPolicy !== "open") {
    config.allowFrom = ["*"];
  } else if (
    dmPolicy !== "open" &&
    dmPolicy !== "disabled" &&
    dmUsers !== (current.allowFrom ?? []).join(", ")
  ) {
    config.allowFrom = uniqueList(dmUsers.split(","));
  }
  return withProvider(values, "slack", config);
}

function updatedSecretBindings(context = {}) {
  if (context.draftSecretBindings === undefined) {
    return undefined;
  }
  const seen = new Set();
  const changedSecrets = [];
  for (const binding of SLACK_SECRET_BINDINGS) {
    const secret = context.draftChangedSecrets?.[binding.key];
    const finalBinding = context.draftSecretBindings[binding.key];
    if (
      secret === undefined ||
      secretIdForBinding(finalBinding) !== secret.id ||
      sameNamespaceEnvSecretHref(finalBinding, context.namespaceId) ===
        sameNamespaceEnvSecretHref(context.secretBindings?.[binding.key], context.namespaceId) ||
      seen.has(secret.id)
    ) {
      continue;
    }
    seen.add(secret.id);
    changedSecrets.push(secret);
  }
  return {
    secretBindings: context.draftSecretBindings,
    changedSecrets,
  };
}

function sameNamespaceEnvSecretHref(binding, namespaceId) {
  const secretId = secretIdForBinding(binding);
  if (
    secretId === null ||
    binding?.source?.namespaceId !== namespaceId ||
    binding?.delivery?.type !== "env"
  ) {
    return null;
  }
  return secretMetadataPath(namespaceId, secretId);
}

function credentialLink(href, label) {
  return element("a", { href, target: "_blank", rel: "noopener" }, `${label} (opens in new tab)`);
}

function secretMetadataPath(namespaceId, secretId) {
  return `${namespacePath(namespaceId)}/secrets/${encodeURIComponent(secretId)}`;
}

function activeSecretBindings(context) {
  return context.draftSecretBindings ?? context.secretBindings ?? {};
}

function activeSecretSource(binding, context) {
  return activeSecretBindings(context)[binding.key];
}

function boundSecretId(binding, context) {
  const source = activeSecretSource(binding, context);
  if (source?.source?.namespaceId !== context.namespaceId || source?.delivery?.type !== "env") {
    return null;
  }
  return secretIdForBinding(source);
}

function updateSecretMetadataLink(link, binding, context) {
  const href = sameNamespaceEnvSecretHref(
    activeSecretSource(binding, context),
    context.namespaceId,
  );
  if (href === null) {
    link.hidden = true;
    link.removeAttribute("href");
    return;
  }
  link.hidden = false;
  link.href = href;
}

function isSecretMetadata(secret, namespaceId) {
  return (
    isRecord(secret) &&
    typeof secret.id === "string" &&
    typeof secret.name === "string" &&
    secret.namespaceId === namespaceId &&
    isRecord(secret.ref) &&
    secret.ref.kind === "secret" &&
    secret.ref.namespaceId === namespaceId &&
    secret.ref.id === secret.id
  );
}

function secretOptionLabel(secret) {
  return `${secret.name} · ${secret.id}`;
}

function setSecretOptions(select, binding, context, secrets = []) {
  const selectedSecretId = boundSecretId(binding, context);
  const selectedSecret = secrets.find((secret) => secret.id === selectedSecretId);
  const options = [];
  if (selectedSecretId === null) {
    options.push(element("option", { value: "", selected: "" }, "No Secret bound"));
  } else if (selectedSecret === undefined) {
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
}

function modalSecretName(binding, context) {
  const agentName =
    typeof context.agentName === "function" ? context.agentName() : context.agentName;
  const trimmedAgentName =
    typeof agentName === "string" && agentName.trim().length ? agentName.trim() : "Slack";
  return `${trimmedAgentName} ${binding.secretName}`;
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

async function bindSecret(binding, context, secret, status, select, secrets, metadataLink) {
  const previous = boundSecretId(binding, context);
  if (secret.id === previous) {
    return;
  }
  select.disabled = true;
  status.className = "hint";
  context.draftSecretBindings = {
    ...activeSecretBindings(context),
    [binding.key]: secretBinding(secret),
  };
  context.draftChangedSecrets = {
    ...(context.draftChangedSecrets ?? {}),
    [binding.key]: secret,
  };
  if (!secrets.some((item) => item.id === secret.id)) {
    secrets.push(secret);
  }
  setSecretOptions(select, binding, context, secrets);
  if (metadataLink !== undefined) {
    updateSecretMetadataLink(metadataLink, binding, context);
  }
  status.textContent = "Secret binding staged. Apply the channel settings to save it.";
  select.disabled = false;
}

function openCreateSecretDialog(binding, context, status, select, secrets, metadataLink) {
  const dialog = element("dialog", {
    className: "channel-dialog credential-secret-dialog",
    "aria-label": `Create ${binding.label} Secret`,
  });
  const key = element("input", {
    id: `create-${binding.key.toLowerCase().replaceAll("_", "-")}-key`,
    value: binding.key,
    readonly: "",
  });
  const value = element("input", {
    id: `create-${binding.key.toLowerCase().replaceAll("_", "-")}-value`,
    type: "password",
    required: "",
    autocomplete: "off",
  });
  const feedback = element("p", { className: "error", role: "alert" });
  const cancel = element("button", { type: "button" }, "Cancel");
  const submit = element("button", { type: "submit", className: "primary" }, "Create Secret");
  let creating = false;
  let outcomeUnknown = false;
  const form = element(
    "form",
    { method: "dialog", className: "channel-drawer-form" },
    element(
      "div",
      { className: "channel-drawer-head" },
      element("h2", {}, `Create ${binding.label} Secret`),
      element("button", { type: "button" }, "Close"),
    ),
    field("Binding key", key, "This environment key is fixed for Slack Socket Mode."),
    field("Secret value", value, "Stored as a Namespace Secret. The value is never read back."),
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
    select.value = boundSecretId(binding, context) ?? "";
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
        body: { name: modalSecretName(binding, context), value: value.value },
      });
      await bindSecret(binding, context, createdSecret, status, select, secrets, metadataLink);
      if (boundSecretId(binding, context) === createdSecret.id) {
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
    if (creating) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  value.focus();
}

function credentialReferenceField(binding, context = {}) {
  const secretHref = sameNamespaceEnvSecretHref(
    activeSecretSource(binding, context),
    context.namespaceId,
  );
  const select = element("select", {
    id: `slack-secret-${binding.key.toLowerCase().replaceAll("_", "-")}`,
    "aria-describedby": `slack-secret-${binding.key.toLowerCase().replaceAll("_", "-")}-status`,
  });
  const status = element("p", {
    id: `slack-secret-${binding.key.toLowerCase().replaceAll("_", "-")}-status`,
    className: "hint",
    role: "status",
  });
  const metadataLink = credentialLink(
    secretHref ?? "#",
    `View ${binding.label.replace("Slack ", "")} Secret metadata`,
  );
  updateSecretMetadataLink(metadataLink, binding, context);
  const fieldChildren = [
    element("label", { for: select.id, className: "channel-label" }, binding.label),
    select,
    metadataLink,
  ];
  if (!context.namespaceId || typeof context.request !== "function") {
    fieldChildren.push(
      element(
        "p",
        { className: "hint" },
        secretHref
          ? "Secret metadata is bound for this token."
          : "No Secret is bound for this token.",
      ),
    );
    setSecretOptions(select, binding, context);
    select.disabled = true;
    return element("div", { className: "channel-field channel-reference" }, ...fieldChildren);
  }
  const secrets = [];
  setSecretOptions(select, binding, context, secrets);
  status.textContent = "Loading available Secrets...";
  context
    .request(`${namespacePath(context.namespaceId)}/secrets`)
    .then((items) => {
      secrets.splice(
        0,
        secrets.length,
        ...(Array.isArray(items)
          ? items.filter((item) => isSecretMetadata(item, context.namespaceId))
          : []),
      );
      setSecretOptions(select, binding, context, secrets);
      status.textContent = secrets.length
        ? "Choose an existing Secret or create a new one."
        : "No readable Secrets yet. Create a new Secret to bind this token.";
    })
    .catch((error) => {
      status.className = "error";
      status.textContent = credentialMutationError(error);
    });
  select.addEventListener("change", () => {
    if (select.value === CREATE_SECRET_VALUE) {
      select.value = boundSecretId(binding, context) ?? "";
      openCreateSecretDialog(binding, context, status, select, secrets, metadataLink);
      return;
    }
    const secret = secrets.find((item) => item.id === select.value);
    if (secret) {
      void bindSecret(binding, context, secret, status, select, secrets, metadataLink);
    }
  });
  fieldChildren.push(status);
  return element("div", { className: "channel-field channel-reference" }, ...fieldChildren);
}

function credentialNavigation(context = {}) {
  if (!context.credentialsHref) {
    return element(
      "p",
      { className: "hint" },
      "Choose existing Slack token Secrets or create them here before creating the Agent.",
    );
  }
  return element(
    "p",
    { className: "hint" },
    credentialLink(context.credentialsHref, "Open Agent Credentials"),
    " to review runtime credential status. Secret menu changes are saved with these channel settings.",
  );
}

function appendFields(body, config, context) {
  const channelIds = Object.keys(config.channels ?? {});
  const firstChannel = Object.values(config.channels ?? {})[0];
  const users = channelUsers(firstChannel);
  const mention = firstChannel?.requireMention ?? config.requireMention ?? true;
  const allowedUsers = input("slack-allowed-user-ids", users.join(", "));
  const everyoneField = checkbox(
    "slack-allow-everyone",
    "Allow everyone in these channels to mention the agent",
    channelIds.length > 0 && users.length === 0,
  );
  const everyone = everyoneField.querySelector("input");
  const updateAccessControls = () => {
    allowedUsers.disabled = everyone.checked;
    everyone.disabled = uniqueList(allowedUsers.value.split(",")).length > 0;
  };
  allowedUsers.addEventListener("input", updateAccessControls);
  everyone.addEventListener("change", updateAccessControls);
  updateAccessControls();
  const dmPolicy = element("select", { id: "slack-dm-policy" });
  if (context.isConfigured && config.dmPolicy === undefined) {
    dmPolicy.append(element("option", { value: "" }, "Runtime default (pairing)"));
  }
  for (const [value, label] of [
    ["pairing", "Pairing — approve new senders"],
    ["allowlist", "Allowlist — selected users only"],
    ["open", "Open — anyone"],
    ["disabled", "Disabled — no direct messages"],
  ]) {
    dmPolicy.append(element("option", { value }, label));
  }
  dmPolicy.value = config.dmPolicy ?? (context.isConfigured ? "" : "allowlist");
  dmPolicy.dataset.enterpriseRestricted = String(
    config.enterpriseOrgInstall === true && config.dm?.enabled !== false,
  );
  const dmUsers = input("slack-dm-user-ids", (config.allowFrom ?? []).join(", "));
  const updateDmControls = () => {
    dmUsers.disabled = dmPolicy.value === "open" || dmPolicy.value === "disabled";
  };
  dmPolicy.addEventListener("change", () => {
    // Leaving open access must require an explicit sender choice for an allowlist.
    if (
      ["allowlist", "pairing"].includes(dmPolicy.value) &&
      dmUsers.value.split(",").some((id) => id.trim() === "*")
    ) {
      dmUsers.value = "";
    }
    updateDmControls();
  });
  updateDmControls();
  body.append(
    element(
      "p",
      { className: "hint" },
      "Choose channel access and direct-message access separately.",
    ),
    field(
      "Slack channel IDs",
      input("slack-channel-ids", channelIds.join(", ")),
      "Comma-separated channel IDs; existing per-channel properties are preserved.",
    ),
    field(
      "Allowed channel user IDs",
      allowedUsers,
      "Comma-separated Slack user IDs allowed in these channels. Clear the IDs to choose everyone. Direct-message access is unchanged.",
    ),
    everyoneField,
    element(
      "p",
      { className: "hint" },
      "Applies only to the selected channels and respects their existing access restrictions. Require a mention controls when the agent responds.",
    ),
    checkbox("slack-require-mention", "Require a mention", Boolean(mention)),
    element("h2", {}, "Direct messages"),
    field(
      "Direct-message policy",
      dmPolicy,
      "Open allows anyone to send direct messages. Disabled is recommended for organization-wide installs.",
    ),
    field(
      "Allowed DM user IDs",
      dmUsers,
      "Comma-separated Slack user IDs. Required for Allowlist; optional preapproved senders for Pairing. These IDs do not change channel access.",
    ),
    ...(config.enterpriseOrgInstall === true
      ? [
          element(
            "p",
            { className: "hint" },
            "Organization-wide installs support Disabled or Open direct-message access.",
          ),
        ]
      : []),
    ...(config.dm?.enabled === false
      ? [
          element(
            "p",
            { className: "hint" },
            "Direct messages are also disabled in native Configuration (dm.enabled). Changing this policy does not enable them.",
          ),
        ]
      : []),
    element("h2", {}, "Credential references"),
    element(
      "p",
      { className: "hint" },
      "Slack channels use fixed environment names. Secret links show metadata only, never token values.",
    ),
    ...SLACK_SECRET_BINDINGS.map((binding) => credentialReferenceField(binding, context)),
    credentialNavigation(context),
  );
}

function summary(config, status) {
  const ids = Object.keys(config.channels ?? {});
  return [
    config.mode === "socket" || status.label === "Not configured" ? "Socket Mode" : "Native Slack",
    ids.length
      ? `${ids.length} selected channel${ids.length === 1 ? "" : "s"}`
      : "No selected channels",
  ].join(" · ");
}

export const slack = {
  id: "slack",
  name: "Slack",
  description: "Socket Mode with channel and user settings.",
  setup: "Provide SLACK_APP_TOKEN and SLACK_BOT_TOKEN through Secret bindings before deployment.",
  plugin: "slack",
  support: supportSlack,
  validate(body) {
    const ids = uniqueList(body.querySelector("#slack-channel-ids").value.split(","));
    const users = uniqueList(body.querySelector("#slack-allowed-user-ids").value.split(","));
    const allowEveryone = body.querySelector("#slack-allow-everyone").checked;
    if (ids.includes("*")) {
      return "Enter specific Slack channel IDs; wildcard channels require native Configuration JSON.";
    }
    if (users.includes("*")) {
      return "Clear the user IDs and select Allow everyone in these channels to mention the agent.";
    }
    if (ids.length === 0 && (allowEveryone || users.length > 0)) {
      return "Enter at least one Slack channel ID for these access settings.";
    }
    if (ids.length > 0 && users.length === 0 && !allowEveryone) {
      return "Enter allowed channel user IDs or allow everyone in these channels.";
    }
    const dmPolicy = body.querySelector("#slack-dm-policy");
    const dmUsers = uniqueList(body.querySelector("#slack-dm-user-ids").value.split(","));
    if (
      dmPolicy.dataset.enterpriseRestricted === "true" &&
      !["disabled", "open"].includes(dmPolicy.value)
    ) {
      return "Choose Disabled or Open for direct messages on an organization-wide Slack install.";
    }
    if (dmPolicy.value === "allowlist" && (dmUsers.length === 0 || dmUsers.includes("*"))) {
      return "Enter specific allowed DM user IDs, or choose a different direct-message policy.";
    }
    return null;
  },
  updatedValues: updatedSlack,
  updatedSecretBindings,
  appendFields,
  summary,
};
