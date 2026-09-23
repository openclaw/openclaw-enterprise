import { element } from "../dom.mjs";
import { SLACK_SECRET_BINDINGS, secretIdForBinding } from "../agents/credentials.mjs";
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
  const channelEntries = Object.entries(config.channels ?? {});
  if (channelEntries.some(([, value]) => !isRecord(value))) {
    return {
      supported: false,
      reason: "At least one Slack channel entry is not an object.",
      config,
    };
  }
  if (config.allowFrom !== undefined && !arrayOfStrings(config.allowFrom)) {
    return {
      supported: false,
      reason: "Slack allowed users are not stored as string IDs.",
      config,
    };
  }
  if (
    channelEntries.some(
      ([, value]) =>
        (value.users !== undefined && !arrayOfStrings(value.users)) ||
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
  return { supported: true, config };
}

function updatedSlack(values, body) {
  const current = supportSlack(values).config;
  const existingConfig = providerConfig(values, "slack");
  const ids = uniqueList(body.querySelector("#slack-channel-ids").value.split(","));
  const users = uniqueList(body.querySelector("#slack-allowed-user-ids").value.split(","));
  const requireMention = body.querySelector("#slack-require-mention").checked;
  const existing = isRecord(current.channels) ? current.channels : {};
  const channels = {};
  for (const id of ids) {
    const entry = isRecord(existing[id]) ? { ...existing[id] } : {};
    channels[id] = { ...entry, requireMention };
  }
  const config = {
    ...current,
    enabled: body.querySelector("#slack-enabled").checked,
    mode: "socket",
    appToken: STANDARD_REFS.slack.appToken,
    botToken: STANDARD_REFS.slack.botToken,
    allowFrom: users,
    channels,
  };
  if (!isRecord(existingConfig)) {
    config.dmPolicy = "allowlist";
    config.groupPolicy = "allowlist";
  }
  return withProvider(values, "slack", config);
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
  return `/namespaces/${encodeURIComponent(namespaceId)}/secrets/${encodeURIComponent(secretId)}`;
}

function credentialLink(href, label) {
  return element("a", { href, target: "_blank", rel: "noopener" }, `${label} (opens in new tab)`);
}

function credentialReferenceField(binding, context = {}) {
  const source = context.secretBindings?.[binding.key];
  const secretHref = sameNamespaceEnvSecretHref(source, context.namespaceId);
  const fieldChildren = [element("span", { className: "channel-label" }, binding.label)];
  if (secretHref) {
    fieldChildren.push(
      credentialLink(secretHref, `View ${binding.label.replace("Slack ", "")} Secret metadata`),
    );
  } else {
    fieldChildren.push(
      element(
        "p",
        { className: "hint" },
        "No Secret is bound for this token. Add it in Credentials.",
      ),
    );
  }
  return element("div", { className: "channel-field channel-reference" }, ...fieldChildren);
}

function credentialNavigation(context = {}) {
  if (!context.credentialsHref) {
    return element(
      "p",
      { className: "hint" },
      "Create the Agent, then use Credentials to add Slack tokens.",
    );
  }
  return element(
    "p",
    { className: "hint" },
    credentialLink(context.credentialsHref, "Open Agent Credentials"),
    " to store Slack tokens. Save channel edits before changing credentials. After credential changes, refresh this page before editing channels again.",
  );
}

function appendFields(body, config, context) {
  const channelIds = Object.keys(config.channels ?? {});
  const users = uniqueList(Array.isArray(config.allowFrom) ? config.allowFrom : []);
  const mention = Object.values(config.channels ?? {})[0]?.requireMention ?? true;
  body.append(
    element(
      "p",
      { className: "hint" },
      "Saving preserves existing direct-message and channel access policies.",
    ),
    field(
      "Slack channel IDs",
      input("slack-channel-ids", channelIds.join(", ")),
      "Comma-separated channel IDs; existing per-channel properties are preserved.",
    ),
    field(
      "Allowed user IDs",
      input("slack-allowed-user-ids", users.join(", ")),
      "Comma-separated direct-message allowFrom user IDs.",
    ),
    checkbox("slack-require-mention", "Require a mention", Boolean(mention)),
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
  const users = uniqueList(Array.isArray(config.allowFrom) ? config.allowFrom : []);
  return [
    config.mode === "socket" || status.label === "Not configured" ? "Socket Mode" : "Native Slack",
    ids.length
      ? `${ids.length} selected channel${ids.length === 1 ? "" : "s"}`
      : "No selected channels",
    users.length
      ? `${users.length} allowed user${users.length === 1 ? "" : "s"}`
      : "No allowed users",
  ].join(" · ");
}

export const slack = {
  id: "slack",
  name: "Slack",
  description: "Socket Mode with channel and user settings.",
  setup: "Use the Agent Credentials tab after creation for SLACK_APP_TOKEN and SLACK_BOT_TOKEN.",
  plugin: "slack",
  support: supportSlack,
  updatedValues: updatedSlack,
  appendFields,
  summary,
};
