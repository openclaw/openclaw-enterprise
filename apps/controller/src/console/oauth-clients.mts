import { googleOAuthProvider } from "./oauth-providers.mjs";
import type { Namespace, OAuthClient } from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator, requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
export type PublicClient = Omit<OAuthClient, "credentialRefreshDriverId">;
type Provider = Partial<Pick<OAuthClient, "issuer" | "tokenUrl" | "revocationUrl">>;
const installationWide = "installation-wide";
const option = (value: string, label: string) => element("option", { value }, label);

export function oauthFailure(cause: unknown, operation: string) {
  const { status, serverMessage } = requestFailure(cause);
  if (status === 403) {
    return "Your access does not include this Installation operation.";
  }
  if (status === 400 || status === 409) {
    return serverMessage || "OCC refused these values. Review the form and try again.";
  }
  return `Could not confirm ${operation}. Refresh the catalog before trying again.`;
}

export function availabilitySelect(
  namespaces: readonly Namespace[],
  currentNamespace: string | null,
  template?: { namespaceId?: string },
) {
  const scope = element(
    "select",
    { disabled: !!template, required: true },
    element("option", { value: "", disabled: true }, "Choose availability"),
    option(installationWide, "Installation-wide"),
    ...namespaces.map((item) => option(item.id, `Namespace · ${item.name}`)),
  );
  if (template?.namespaceId && !namespaces.some((item) => item.id === template.namespaceId)) {
    scope.append(option(template.namespaceId, template.namespaceId));
  }
  scope.value = template
    ? (template.namespaceId ?? installationWide)
    : (namespaces.find((item) => item.id === currentNamespace)?.id ?? "");
  return scope;
}
export function availabilityNamespace(scope: HTMLSelectElement) {
  return scope.value === installationWide ? undefined : scope.value;
}

export async function oauthClients(context: Context) {
  return (await context.request("/oauth-clients", {
    installationAdministration: "required",
    includeMeta: true,
  })) as { data: PublicClient[]; meta?: { redirectUri?: string } };
}

