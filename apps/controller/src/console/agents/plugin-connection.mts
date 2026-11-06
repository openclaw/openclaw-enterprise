import type {
  AgentPluginCredentialSlot,
  PluginConnectionTemplateChoice,
} from "@openclaw-enterprise/contracts";
import { button, dismissOnBackdrop, element, field, mayReturnFocus } from "../dom.mjs";
import { requestFailure } from "../api-client.mjs";
import { connectionTemplatesPage } from "../navigation.mjs";

export type SlotTemplate = PluginConnectionTemplateChoice;

const pluginConsentKey = "oce.pluginAccountConsent";

type ConsentOutcome = "attached" | "saved" | "unconfirmed" | "failed" | "expired" | "cancelled";
type ConsentStart = { authorizationUrl: string; credentialSourceId: string; expiresAt: string };

/** Only the separately opened tab holds this channel name. The server has already consumed the OAuth callback. */
export function finishPluginConsentTab() {
  const url = new URL(location.href);
  const returned = url.searchParams.get("connection");
  const outcome = returned === "connected" ? "saved" : returned;
  if (!["attached", "saved", "unconfirmed", "failed"].includes(outcome ?? "")) {
    return false;
  }
  let name: string | null;
  try {
    name = sessionStorage.getItem(pluginConsentKey);
    sessionStorage.removeItem(pluginConsentKey);
  } catch {
    return false;
  }
  if (!name) {
    return false;
  }
  const channel = new BroadcastChannel(name);
  channel.postMessage(outcome);
  channel.close();
  document.body.replaceChildren(
    element("p", { role: "status" }, "Return to the Agent tab to check your connection."),
  );
  window.close();
  return true;
}

/** Open synchronously on the user's click and sever the opener before navigating to the provider. */
export async function authorizePluginInNewTab(
  begin: () => Promise<ConsentStart>,
  signal: AbortSignal,
  waiting: (sourceId: string, confirmed: () => void) => void,
) {
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    return { message: "Allow pop-ups for this Console, then try again." } as const;
  }
  let channel: BroadcastChannel | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finished = new AbortController();
  try {
    tab.opener = null;
    const name = pluginConsentKey + "." + crypto.randomUUID();
    channel = new BroadcastChannel(name);
    tab.sessionStorage.setItem(pluginConsentKey, name);
    tab.document.title = "Account sign-in";
    tab.document.body.textContent = "Opening your provider…";
    const start = await begin();
    const provider = new URL(start.authorizationUrl);
    const deadline = Date.parse(start.expiresAt);
    if (
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      !start.credentialSourceId ||
      !Number.isFinite(deadline)
    ) {
      throw new Error("Invalid provider response.");
    }
    if (tab.closed || signal.aborted) {
      return { message: "Sign-in was closed. Try again to connect an account." } as const;
    }
    const outcome = await new Promise<ConsentOutcome>((resolve) => {
      channel!.onmessage = ({ data }) => {
        if (
          data === "attached" ||
          data === "saved" ||
          data === "unconfirmed" ||
          data === "failed"
        ) {
          resolve(data);
        }
      };
      signal.addEventListener("abort", () => resolve("cancelled"), {
        once: true,
        signal: finished.signal,
      });
      timeout = setTimeout(() => resolve("expired"), Math.max(0, deadline - Date.now()));
      tab.location.replace(provider.href);
      // COOP can sever the WindowProxy while consent is still in progress. Keep listening
      // for the callback and let the user check or retry from the original editor.
      waiting(start.credentialSourceId, () => resolve("attached"));
    });
    return { outcome, sourceId: start.credentialSourceId } as const;
  } finally {
    finished.abort();
    clearTimeout(timeout);
    channel?.close();
    tab.close();
  }
}

type TemplateSetup = NonNullable<AgentPluginCredentialSlot["templateSetup"]> & {
  namespaceId: string;
};

export interface SlotConnection {
  grantOnCreate?: true;
  unavailable(slot: AgentPluginCredentialSlot): string | undefined;
  feedback?(slot: AgentPluginCredentialSlot, sourceId?: string): string | undefined;
  list(slot: AgentPluginCredentialSlot): Promise<{
    templates: readonly SlotTemplate[];
    setup?: TemplateSetup;
  }>;
  start(
    slot: AgentPluginCredentialSlot,
    template: SlotTemplate,
    selectedScopes: readonly string[] | undefined,
    waiting: (check: () => Promise<string | undefined>) => void,
    stage: (sourceId: string) => boolean,
  ): Promise<string | void>;
}

