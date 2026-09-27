import { element } from "../dom.mjs";
import { SLACK_SECRET_BINDINGS, secretIdForBinding } from "../agents/credentials.mjs";
import { createSlackDirectoryField, isSlackConfigTarget } from "../agents/slack-directory.mjs";
import {
  createSecretReferenceField,
  sameNamespaceSecretHref,
  secretBinding,
} from "../agents/secret-picker.mjs";
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
const originalTargets = new WeakMap();

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
  const allowEveryone = body.querySelector("#slack-channel-access").value === "everyone";
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
  if (binding?.source?.namespaceId !== namespaceId || binding?.delivery?.type !== "env") {
    return null;
  }
  return sameNamespaceSecretHref(binding.source, namespaceId);
}

function activeSecretBindings(context) {
  return context.draftSecretBindings ?? context.secretBindings ?? {};
}

function activeSecretBinding(binding, context) {
  return activeSecretBindings(context)[binding.key];
}

function modalSecretName(binding, context) {
  const agentName =
    typeof context.agentName === "function" ? context.agentName() : context.agentName;
  const trimmedAgentName =
    typeof agentName === "string" && agentName.trim().length ? agentName.trim() : "Slack";
  return `${trimmedAgentName} ${binding.secretName}`;
}

async function bindSecret(binding, context, secret) {
  context.draftSecretBindings = {
    ...activeSecretBindings(context),
    [binding.key]: secretBinding(secret),
  };
  context.draftChangedSecrets = {
    ...(context.draftChangedSecrets ?? {}),
    [binding.key]: secret,
  };
}

function credentialReferenceField(binding, context = {}, onSelected) {
  const picker = createSecretReferenceField({
    context,
    id: `slack-secret-${binding.key.toLowerCase().replaceAll("_", "-")}`,
    label: binding.label,
    getCurrentSource: () => activeSecretBinding(binding, context)?.source,
    onSecretSelected: async (secret) => {
      await bindSecret(binding, context, secret);
      onSelected?.(binding.key);
    },
    createSecretName: () => modalSecretName(binding, context),
    createDialogTitle: `Create ${binding.label} Secret`,
    createFixedKey: {
      label: "Binding key",
      value: binding.key,
      hint: "This environment key is fixed for Slack Socket Mode.",
    },
    metadataLabel: `View ${binding.label.replace("Slack ", "")} Secret metadata`,
    fieldClassName: "channel-field channel-reference",
    selectClassName: "channel-select",
  });
  return picker.field;
}

function credentialNavigation(context) {
  return element(
    "p",
    { className: "hint" },
    context.creating
      ? "Choose existing Slack token Secrets or create them here before creating the Agent."
      : "Choose existing Slack token Secrets or create them here. Secret menu changes are saved with these channel settings.",
  );
}

