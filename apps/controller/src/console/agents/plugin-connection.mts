import type {
  AgentPluginCredentialSlot,
  ConnectionTemplate,
  OAuthClient,
} from "@openclaw-enterprise/contracts";
import { requestFailure } from "../api-client.mjs";
import {
  authorizeInNewTab,
  consentFailureMessage,
  scopeChoices,
  type ConsentStart,
  type OAuthTemplate,
} from "../credential-consent.mjs";
import { button, dismissOnBackdrop, element, field, mayReturnFocus } from "../dom.mjs";
import { connectionTemplatesPage, credentialClientsPage } from "../navigation.mjs";
import { namespacePath } from "./list.mjs";
import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";

export type PluginAccountSlot = AgentPluginCredentialSlot;

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
              element(
                "option",
                { value: template.id },
                template.displayName + (template.current.issuerVerification ? "" : " (unverified)"),
              ),
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
            connect.disabled =
              !selected?.current.issuerVerification || !selectedClient || selectedScopes === null;
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
            if (!template.current.issuerVerification) {
              status.textContent =
                "This OAuth template is unverified. An Installation administrator must edit and save a verified version before consent can start.";
              if (context.installationAdmin === true) {
                const settings = new URL(`/console/${connectionTemplatesPage}`, location.origin);
                settings.searchParams.set("namespace", context.namespaceId);
                settings.searchParams.set("edit", template.id);
                clientArea.append(
                  element(
                    "p",
                    {},
                    element(
                      "a",
                      { href: settings.href, target: "_blank", rel: "noopener noreferrer" },
                      "Edit connection template",
                    ),
                  ),
                );
              }
              clientArea.append(refresh());
              return;
            }
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
      if (
        !selected?.current.issuerVerification ||
        !selectedClient ||
        connect.disabled ||
        selectedScopes === null
      ) {
        return;
      }
      attempt?.abort();
      attempt = new AbortController();
      const active = attempt;
      pendingConsents.set(connections, active);
      connect.disabled = true;
      let accountSaved = false;
      try {
        const result = await authorizeInNewTab(
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
            consentFailureMessage(result.reason) ||
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
