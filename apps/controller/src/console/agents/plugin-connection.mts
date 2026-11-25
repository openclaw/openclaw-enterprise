import type {
  AgentPluginCredentialSlot,
  ConnectionTemplate,
  OAuthClient,
} from "@openclaw-enterprise/contracts";
import { requestFailure } from "../api-client.mjs";
import { button, dismissOnBackdrop, element, field, mayReturnFocus } from "../dom.mjs";
import { connectionTemplatesPage, credentialClientsPage } from "../navigation.mjs";
import { namespacePath } from "./list.mjs";
import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";

export type PluginAccountSlot = AgentPluginCredentialSlot;

type OAuthTemplate = ConnectionTemplate & {
  readonly current: Extract<ConnectionTemplate["current"], { mode: "manual" | "mcp_discovery" }>;
};
type ConsentStart = { authorizationUrl: string; expiresAt: string };
type ConsentResult =
  { outcome: "saved"; sourceId: string } | { outcome: "failed"; reason?: string };

const consentKey = "oce.pluginAccountConsent";
const consentStateKey = `${consentKey}.stateHash`;
const failures: Record<string, string> = {
  consent_denied: "Authorization was declined. Try again to connect the account.",
  session_required: "Sign in to OCE, then try connecting the account again.",
  invalid_session:
    "OCE could not verify this sign-in attempt. Try again from the same signed-in browser.",
  client_refused:
    "The provider rejected the OAuth client. Ask an administrator to check its registration.",
  exchange_refused:
    "The provider rejected the token exchange. Ask an administrator to check the OAuth client and token endpoint.",
  grant_scope_mismatch:
    "OCE could not accept the provider's granted scopes. Ask an administrator to check the callback audit.",
};

/** Failure redirects may offer retry. Success is sent only by the verified callback response. */
export function finishPluginConsentTab() {
  const url = new URL(location.href);
  const connection = url.searchParams.get("connection");
  if (connection !== "failed") {
    return false;
  }
  let name: string | null;
  try {
    name = sessionStorage.getItem(consentKey);
    sessionStorage.removeItem(consentKey);
    sessionStorage.removeItem(consentStateKey);
  } catch {
    return false;
  }
  if (!name) {
    return false;
  }
  const reason = url.searchParams.get("reason");
  const result: ConsentResult = {
    outcome: "failed",
    ...(reason && Object.hasOwn(failures, reason) ? { reason } : {}),
  };
  const channel = new BroadcastChannel(name);
  channel.postMessage(result);
  channel.close();
  document.body.replaceChildren(
    element("p", { role: "status" }, "Return to the Agent tab to check your connection."),
  );
  window.close();
  return true;
}