function consentScopes(template: SlotTemplate, setSelection: (scopes: string[] | null) => void) {
  const unrestricted = template.scopes.length === 0;
  const fieldset = element(
    "fieldset",
    { className: "stack" },
    element("legend", {}, "Permissions for this connection"),
  );
  const fixed = template.mode === "manual" && !unrestricted;
  const suggestions = unrestricted ? template.offeredScopes : template.scopes;
  const incompatible =
    !unrestricted && template.requiredScopes.some((scope) => !template.scopes.includes(scope));
  const choices = [...new Set([...template.requiredScopes, ...suggestions])].map((scope) => {
    const required = fixed || template.requiredScopes.includes(scope);
    const input = element("input", { type: "checkbox", value: scope });
    input.checked = true;
    input.disabled = required;
    fieldset.append(
      element(
        "label",
        { className: "plugin-toggle" },
        input,
        required ? `${scope} (required)` : scope,
      ),
    );
    return input;
  });
  const optional = choices.filter((input) => !input.disabled);
  const toggle = button(
    "Unselect all",
    () => {
      const select = optional.some((input) => !input.checked);
      for (const input of optional) {
        input.checked = select;
      }
      update();
    },
    { tone: "secondary", size: "sm" },
  );
  if (optional.length) {
    fieldset.insertBefore(
      element("div", { className: "form-actions" }, toggle),
      fieldset.children[1] ?? null,
    );
  }
  const extra = unrestricted
    ? element("input", {
        type: "text",
        spellcheck: false,
        autocapitalize: "none",
        autocomplete: "off",
      })
    : null;
  const problem = element("p", { className: "hint", role: "status" });
  if (extra) {
    // A text input in the new Agent's picker would otherwise submit its enclosing form.
    extra.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
    fieldset.append(
      field({
        label: "Additional scopes",
        control: extra,
        help: "Separate scope names with spaces.",
      }),
    );
    if (template.requiredScopes.length === 0) {
      fieldset.append(
        element("p", { className: "hint" }, "Leave all scopes empty to use the provider defaults."),
      );
    }
  }
  fieldset.append(problem);
  function update() {
    toggle.textContent = optional.every((input) => input.checked) ? "Unselect all" : "Select all";
    const checked = choices.filter((input) => input.checked).map((input) => input.value);
    const added = extra?.value.trim().split(/\s+/).filter(Boolean) ?? [];
    const invalid = added.some(
      (scope) => scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    );
    const message = incompatible
      ? "The server requires a scope outside the template’s approved scopes."
      : invalid
        ? "Use printable ASCII scope names of up to 512 characters, without double quotes or backslashes."
        : "";
    if (extra) {
      extra.setCustomValidity(message);
      extra.setAttribute("aria-invalid", String(invalid));
    }
    problem.textContent = message;
    problem.hidden = !message;
    const selected = [...new Set([...checked, ...added])];
    setSelection(message || (!unrestricted && !selected.length) ? null : selected);
  }
  fieldset.addEventListener("input", update);
  update();
  return fieldset;
}

