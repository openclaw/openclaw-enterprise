import { button, element, field, statusBlock } from "./dom.mjs";
import { message } from "./agents/list.mjs";

// The Installation's connection template catalog (RFC-0023): the OAuth client, scopes, and the
// one endpoint and variable a connected account reaches. Only Installation administrators see
// this card; the API authorizes every call again.

// Google's endpoints for a Gmail read-only connection, as the Gmail guide registers them.
const GMAIL_EXAMPLE = {
  displayName: "Gmail",
  issuer: "https://accounts.google.com",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: "https://www.googleapis.com/auth/gmail.readonly",
  authorizationParameters: "access_type=offline\nprompt=consent",
  host: "gmail.googleapis.com",
  port: "",
  path: "/**",
  envVar: "GOG_ACCESS_TOKEN",
};

const FIELDS = [
  ["displayName", "Name", "Shown on the Connect button and consent warning."],
  ["issuer", "Issuer", "The provider's issuer URL."],
  ["authorizationUrl", "Authorization URL", null],
  ["tokenUrl", "Token URL", null],
  ["clientId", "Client ID", "The OAuth client registered with the provider."],
  [
    "clientSecret",
    "Client secret",
    "Write-only. Required for a client this Installation has not registered yet; never shown again.",
  ],
  ["scopes", "Scopes", "One per line. People approve exactly these."],
  [
    "authorizationParameters",
    "Authorization parameters",
    "Optional name=value lines, for example access_type=offline for Google refresh tokens.",
  ],
  ["host", "Endpoint host", "The only host that receives the token."],
  ["port", "Endpoint port", "Optional; 443 when empty."],
  ["path", "Endpoint path", "Optional path pattern; every path (/**) when empty."],
  ["envVar", "Variable", "The environment variable that holds the token placeholder in the Agent."],
];

function formValues(template) {
  const version = template.current;
  return {
    displayName: template.displayName,
    issuer: version.issuer,
    authorizationUrl: version.authorizationUrl,
    tokenUrl: version.tokenUrl,
    clientId: version.clientId,
    clientSecret: "",
    scopes: version.scopes.join("\n"),
    authorizationParameters: Object.entries(version.authorizationParameters)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
    host: version.endpoint.host,
    port: version.endpoint.port === 443 ? "" : String(version.endpoint.port),
    path: version.endpoint.path,
    envVar: version.envVar,
  };
}

// The API body for the form's values. An update sends only what changed, so a rename alone
// creates no new version.
function requestBody(values, before) {
  const lines = (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const parameters = Object.fromEntries(
    lines(values.authorizationParameters).map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  const endpoint = {
    host: values.host.trim(),
    ...(values.port.trim() ? { port: Number(values.port) } : {}),
    ...(values.path.trim() ? { path: values.path.trim() } : {}),
  };
  const body = {
    displayName: values.displayName.trim(),
    issuer: values.issuer.trim(),
    authorizationUrl: values.authorizationUrl.trim(),
    tokenUrl: values.tokenUrl.trim(),
    clientId: values.clientId.trim(),
    scopes: lines(values.scopes),
    authorizationParameters: parameters,
    endpoint,
    envVar: values.envVar.trim(),
    ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
  };
  if (!before) {
    return body;
  }
  const previous = requestBody(before);
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key]),
    ),
  );
}

