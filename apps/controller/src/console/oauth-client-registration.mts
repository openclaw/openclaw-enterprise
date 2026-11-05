import type {
  ConnectionTemplate,
  McpAuthorizationMetadata,
  Namespace,
  OAuthClient,
} from "@openclaw-enterprise/contracts";
import { requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import { googleOAuthProvider } from "./oauth-providers.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
export type PublicClient = Omit<OAuthClient, "credentialRefreshDriverId">;
const option = (value: string, label: string) => element("option", { value }, label);
const methods = {
  client_secret_basic: "Client secret in Authorization header",
  client_secret_post: "Client secret in request body",
  none: "Public client (no secret)",
} as const;

export function advertisedClientMethods(observed: McpAuthorizationMetadata | undefined) {
  return observed?.tokenEndpointAuthMethods ?? ["client_secret_basic"];
}

export function availabilityLabel(
  value: { namespaceId?: string },
  namespaces: readonly Namespace[],
) {
  return value.namespaceId
    ? `Namespace · ${namespaces.find((item) => item.id === value.namespaceId)?.name ?? value.namespaceId}`
    : "Installation-wide";
}
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

export async function oauthClients(context: Context) {
  return (await context.request("/oauth-clients", {
    installationAdministration: "required",
    includeMeta: true,
  })) as { data: PublicClient[]; meta?: { redirectUri?: string } };
}

/** Both entry points register the provider-issued credentials against the displayed template version. */
export function openOAuthClientRegistration(
  context: Context,
  options: {
    parent: HTMLElement;
    namespaces: readonly Namespace[];
    templates: readonly ConnectionTemplate[];
    selected?: ConnectionTemplate;
    redirectUri?: string | undefined;
    createTemplate?: (google: boolean, onSaved: (template: ConnectionTemplate) => void) => void;
    onClose: (created?: PublicClient) => void;
  },
) {
  const dialog = element("dialog", {
    className: "dialog dialog--framed connection-template-dialog",
    "aria-label": "Register OAuth client",
  });
  const status = element("p", { className: "hint", role: "status" });
  const byId = new Map(options.templates.map((template) => [template.id, template]));
  const choice = element("select", {
    id: "oauth-registration-template",
    required: true,
    disabled: !options.createTemplate,
  });
  function showChoices() {
    choice.replaceChildren(
      element("option", { value: "", disabled: true }, "Choose a connection template"),
      ...Array.from(byId.values(), (t) =>
        option(t.id, `${t.displayName} · ${availabilityLabel(t, options.namespaces)}`),
      ),
    );
    if (options.createTemplate) {
      choice.append(
        element(
          "optgroup",
          { label: "Create a template" },
          option("create-google", "Set up Google OAuth…"),
          option("create-template", "Create connection template…"),
        ),
      );
    }
  }
  const availability = element("input", { readOnly: true });
  const name = element("input", { required: true });
  const clientId = element("input", { required: true, autocomplete: "off" });
  const method = element("select", { required: true });
  const secret = element("input", {
    type: "password",
    required: true,
    autocomplete: "new-password",
  });
  const secretField = field({ label: "Client secret", control: secret });
  const details = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "Client availability", control: availability }),
    field({
      label: "Redirect URI",
      control: element("input", {
        readOnly: true,
        value: options.redirectUri ?? "",
        placeholder: "Public origin not configured",
      }),
      help: options.redirectUri
        ? "Register this URI with the provider before using its client."
        : "Configure the Installation’s public origin to obtain the callback URI for this registration.",
    }),
    field({ label: "OAuth client name", control: name }),
    field({ label: "Client ID", control: clientId }),
    field({ label: "Client authentication", control: method }),
    secretField,
  );
  const fields = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "Connection template", control: choice }),
    details,
  );
  const cancel = button("Cancel", () => dialog.close());
  const register = button("Register OAuth client", () => void submit(), { tone: "primary" });
  let selected: ConnectionTemplate | undefined;
  let pending = false;
  let uncertain = false;
  let created: PublicClient | undefined;
  function showSecret() {
    secretField.hidden = secret.disabled = method.value === "none" || !method.value;
    if (secret.disabled) {
      secret.value = "";
    }
  }
  method.addEventListener("change", showSecret);
  function select(template: ConnectionTemplate | undefined) {
    const sameTemplate =
      selected?.id === template?.id && selected?.current.version === template?.current.version;
    const previousMethod = sameTemplate ? method.value : "";
    if (!sameTemplate) {
      clientId.value = "";
      secret.value = "";
    }
    selected = template;
    choice.value = template?.id ?? "";
    details.hidden = details.disabled = !template;
    availability.value = template ? availabilityLabel(template, options.namespaces) : "";
    const allowed =
      template?.current.mode === "mcp_discovery"
        ? advertisedClientMethods(template.current.observed)
        : undefined;
    method.replaceChildren(
      ...Object.entries(methods)
        .filter(([key]) => !allowed || allowed.includes(key))
        .map(([key, label]) => option(key, label)),
    );
    const defaultMethod =
      template?.current.issuer === googleOAuthProvider.issuer
        ? "client_secret_post"
        : "client_secret_basic";
    const preferred = previousMethod || defaultMethod;
    if (Array.from(method.options).some((item) => item.value === preferred)) {
      method.value = preferred;
    }
    showSecret();
    register.disabled = !template || !method.value;
    status.textContent =
      template && !method.value
        ? "This template’s authorization server advertises no supported client authentication method."
        : "";
  }
  choice.addEventListener("change", () => {
    if (
      (choice.value === "create-template" || choice.value === "create-google") &&
      options.createTemplate
    ) {
      const google = choice.value === "create-google";
      choice.value = selected?.id ?? "";
      options.createTemplate(google, (saved) => {
        if (!dialog.open || !context.isCurrent()) {
          return;
        }
        byId.set(saved.id, saved);
        showChoices();
        select(saved);
        name.focus();
      });
    } else {
      select(byId.get(choice.value));
    }
  });
  async function submit() {
    const template = selected;
    if (
      pending ||
      uncertain ||
      !template ||
      !method.value ||
      !validateFields([name, clientId, method, secret])
    ) {
      return;
    }
    const registration = {
      connectionTemplateId: template.id,
      connectionTemplateVersion: template.current.version,
      displayName: name.value.trim(),
      clientId: clientId.value.trim(),
      tokenEndpointAuthMethod: method.value,
      ...(method.value !== "none" && { clientSecret: secret.value }),
    };
    pending = true;
    fields.disabled = cancel.disabled = register.disabled = true;
    status.textContent = "Registering OAuth client…";
    try {
      const result = (await context.request("/oauth-clients", {
        method: "POST",
        installationAdministration: "required",
        expectedStatus: 201,
        body: registration,
      })) as PublicClient;
      if (!dialog.open || !context.isCurrent()) {
        return;
      }
      if (
        !result.id ||
        result.namespaceId !== template.namespaceId ||
        result.issuer !== template.current.issuer ||
        result.tokenUrl !== template.current.tokenUrl ||
        result.clientId !== registration.clientId ||
        result.tokenEndpointAuthMethod !== registration.tokenEndpointAuthMethod
      ) {
        throw Error("Unconfirmed OAuth client");
      }
      created = result;
      dialog.close();
    } catch (cause) {
      const code = requestFailure(cause).status;
      uncertain = code === undefined || code >= 500 || code === 408;
      if (dialog.open) {
        const reason = oauthFailure(cause, "OAuth client registration");
        status.textContent =
          code === 409
            ? reason + " Close this dialog and reopen registration to load the current template."
            : reason;
      }
    } finally {
      secret.value = "";
      pending = false;
      fields.disabled = register.disabled = uncertain;
      cancel.disabled = false;
    }
  }
  dialog.append(
    element("header", { className: "dialog-header" }, element("h2", {}, "Register OAuth client")),
    element("div", { className: "dialog-body" }, fields, status),
    element("div", { className: "dialog-actions" }, cancel, register),
  );
  dialog.addEventListener("cancel", (event) => {
    if (pending) {
      event.preventDefault();
    }
  });
  dialog.addEventListener(
    "close",
    () => {
      secret.value = "";
      dialog.remove();
      if (context.isCurrent()) {
        options.onClose(created);
      }
    },
    { once: true },
  );
  options.parent.append(dialog);
  showChoices();
  select(options.selected);
  dialog.showModal();
  (options.selected ? name : choice).focus();
  return () => dialog.close();
}