export async function authorizePluginInNewTab(
  begin: () => Promise<ConsentStart>,
  signal: AbortSignal,
  waiting: () => void,
): Promise<ConsentResult> {
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    throw new Error("Allow pop-ups for this Console, then try again.");
  }
  const name = `${consentKey}.${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  const closeOnAbort = () => tab.close();
  signal.addEventListener("abort", closeOnAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    tab.opener = null;
    tab.sessionStorage.setItem(consentKey, name);
    tab.document.title = "Account sign-in";
    tab.document.body.textContent = "Opening your provider…";
    const start = await begin();
    const provider = new URL(start.authorizationUrl);
    const deadline = Date.parse(start.expiresAt);
    const state = provider.searchParams.get("state");
    if (
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      !Number.isFinite(deadline) ||
      !state
    ) {
      throw new Error("The provider returned an invalid authorization URL or expiry.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
    tab.sessionStorage.setItem(
      consentStateKey,
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    if (signal.aborted || tab.closed) {
      throw new Error("Sign-in was closed. Try again to connect the account.");
    }
    return await new Promise<ConsentResult>((resolve, reject) => {
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== "object") {
          return;
        }
        const result = data as Partial<ConsentResult>;
        if (
          result.outcome === "saved" &&
          typeof result.sourceId === "string" &&
          result.sourceId.length > 0
        ) {
          resolve({ outcome: "saved", sourceId: result.sourceId });
        } else if (result.outcome === "failed") {
          resolve({
            outcome: "failed",
            ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          });
        }
      };
      signal.addEventListener(
        "abort",
        () => reject(new Error("Sign-in was cancelled. Try again to connect the account.")),
        { once: true },
      );
      timeout = setTimeout(
        () => reject(new Error("Authorization expired. Try again to connect the account.")),
        Math.max(0, deadline - Date.now()),
      );
      tab.location.replace(provider.href);
      waiting();
    });
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    clearTimeout(timeout);
    channel.close();
    tab.close();
  }
}

function compatibleTemplate(
  slot: PluginAccountSlot,
  template: ConnectionTemplate,
): template is OAuthTemplate {
  const version = template.current;
  if (version.mode === "static_bearer" || !slot.issuers?.includes(version.issuer)) {
    return false;
  }
  if (slot.recipient?.mode === "manual") {
    return version.mode === "manual" && version.tokenUrl === slot.recipient.tokenUrl;
  }
  if (slot.recipient?.mode === "mcp_discovery") {
    return (
      version.mode === "mcp_discovery" &&
      version.mcp?.serverUrl === slot.recipient.serverUrl &&
      version.mcp.resource === slot.recipient.resource
    );
  }
  return true;
}

function scopeChoices(
  template: OAuthTemplate,
  update: (selected: string[] | null | undefined) => void,
) {
  const version = template.current;
  const unrestricted = version.scopes.length === 0;
  const offered = unrestricted
    ? (version.observed?.supportedScopes ?? version.observed?.requestedScopes ?? [])
    : version.scopes;
  const fixed = version.mode === "manual" && !unrestricted;
  const required = new Set(
    version.mode === "mcp_discovery" ? (version.observed?.requestedScopes ?? []) : [],
  );
  const incompatible =
    !unrestricted && [...required].some((scope) => !version.scopes.includes(scope));
  const scopes = [...new Set([...required, ...offered])];
  const fieldset = element(
    "fieldset",
    { className: "connection-template-fields stack" },
    element("legend", {}, "Permissions for this connection"),
  );
  const choices = scopes.map((scope) => {
    const checkbox = element("input", { type: "checkbox", value: scope });
    checkbox.checked = true;
    checkbox.disabled = fixed || required.has(scope);
    fieldset.append(
      element(
        "label",
        { className: "plugin-toggle" },
        checkbox,
        checkbox.disabled ? `${scope} (required)` : scope,
      ),
    );
    return checkbox;
  });
  const toggle = button(
    "Unselect all",
    () => {
      const select = choices.some((choice) => !choice.disabled && !choice.checked);
      for (const choice of choices.filter((choice) => !choice.disabled)) {
        choice.checked = select;
      }
      change();
    },
    { size: "sm" },
  );
  if (choices.some((choice) => !choice.disabled)) {
    fieldset.insertBefore(
      element("div", { className: "form-actions" }, toggle),
      fieldset.children[1] ?? null,
    );
  }
  const extra = unrestricted
    ? element("input", { type: "text", spellcheck: "false", autocomplete: "off" })
    : undefined;
  if (extra) {
    fieldset.append(
      field({
        label: "Additional scopes",
        control: extra,
        help: "Separate scope names with spaces. Leave empty to use provider defaults.",
      }),
    );
    extra.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
  }
  if (incompatible) {
    fieldset.append(
      element(
        "p",
        { className: "hint" },
        "The server requires a scope outside this Template's approved scopes. Ask an administrator to update it.",
      ),
    );
  }
  function change() {
    toggle.textContent = choices
      .filter((choice) => !choice.disabled)
      .every((choice) => choice.checked)
      ? "Unselect all"
      : "Select all";
    const selected = [
      ...new Set([
        ...choices.filter((choice) => choice.checked).map((choice) => choice.value),
        ...(extra?.value.trim().split(/\s+/).filter(Boolean) ?? []),
      ]),
    ];
    const invalid = selected.some(
      (scope) => scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    );
    extra?.setCustomValidity(invalid ? "Enter valid OAuth scope names." : "");
    update(
      fixed
        ? undefined
        : incompatible ||
            invalid ||
            (!unrestricted && selected.length === 0) ||
            [...required].some((scope) => !selected.includes(scope))
          ? null
          : selected,
    );
  }
  fieldset.addEventListener("input", change);
  change();
  return fieldset;
}

export interface SlotConnection {
  readonly grantOnCreate?: boolean;
  feedback?(slot: PluginAccountSlot): { message: string; retry?: boolean } | undefined;
  report(slot: PluginAccountSlot, message: string, retry?: boolean): void;
  unavailable?(slot: PluginAccountSlot): string | undefined;
  refreshSlot(slot: PluginAccountSlot): Promise<PluginAccountSlot | undefined>;
  attach(
    slot: PluginAccountSlot,
    sourceId: string,
    stage: (sourceId: string) => boolean,
  ): Promise<string>;
}
const pendingConsents = new WeakMap<SlotConnection, AbortController>();

export function pluginConnectionControl(
  context: PluginDiscoveryContext,
  slot: PluginAccountSlot,
  connections: SlotConnection,
  stage: (sourceId: string) => boolean,
) {
  if (!slot.issuers?.length) {
    return null;
  }
  const feedback = connections.feedback?.(slot);
  const notice = element("p", { className: "hint", role: "status" }, feedback?.message ?? "");
  const root = element("div", { className: "stack" }, notice);
  let attempt: AbortController | undefined;
  const open = button(feedback?.retry ? "Try again" : "Connect account", () => choose(), {
    size: "sm",
  });
  root.prepend(open);
  function choose() {
    pendingConsents.get(connections)?.abort();
    pendingConsents.delete(connections);
    attempt?.abort();
    attempt = undefined;
    const unavailable = connections.unavailable?.(slot);
    if (unavailable) {
      connections.report(slot, unavailable);
      return;
    }
    const dialog = element("dialog", {
      className: "dialog dialog--framed plugin-consent-dialog",
      "aria-label": "Connect an account",
    });
    const content = element("div", { className: "stack" });
    const status = element(
      "p",
      { className: "hint", role: "status" },
      "Loading compatible templates…",
    );
    const cancel = button("Cancel", () => dialog.close());
    const connect = button(
      connections.grantOnCreate ? "Connect account" : "Connect and attach",
      () => void start(),
      { tone: "primary" },
    );
    connect.disabled = true;
    let transferred = false;
    dialog.append(
      element(
        "div",
        { className: "dialog-header" },
        element("p", {}, slot.label),
        element("h2", {}, "Connect an account"),
      ),
      element("div", { className: "dialog-body" }, content, status),
      element("div", { className: "dialog-actions" }, cancel, connect),
    );
    dismissOnBackdrop(dialog);
    dialog.addEventListener(
      "close",
      () => {
        if (!transferred) {
          attempt?.abort();
        }
        const restore = mayReturnFocus(dialog);
        dialog.remove();
        if (restore && open.isConnected) {
          open.focus();
        }
      },
      { once: true },
    );
    root.append(dialog);
    dialog.showModal();
    let selected: OAuthTemplate | undefined;
    let selectedClient: OAuthClient | undefined;
    let selectedScopes: string[] | null | undefined;
    void context
      .request(`${namespacePath(context.namespaceId)}/connection-templates`, { readOnly: true })
      .then(
        (answer) => {
          if (!dialog.open || !Array.isArray(answer)) {
            return;
          }
          const templates = (answer as ConnectionTemplate[]).filter(
            (template): template is OAuthTemplate => compatibleTemplate(slot, template),
          );
          const refresh = () =>
            button(
              "Refresh templates",
              () => {
                dialog.close();
                choose();
              },
              { size: "sm" },
            );
          content.replaceChildren();
          if (!templates.length) {
            status.textContent =
              "No compatible OAuth template is available for this slot in this Namespace. Ask an Installation administrator to configure this server.";
            if (context.installationAdmin === true) {
              const settings = new URL(`/console/${connectionTemplatesPage}`, location.origin);
              settings.searchParams.set("namespace", context.namespaceId);
              settings.searchParams.set("create", "1");
              if (slot.issuers?.length === 1) {
                settings.searchParams.set("issuer", slot.issuers[0]!);
              }
              if (slot.recipient?.mode === "mcp_discovery") {
                settings.searchParams.set("mcpServerUrl", slot.recipient.serverUrl);
              } else if (slot.recipient?.mode === "manual") {
                settings.searchParams.set("tokenUrl", slot.recipient.tokenUrl);
              }
              content.append(
                element(
                  "a",
                  { href: settings.href, target: "_blank", rel: "noopener noreferrer" },
                  "Create connection template",
                ),
              );
            }
            content.append(refresh());
            return;
          }
          const picker = element(
            "select",
            { "aria-label": `Connection template for ${slot.label}` },
            element("option", { value: "" }, "Choose a template"),
            ...templates.map((template) =>
              element("option", { value: template.id }, template.displayName),
            ),
          );
          const clientArea = element("div");
          const scopeArea = element("div");
          content.append(
            field({ label: "Connection template", control: picker }),
            clientArea,
            scopeArea,
          );
          let selectionNumber = 0;
          const updateConnect = () => {
            connect.disabled = !selected || !selectedClient || selectedScopes === null;
          };
          async function select() {
            const number = ++selectionNumber;
            selected = templates.find((template) => template.id === picker.value);
            selectedClient = undefined;
            selectedScopes = undefined;
            clientArea.replaceChildren();
            scopeArea.replaceChildren();
            updateConnect();
            if (!selected) {
              status.textContent = "";
              return;
            }
            const template = selected;
            scopeArea.append(
              scopeChoices(template, (scopes) => {
                selectedScopes = scopes;
                updateConnect();
              }),
            );
            status.textContent = "Loading eligible OAuth clients…";
            try {
              const clients = (await context.request(
                `${namespacePath(context.namespaceId)}/connections/oauth-clients?connectionTemplateId=${encodeURIComponent(template.id)}`,
                { readOnly: true },
              )) as OAuthClient[];
              if (!dialog.open || number !== selectionNumber) {
                return;
              }
              if (!Array.isArray(clients) || !clients.length) {
                status.textContent =
                  "No eligible OAuth client is registered for this template. Ask an Installation administrator to register one.";
                if (context.installationAdmin === true) {
                  const settings = new URL(`/console/${credentialClientsPage}`, location.origin);
                  settings.searchParams.set("namespace", context.namespaceId);
                  clientArea.append(
                    element(
                      "a",
                      { href: settings.href, target: "_blank", rel: "noopener noreferrer" },
                      "Manage OAuth clients",
                    ),
                  );
                }
                clientArea.append(refresh());
                return;
              }
              const clientPicker = element(
                "select",
                { "aria-label": `OAuth client for ${slot.label}` },
                ...clients.map((client) =>
                  element("option", { value: client.id }, client.displayName),
                ),
              );
              clientPicker.value = clients[0]!.id;
              selectedClient = clients[0];
              clientPicker.addEventListener("change", () => {
                selectedClient = clients.find((client) => client.id === clientPicker.value);
                updateConnect();
              });
              clientArea.append(field({ label: "OAuth client", control: clientPicker }));
              status.textContent = "";
              updateConnect();
            } catch (cause) {
              if (dialog.open && number === selectionNumber) {
                status.textContent = connectionError(cause);
              }
            }
          }
          picker.addEventListener("change", () => void select());
          if (templates.length === 1) {
            picker.value = templates[0]!.id;
            void select();
          } else {
            status.textContent = "";
          }
          picker.focus();
        },
        (cause) => {
          status.textContent = connectionError(cause);
        },
      );
    async function start() {
      if (!selected || !selectedClient || connect.disabled || selectedScopes === null) {
        return;
      }
      attempt?.abort();
      attempt = new AbortController();
      const active = attempt;
      pendingConsents.set(connections, active);
      connect.disabled = true;
      let accountSaved = false;
      try {
        const result = await authorizePluginInNewTab(
          () =>
            context.request(`${namespacePath(context.namespaceId)}/connections`, {
              method: "POST",
              signal: active.signal,
              body: {
                connectionTemplateId: selected!.id,
                oauthClientId: selectedClient!.id,
                ...(selectedScopes === undefined ? {} : { selectedScopes }),
              },
            }) as Promise<ConsentStart>,
          active.signal,
          () => {
            transferred = true;
            dialog.close();
            connections.report(
              slot,
              "Finish sign-in in the new tab. If you closed it, try again.",
              true,
            );
          },
        );
        if (active.signal.aborted || !context.isCurrent()) {
          return;
        }
        if (result.outcome === "failed") {
          connections.report(
            slot,
            (result.reason && failures[result.reason]) ||
              "Authorization did not finish. Try again to connect the account.",
            true,
          );
          return;
        }
        accountSaved = true;
        const freshSlot = await connections.refreshSlot(slot);
        if (!freshSlot?.sources.some((source) => source.id === result.sourceId)) {
          connections.report(
            slot,
            "The account was saved but is not available for this plugin slot. Refresh the editor and check the account.",
          );
          return;
        }
        connections.report(slot, await connections.attach(freshSlot, result.sourceId, stage));
      } catch (cause) {
        if (!active.signal.aborted && context.isCurrent()) {
          if (accountSaved) {
            connections.report(
              slot,
              "The account was saved, but OCE could not confirm this plugin slot. Refresh the editor and check the existing account before attaching it.",
            );
          } else if (dialog.open) {
            status.textContent = connectionError(cause);
            connect.textContent = "Try again";
          } else {
            connections.report(slot, connectionError(cause), true);
          }
        }
      } finally {
        if (attempt === active) {
          attempt = undefined;
          connect.disabled = false;
        }
        if (pendingConsents.get(connections) === active) {
          pendingConsents.delete(connections);
        }
      }
    }
  }
  return root;
}

function connectionError(cause: unknown) {
  const failure = requestFailure(cause);
  if (failure.status === 401) {
    return "Your session expired. Sign in before connecting an account.";
  }
  if (failure.status === 403) {
    return "You need permission to create credentials in this Namespace to connect an account.";
  }
  if (cause instanceof Error && !failure.status) {
    return cause.message;
  }
  return "Could not start or finish the connection. Check the connection template and try again.";
}
