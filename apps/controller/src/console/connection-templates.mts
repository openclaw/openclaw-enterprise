import type {
  ConnectionEndpoint,
  ConnectionTemplate,
  McpAuthorizationMetadata,
  Namespace,
} from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator, requestFailure } from "./api-client.mjs";
import {
  openOAuthClientRegistration,
  advertisedClientMethods,
  availabilityLabel,
  oauthClients,
  oauthFailure as failure,
  type PublicClient,
} from "./oauth-client-registration.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import { resourceActionIcon } from "./resource-actions.mjs";
import { googleOAuthProvider } from "./oauth-providers.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
function option(value: string, label: string) {
  return element("option", { value }, label);
}

export async function connectionTemplates(context: Context) {
  return (await context.request("/connection-templates", {
    installationAdministration: "required",
    includeMeta: true,
  })) as {
    data: ConnectionTemplate[];
    meta: { googleWorkspaceDestinations: ConnectionEndpoint[] };
  };
}

function destinationEditor(initial: readonly ConnectionEndpoint[], onEdit: () => void) {
  const body = element("tbody");
  const panel = element("details", { className: "connection-destinations" });
  const summary = element("summary");
  const rows = new Map<HTMLTableRowElement, ReturnType<typeof inputs>>();
  function inputs(value?: ConnectionEndpoint) {
    return {
      host: element("input", {
        "aria-label": "Host",
        required: true,
        value: value?.host ?? "",
        spellcheck: false,
      }),
      port: element("input", {
        "aria-label": "Port",
        type: "number",
        required: true,
        min: 1,
        max: 65535,
        value: String(value?.port ?? 443),
      }),
      path: element("input", {
        "aria-label": "Path",
        required: true,
        pattern: "/.*",
        value: value?.path ?? "/**",
        spellcheck: false,
      }),
    };
  }
  function updateRows() {
    summary.textContent = `API destinations (${rows.size})`;
    for (const remove of body.querySelectorAll("button")) {
      remove.disabled = rows.size === 1;
    }
  }
  function append(value?: ConnectionEndpoint) {
    const controls = inputs(value);
    const row = element("tr");
    const remove = button(
      resourceActionIcon("delete"),
      () => {
        const focusRow = row.nextElementSibling ?? row.previousElementSibling;
        rows.delete(row);
        row.remove();
        updateRows();
        focusRow?.querySelector("input")?.focus();
        onEdit();
      },
      { className: "icon-button", title: "Remove destination", "aria-label": "Remove destination" },
    );
    row.append(
      ...Object.entries(controls).map(([name, input]) =>
        element("td", { "data-label": name }, input),
      ),
      element("td", {}, remove),
    );
    rows.set(row, controls);
    body.append(row);
    return controls.host;
  }
  function replace(values: readonly ConnectionEndpoint[]) {
    panel.open = values.length === 0;
    body.replaceChildren();
    rows.clear();
    for (const value of values) {
      append(value);
    }
    if (!rows.size) {
      append();
    }
    updateRows();
  }
  replace(initial);
  const add = button(
    "Add destination",
    () => {
      const host = append();
      updateRows();
      host.focus();
      onEdit();
    },
    { size: "sm" },
  );
  const table = element(
    "table",
    { className: "connection-destination-table", "aria-label": "HTTPS destinations" },
    element(
      "thead",
      {},
      element(
        "tr",
        {},
        ...["Host", "Port", "Path", ""].map((label) => element("th", { scope: "col" }, label)),
      ),
    ),
    body,
  );
  panel.append(
    summary,
    element(
      "p",
      { className: "hint" },
      "OCE sends credentials only to HTTPS destinations that match a row. Existing connections keep their approved destinations.",
    ),
    element("div", { className: "connection-destination-scroll" }, table),
    add,
  );
  return {
    element: panel,
    replace,
    controls: () => Array.from(rows.values()).flatMap(({ host, port, path }) => [host, port, path]),
    values: () =>
      Array.from(rows.values(), ({ host, port, path }) => ({
        host: host.value.trim(),
        port: Number(port.value),
        path: path.value.trim(),
      })),
  };
}