/** Both the template editor and the client catalog record a registration issued by the provider. */
export function oauthClientRegistration(
  context: Context,
  options: {
    scope: HTMLSelectElement;
    dialog: HTMLDialogElement;
    provider: () => Provider | undefined;
    redirectUri: string | undefined;
    status: HTMLElement;
    setBusy: (pending: boolean, uncertain: boolean) => void;
    onCreated: (client: PublicClient) => void;
  },
) {
  const { scope, provider, redirectUri, status } = options;
  const clientName = element("input", { required: true });
  const clientId = element("input", { required: true, autocomplete: "off" });
  const method = element(
    "select",
    {},
    option("client_secret_basic", "Client secret in Authorization header"),
    option("client_secret_post", "Client secret in request body"),
    option("none", "Public client (no secret)"),
  );
  const secret = element("input", {
    type: "password",
    required: true,
    autocomplete: "new-password",
  });
  options.dialog.addEventListener(
    "close",
    () => {
      secret.value = "";
    },
    { once: true },
  );
  const secretField = field({ label: "Client secret", control: secret });
  method.addEventListener("change", () => {
    secretField.hidden = secret.disabled = method.value === "none";
    secret.value = "";
  });

  const register = button("Register OAuth client", () => void submit(), { size: "sm" });
  const form = element(
    "div",
    { className: "connection-template-fields" },
    element(
      "p",
      { className: "hint" },
      "Create the OAuth client with the provider first, then enter the client details it issued.",
    ),
    redirectUri
      ? field({
          label: "Redirect URI",
          control: element("input", { readonly: true, value: redirectUri }),
          help: "Register this URI with the provider before using its client.",
        })
      : null,
    field({ label: "OAuth client name", control: clientName }),
    field({ label: "Provider client ID", control: clientId }),
    field({ label: "Client authentication", control: method }),
    secretField,
    register,
  );
  let pending = false;
  async function submit() {
    if (pending || !validateFields([scope])) {
      return;
    }
    const oauth = provider();
    if (!oauth?.issuer || !oauth.tokenUrl) {
      status.textContent = "Enter or discover the OAuth provider before registering its client.";
      return;
    }
    if (!validateFields([clientName, clientId, ...(method.value !== "none" ? [secret] : [])])) {
      return;
    }
    const namespaceId = availabilityNamespace(scope);
    const registration = {
      displayName: clientName.value.trim(),
      namespaceId,
      issuer: oauth.issuer,
      tokenUrl: oauth.tokenUrl,
      ...(oauth.revocationUrl && { revocationUrl: oauth.revocationUrl }),
      clientId: clientId.value.trim(),
      tokenEndpointAuthMethod: method.value,
      ...(method.value !== "none" && { clientSecret: secret.value }),
    };
    pending = true;
    options.setBusy(true, false);
    status.textContent = "Registering OAuth client…";
    let uncertain = false;
    try {
      const created = (await context.request("/oauth-clients", {
        method: "POST",
        installationAdministration: "required",
        expectedStatus: 201,
        body: registration,
      })) as PublicClient;
      if (!context.isCurrent() || !form.isConnected) {
        return;
      }
      if (
        !created.id ||
        created.namespaceId !== namespaceId ||
        created.issuer !== oauth.issuer ||
        created.tokenUrl !== oauth.tokenUrl ||
        created.clientId !== registration.clientId ||
        created.tokenEndpointAuthMethod !== method.value
      ) {
        throw Error("Unconfirmed OAuth client");
      }
      options.onCreated(created);
    } catch (cause) {
      const code = requestFailure(cause).status;
      uncertain = code === undefined || code >= 500 || code === 408;
      if (form.isConnected) {
        status.textContent = oauthFailure(cause, "OAuth client registration");
      }
    } finally {
      secret.value = "";
      pending = false;
      options.setBusy(false, uncertain);
    }
  }
  return {
    form,
    chooseAuthMethod(value: OAuthClient["tokenEndpointAuthMethod"]) {
      method.value = value;
      method.dispatchEvent(new Event("change"));
    },
  };
}

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
  async function refresh(message?: string) {
    create.disabled = true;
    rows.replaceChildren();
    notice.textContent = "Loading OAuth clients…";
    try {
      const { data, meta } = await oauthClients(context);
      if (!context.isCurrent()) {
        return;
      }
      redirectUri = meta?.redirectUri;
      const auth = {
        none: "Public client",
        client_secret_basic: "Client secret in Authorization header",
        client_secret_post: "Client secret in request body",
      };
      for (const item of data) {
        const scope = item.namespaceId
          ? `Namespace · ${namespaces.find((ns) => ns.id === item.namespaceId)?.name ?? item.namespaceId}`
          : "Installation-wide";
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
    const dialog = element("dialog", {
      className: "dialog dialog--framed connection-template-dialog",
      "aria-label": "Register OAuth client",
    });
    const scope = availabilitySelect(namespaces, currentNamespace);
    const provider = element(
      "select",
      {},
      option("custom", "Custom OAuth provider"),
      option("google", "Google"),
    );
    const issuer = element("input", { type: "url", required: true });
    const tokenUrl = element("input", { type: "url", required: true });
    const revocationUrl = element("input", { type: "url" });
    const status = element("p", { className: "hint", role: "status" });
    const fields = element(
      "fieldset",
      { className: "connection-template-fields" },
      field({ label: "Client availability", control: scope }),
      field({ label: "Provider", control: provider }),
      field({ label: "Issuer URL", control: issuer }),
      field({ label: "Token URL", control: tokenUrl }),
      field({ label: "Revocation URL (optional)", control: revocationUrl }),
    );
    const close = button("Cancel", () => dialog.close());
    const registration = oauthClientRegistration(context, {
      scope,
      dialog,
      status,
      redirectUri,
      provider: () =>
        validateFields([issuer, tokenUrl, revocationUrl])
          ? {
              issuer: issuer.value.trim(),
              tokenUrl: tokenUrl.value.trim(),
              revocationUrl: revocationUrl.value.trim(),
            }
          : undefined,
      setBusy(pending, uncertain) {
        fields.disabled = pending || uncertain;
        close.disabled = pending;
      },
      onCreated(client) {
        dialog.close();
        void refresh(`Registered ${client.displayName}.`);
      },
    });
    fields.append(registration.form);
    provider.addEventListener("change", () => {
      const settings = provider.value === "google" ? googleOAuthProvider : undefined;
      issuer.value = settings?.issuer ?? "";
      tokenUrl.value = settings?.tokenUrl ?? "";
      revocationUrl.value = settings?.revocationUrl ?? "";
      registration.chooseAuthMethod(settings ? "client_secret_post" : "client_secret_basic");
    });
    for (const input of [issuer, tokenUrl, revocationUrl]) {
      input.addEventListener("input", () => {
        provider.value = "custom";
      });
    }

    dialog.append(
      element("header", { className: "dialog-header" }, element("h2", {}, "Register OAuth client")),
      element("div", { className: "dialog-body" }, fields, status),
      element("div", { className: "dialog-actions" }, close),
    );
    section.append(dialog);
    dialog.addEventListener("cancel", (event) => {
      if (close.disabled) {
        event.preventDefault();
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    scope.focus();
  }
  void refresh();
  return section;
}
