import type { ConnectionTemplate, Namespace, OAuthClient } from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator } from "./api-client.mjs";
import { button, element } from "./dom.mjs";
import { oauthCatalog } from "./oauth-catalog.mjs";
import { oauthDeleteButton } from "./oauth-deletion.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import {
  availabilityLabel,
  availableInNamespace,
  oauthClients,
  oauthFailure,
  openOAuthClientRegistration,
} from "./oauth-client-registration.mjs";
import { connectionTemplates, openConnectionTemplateEditor } from "./connection-templates.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;

export function renderOAuthClients(
  context: Context,
  namespaces: readonly Namespace[],
  currentNamespace: string | null,
) {
  const create = button("Register OAuth client", () => edit(), { tone: "primary", size: "sm" });
  const { section, list, notice, showRows } = oauthCatalog("OAuth clients", create, "Client", [
    "Issuer",
    "Availability",
    "Token endpoint authentication method",
  ]);
  let redirectUri: string | undefined;
  let clients: OAuthClient[] = [];
  let templates: ConnectionTemplate[] = [];
  async function refresh(message?: string) {
    create.disabled = true;
    list.replaceChildren();
    notice.textContent = "Loading OAuth clients…";
    try {
      const [available, saved] = await Promise.all([
        oauthClients(context),
        connectionTemplates(context),
      ]);
      const { data, meta } = available;
      if (!context.isCurrent()) {
        return;
      }
      clients = data;
      templates = saved.filter((item) => availableInNamespace(item, currentNamespace));
      const visibleClients = data.filter((item) => availableInNamespace(item, currentNamespace));
      redirectUri = meta?.redirectUri;
      showRows(
        visibleClients.map((item) => {
          const scope = availabilityLabel(item, namespaces);
          return {
            name: item.displayName,
            details: [item.issuer, scope, element("code", {}, item.tokenEndpointAuthMethod)],
            actions: [oauthDeleteButton(context, "OAuth client", item, scope, refresh, create)],
          };
        }),
      );
      notice.textContent =
        message ??
        (visibleClients.length ? "" : "No OAuth clients are available for this selection.");
      create.disabled = false;
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (refusedAsNonAdministrator(cause)) {
        section.remove();
        return;
      }
      notice.textContent = oauthFailure(cause, "the OAuth client list");
      list.append(button("Reload OAuth clients", () => void refresh(), { size: "sm" }));
    }
  }

  function edit() {
    let recoveryNotice: string | undefined;
    const closeRegistration = openOAuthClientRegistration(context, {
      parent: section,
      templates,
      namespaces,
      redirectUri,
      createTemplate(selectCreated) {
        openConnectionTemplateEditor(context, {
          parent: section,
          namespaces,
          currentNamespace,
          clients,
          onSaved(saved) {
            templates.push(saved);
            selectCreated(saved);
          },
          onUnconfirmed() {
            recoveryNotice =
              "Could not confirm template creation. Reopen registration and check the template list before creating another.";
            closeRegistration();
          },
        });
      },
      onClose(client) {
        void refresh(client ? `Registered ${client.displayName}.` : recoveryNotice);
      },
    });
  }
  void refresh();
  return section;
}
