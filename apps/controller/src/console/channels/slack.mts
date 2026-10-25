import type { SecretBinding, SecretMetadata } from "@openclaw-enterprise/contracts";
import { element } from "../dom.mjs";
import { SLACK_SECRET_BINDINGS } from "../agents/credentials.mjs";
import { createSlackDirectoryField, isSlackConfigTarget } from "../agents/slack-directory.mjs";
import {
  createSecretReferenceField,
  sameNamespaceSecretHref,
  secretBinding,
  secretIdForBinding,
} from "../agents/secret-picker.mjs";
import {
  type ChannelDrawerContext,
  type ChannelProvider,
  type ChannelSupport,
  type ChannelValues,
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

// A token this editor can read back and save unchanged: the standard env SecretRef, or the whole
// `${NAME}` reference to the same binding, which the Configuration save recommends (finding 2495).
const standardToken = (value: unknown, ref: { readonly id: string }) =>
  value === undefined || refsEqual(value, ref) || value === `\${${ref.id}}`;

const DM_POLICIES = ["pairing", "allowlist", "open", "disabled"];
type SlackChannel = { users?: string[]; requireMention?: boolean };
type SlackConfig = ChannelValues & {
  channels?: Record<string, SlackChannel>;
  dmPolicy?: string;
  allowFrom?: string[];
  dm?: { enabled?: boolean };
};
type BindingField = (typeof SLACK_SECRET_BINDINGS)[number];
const originalTargets = new WeakMap<
  HTMLFormElement,
  {
    channels: Set<string>;
    users: Set<string>;
    dmUsers: Set<string>;
  }
>();

function channelUsers(channel: SlackChannel | undefined) {
  const users = uniqueList(channel?.users ?? []);
  return users.includes("*") ? [] : users.sort();
}

function supportSlack(values: ChannelValues): ChannelSupport<SlackConfig> {
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
      reason:
        "Only the default Slack account is supported by this editor. Edit named accounts in the native JSON, and give each its own token environment names, not SLACK_APP_TOKEN or SLACK_BOT_TOKEN.",
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
  if (!standardToken(config.appToken, STANDARD_REFS.slack.appToken)) {
    return {
      supported: false,
      reason: `Slack app token uses a credential reference this editor does not write. To edit Slack here, set appToken to \${SLACK_APP_TOKEN} in the Configuration JSON.`,
      config,
    };
  }
  if (!standardToken(config.botToken, STANDARD_REFS.slack.botToken)) {
    return {
      supported: false,
      reason: `Slack bot token uses a credential reference this editor does not write. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`,
      config,
    };
  }
  if (config.channels !== undefined && !isRecord(config.channels)) {
    return { supported: false, reason: "Slack channels are not stored as a channel map.", config };
  }
  if (
    config.dmPolicy !== undefined &&
    (typeof config.dmPolicy !== "string" || !DM_POLICIES.includes(config.dmPolicy))
  ) {
    return { supported: false, reason: "Slack direct-message policy is unsupported.", config };
  }
  const channelEntries: unknown[] = Object.values(config.channels ?? {});
  if (!channelEntries.every(isRecord)) {
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
      (value) =>
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
  const mentions = [...new Set(channelEntries.map((value) => value.requireMention))];
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
  const senderLists = new Set(channelEntries.map((value) => JSON.stringify(channelUsers(value))));
  if (senderLists.size > 1) {
    return {
      supported: false,
      reason:
        "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
      config,
    };
  }
  // The fields this editor writes have been checked; preserve every other native option.
  return { supported: true, config: config as SlackConfig };
}

function updatedSlack(values: ChannelValues, body: HTMLFormElement) {
  const support = supportSlack(values);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const current = support.config;
  const existingConfig = providerConfig(values, "slack");
  const ids = uniqueList(
    body.querySelector<HTMLInputElement>("#slack-channel-ids")!.value.split(","),
  );
  const users = uniqueList(
    body.querySelector<HTMLInputElement>("#slack-allowed-user-ids")!.value.split(","),
  );
  const allowEveryone =
    body.querySelector<HTMLSelectElement>("#slack-channel-access")!.value === "everyone";
  const requireMention = body.querySelector<HTMLInputElement>("#slack-require-mention")!.checked;
  const existing = isRecord(current.channels) ? current.channels : {};
  const channels: Record<string, SlackChannel> = {};
  for (const id of ids) {
    const entry = isRecord(existing[id]) ? { ...existing[id] } : {};
    channels[id] = { ...entry, requireMention, users: allowEveryone ? ["*"] : users };
  }
  const config: SlackConfig = {
    ...current,
    enabled: body.querySelector<HTMLInputElement>("#slack-enabled")!.checked,
    mode: "socket",
    // A standard token keeps the form it was saved in.
    appToken: current.appToken ?? STANDARD_REFS.slack.appToken,
    botToken: current.botToken ?? STANDARD_REFS.slack.botToken,
    channels,
  };
  if (!isRecord(existingConfig)) {
    config.groupPolicy = "allowlist";
    config.replyToModeByChatType = { channel: "all" };
  }
  const dmPolicy = body.querySelector<HTMLSelectElement>("#slack-dm-policy")!.value;
  if (dmPolicy !== "") {
    config.dmPolicy = dmPolicy;
  }
  const dmUsers = body.querySelector<HTMLInputElement>("#slack-dm-user-ids")!.value;
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

function updatedSecretBindings(context: ChannelDrawerContext) {
  if (context.draftSecretBindings === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
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

function sameNamespaceEnvSecretHref(binding: SecretBinding | undefined, namespaceId: string) {
  if (binding?.source?.namespaceId !== namespaceId || binding?.delivery?.type !== "env") {
    return null;
  }
  return sameNamespaceSecretHref(binding.source, namespaceId);
}

function activeSecretBindings(context: ChannelDrawerContext) {
  return context.draftSecretBindings ?? context.secretBindings ?? {};
}

function activeSecretBinding(binding: BindingField, context: ChannelDrawerContext) {
  return activeSecretBindings(context)[binding.key];
}

function modalSecretName(binding: BindingField, context: ChannelDrawerContext) {
  const agentName =
    typeof context.agentName === "function" ? context.agentName() : context.agentName;
  const trimmedAgentName =
    typeof agentName === "string" && agentName.trim().length ? agentName.trim() : "Slack";
  return `${trimmedAgentName} ${binding.secretName}`;
}

function bindSecret(binding: BindingField, context: ChannelDrawerContext, secret: SecretMetadata) {
  context.draftSecretBindings = {
    ...activeSecretBindings(context),
    [binding.key]: secretBinding(secret),
  };
  context.draftChangedSecrets = {
    ...(context.draftChangedSecrets ?? {}),
    [binding.key]: secret,
  };
}

function credentialReferenceField(
  binding: BindingField,
  context: ChannelDrawerContext,
  onSelected: (key: string) => void,
) {
  const picker = createSecretReferenceField({
    context,
    id: `slack-secret-${binding.key.toLowerCase().replaceAll("_", "-")}`,
    label: binding.label,
    getCurrentSource: () => activeSecretBinding(binding, context)?.source,
    onSecretSelected: (secret) => {
      bindSecret(binding, context, secret);
      onSelected(binding.key);
    },
    createSecretName: () => modalSecretName(binding, context),
    createDialogTitle: `Create ${binding.label} Secret`,
    createFixedKey: {
      label: "Binding key",
      value: binding.key,
      hint: "This environment key is fixed for Slack Socket Mode.",
    },
    metadataLabel: `View ${binding.label.replace("Slack ", "")} Secret metadata`,
    ...(context.creating
      ? { stagedHint: "Secret selected. Apply channel settings, then Create Agent binds it." }
      : {}),
    fieldClassName: "channel-field channel-reference",
    selectClassName: "channel-select",
  });
  return picker;
}

// A hint that offers Secret create, worded choose-only when the token fields disable their create
// action: the Namespace permission answer denies Secret create (finding 2483), or the Secret
// operate answer denies a readable Secret, so a new one could not be chosen (finding 2500). An
// unknown answer keeps the create wording, as the fields keep their create action.
function secretHint(context: ChannelDrawerContext, withCreate: string, chooseOnly: string) {
  const hint = element("p", { className: "hint" }, withCreate);
  const chooseOnlyWhen = (denied: boolean) => {
    if (denied) {
      hint.textContent = chooseOnly;
    }
  };
  void context.secretsCreateAllowed?.().then(
    (allowed) => chooseOnlyWhen(allowed === false),
    () => {},
  );
  void context.secretsOperateDenied?.().then(
    (denied) => chooseOnlyWhen(Boolean(denied?.size)),
    () => {},
  );
  return hint;
}

function credentialNavigation(context: ChannelDrawerContext) {
  return context.creating
    ? secretHint(
        context,
        "Choose existing Slack token Secrets or create them here before creating the Agent.",
        "Choose existing Slack token Secrets before creating the Agent.",
      )
    : secretHint(
        context,
        "Choose existing Slack token Secrets or create them here. Secret menu changes are saved with these channel settings.",
        "Choose existing Slack token Secrets. Secret menu changes are saved with these channel settings.",
      );
}

function appendFields(body: HTMLFormElement, config: SlackConfig, context: ChannelDrawerContext) {
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
  const picker = (kind: "users" | "channels", control: HTMLInputElement, label: string) =>
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
  ] as const) {
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
  const tokenPickers = [...SLACK_SECRET_BINDINGS].reverse().map((binding) =>
    credentialReferenceField(binding, context, (key) => {
      // A chosen Secret fires no field event; the editor rechecks whether Save has a change.
      body.dispatchEvent(new Event("change"));
      if (key === "SLACK_BOT_TOKEN") {
        for (const picker of [channelPicker, allowedUsersPicker, dmUsersPicker]) {
          picker.refreshNames();
        }
      }
    }),
  );
  // Configuration save refuses an enabled channel whose token references have no Secret
  // binding (finding 2319), so a drawer that saves names the missing token under its picker
  // first. Create Agent's drawer only stages settings, which may take several visits; its
  // preflight refuses an unbound token before anything is saved.
  const enabled = body.querySelector<HTMLInputElement>("#slack-enabled");
  const requireTokens = () => {
    for (const picker of tokenPickers) {
      picker.setRequired(!context.creating && enabled?.checked !== false);
    }
  };
  enabled?.addEventListener("change", requireTokens);
  requireTokens();
  body.append(
    element("h2", {}, "Slack credentials"),
    secretHint(
      context,
      "First, select or create a Slack bot token Secret to search channels and people by name. Then choose an app token for Socket Mode and configure access below. An enabled Slack channel saves only with both tokens.",
      "First, select a Slack bot token Secret to search channels and people by name. Then choose an app token for Socket Mode and configure access below. An enabled Slack channel saves only with both tokens.",
    ),
    ...tokenPickers.map((picker) => picker.field),
    credentialNavigation(context),
    element("h2", {}, "Channel access"),
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
  );
}

function summary(config: SlackConfig, status: { label: string }) {
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
  // Comma lists: a save conflict carries the entries the reader added and removed.
  listFields: ["slack-channel-ids", "slack-allowed-user-ids", "slack-dm-user-ids"],
  support: supportSlack,
  validate(body) {
    const existing = originalTargets.get(body);
    const ids = uniqueList(
      body.querySelector<HTMLInputElement>("#slack-channel-ids")!.value.split(","),
    );
    const users = uniqueList(
      body.querySelector<HTMLInputElement>("#slack-allowed-user-ids")!.value.split(","),
    );
    const allowEveryone =
      body.querySelector<HTMLSelectElement>("#slack-channel-access")!.value === "everyone";
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
    const dmPolicy = body.querySelector<HTMLSelectElement>("#slack-dm-policy")!;
    const dmUsers = uniqueList(
      body.querySelector<HTMLInputElement>("#slack-dm-user-ids")!.value.split(","),
    );
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
} satisfies ChannelProvider<SlackConfig>;
