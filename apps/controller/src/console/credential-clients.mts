import type { CredentialClient, Namespace } from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator, requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import { oauthCatalog } from "./oauth-catalog.mjs";
import { oauthDeleteButton } from "./oauth-deletion.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import {
  availabilityLabel,
  availableInNamespace,
  oauthClients,
  oauthFailure,
  openCredentialClientRegistration,
  privateKeyFile,
  readPrivateKey,
} from "./oauth-client-registration.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;

export function renderCredentialClients(
  context: Context,
  namespaces: readonly Namespace[],
  currentNamespace: string | null,
) {
  const create = button("Register client", () => edit(), { tone: "primary", size: "sm" });
  const { section, list, notice, showRows } = oauthCatalog("Credential clients", create, "Client", [
    "Type",
    "Issuer or App ID",
    "Availability",
    "Authentication",
  ]);
  let redirectUri: string | undefined;
  async function refresh(message?: string) {
    create.disabled = true;
    list.replaceChildren();
    notice.textContent = "Loading credential clients…";
    try {
      const { data, meta } = await oauthClients(context);
      if (!context.isCurrent()) {
        return;
      }
      redirectUri = meta?.redirectUri;
      const visible = data.filter((item) => availableInNamespace(item, currentNamespace));
      showRows(
        visible.map((item) => {
          const scope = availabilityLabel(item, namespaces);
          const github = item.kind === "github-app";
          const actions = [];
          if (github || item.tokenEndpointAuthMethod !== "none") {
            actions.push(rotationButton(item));
          }
          actions.push(
            oauthDeleteButton(context, "credential client", item, scope, refresh, create),
          );
          return {
            name: item.displayName,
            details: github
              ? ["GitHub App", item.appId, scope, "Signing key"]
              : [
                  "OAuth 2.0",
                  item.issuer,
                  scope,
                  element("code", {}, item.tokenEndpointAuthMethod),
                ],
            actions,
          };
        }),
      );
      notice.textContent =
        message ??
        (visible.length ? "" : "No credential clients are available for this selection.");
      create.disabled = false;
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (refusedAsNonAdministrator(cause)) {
        section.remove();
        return;
      }
      notice.textContent = oauthFailure(cause, "the credential client list");
      list.append(button("Reload clients", () => void refresh(), { size: "sm" }));
    }
  }

  function edit() {
    openCredentialClientRegistration(context, {
      parent: section,
      namespaces,
      currentNamespace,
      redirectUri,
      onClose(client) {
        void refresh(client ? "Registered " + client.displayName + "." : undefined);
      },
    });
  }

  function rotationButton(client: CredentialClient) {
    return button("Rotate", () => rotate(client), {
      size: "sm",
      "aria-label": "Rotate " + client.displayName,
    });
  }

  function rotate(client: CredentialClient) {
    const github = client.kind === "github-app";
    const title = github ? "Rotate GitHub App key" : "Rotate OAuth client secret";
    const dialog = element("dialog", {
      className: "dialog dialog--framed",
      "aria-label": title,
    });
    const form = element("form", { id: "credential-client-rotation", novalidate: "" });
    const status = element("p", { className: "hint", role: "status" });
    const value = github
      ? privateKeyFile("client-rotation-private-key")
      : element("input", { type: "password", required: true, autocomplete: "new-password" });
    const valueField = field({
      label: github ? "New private key file" : "New client secret",
      control: value,
      help: github
        ? "The selected TokenService verifies the key before replacement. Subsequent mints use it without a restart."
        : "Subsequent OAuth exchanges use the replacement secret.",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button("Rotate", () => undefined, {
      tone: "primary",
      type: "submit",
      form: form.id,
    });
    let pending = false;
    let uncertain = false;
    let message: string | undefined;
    form.append(
      element("p", {}, client.displayName),
      element("p", { className: "resource-id" }, client.id),
      valueField,
      status,
    );
    dialog.append(
      element("header", { className: "dialog-header" }, element("h2", {}, title)),
      element("div", { className: "dialog-body" }, form),
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        value.value = "";
        dialog.remove();
        if ((message || uncertain) && context.isCurrent()) {
          void refresh(message);
        }
      },
      { once: true },
    );
    section.append(dialog);
    dialog.showModal();
    value.focus();

    async function submit() {
      if (pending || uncertain || !validateFields([value])) {
        return;
      }
      pending = true;
      cancel.disabled = confirm.disabled = true;
      try {
        const privateKey = github ? await readPrivateKey(value) : undefined;
        if (github && privateKey === undefined) {
          return;
        }
        value.disabled = true;
        status.textContent = "Rotating…";
        const result = (await context.request(
          "/credential-clients/" + encodeURIComponent(client.id) + "/rotate",
          {
            method: "POST",
            installationAdministration: "required",
            body: github
              ? { kind: "github-app", privateKey }
              : { kind: "oauth2", clientSecret: value.value },
          },
        )) as CredentialClient;
        if (!dialog.open || !context.isCurrent()) {
          return;
        }
        if (
          result.id !== client.id ||
          result.kind !== client.kind ||
          result.displayName !== client.displayName ||
          result.namespaceId !== client.namespaceId ||
          (client.kind === "github-app" &&
            (result.kind !== "github-app" || result.appId !== client.appId)) ||
          (client.kind === "oauth2" &&
            (result.kind !== "oauth2" ||
              result.issuer !== client.issuer ||
              result.tokenUrl !== client.tokenUrl ||
              result.revocationUrl !== client.revocationUrl ||
              result.clientId !== client.clientId ||
              result.tokenEndpointAuthMethod !== client.tokenEndpointAuthMethod))
        ) {
          throw Error("Unconfirmed client rotation");
        }
        message = "Rotated " + client.displayName + ".";
        dialog.close();
      } catch (cause) {
        const code = requestFailure(cause).status;
        uncertain = code === undefined || code >= 500 || code === 408;
        status.textContent = oauthFailure(cause, "client rotation");
      } finally {
        value.value = "";
        pending = false;
        value.disabled = confirm.disabled = uncertain;
        cancel.disabled = false;
      }
    }
  }
  void refresh();
  return section;
}
