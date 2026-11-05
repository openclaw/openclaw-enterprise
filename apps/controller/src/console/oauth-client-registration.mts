import type {
  ConnectionTemplate,
  McpAuthorizationMetadata,
  Namespace,
  OAuthClient,
} from "@openclaw-enterprise/contracts";
import { requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
export type PublicClient = Omit<OAuthClient, "credentialRefreshDriverId">;
const option = (value: string, label: string) => element("option", { value }, label);
const methods: readonly PublicClient["tokenEndpointAuthMethod"][] = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

export function advertisedClientMethods(observed: McpAuthorizationMetadata | undefined) {
  return observed?.tokenEndpointAuthMethods ?? ["client_secret_basic"];
}

export function availableInNamespace(value: { namespaceId?: string }, namespaceId: string | null) {
  return !value.namespaceId || value.namespaceId === namespaceId;
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
    createTemplate?: (onSaved: (template: ConnectionTemplate) => void) => void;
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
  const choiceField = field({ label: "Connection template", control: choice });
  const empty = element(
    "p",
    { className: "hint" },
    "No connection templates are available for this selection.",
  );
  const createTemplate = options.createTemplate
    ? button(
        "Create connection template",
        () =>
          options.createTemplate?.((saved) => {
            if (!dialog.open || !context.isCurrent()) {
              return;
            }
            byId.set(saved.id, saved);
            showChoices();
            select(saved);
            name.focus();
          }),
        { size: "sm" },
      )
    : undefined;
  function showChoices() {
    const hasTemplates = byId.size > 0;
    choiceField.hidden = !hasTemplates;
    empty.hidden = hasTemplates;
    register.hidden = !hasTemplates;
    choice.replaceChildren(
      element("option", { value: "", disabled: true }, "Choose a connection template"),
      ...Array.from(byId.values(), (t) =>
        option(t.id, `${t.displayName} · ${availabilityLabel(t, options.namespaces)}`),
      ),
    );
  }
  const availability = element("input", { readOnly: true });
  const name = element("input", { required: true });
  const clientId = element("input", { required: true, autocomplete: "off" });
  const clientType = element("select", { required: true });
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
    field({ label: "Client type", control: clientType }),
    field({
      label: "Token endpoint authentication method",
      control: method,
      help: "Use the method registered for this client ID at the provider.",
    }),
    secretField,
  );
  const fields = element(
    "fieldset",
    { className: "connection-template-fields" },
    empty,
    choiceField,
    createTemplate ?? null,
    details,
  );
  const cancel = button("Cancel", () => dialog.close());
  const register = button("Register OAuth client", () => void submit(), { tone: "primary" });
  let selected: ConnectionTemplate | undefined;
  let pending = false;
  let uncertain = false;
  let created: PublicClient | undefined;
  let confidentialMethods: typeof methods = [];
  function showMethods(previous = "") {
    const isPublic = clientType.value === "public";
    const choices = isPublic ? ["none"] : confidentialMethods;
    method.replaceChildren(...choices.map((value) => option(value, value)));
    method.disabled = choices.length <= 1;
    const preferred =
      previous ||
      (selected?.current.issuer === "https://accounts.google.com"
        ? "client_secret_post"
        : "client_secret_basic");
    if (choices.some((value) => value === preferred)) {
      method.value = preferred;
    }
    secretField.hidden = secret.disabled = isPublic || !method.value;
    if (secret.disabled) {
      secret.value = "";
    }
  }
  clientType.addEventListener("change", () => showMethods());
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
    const availableMethods = methods.filter((value) => !allowed || allowed.includes(value));
    confidentialMethods = availableMethods.filter((value) => value !== "none");
    clientType.replaceChildren();
    if (confidentialMethods.length) {
      clientType.append(option("confidential", "Confidential"));
    }
    if (availableMethods.includes("none")) {
      clientType.append(option("public", "Public"));
    }
    clientType.disabled = clientType.options.length <= 1;
    if (previousMethod === "none") {
      clientType.value = "public";
    }
    showMethods(previousMethod);
    register.disabled = !template || !method.value;
    status.textContent =
      template && !method.value
        ? "This template’s authorization server advertises no supported client authentication method."
        : "";
  }
  choice.addEventListener("change", () => select(byId.get(choice.value)));
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
  if (byId.size) {
    (options.selected ? name : choice).focus();
  } else {
    createTemplate?.focus();
  }
  return () => dialog.close();
}