const installationWide = "installation-wide";
function availabilitySelect(
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
function availabilityNamespace(scope: HTMLSelectElement) {
  return scope.value === installationWide ? undefined : scope.value;
}

export function renderConnectionTemplates(
  context: Context,
  namespaces: readonly Namespace[],
  currentNamespace: string | null,
) {
  const section = element("section", { className: "card" });
  const catalog = element("div");
  const notice = element("p", { className: "hint", role: "status" });
  const create = button("Create connection template", () => edit(), {
    tone: "primary",
    size: "sm",
  });
  section.append(
    element(
      "div",
      { className: "driver-configurations-heading" },
      element("h2", {}, "Connection templates"),
      create,
    ),
    element(
      "p",
      {},
      "Choose which OAuth providers, scopes, and destinations people can use to connect accounts.",
    ),
    catalog,
    notice,
  );
  let clients: PublicClient[] = [];
  let savedTemplates: ConnectionTemplate[] = [];
  let googleDestinations: ConnectionEndpoint[] = [];
  let redirectUri: string | undefined;
  async function refresh(saved?: string) {
    create.disabled = true;
    catalog.replaceChildren();
    notice.textContent = "Loading connection templates…";
    try {
      const [templates, available] = await Promise.all([
        connectionTemplates(context),
        oauthClients(context),
      ]);
      if (!context.isCurrent()) {
        return;
      }
      const clientList = available;
      clients = clientList.data;
      savedTemplates = templates.data;
      googleDestinations = templates.meta.googleWorkspaceDestinations;
      redirectUri = clientList.meta?.redirectUri;
      catalog.append(
        element(
          "section",
          { className: "connection-template-row" },
          element("h3", {}, googleOAuthProvider.displayName),
          element(
            "p",
            { className: "hint" },
            "Start with the Google Workspace plugin’s editable API destinations and register your own OAuth client.",
          ),
          button("Set up Google OAuth", () => edit(undefined, googleOAuthProvider), { size: "sm" }),
        ),
      );
      for (const template of savedTemplates) {
        const scope = availabilityLabel(template, namespaces);
        const client = clients.find((item) => item.id === template.current.oauthClientId);
        catalog.append(
          element(
            "section",
            { className: "connection-template-row" },
            element("h3", {}, template.displayName),
            element(
              "p",
              { className: "hint" },
              `${scope} · Version ${template.current.version} · ${client?.displayName ?? "No OAuth client assigned"}`,
            ),
            button(`Edit ${template.displayName}`, () => edit(template), { size: "sm" }),
          ),
        );
      }
      notice.textContent = saved || (savedTemplates.length ? "" : "No saved connection templates.");
      create.disabled = false;
      return true;
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (refusedAsNonAdministrator(cause)) {
        section.remove();
        return;
      }
      notice.textContent = failure(cause, "the connection template list");
      catalog.append(button("Reload connection templates", () => void refresh(), { size: "sm" }));
    }
  }

  function edit(template?: ConnectionTemplate, preset?: typeof googleOAuthProvider) {
    openConnectionTemplateEditor(context, {
      parent: section,
      namespaces,
      currentNamespace,
      clients,
      googleDestinations,
      template,
      preset,
      onSaved(saved) {
        void refresh(`Saved ${saved.displayName}, version ${saved.current.version}.`);
      },
      onUnconfirmed: () => void refresh(),
      onRegister(saved) {
        openOAuthClientRegistration(context, {
          parent: section,
          namespaces,
          templates: [saved],
          selected: saved,
          redirectUri,
          async onClose(created) {
            if (!(await refresh(created ? `Registered ${created.displayName}.` : undefined))) {
              return;
            }
            const latest = savedTemplates.find((t) => t.id === saved.id);
            if (latest && context.isCurrent() && section.isConnected) {
              edit(latest);
            }
          },
        });
      },
    });
  }
  void refresh();
  return section;
}

export function openConnectionTemplateEditor(
  context: Context,
  options: {
    parent: HTMLElement;
    namespaces: readonly Namespace[];
    currentNamespace: string | null;
    clients: readonly PublicClient[];
    googleDestinations: readonly ConnectionEndpoint[];
    template?: ConnectionTemplate | undefined;
    preset?: typeof googleOAuthProvider | undefined;
    onSaved: (saved: ConnectionTemplate) => void;
    onUnconfirmed: () => void;
    onRegister?: (saved: ConnectionTemplate) => void;
  },
) {
  const { parent, namespaces, currentNamespace, clients, template, preset } = options;
  const version = template?.current;
  const dialog = element("dialog", {
    className: "dialog dialog--framed connection-template-dialog",
    "aria-label": template ? "Edit connection template" : "Create connection template",
  });
  const name = element("input", {
    required: true,
    maxLength: 200,
    value: template?.displayName ?? "",
  });
  const scope = availabilitySelect(namespaces, currentNamespace, template);
  const mode = element(
    "select",
    { id: "connection-template-mode" },
    option("manual", "Enter OAuth details manually"),
    option("mcp_discovery", "Discover from an MCP server URL"),
  );
  mode.value = version?.mode ?? "manual";
  const issuer = element("input", {
    type: "url",
    required: true,
    value: version?.issuer ?? "",
  });
  const authorizationUrl = element("input", {
    type: "url",
    required: true,
    value: version?.authorizationUrl ?? "",
  });
  const tokenUrl = element("input", {
    type: "url",
    required: true,
    value: version?.tokenUrl ?? "",
  });
  const revocationUrl = element("input", {
    type: "url",
    value: version?.revocationUrl ?? "",
  });
  const destinations = destinationEditor(version?.destinations ?? [], markEdited);
  const googleStarter =
    !template && !preset
      ? button("Use Google OAuth settings", applyGoogleSettings, { size: "sm" })
      : undefined;
  const manual = element(
    "fieldset",
    { className: "connection-template-fields" },
    element("legend", {}, "OAuth provider"),
    googleStarter ?? null,
    field({ label: "Issuer URL", control: issuer }),
    field({ label: "Authorization URL", control: authorizationUrl }),
    field({ label: "Token URL", control: tokenUrl }),
    field({ label: "Revocation URL (optional)", control: revocationUrl }),
    destinations.element,
  );
  const server = element("input", {
    id: "connection-template-server",
    type: "url",
    required: true,
    value: version?.mcp?.serverUrl ?? "",
  });
  const authority = element("select");
  const authorityField = field({ label: "Authorization server", control: authority });
  const observation = element("div");
  const discover = button("Discover OAuth settings", () => void inspect(), { size: "sm" });
  const remote = element(
    "fieldset",
    { className: "connection-template-fields" },
    element("legend", {}, "MCP discovery"),
    field({ label: "MCP server URL", control: server }),
    discover,
    authorityField,
    observation,
  );
  const scopeLimit = element(
    "select",
    { id: "connection-template-scope-limit" },
    option("unrestricted", "No template limit"),
    option("restricted", "Limit to approved scopes"),
  );
  scopeLimit.value = version?.scopes.length ? "restricted" : "unrestricted";
  const scopes = element("textarea", { rows: 2, "data-trim": "" });
  scopes.value = version?.scopes.join("\n") ?? "";
  const approvedScopes = field({
    label: "Approved OAuth scopes",
    control: scopes,
    help: "Enter at least one scope. Separate scopes with spaces or new lines.",
  });
  function showScopeLimit() {
    const limited = scopeLimit.value === "restricted";
    scopes.required = limited;
    approvedScopes.hidden = scopes.disabled = !limited;
  }
  scopeLimit.addEventListener("change", showScopeLimit);
  showScopeLimit();
  const parameters = element("textarea", { rows: 2 });
  function formatParameters(values: Readonly<Record<string, string>>) {
    return Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  }
  parameters.value = formatParameters(version?.authorizationParameters ?? {});
  function applyGoogleSettings() {
    if (!name.value.trim()) {
      name.value = googleOAuthProvider.displayName;
    }
    issuer.value = googleOAuthProvider.issuer;
    authorizationUrl.value = googleOAuthProvider.authorizationUrl;
    tokenUrl.value = googleOAuthProvider.tokenUrl;
    revocationUrl.value = googleOAuthProvider.revocationUrl;
    destinations.replace(options.googleDestinations);
    parameters.value = formatParameters(googleOAuthProvider.authorizationParameters);
    clientChoices();
    if (googleStarter) {
      googleStarter.hidden = true;
    }
  }
  const client = element("select");
  const status = element("p", { className: "hint", role: "status" });
  let edited = false;
  const register = options.onRegister
    ? button(
        template ? "Register a new OAuth client" : "Create template and register OAuth client",
        () => {
          if (template && !edited) {
            dialog.close();
            options.onRegister?.(template);
          } else {
            void submit(true);
          }
        },
        { size: "sm" },
      )
    : undefined;
  const save = button(template ? "Save new version" : "Create template", () => void submit(), {
    tone: "primary",
  });
  const close = button("Cancel", () => dialog.close());
  const inputs = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "Template name", control: name }),
    field({ label: "Template availability", control: scope }),
    field({ label: "OAuth configuration", control: mode }),
    manual,
    remote,
    field({
      label: "OAuth scope limit",
      control: scopeLimit,
      help: "Choose which scopes this template allows people to request when connecting an account. With no template limit, the provider and the consent request determine the scopes.",
    }),
    approvedScopes,
    field({
      label: "Authorization parameters (optional)",
      control: parameters,
      help: "Enter one name=value per line for additional provider consent parameters.",
    }),
    options.onRegister
      ? field({
          label: "OAuth client",
          control: client,
          help: "Only compatible clients in this scope appear here. You can save a draft and assign a client later.",
        })
      : null,
    register ?? null,
  );
  dialog.append(
    element(
      "header",
      { className: "dialog-header" },
      element("h2", {}, template ? "Edit connection template" : "Create connection template"),
    ),
    element("div", { className: "dialog-body" }, inputs, status),
    element("div", { className: "dialog-actions" }, close, save),
  );
  parent.append(dialog);
  inputs.addEventListener("input", markEdited);
  inputs.addEventListener("change", markEdited);
  function markEdited() {
    edited = true;
    if (template && register) {
      register.textContent = "Save changes and register OAuth client";
    }
  }
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (uncertain) {
      options.onUnconfirmed();
    }
  });
  let observed = version?.observed;
  let discoveryEpoch = 0;
  let busy = false;
  let uncertain = false;

  function provider() {
    return mode.value === "manual"
      ? {
          issuer: issuer.value.trim(),
          tokenUrl: tokenUrl.value.trim(),
          revocationUrl: revocationUrl.value.trim(),
        }
      : observed;
  }
  function clientChoices(selected = client.value) {
    const oauth = provider();
    const compatible = clients.filter(
      (item) =>
        oauth?.issuer === item.issuer &&
        oauth.tokenUrl === item.tokenUrl &&
        (!oauth.revocationUrl || item.revocationUrl === oauth.revocationUrl) &&
        (mode.value !== "mcp_discovery" ||
          advertisedClientMethods(observed).includes(item.tokenEndpointAuthMethod)) &&
        scope.value !== "" &&
        (!item.namespaceId || item.namespaceId === scope.value),
    );
    client.replaceChildren(
      option("", "Assign later (draft)"),
      ...compatible.map((item) => option(item.id, item.displayName)),
    );
    if (compatible.some((item) => item.id === selected)) {
      client.value = selected;
    }
  }
  function renderDiscovery() {
    const advertised = observed?.issuers ?? [];
    authorityField.hidden = advertised.length < 2;
    const chooseIssuer = option("", "Select an issuer");
    chooseIssuer.disabled = true;
    authority.replaceChildren(chooseIssuer, ...advertised.map((url) => option(url, url)));
    authority.value = observed?.issuer ?? "";
    observation.replaceChildren();
    if (observed?.issuer) {
      const facts = [
        ["Issuer", observed.issuer],
        ["Resource", observed.resource],
        ["Authorization URL", observed.authorizationUrl],
        ["Token URL", observed.tokenUrl],
        ["Revocation URL", observed.revocationUrl],
        ["Registration URL", observed.registrationUrl],
        ["Requested scopes", observed.requestedScopes.join(" ")],
        ["Supported scopes", observed.supportedScopes?.join(" ")],
      ];
      observation.append(
        element("h3", {}, "Discovered provider settings"),
        element(
          "dl",
          { className: "settings" },
          ...facts
            .filter(([, value]) => value)
            .flatMap(([label, value]) => [element("dt", {}, label), element("dd", {}, value)]),
        ),
      );
    }
    clientChoices();
  }
  function showMode() {
    manual.hidden = manual.disabled = mode.value !== "manual";
    remote.hidden = remote.disabled = mode.value === "manual";
    discoveryEpoch++;
    discover.disabled = false;
    renderDiscovery();
  }
  async function inspect(chosenIssuer?: string) {
    if (!validateFields([server])) {
      return;
    }
    const epoch = ++discoveryEpoch;
    const serverUrl = server.value.trim();
    discover.disabled = true;
    status.textContent = "Discovering OAuth settings…";
    observed = undefined;
    renderDiscovery();
    try {
      const result = (await context.request("/connection-templates/discover", {
        method: "POST",
        body: { serverUrl, ...(chosenIssuer && { issuer: chosenIssuer }) },
      })) as McpAuthorizationMetadata;
      if (epoch !== discoveryEpoch || !dialog.open || !context.isCurrent()) {
        return;
      }
      observed = result;
      renderDiscovery();
      status.textContent = result.issuer
        ? "Review the discovered settings and choose an OAuth scope limit."
        : "Choose an advertised authorization server to continue.";
    } catch (cause) {
      if (epoch === discoveryEpoch && dialog.open) {
        status.textContent = failure(cause, "OAuth discovery");
      }
    } finally {
      if (epoch === discoveryEpoch) {
        discover.disabled = false;
      }
    }
  }
  function setBusy(value: boolean) {
    busy = value;
    inputs.disabled = value || uncertain;
    close.disabled = value;
    save.disabled = value || uncertain;
  }
  dialog.addEventListener("cancel", (event) => {
    if (busy) {
      event.preventDefault();
    }
  });
  async function submit(continueRegistration = false) {
    if (
      busy ||
      !validateFields([
        scope,
        name,
        scopes,
        ...(mode.value === "manual"
          ? [issuer, authorizationUrl, tokenUrl, revocationUrl, ...destinations.controls()]
          : [server]),
      ])
    ) {
      return;
    }
    if (mode.value !== "manual" && !observed?.issuer) {
      status.textContent = "Discover the MCP server and select its authorization server first.";
      return;
    }
    const authorizationParameters: Record<string, string> = Object.create(null);
    for (const line of parameters.value.trim().split("\n").filter(Boolean)) {
      const split = line.indexOf("=");
      if (split < 1 || Object.hasOwn(authorizationParameters, line.slice(0, split))) {
        status.textContent = "Enter each authorization parameter once as name=value.";
        return;
      }
      authorizationParameters[line.slice(0, split)] = line.slice(split + 1);
    }
    const approved =
      scopeLimit.value === "restricted" ? [...new Set(scopes.value.trim().split(/\s+/))] : [];
    const body = {
      displayName: name.value.trim(),
      ...(!template && { namespaceId: availabilityNamespace(scope) }),
      ...(client.value && { oauthClientId: client.value }),
      scopes: approved,
      authorizationParameters,
      ...(mode.value === "manual"
        ? {
            mode: "manual",
            issuer: issuer.value.trim(),
            authorizationUrl: authorizationUrl.value.trim(),
            tokenUrl: tokenUrl.value.trim(),
            ...(revocationUrl.value.trim() && { revocationUrl: revocationUrl.value.trim() }),
            destinations: destinations.values(),
          }
        : { mode: "mcp_discovery", serverUrl: server.value.trim(), issuer: observed!.issuer }),
    };
    setBusy(true);
    status.textContent = "Saving connection template…";
    try {
      const saved = (await context.request(
        template
          ? `/connection-templates/${encodeURIComponent(template.id)}`
          : "/connection-templates",
        { method: template ? "PATCH" : "POST", expectedStatus: template ? 200 : 201, body },
      )) as ConnectionTemplate;
      if (!context.isCurrent() || !dialog.open) {
        return;
      }
      if (
        !saved.id ||
        (template &&
          (saved.id !== template.id || saved.current.version < template.current.version)) ||
        saved.displayName !== body.displayName ||
        (saved.current.oauthClientId ?? "") !== client.value ||
        saved.current.issuer !== body.issuer
      ) {
        throw Error("Unconfirmed connection template");
      }
      dialog.close();
      if (continueRegistration && options.onRegister) {
        options.onRegister(saved);
      } else {
        options.onSaved(saved);
      }
    } catch (cause) {
      const code = requestFailure(cause).status;
      uncertain = code === undefined || code >= 500 || code === 408;
      if (dialog.open) {
        status.textContent = failure(cause, "the template change");
      }
    } finally {
      setBusy(false);
    }
  }
  server.addEventListener("input", () => {
    discoveryEpoch++;
    observed = undefined;
    discover.disabled = false;
    renderDiscovery();
    status.textContent = "";
  });
  authority.addEventListener("change", () => {
    if (authority.value) {
      void inspect(authority.value);
    }
  });
  mode.addEventListener("change", showMode);
  for (const control of [issuer, tokenUrl, revocationUrl, scope]) {
    control.addEventListener("input", () => clientChoices());
  }
  if (googleStarter) {
    inputs.addEventListener("input", () => {
      googleStarter.hidden =
        [issuer, authorizationUrl, tokenUrl, revocationUrl, parameters].some((input) =>
          input.value.trim(),
        ) ||
        destinations
          .values()
          .some(({ host, port, path }) => host !== "" || port !== 443 || path !== "/**");
    });
  }
  if (preset) {
    applyGoogleSettings();
  }
  showMode();
  clientChoices(version?.oauthClientId);
  dialog.showModal();
  name.focus();
}