function templateSetupActions(setup: TemplateSetup, refresh: () => void) {
  const settings = new URL(`/console/${connectionTemplatesPage}`, location.origin);
  settings.searchParams.set("namespace", setup.namespaceId);
  const link = (url: URL, label: string) =>
    element(
      "a",
      {
        className: "button button--secondary button--sm",
        href: url.href,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      label,
    );
  const drafts = setup.unregisteredTemplates;
  const actions = element("div", { className: "form-actions" });
  const guidance = drafts.length
    ? "Assign an OAuth client to a compatible template in Credentials, then refresh templates here."
    : "Create a connection template and assign an OAuth client in Credentials, then refresh templates here.";

  for (const draft of drafts) {
    const url = new URL(settings);
    url.searchParams.set("edit", draft.id);
    const sameName = drafts.filter((other) => other.displayName === draft.displayName);
    const sameScope = sameName.filter((other) => other.namespaceId === draft.namespaceId);
    const scope = draft.namespaceId ? "this Namespace" : "Installation-wide";
    const qualifier =
      sameScope.length > 1 ? ` (${scope}, ${draft.id})` : sameName.length > 1 ? ` (${scope})` : "";
    actions.append(link(url, `Configure ${draft.displayName}${qualifier}`));
  }
  if (!drafts.length) {
    settings.searchParams.set("create", "1");
    if (setup.mcpServerUrl) {
      settings.searchParams.set("mcpServerUrl", setup.mcpServerUrl);
    }
    if (setup.issuers.length === 1) {
      settings.searchParams.set("issuer", setup.issuers[0]!);
    }
    actions.append(link(settings, "Create connection template"));
  }
  actions.append(button("Refresh templates", refresh, { tone: "secondary", size: "sm" }));

  return element(
    "div",
    { className: "stack" },
    element("p", { className: "hint" }, guidance),
    actions,
  );
}

export function pluginConnectionControl(
  slot: AgentPluginCredentialSlot,
  connections: SlotConnection,
  currentSourceId: string | undefined,
  stage: (sourceId: string) => boolean,
) {
  const currentSource = slot.sources.find((source) => source.id === currentSourceId);
  const currentName = currentSourceId ? (currentSource?.name ?? "the current account") : undefined;
  const needsConsent = currentSourceId
    ? currentSource?.authorization === "required"
    : slot.sources.some((source) => source.authorization === "required");
  if (!slot.connectAccount && !slot.templateSetup) {
    return needsConsent
      ? element(
          "p",
          { className: "hint" },
          connections.unavailable(slot) ??
            "This slot needs a connection template and permission to start consent for this server.",
        )
      : null;
  }
  const notice = element("p", { className: "hint", role: "status" });
  const feedback = connections.feedback?.(slot, currentSourceId);
  if (feedback) {
    notice.textContent = feedback;
  } else if (connections.grantOnCreate && currentSource && !currentSource.authorization) {
    notice.textContent = "Creating the Agent grants it access to this account.";
  }
  let busy = false;
  let attempt = 0;
  let checkButton: HTMLButtonElement | undefined;
  let retryButton: HTMLButtonElement | undefined;
  const open = button(
    !slot.connectAccount
      ? "Configure connection template"
      : needsConsent
        ? "Authorize for this server"
        : currentName
          ? "Connect a different account"
          : "Choose a connection template",
    choose,
    { tone: "secondary", size: "sm" },
  );
  const root = element("div", { className: "stack" }, open, notice);
  const unavailable = connections.unavailable(slot);
  if (unavailable) {
    open.hidden = true;
    notice.textContent = unavailable;
  }
  function describeError(cause: unknown) {
    const { status } = requestFailure(cause);
    if (status === 401) {
      return "Your session expired. Sign in before connecting an account.";
    }
    if (status === 403) {
      return connections.grantOnCreate
        ? "You need permission to connect an account in this Namespace."
        : "You need permission to update this Agent and connect an account in this Namespace.";
    }
    if (status === 409) {
      return "The template or plugin selection changed. Reload the Agent before connecting.";
    }
    return "Could not load or start the connection. Check the connection templates and try again.";
  }
  function choose() {
    if (busy || connections.unavailable(slot)) {
      return;
    }
    const title = "Connect an account";
    const dialog = element("dialog", {
      className: "dialog dialog--framed plugin-consent-dialog",
      "aria-label": title,
    });
    const content = element("div");
    const status = element("p", { className: "hint", role: "status" });
    const body = element("div", { className: "dialog-body" }, content, status);
    let template: SlotTemplate | undefined;
    let selectedScopes: readonly string[] | null | undefined;
    let starting = false;
    const action = button(
      connections.grantOnCreate
        ? "Connect account"
        : currentName
          ? "Authorize and replace account"
          : "Connect and attach",
      async () => {
        if (
          !template ||
          selectedScopes === null ||
          starting ||
          busy ||
          connections.unavailable(slot)
        ) {
          return;
        }
        starting = true;
        cancel.disabled = true;
        const close = () => {
          starting = false;
          dialog.close();
        };
        await start(template, selectedScopes, action, status, close);
        starting = false;
        cancel.disabled = false;
      },
      { tone: "primary" },
    );
    const cancel = button("Cancel", () => dialog.close(), { tone: "secondary" });
    const footer = element("div", { className: "dialog-actions" }, cancel, action);
    dialog.append(
      element(
        "div",
        { className: "dialog-header" },
        element("p", {}, slot.label),
        element("h2", {}, title),
      ),
      body,
      footer,
    );
    dismissOnBackdrop(dialog);
    dialog.addEventListener("cancel", (event) => {
      if (starting) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        const restore = mayReturnFocus(dialog);
        dialog.remove();
        if (restore && open.isConnected && !open.disabled) {
          open.focus();
        }
      },
      { once: true },
    );
    root.append(dialog);
    dialog.showModal();
    void refresh();
    async function refresh() {
      action.hidden = true;
      template = undefined;
      content.replaceChildren();
      status.textContent = "Loading compatible templates…";
      try {
        const { templates, setup } = await connections.list(slot);
        if (!dialog.open || !dialog.isConnected) {
          return;
        }
        if (!templates.length) {
          if (!setup) {
            status.textContent = slot.connectAccount
              ? "No compatible OAuth template is available for this slot in this Namespace. Ask an Installation administrator to configure this server."
              : "You need permission to connect an account in this Namespace.";
            return;
          }
          const controls = templateSetupActions(setup, () => void refresh());
          content.append(controls);
          status.textContent = "";
          controls.querySelector("a")?.focus();
          return;
        }
        const picker = element(
          "select",
          { "aria-label": `Connection template for ${slot.label}` },
          element("option", { value: "" }, "Choose a template"),
          ...templates.map((item) => element("option", { value: item.id }, item.displayName)),
        );
        const scopes = element("div");
        content.append(
          element("label", { className: "plugin-control" }, "Connection template", picker),
          scopes,
        );
        status.textContent = currentName
          ? `After authorization, this account will replace ${currentName} in the ${slot.label} slot.`
          : "";
        action.hidden = false;
        action.disabled = true;
        const selectTemplate = () => {
          template = templates.find((item) => item.id === picker.value);
          selectedScopes = undefined;
          scopes.replaceChildren();
          action.disabled = !template;
          if (template) {
            const fixed = template.mode === "manual" && template.scopes.length > 0;
            scopes.append(
              consentScopes(template, (selection) => {
                selectedScopes = fixed ? undefined : selection;
                action.disabled = selection === null;
              }),
            );
          }
        };
        picker.addEventListener("change", selectTemplate);
        if (templates.length === 1) {
          picker.value = templates[0]!.id;
          selectTemplate();
        }
        picker.focus();
      } catch (cause) {
        if (dialog.open) {
          status.textContent = describeError(cause);
          content.replaceChildren(
            button("Refresh templates", () => void refresh(), { tone: "secondary", size: "sm" }),
          );
        }
      }
    }
  }
  async function start(
    template: SlotTemplate,
    selectedScopes: readonly string[] | undefined,
    action: HTMLButtonElement,
    status: HTMLElement,
    close?: () => void,
  ) {
    if (busy || connections.unavailable(slot)) {
      return;
    }
    const current = ++attempt;
    checkButton?.remove();
    busy = open.disabled = action.disabled = true;
    status.textContent = "Opening the provider for your consent…";
    try {
      const message = await connections.start(
        slot,
        template,
        selectedScopes,
        (check) => {
          if (current !== attempt) {
            return;
          }
          close?.();
          busy = open.disabled = false;
          retryButton?.remove();
          retryButton = button(
            "Try again",
            () => void start(template, selectedScopes, retryButton!, notice),
            { tone: "primary" },
          );
          notice.textContent =
            "Finish sign-in in the new tab. If you closed it, you can try again.";
          const checkNow = button(
            "Check connection",
            async () => {
              checkNow.disabled = true;
              try {
                const message = await check();
                if (current === attempt && checkNow.isConnected && message) {
                  notice.textContent = message;
                }
              } catch (cause) {
                if (current === attempt && checkNow.isConnected) {
                  notice.textContent = describeError(cause);
                }
              } finally {
                checkNow.disabled = false;
              }
            },
            { tone: "secondary" },
          );
          checkButton = checkNow;
          root.append(retryButton, checkNow);
        },
        stage,
      );
      if (current === attempt && message) {
        (status.isConnected ? status : notice).textContent = message;
        action.textContent = "Try again";
      }
    } catch (cause) {
      if (current === attempt) {
        (status.isConnected ? status : notice).textContent = describeError(cause);
        action.textContent = "Try again";
      }
    } finally {
      if (current === attempt) {
        busy = open.disabled = action.disabled = false;
        checkButton?.remove();
      }
    }
  }
  return root;
}
