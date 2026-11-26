import type { CredentialClient, Namespace, OAuthClient } from "@openclaw-enterprise/contracts";
import type { OAuthTemplate } from "./credential-consent.mjs";
import { requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import { credentialValueProblem } from "./credential-value.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
type ClientKind = CredentialClient["kind"];
const option = (value: string, label: string) => element("option", { value }, label);
const installation = "installation";
const methods: readonly OAuthClient["tokenEndpointAuthMethod"][] = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

export function availableInNamespace(value: { namespaceId?: string }, namespaceId: string | null) {
  return !value.namespaceId || value.namespaceId === namespaceId;
}

export function availabilityLabel(
  value: { namespaceId?: string },
  namespaces: readonly Namespace[],
) {
  return value.namespaceId
    ? "Namespace · " +
        (namespaces.find((item) => item.id === value.namespaceId)?.name ?? value.namespaceId)
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
  return "Could not confirm " + operation + ". Refresh the catalog before trying again.";
}

export async function oauthClients(context: Context) {
  return (await context.request("/credential-clients", {
    installationAdministration: "required",
    includeMeta: true,
  })) as { data: CredentialClient[]; meta?: { redirectUri?: string } };
}

/** GitHub provides the App signing key as a PEM file. Its contents are never shown in the Console. */
export function privateKeyFile(id: string) {
  const control = element("input", { id, type: "file", required: true, accept: ".pem" });
  control.addEventListener("change", () => control.setCustomValidity(""));
  return control;
}

export async function readPrivateKey(control: HTMLInputElement) {
  const file = control.files?.[0];
  if (!file) {
    return undefined;
  }
  let problem = file.size > 20_000 ? "Use a key file of at most 20,000 bytes." : "";
  let value = "";
  if (!problem) {
    try {
      value = await file.text();
      problem = credentialValueProblem(value) || (!value ? "Choose a nonempty key file." : "");
    } catch {
      problem = "Could not read this key file. Choose it again.";
    }
  }
  if (problem) {
    control.setCustomValidity(problem);
    validateFields([control]);
    return undefined;
  }
  return value;
}

/** A Template can prefill the issuer; each client registration owns its own scope. */
export function openCredentialClientRegistration(
  context: Context,
  options: {
    parent: HTMLElement;
    namespaces: readonly Namespace[];
    currentNamespace: string | null;
    selected?: OAuthTemplate;
    redirectUri?: string | undefined;
    kind?: ClientKind;
    onClose: (created?: CredentialClient) => void;
  },
) {
  const dialog = element("dialog", {
    className: "dialog dialog--framed connection-template-dialog",
    "aria-label": "Register credential client",
  });
  const form = element("form", { id: "credential-client-registration", novalidate: "" });
  const status = element("p", { className: "hint", role: "status" });
  const kind = element(
    "select",
    { id: "credential-client-kind", required: true },
    option("oauth2", "OAuth 2.0 client"),
    option("github-app", "GitHub App"),
  );
  kind.value = options.kind ?? "oauth2";
  const kindField = field({ label: "Client type", control: kind });
  kindField.hidden = !!options.kind;
  kind.disabled = !!options.kind;
  const name = element("input", {
    id: "credential-client-name",
    required: true,
    maxLength: 200,
    autocomplete: "off",
  });
  const scope = element(
    "select",
    { id: "credential-client-scope", required: true },
    option(installation, "Installation-wide"),
    ...options.namespaces.map((item) => option(item.id, "Namespace · " + item.name)),
  );
  scope.value = options.selected?.namespaceId ?? installation;
  const issuer = element("input", {
    id: "credential-client-issuer",
    type: "url",
    required: true,
    value: options.selected?.current.issuer ?? "",
  });
  const clientId = element("input", { required: true, autocomplete: "off", maxLength: 256 });
  const allowedMethods = options.selected?.current.issuerVerification?.tokenEndpointAuthMethods;
  const availableMethods = methods.filter(
    (value) => !allowedMethods || allowedMethods.includes(value),
  );
  const method = element(
    "select",
    { required: true },
    ...availableMethods.map((item) => option(item, item)),
  );
  if (
    options.selected?.current.issuer === "https://accounts.google.com" &&
    availableMethods.includes("client_secret_post")
  ) {
    method.value = "client_secret_post";
  }
  const secret = element("input", {
    type: "password",
    required: true,
    autocomplete: "new-password",
  });
  const secretField = field({ label: "Client secret", control: secret });
  const redirectUri = element("input", {
    readOnly: true,
    value: options.redirectUri ?? "",
    placeholder: "Public origin not configured",
  });
  const copyFeedback = element("p", { className: "hint", role: "status", hidden: true });
  const copyRedirect = button(
    "Copy",
    async () => {
      let copied = false;
      try {
        if (typeof navigator.clipboard?.writeText === "function") {
          await navigator.clipboard.writeText(redirectUri.value);
          copied = true;
        }
      } catch {
        // Browsers can refuse clipboard access; leave the value selected for manual copying.
      }
      if (!dialog.open) {
        return;
      }
      if (!copied) {
        redirectUri.focus();
        redirectUri.select();
      }
      copyFeedback.textContent = copied
        ? "Redirect URI copied."
        : "Redirect URI selected. Use your copy shortcut to copy it.";
      copyFeedback.hidden = false;
    },
    {
      tone: "secondary",
      size: "sm",
      disabled: !options.redirectUri,
      "aria-label": "Copy redirect URI",
    },
  );
  const redirectField = field({
    label: "Redirect URI",
    control: redirectUri,
    className: "credential-client-redirect",
    help: options.redirectUri
      ? "Register this URI with the provider before using its client."
      : "Configure the Installation's public origin to obtain the callback URI.",
  });
  redirectUri.after(copyRedirect);
  redirectField.append(copyFeedback);
  const oauthFields = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "Issuer URL", control: issuer }),
    redirectField,
    field({ label: "Client ID", control: clientId }),
    field({ label: "Token endpoint authentication method", control: method }),
    secretField,
  );
  const appId = element("input", {
    id: "credential-client-app-id",
    required: true,
    inputmode: "numeric",
    pattern: "[1-9][0-9]*",
    autocomplete: "off",
  });
  const key = privateKeyFile("client-app-private-key");
  const keyField = field({
    label: "Private key file",
    control: key,
    help: "The selected TokenService verifies and stores this key. It cannot be read back.",
  });
  const githubFields = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "GitHub App ID", control: appId }),
    keyField,
  );
  const fields = element(
    "fieldset",
    { className: "connection-template-fields" },
    kindField,
    field({ label: "Client name", control: name }),
    field({ label: "Availability", control: scope }),
    oauthFields,
    githubFields,
  );
  const cancel = button("Cancel", () => dialog.close());
  const register = button("Register client", () => undefined, {
    tone: "primary",
    type: "submit",
    form: form.id,
  });
  let pending = false;
  let uncertain = false;
  let created: CredentialClient | undefined;

  function showSecret() {
    const confidential = !!method.value && method.value !== "none";
    secretField.hidden = secret.disabled = !confidential;
    if (!confidential) {
      secret.value = "";
    }
  }
  function showKind() {
    const github = kind.value === "github-app";
    oauthFields.hidden = oauthFields.disabled = github;
    githubFields.hidden = githubFields.disabled = !github;
    secret.value = "";
    key.value = "";
    showSecret();
    register.disabled = !github && !method.value;
    status.textContent = register.disabled
      ? "This Template’s authorization server advertises no supported client authentication method."
      : "";
  }
  method.addEventListener("change", showSecret);
  kind.addEventListener("change", showKind);
  showKind();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  async function submit() {
    const github = kind.value === "github-app";
    const controls = github
      ? [name, scope, appId, key]
      : [name, scope, issuer, clientId, method, secret];
    if (pending || uncertain || !validateFields(controls)) {
      return;
    }
    const displayName = name.value.trim();
    const namespaceId = scope.value === installation ? undefined : scope.value;
    pending = true;
    cancel.disabled = register.disabled = true;
    try {
      const privateKey = github ? await readPrivateKey(key) : undefined;
      if (github && privateKey === undefined) {
        return;
      }
      const client = { displayName, ...(namespaceId && { namespaceId }) };
      const registration = github
        ? { ...client, kind: "github-app", appId: appId.value.trim(), privateKey }
        : {
            ...client,
            kind: "oauth2",
            issuer: issuer.value.trim(),
            clientId: clientId.value.trim(),
            tokenEndpointAuthMethod: method.value,
            ...(method.value !== "none" && { clientSecret: secret.value }),
          };
      fields.disabled = true;
      status.textContent = "Registering client…";
      const result = (await context.request("/credential-clients", {
        method: "POST",
        installationAdministration: "required",
        expectedStatus: 201,
        body: registration,
      })) as CredentialClient;
      if (!dialog.open || !context.isCurrent()) {
        return;
      }
      const confirmed =
        !!result.id &&
        result.displayName === displayName &&
        result.namespaceId === namespaceId &&
        (github
          ? result.kind === "github-app" && result.appId === appId.value.trim()
          : result.kind === "oauth2" &&
            result.issuer === issuer.value.trim() &&
            result.clientId === clientId.value.trim() &&
            result.tokenEndpointAuthMethod === method.value);
      if (!confirmed) {
        throw Error("Unconfirmed client registration");
      }
      created = result;
      dialog.close();
    } catch (cause) {
      const code = requestFailure(cause).status;
      uncertain = code === undefined || code >= 500 || code === 408;
      if (dialog.open) {
        status.textContent =
          github && code === 404
            ? "GitHub App verification failed. Check the App ID and matching private key, and OCC connectivity to GitHub."
            : oauthFailure(cause, "client registration");
      }
    } finally {
      secret.value = "";
      key.value = "";
      pending = false;
      fields.disabled = uncertain;
      register.disabled = uncertain || (!github && !method.value);
      cancel.disabled = false;
      showSecret();
    }
  }
  form.append(fields, status);
  dialog.append(
    element("header", { className: "dialog-header" }, element("h2", {}, "Register client")),
    element("div", { className: "dialog-body" }, form),
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
      key.value = "";
      dialog.remove();
      if (context.isCurrent()) {
        options.onClose(created);
      }
    },
    { once: true },
  );
  options.parent.append(dialog);
  dialog.showModal();
  (options.kind ? name : kind).focus();
  return () => dialog.close();
}
