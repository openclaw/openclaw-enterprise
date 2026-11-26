import type { SecretBinding } from "@openclaw-enterprise/contracts";
import { button, element } from "../dom.mjs";
import { namedDenial, requestFailure } from "../api-client.mjs";
import { readCredentialSourceMetadata } from "../credential-source-metadata.mjs";
import {
  createCredentialSourcePicker,
  staticCredentialSourceSelection,
} from "../credential-source-picker.mjs";
import { SLACK_SECRET_BINDINGS } from "../agents/credentials.mjs";
import { createSlackDirectoryField, isSlackConfigTarget } from "../agents/slack-directory.mjs";
import {
  environmentReferenceNames,
  secretInputShorthandName,
  unsubstitutedReference,
} from "../environment-references.mjs";
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

// The card names a token it cannot edit as Configuration save names it, and never shows it
// (findings 2523, 2530). A string is a reference only in a form the runtime reads as one, or with
// a `${` it keeps as written. An object with a source is a SecretRef; any other object is the
// object save refuses. Every other value holds the credential inline.
const INLINE_TOKEN = "holds a credential value inline, where a reference is required";
const REFERENCE_TOKEN = "uses a credential reference this editor does not write";
const tokenForm = (value: unknown) => {
  if (typeof value === "string") {
    return secretInputShorthandName(value) !== undefined ||
      environmentReferenceNames(value).length > 0 ||
      unsubstitutedReference(value) !== undefined
      ? REFERENCE_TOKEN
      : INLINE_TOKEN;
  }
  if (isRecord(value)) {
    return typeof value.source === "string"
      ? REFERENCE_TOKEN
      : "holds an object the Slack Channel Driver cannot read";
  }
  return INLINE_TOKEN;
};

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
const unresolvedSourceCreates = new WeakMap<object, Set<string>>();

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
      reason: `Slack app token ${tokenForm(config.appToken)}. To edit Slack here, set appToken to \${SLACK_APP_TOKEN} in the Configuration JSON.`,
      config,
    };
  }
  if (!standardToken(config.botToken, STANDARD_REFS.slack.botToken)) {
    return {
      supported: false,
      reason: `Slack bot token ${tokenForm(config.botToken)}. To edit Slack here, set botToken to \${SLACK_BOT_TOKEN} in the Configuration JSON.`,
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
  return {
    secretBindings: context.draftSecretBindings,
  };
}

function bindingSource(binding: SecretBinding | undefined, namespaceId: string) {
  const source = binding?.source;
  return source?.kind === "credential_source" &&
    source.namespaceId === namespaceId &&
    (binding?.delivery === undefined || binding.delivery.type === "env")
    ? source
    : null;
}

function activeSecretBindings(context: ChannelDrawerContext) {
  return context.draftSecretBindings ?? context.secretBindings ?? {};
}

function activeSecretBinding(binding: BindingField, context: ChannelDrawerContext) {
  return activeSecretBindings(context)[binding.key];
}

function credentialReferenceField(
  binding: BindingField,
  context: ChannelDrawerContext,
  body: HTMLFormElement,
  onSelected: (key: string) => void,
  onEnrollmentPending: (value: boolean) => void,
) {
  const initial = bindingSource(activeSecretBinding(binding, context), context.namespaceId);
  const currentId = initial?.id;
  const enrollmentKey = `${context.namespaceId}:${binding.key}`;
  const enrollmentOwner = context.drafts ?? context;
  const unresolved = unresolvedSourceCreates.get(enrollmentOwner) ?? new Set<string>();
  unresolvedSourceCreates.set(enrollmentOwner, unresolved);
  const id = `slack-source-${binding.key.toLowerCase().replaceAll("_", "-")}`;
  const picker = createCredentialSourcePicker(context, {
    ...staticCredentialSourceSelection,
    listStatus: (hasEligible) =>
      hasEligible
        ? staticCredentialSourceSelection.listStatus(true)
        : "No ready static Credential Sources are readable in this Namespace. Select Add new credential… to create one here.",
    id,
    label: binding.label,
    addNew: { label: "Add new credential…" },
    initial,
    ...(currentId ? { currentId } : {}),
    onChange: (source) => {
      const next = { ...activeSecretBindings(context) };
      if (source) {
        next[binding.key] = { source, delivery: { type: "env" } };
      } else {
        delete next[binding.key];
      }
      context.draftSecretBindings = next;
      onSelected(binding.key);
      feedback.textContent = "";
      renderEnrollment();
    },
  });
  const sourceName = element("input", {
    id: `${id}-name`,
    autocomplete: "off",
    maxlength: "200",
    "data-channel-enrollment": "",
  });
  const token = element("input", {
    id: `${id}-value`,
    type: "password",
    autocomplete: "new-password",
  });
  const feedback = element("p", { className: "hint", role: "status" });
  const create = button("Create credential", () => void enroll(), { tone: "secondary" });
  const cancel = button("Cancel", () => {
    token.value = "";
    sourceName.value = "";
    picker.cancelCreating();
  });
  const enrollment = element(
    "div",
    { className: "credential-enrollment", hidden: true },
    field(`${binding.label} Source name`, sourceName),
    field(`${binding.label} value`, token),
    element("div", { className: "dialog-actions" }, cancel, create),
  );
  picker.field.append(enrollment, feedback);
  function renderEnrollment() {
    const blocked = unresolved.has(enrollmentKey);
    enrollment.hidden = !picker.creating;
    sourceName.required = picker.creating;
    token.required = picker.creating;
    create.disabled = blocked;
    picker.setAddNewDisabled(blocked);
    if (blocked) {
      feedback.textContent =
        "The credential save could not be confirmed. Check Credential Sources and the credential owner, then reload this page before creating another Source.";
    }
  }
  async function enroll() {
    if (unresolved.has(enrollmentKey) || !sourceName.reportValidity() || !token.reportValidity()) {
      return;
    }
    const requestedName = sourceName.value.trim();
    if (!requestedName) {
      sourceName.setCustomValidity("Enter a Source name.");
      sourceName.reportValidity();
      return;
    }
    sourceName.setCustomValidity("");
    const controls = [
      ...body.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, button, select, textarea"),
    ];
    const disabled = controls.map((control) => control.disabled);
    for (const control of controls) {
      control.disabled = true;
    }
    onEnrollmentPending(true);
    const dialog = body.closest("dialog");
    const preventCancel = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    dialog?.addEventListener("cancel", preventCancel, true);
    feedback.textContent = "Creating credential…";
    try {
      const request = context.request(
        `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources`,
        {
          method: "POST",
          expectedStatus: 201,
          body: { name: requestedName, type: "static", secret: token.value },
        },
      );
      token.value = "";
      const response = await request;
      const source = readCredentialSourceMetadata(response, context.namespaceId);
      if (
        !source ||
        source.name !== requestedName ||
        source.type !== "static" ||
        source.state !== "ready"
      ) {
        throw new Error("The create response did not confirm the requested Source.");
      }
      picker.selectCreated(source);
      sourceName.value = "";
      feedback.textContent = `Credential Source created: ${source.id}. Using it requires exact Source operate permission.`;
    } catch (cause) {
      token.value = "";
      const { status } = requestFailure(cause);
      if (status === 401) {
        context.onExpired();
      } else if (status === 403) {
        feedback.textContent =
          namedDenial(cause) ?? "You need Credential Source create on this Namespace.";
      } else if (status === 400 || status === 404) {
        feedback.textContent = "The Source was refused. Check its name and value.";
      } else if (status === 429) {
        feedback.textContent = "The request was rate limited. Try again later.";
      } else if (status === 501) {
        feedback.textContent = "The selected credential owner does not support this operation.";
      } else if (status === 409) {
        feedback.textContent =
          "Credential Source creation conflicted. Check Credential Sources and the owner before retrying with a different name.";
      } else {
        unresolved.add(enrollmentKey);
      }
    } finally {
      dialog?.removeEventListener("cancel", preventCancel, true);
      controls.forEach((control, index) => {
        control.disabled = disabled[index]!;
      });
      onEnrollmentPending(false);
      renderEnrollment();
      body.dispatchEvent(new Event("change"));
    }
  }
  sourceName.addEventListener("input", () => sourceName.setCustomValidity(""));
  enrollment.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target === sourceName || event.target === token)) {
      event.preventDefault();
      create.click();
    }
  });
  renderEnrollment();
  picker.field.classList.add("channel-field", "channel-reference");
  picker.control.classList.add("channel-select");
  picker.control.dataset.channelBinding = "";
  picker.setActive(true);
  return picker;
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
  const getSourceId = () =>
    bindingSource(activeSecretBindings(context).SLACK_BOT_TOKEN, context.namespaceId)?.id ?? null;
  const workspace = element("p", { className: "hint slack-directory-workspace" });
  const channelInput = input("slack-channel-ids", channelIds.join(", "));
  const picker = (kind: "users" | "channels", control: HTMLInputElement, label: string) =>
    createSlackDirectoryField({
      context,
      kind,
      control,
      label,
      getSourceId,
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
    credentialReferenceField(
      binding,
      context,
      body,
      (key) => {
        // The binding is staged separately from ordinary fields.
        body.dispatchEvent(new Event("change"));
        if (key === "SLACK_BOT_TOKEN") {
          for (const picker of [channelPicker, allowedUsersPicker, dmUsersPicker]) {
            picker.refreshNames();
          }
        }
      },
      (pending) => {
        for (const picker of tokenPickers) {
          picker.setDisabled(pending);
        }
      },
    ),
  );
  // Configuration save refuses an enabled channel whose token references have no Source
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
    element(
      "p",
      { className: "hint" },
      "Choose ready static Credential Sources or add new credentials for the Slack bot and app tokens. An enabled Slack channel requires both tokens.",
    ),
    ...tokenPickers.map((picker) => picker.field),
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
  setup:
    "Bind ready static Credential Sources to SLACK_APP_TOKEN and SLACK_BOT_TOKEN before deployment.",
  plugin: "slack",
  secretBindings: SLACK_SECRET_BINDINGS,
  acceptsBinding: (source, namespaceId) =>
    source?.kind === "credential_source" && source.namespaceId === namespaceId,
  // Comma lists: a save conflict carries the entries the reader added and removed.
  listFields: ["slack-channel-ids", "slack-allowed-user-ids", "slack-dm-user-ids"],
  support: supportSlack,
  validate(body) {
    if (body.querySelector(".credential-enrollment:not([hidden])")) {
      return "Create the new credential or Cancel before saving channel settings.";
    }
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