function failureText(error) {
  return [
    message(error, true),
    error.serverMessage,
    error.requestId && `Request ID: ${error.requestId}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function renderConnectionTemplates({ request, namespaces, isCurrent, onExpired }) {
  const status = element(
    "p",
    { className: "hint", role: "status" },
    "Loading connection templates…",
  );
  const error = element("p", { className: "error", role: "alert" });
  const list = element("ul", { className: "connection-templates-list", role: "list" });
  const create = button(
    "New connection template",
    (event) => openEditor(null, event.currentTarget),
    {
      tone: "secondary",
    },
  );
  const section = element(
    "section",
    { className: "card connection-templates", "aria-labelledby": "connection-templates-title" },
    element("h2", { id: "connection-templates-title" }, "Connection templates"),
    element(
      "p",
      { className: "hint" },
      "People connect their own accounts to personal Agents from these templates. Grant use to a person or a Namespace; register the redirect URI with the provider's OAuth client.",
    ),
    status,
    error,
    list,
    create,
  );

  let templates = [];
  let bindings = [];
  let useRoleId = null;

  const namespaceName = (id) => namespaces.find((item) => item.id === id)?.name ?? id;

  function handle(cause, target = error) {
    if (!isCurrent()) {
      return;
    }
    if (cause.status === 401) {
      onExpired();
      return;
    }
    target.textContent = failureText(cause);
  }

  async function load() {
    try {
      const [freshTemplates, freshBindings, roles] = await Promise.all([
        request("/connection-templates"),
        request("/iam/access-bindings"),
        useRoleId ? null : request("/iam/roles"),
      ]);
      if (!isCurrent()) {
        return;
      }
      templates = freshTemplates;
      bindings = freshBindings;
      // A template binding needs a Role whose every permission is on connection templates, such
      // as the seeded role_connection_template_user; the administrator Role also has `use`.
      useRoleId ??=
        roles?.find(
          (role) =>
            role.permissions.every(
              (permission) => permission.resourceKind === "connection_template",
            ) && role.permissions.some((permission) => permission.action === "use"),
        )?.id ?? null;
      error.textContent = "";
      status.textContent = templates.length ? "" : "No connection templates yet.";
      list.replaceChildren(...templates.map(templateRow));
    } catch (cause) {
      status.textContent = "";
      handle(cause);
    }
  }

  function templateRow(template) {
    const version = template.current;
    const grants = bindings.filter((binding) => binding.resourceId === template.id);
    const rowError = element("p", { className: "error", role: "alert" });
    const subjectKind = element(
      "select",
      { id: `grant-kind-${template.id}`, "aria-label": "Grant to" },
      element("option", { value: "namespace" }, "Namespace"),
      element("option", { value: "identity" }, "Person (principal ID)"),
    );
    const namespaceChoice = element(
      "select",
      { id: `grant-namespace-${template.id}`, "aria-label": "Namespace" },
      ...namespaces.map((item) => element("option", { value: item.id }, item.name)),
    );
    const identity = element("input", {
      id: `grant-identity-${template.id}`,
      "aria-label": "Principal ID",
      placeholder: "identity_…",
      hidden: true,
    });
    subjectKind.addEventListener("change", () => {
      namespaceChoice.hidden = subjectKind.value !== "namespace";
      identity.hidden = subjectKind.value !== "identity";
    });
    const grant = button(
      "Grant use",
      async () => {
        rowError.textContent = "";
        if (!useRoleId) {
          rowError.textContent =
            "This Installation has no Role that grants connection template use.";
          return;
        }
        const subjectId =
          subjectKind.value === "namespace" ? namespaceChoice.value : identity.value.trim();
        if (!subjectId) {
          rowError.textContent = "Choose who may use this template.";
          return;
        }
        grant.disabled = true;
        try {
          await request("/iam/access-bindings", {
            method: "POST",
            body: {
              subjectKind: subjectKind.value,
              subjectId,
              roleId: useRoleId,
              resourceKind: "connection_template",
              resourceId: template.id,
            },
          });
          await load();
        } catch (cause) {
          grant.disabled = false;
          handle(cause, rowError);
        }
      },
      { tone: "secondary", size: "sm" },
    );
    const copy = button(
      "Copy",
      () => void navigator.clipboard?.writeText(template.redirectUri ?? ""),
      { tone: "ghost", size: "sm", hidden: !template.redirectUri || !navigator.clipboard },
    );
    return element(
      "li",
      { className: "connection-template", "data-template-id": template.id },
      element(
        "div",
        { className: "connection-template-heading" },
        element("strong", {}, template.displayName),
        element("span", { className: "badge" }, `Version ${version.version}`),
      ),
      element(
        "dl",
        { className: "settings connection-template-facts" },
        element("dt", {}, "Client"),
        element("dd", {}, element("code", {}, version.clientId), ` at ${version.issuer}`),
        element("dt", {}, "Scopes"),
        element("dd", {}, ...version.scopes.map((scope) => element("code", {}, scope))),
        element("dt", {}, "Endpoint"),
        element(
          "dd",
          {},
          element(
            "code",
            {},
            `${version.endpoint.host}:${version.endpoint.port}${version.endpoint.path}`,
          ),
          " as ",
          element("code", {}, version.envVar),
        ),
        element("dt", {}, "Redirect URI"),
        element(
          "dd",
          {},
          template.redirectUri
            ? element("code", {}, template.redirectUri)
            : "Not configured: set the console's public origin before people connect.",
          copy,
        ),
        element("dt", {}, "Who can connect"),
        element(
          "dd",
          {},
          grants.length
            ? element(
                "ul",
                { className: "connection-template-grants", role: "list" },
                ...grants.map((binding) =>
                  element(
                    "li",
                    {},
                    binding.subjectKind === "namespace"
                      ? `Namespace ${namespaceName(binding.subjectId)}`
                      : `Person ${binding.subjectId}`,
                    " ",
                    button(
                      "Remove",
                      async (event) => {
                        event.currentTarget.disabled = true;
                        try {
                          await request(`/iam/access-bindings/${encodeURIComponent(binding.id)}`, {
                            method: "DELETE",
                            expectedStatus: 204,
                          });
                          await load();
                        } catch (cause) {
                          handle(cause, rowError);
                        }
                      },
                      {
                        tone: "ghost",
                        size: "sm",
                        "aria-label": `Remove use for ${binding.subjectId}`,
                      },
                    ),
                  ),
                ),
              )
            : "Nobody yet.",
        ),
      ),
      element(
        "div",
        { className: "connection-template-grant" },
        subjectKind,
        namespaceChoice,
        identity,
        grant,
      ),
      rowError,
      element(
        "div",
        { className: "connection-template-actions" },
        button("Edit", (event) => openEditor(template, event.currentTarget), {
          tone: "ghost",
          size: "sm",
        }),
        button("Rotate client secret", (event) => openRotate(template, event.currentTarget), {
          tone: "ghost",
          size: "sm",
        }),
        button("Delete", (event) => openDelete(template, event.currentTarget), {
          tone: "ghost",
          size: "sm",
        }),
      ),
    );
  }

  function dialogShell(title, invoker) {
    const dialog = element("dialog", {
      className: "dialog connection-template-dialog",
      "aria-labelledby": "connection-template-dialog-title",
    });
    dialog.append(element("h2", { id: "connection-template-dialog-title" }, title));
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (invoker.isConnected) {
        invoker.focus();
      }
    });
    section.append(dialog);
    return dialog;
  }

  function openEditor(template, invoker) {
    const dialog = dialogShell(
      template ? `Edit ${template.displayName}` : "New connection template",
      invoker,
    );
    const before = template ? formValues(template) : null;
    const controls = {};
    const fields = FIELDS.map(([key, label, help]) => {
      const multiline = key === "scopes" || key === "authorizationParameters";
      const control = element(multiline ? "textarea" : "input", {
        id: `connection-template-${key}`,
        name: key,
        ...(multiline ? { rows: 3, spellcheck: "false" } : {}),
        ...(key === "clientSecret" ? { type: "password", autocomplete: "new-password" } : {}),
        ...(key === "port" ? { inputmode: "numeric" } : {}),
        required: !["clientSecret", "authorizationParameters", "port"].includes(key),
      });
      control.value = before?.[key] ?? "";
      controls[key] = control;
      return field({ label, control, help });
    });
    const feedback = element("p", { className: "error", role: "alert" });
    const note = element(
      "p",
      { className: "hint" },
      template
        ? "Changing anything except the name creates a new version. Existing connections keep the version their owner approved and show Reconnect to apply changes."
        : "",
    );
    const example = template
      ? null
      : button(
          "Fill in the Gmail example",
          () => {
            for (const [key, value] of Object.entries(GMAIL_EXAMPLE)) {
              controls[key].value = value;
            }
            controls.clientId.focus();
          },
          { tone: "ghost", size: "sm" },
        );
    const cancel = button("Cancel", () => dialog.close());
    const save = button(
      template ? "Save" : "Create template",
      async () => {
        feedback.textContent = "";
        if (![...Object.values(controls)].every((control) => control.reportValidity())) {
          return;
        }
        const values = Object.fromEntries(
          Object.entries(controls).map(([key, control]) => [key, control.value]),
        );
        const body = requestBody(values, before);
        if (template && Object.keys(body).length === 0) {
          dialog.close();
          return;
        }
        save.disabled = true;
        try {
          await request(
            template
              ? `/connection-templates/${encodeURIComponent(template.id)}`
              : "/connection-templates",
            { method: template ? "PATCH" : "POST", body },
          );
          // The secret leaves the page once the API holds it.
          controls.clientSecret.value = "";
          dialog.close();
          await load();
        } catch (cause) {
          save.disabled = false;
          handle(cause, feedback);
        }
      },
      { tone: "primary" },
    );
    dialog.append(
      note,
      example,
      element("div", { className: "connection-template-form" }, ...fields),
      feedback,
      element("div", { className: "dialog-actions" }, cancel, save),
    );
    dialog.addEventListener("close", () => {
      controls.clientSecret.value = "";
    });
    dialog.showModal();
    controls.displayName.focus();
  }

  function openRotate(template, invoker) {
    const dialog = dialogShell(`Rotate the ${template.displayName} client secret`, invoker);
    const secret = element("input", {
      id: "connection-template-rotate-secret",
      type: "password",
      autocomplete: "new-password",
      required: true,
    });
    const feedback = element("p", { className: "error", role: "alert" });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Rotate",
      async () => {
        if (!secret.reportValidity()) {
          return;
        }
        confirm.disabled = true;
        try {
          await request(
            `/connection-templates/${encodeURIComponent(template.id)}/rotate-client-secret`,
            {
              method: "POST",
              body: { clientSecret: secret.value },
            },
          );
          dialog.close();
          await load();
        } catch (cause) {
          confirm.disabled = false;
          handle(cause, feedback);
        }
      },
      { tone: "primary" },
    );
    dialog.append(
      element(
        "p",
        {},
        `Replaces the secret for client ${template.current.clientId} at ${template.current.issuer}. New and refreshed connections use it; nobody is asked for consent again.`,
      ),
      field({ label: "New client secret", control: secret }),
      feedback,
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("close", () => {
      secret.value = "";
    });
    dialog.showModal();
    secret.focus();
  }

  function openDelete(template, invoker) {
    const dialog = dialogShell(`Delete ${template.displayName}?`, invoker);
    const feedback = element("p", { className: "error", role: "alert" });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Delete template",
      async () => {
        confirm.disabled = true;
        try {
          await request(`/connection-templates/${encodeURIComponent(template.id)}`, {
            method: "DELETE",
            expectedStatus: 204,
          });
          dialog.close();
          await load();
        } catch (cause) {
          confirm.disabled = false;
          if (cause.status === 409) {
            feedback.textContent =
              "Connections still use this template. Their owners or an administrator must disconnect them first.";
            return;
          }
          handle(cause, feedback);
        }
      },
      { tone: "danger" },
    );
    dialog.append(
      statusBlock(
        "warning",
        null,
        "Deleting removes the template and every grant to use it. OCC refuses while any connection uses one of its versions.",
        [],
        { role: null },
      ),
      feedback,
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.showModal();
    cancel.focus();
  }

  void load();
  return section;
}
