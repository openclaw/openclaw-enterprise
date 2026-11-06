import type { AgentPluginCredentialSlot } from "@openclaw-enterprise/contracts";
import { button, element } from "../dom.mjs";
import { requestFailure } from "../api-client.mjs";

export interface SlotTemplate {
  id: string;
  displayName: string;
  version: number;
  mode: "manual" | "mcp_discovery";
  scopes: readonly string[];
  requiredScopes: readonly string[];
  offeredScopes: readonly string[];
}

const pluginConsentKey = "oce.pluginAccountConsent";

type ConsentOutcome = "attached" | "saved" | "unconfirmed" | "failed" | "expired" | "cancelled";
type ConsentStart = { authorizationUrl: string; credentialSourceId: string; expiresAt: string };

/** Only the separately opened tab holds this channel name. The server has already consumed the OAuth callback. */
export function finishPluginConsentTab() {
  const url = new URL(location.href);
  const outcome = url.searchParams.get("connection");
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

export interface SlotConnection {
  unavailable(slot: AgentPluginCredentialSlot): string | undefined;
  confirmed?(slot: AgentPluginCredentialSlot, sourceId: string): boolean;
  list(slot: AgentPluginCredentialSlot): Promise<readonly SlotTemplate[]>;
  start(
    slot: AgentPluginCredentialSlot,
    template: SlotTemplate,
    selectedScopes: readonly string[] | undefined,
    waiting: (check: () => Promise<string | undefined>) => void,
  ): Promise<string | void>;
}

function consentScopes(template: SlotTemplate, setSelection: (scopes: string[] | null) => void) {
  const unrestricted = template.scopes.length === 0;
  const fieldset = element(
    "fieldset",
    { className: "stack" },
    element("legend", {}, "Permissions for this connection"),
  );
  const suggestions = unrestricted ? template.offeredScopes : template.scopes;
  const choices = [...new Set([...template.requiredScopes, ...suggestions])].map((scope) => {
    const required = template.requiredScopes.includes(scope);
    const input = element("input", { type: "checkbox", value: scope });
    input.checked = input.disabled = required;
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
    fieldset.append(
      element("label", { className: "plugin-control" }, "Additional scopes", extra),
      element("p", { className: "hint" }, "Separate scope names with spaces."),
      problem,
    );
    if (template.requiredScopes.length === 0) {
      fieldset.append(
        element("p", { className: "hint" }, "Leave all scopes empty to use the provider defaults."),
      );
    }
  }
  function update() {
    const checked = choices.filter((input) => input.checked).map((input) => input.value);
    const added = extra?.value.trim().split(/\s+/).filter(Boolean) ?? [];
    const invalid = added.some(
      (scope) => scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    );
    const message = invalid
      ? "Use printable ASCII scope names of up to 512 characters, without double quotes or backslashes."
      : "";
    if (extra) {
      extra.setCustomValidity(message);
      extra.setAttribute("aria-invalid", String(invalid));
      problem.textContent = message;
      problem.hidden = !message;
    }
    const selected = [...new Set([...checked, ...added])];
    setSelection(invalid || (!unrestricted && !selected.length) ? null : selected);
  }
  fieldset.addEventListener("input", update);
  update();
  return fieldset;
}

export function pluginConnectionControl(
  slot: AgentPluginCredentialSlot,
  connections: SlotConnection,
  currentSourceId?: string,
) {
  const currentSource = slot.sources.find((source) => source.id === currentSourceId);
  const currentName = currentSourceId ? (currentSource?.name ?? "the current account") : undefined;
  const needsConsent = currentSourceId
    ? currentSource?.authorization === "required"
    : slot.sources.some((source) => source.authorization === "required");
  if (!slot.connectAccount) {
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
  if (currentSourceId && connections.confirmed?.(slot, currentSourceId)) {
    notice.textContent = "Account attached.";
  }
  const panel = element("div");
  let busy = false;
  let attempt = 0;
  let checkButton: HTMLButtonElement | undefined;
  const open = button(
    needsConsent
      ? "Authorize for this server"
      : currentName
        ? "Connect a different account"
        : "Choose a connection template",
    () => void choose(),
    {
      tone: "secondary",
      size: "sm",
    },
  );
  const root = element("div", { className: "stack" }, open, panel, notice);
  const unavailable = connections.unavailable(slot);
  if (unavailable) {
    open.hidden = true;
    notice.textContent = unavailable;
  }

  function available() {
    const reason = connections.unavailable(slot);
    if (reason) {
      notice.textContent = reason;
    }
    return !busy && !reason;
  }
  function showError(cause: unknown) {
    const { status } = requestFailure(cause);
    notice.textContent =
      status === 403
        ? "You need permission to update this Agent and connect an account in this Namespace."
        : status === 409
          ? "The template or plugin selection changed. Reload the Agent before connecting."
          : status === 401
            ? "Your session expired. Sign in before connecting an account."
            : "The connection could not start. Check the connection templates and try again.";
  }
  async function choose() {
    if (!available()) {
      return;
    }
    busy = true;
    open.disabled = true;
    panel.replaceChildren();
    notice.textContent = "Loading compatible templates…";
    try {
      const templates = await connections.list(slot);
      if (!templates.length) {
        notice.textContent =
          "No compatible OAuth template is available for this slot in this Namespace. Ask an Installation administrator to configure this server.";
        return;
      }
      const picker = element(
        "select",
        { "aria-label": `Connection template for ${slot.label}` },
        element("option", { value: "" }, "Choose a template"),
        ...templates.map((item) => element("option", { value: item.id }, item.displayName)),
      );
      const scopeChoices = element("div");
      let selectedScopes: string[] | null | undefined;
      const consent = button(
        currentName ? "Authorize and replace account" : "Connect and attach",
        () => {
          const template = templates.find((item) => item.id === picker.value);
          if (template && available() && selectedScopes !== null) {
            void start(template, consent, selectedScopes);
          }
        },
        { tone: "primary" },
      );
      consent.disabled = true;
      picker.addEventListener("change", () => {
        const template = templates.find((item) => item.id === picker.value);
        scopeChoices.replaceChildren();
        selectedScopes = undefined;
        consent.disabled = !template;
        if (template && (template.mode === "mcp_discovery" || template.scopes.length === 0)) {
          scopeChoices.append(
            consentScopes(template, (scopes) => {
              selectedScopes = scopes;
              consent.disabled = scopes === null;
            }),
          );
        }
      });
      open.hidden = true;
      panel.replaceChildren(
        element("label", { className: "plugin-control" }, "Connection template", picker),
        scopeChoices,
        element("div", { className: "form-actions" }, consent),
      );
      notice.textContent = currentName
        ? `After you authorize the account at the provider for this server, it will replace ${currentName} in the ${slot.label} slot.`
        : needsConsent
          ? `Choose the account at the provider. After you approve access to this server, OCE will attach the approved account to the ${slot.label} slot.`
          : `Approving the provider will save your account and attach it to this Agent’s ${slot.label} slot.`;
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      open.disabled = false;
    }
  }
  async function start(
    template: SlotTemplate,
    action: HTMLButtonElement,
    selectedScopes?: readonly string[],
  ) {
    const current = ++attempt;
    checkButton?.remove();
    busy = true;
    action.disabled = true;
    open.disabled = true;
    notice.textContent = "Opening the provider for your consent…";
    try {
      const message = await connections.start(slot, template, selectedScopes, (check) => {
        busy = false;
        action.disabled = false;
        action.textContent = "Try again";
        notice.textContent = "Finish sign-in in the new tab. If you closed it, you can try again.";
        const checkNow = button(
          "Check connection",
          async () => {
            checkNow.disabled = true;
            try {
              const message = await check();
              if (current === attempt && checkNow.isConnected && message) {
                notice.textContent = message;
              }
            } catch (error) {
              if (current === attempt && checkNow.isConnected) {
                showError(error);
              }
            } finally {
              checkNow.disabled = false;
            }
          },
          { tone: "secondary" },
        );
        checkButton = checkNow;
        action.after(checkNow);
      });
      if (current === attempt && message) {
        notice.textContent = message;
        action.textContent = "Try again";
      }
    } catch (error) {
      if (current === attempt) {
        action.textContent = "Try again";
        showError(error);
      }
    } finally {
      if (current === attempt) {
        busy = false;
        action.disabled = false;
        open.disabled = false;
        checkButton?.remove();
      }
    }
  }
  return root;
}