function appendFields(body, config, context) {
  const channelIds = Object.keys(config.channels ?? {});
  const firstChannel = Object.values(config.channels ?? {})[0];
  const users = channelUsers(firstChannel);
  originalTargets.set(body, {
    channels: new Set(channelIds),
    users: new Set(users),
    dmUsers: new Set(config.allowFrom ?? []),
  });
  const mention = firstChannel?.requireMention ?? config.requireMention ?? true;
  const allowedUsers = input("slack-allowed-user-ids", users.join(", "));
  const getSecretId = () => {
    const source = activeSecretBindings(context).SLACK_BOT_TOKEN?.source;
    return source?.kind === "secret" && source.namespaceId === context.namespaceId
      ? source.id
      : null;
  };
  const workspace = element("p", { className: "hint slack-directory-workspace" });
  const channelInput = input("slack-channel-ids", channelIds.join(", "));
  const picker = (kind, control, label) =>
    createSlackDirectoryField({
      context,
      kind,
      control,
      label,
      getSecretId,
      configurationId: context.configurationId,
      onWorkspace: (page) => {
        workspace.textContent = page
          ? `Slack workspace: ${page.workspaceName || page.workspaceId}`
          : "";
        workspace.title = page?.workspaceId ?? "";
      },
    });
  const channelPicker = picker("channels", channelInput, "Channels");
  const allowedUsersPicker = picker("users", allowedUsers, "Allowed people in these channels");
  const access = element(
    "select",
    { id: "slack-channel-access" },
    element("option", { value: "selected" }, "Specific people"),
    element("option", { value: "everyone" }, "Everyone in these channels"),
  );
  access.value = channelIds.length > 0 && users.length === 0 ? "everyone" : "selected";
  const updateAccessControls = () => {
    allowedUsers.disabled = access.value === "everyone";
    allowedUsersPicker.hidden = allowedUsers.disabled;
    allowedUsersPicker.refreshValue();
  };
  access.addEventListener("change", updateAccessControls);
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
  const dmUsersPicker = picker("users", dmUsers, "Allowed people in direct messages");
  const updateDmControls = () => {
    dmUsers.disabled = dmPolicy.value === "open" || dmPolicy.value === "disabled";
    dmUsersPicker.hidden = dmUsers.disabled;
    dmUsersPicker.refreshValue();
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
    workspace,
    channelPicker,
    field(
      "Who can use the agent in these channels?",
      access,
      "Applies only to the selected channels and respects their existing access restrictions.",
    ),
    allowedUsersPicker,
    checkbox("slack-require-mention", "Require a mention", Boolean(mention)),
    element("h2", {}, "Direct messages"),
    field(
      "Direct-message policy",
      dmPolicy,
      "Open allows anyone to send direct messages. Disabled is recommended for organization-wide installs.",
    ),
    dmUsersPicker,
    element(
      "p",
      { className: "hint" },
      "For Pairing, selected people are preapproved. Other senders need approval. Direct-message access is separate from channel access.",
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
    ...SLACK_SECRET_BINDINGS.map((binding) =>
      credentialReferenceField(binding, context, (key) => {
        if (key === "SLACK_BOT_TOKEN") {
          for (const picker of [channelPicker, allowedUsersPicker, dmUsersPicker]) {
            picker.refreshNames();
          }
        }
      }),
    ),
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
  secretBindings: SLACK_SECRET_BINDINGS,
  support: supportSlack,
  validate(body) {
    const existing = originalTargets.get(body);
    const ids = uniqueList(body.querySelector("#slack-channel-ids").value.split(","));
    const users = uniqueList(body.querySelector("#slack-allowed-user-ids").value.split(","));
    const allowEveryone = body.querySelector("#slack-channel-access").value === "everyone";
    if (ids.includes("*")) {
      return "Enter specific Slack channel IDs; wildcard channels require native Configuration JSON.";
    }
    if (users.includes("*")) {
      return "Choose Everyone in these channels instead of entering a wildcard user ID.";
    }
    if (ids.length === 0 && (allowEveryone || users.length > 0)) {
      return "Enter at least one Slack channel ID for these access settings.";
    }
    if (ids.length > 0 && users.length === 0 && !allowEveryone) {
      return "Choose specific people or select Everyone in these channels.";
    }
    if (ids.some((id) => !isSlackConfigTarget(id, "channels") && !existing?.channels.has(id))) {
      return "Enter exact Slack channel IDs or channel targets, or choose channels from the directory.";
    }
    if (users.some((id) => !isSlackConfigTarget(id, "users") && !existing?.users.has(id))) {
      return "Enter exact Slack user IDs or user targets, or choose people from the directory.";
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
    if (
      dmUsers.some(
        (id) => id !== "*" && !isSlackConfigTarget(id, "users") && !existing?.dmUsers.has(id),
      )
    ) {
      return "Enter exact allowed DM user IDs or user targets, or choose people from the directory.";
    }
    return null;
  },
  updatedValues: updatedSlack,
  updatedSecretBindings,
  appendFields,
  summary,
};
