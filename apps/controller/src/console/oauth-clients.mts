import type { ConnectionTemplate, Namespace } from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator } from "./api-client.mjs";
import { button, element } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import {
  availabilityLabel,
  oauthClients,
  oauthFailure,
  openOAuthClientRegistration,
  type PublicClient,
} from "./oauth-client-registration.mjs";
import { openConnectionTemplateEditor } from "./connection-templates.mjs";
import { googleOAuthProvider } from "./oauth-providers.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;

export function renderOAuthClients(
  context: Context,
  namespaces: readonly Namespace[],
  currentNamespace: string | null,
) {
  const section = element("section", { className: "card" });
  const rows = element("div");
  const notice = element("p", { className: "hint", role: "status" });
  const create = button("Register OAuth client", () => edit(), { tone: "primary", size: "sm" });
  section.append(
    element(
      "div",
      { className: "driver-configurations-heading" },
      element("h2", {}, "OAuth clients"),
      create,
    ),
    rows,
    notice,
  );
  let redirectUri: string | undefined;
  let clients: PublicClient[] = [];
  let templates: ConnectionTemplate[] = [];
  async function refresh(message?: string) {
    create.disabled = true;
    rows.replaceChildren();
    notice.textContent = "Loading OAuth clients…";
    try {
      const [available, saved] = await Promise.all([
        oauthClients(context),
        context.request("/connection-templates", { installationAdministration: "required" }),
      ]);
      const { data, meta } = available;
      if (!context.isCurrent()) {
        return;
      }
      clients = data;
      templates = saved as ConnectionTemplate[];
      redirectUri = meta?.redirectUri;
      const auth = {
        none: "Public client",
        client_secret_basic: "Client secret in Authorization header",
        client_secret_post: "Client secret in request body",
      };
      for (const item of data) {
        const scope = availabilityLabel(item, namespaces);
        rows.append(
          element(
            "section",
            { className: "connection-template-row" },
            element("h3", {}, item.displayName),
            element("p", {}, item.issuer),
            element("p", { className: "hint" }, scope + " · " + auth[item.tokenEndpointAuthMethod]),
          ),
        );
      }
      notice.textContent = message ?? (data.length ? "" : "No OAuth clients have been registered.");
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
      rows.append(button("Reload OAuth clients", () => void refresh(), { size: "sm" }));
    }
  }

  function edit() {
    let recoveryNotice: string | undefined;
    const closeRegistration = openOAuthClientRegistration(context, {
      parent: section,
      templates,
      namespaces,
      redirectUri,
      createTemplate(google, selectCreated) {
        openConnectionTemplateEditor(context, {
          parent: section,
          namespaces,
          currentNamespace,
          clients,
          preset: google ? googleOAuthProvider : undefined,
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
