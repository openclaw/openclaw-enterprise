import type {
  ConnectionTemplate,
  McpAuthorizationMetadata,
  Namespace,
  OAuthClient,
} from "@openclaw-enterprise/contracts";
import { refusedAsNonAdministrator, requestFailure } from "./api-client.mjs";
import { button, element, field, validateFields } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
type PublicClient = Omit<OAuthClient, "credentialRefreshDriverId">;

function option(value: string, label: string) {
  return element("option", { value }, label);
}

function failure(cause: unknown, operation: string) {
  const { status, serverMessage } = requestFailure(cause);
  if (status === 403) {
    return "Your access does not include this Installation operation.";
  }
  if (status === 400 || status === 409) {
    return serverMessage || "OCC refused these values. Review the form and try again.";
  }
  return `Could not confirm ${operation}. Refresh the catalog before trying again.`;
}

export function renderConnectionTemplates(context: Context, namespaces: readonly Namespace[]) {
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
  let redirectUri: string | undefined;
  async function refresh(saved?: string) {
    create.disabled = true;
    catalog.replaceChildren();
    notice.textContent = "Loading connection templates…";
    try {
      const [templates, available] = await Promise.all([
        context.request("/connection-templates", { installationAdministration: "required" }),
        context.request("/oauth-clients", {
          installationAdministration: "required",
          includeMeta: true,
        }),
      ]);
      if (!context.isCurrent()) {
        return;
      }
      const clientList = available as { data: PublicClient[]; meta?: { redirectUri?: string } };
      clients = clientList.data;
      redirectUri = clientList.meta?.redirectUri;
      for (const template of templates as ConnectionTemplate[]) {
        const scope =
          namespaces.find((item) => item.id === template.namespaceId)?.name ??
          template.namespaceId ??
          "Installation";
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
      notice.textContent =
        saved ||
        ((templates as ConnectionTemplate[]).length
          ? ""
          : "No connection templates have been created.");
      create.disabled = false;
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

  function edit(template?: ConnectionTemplate) {
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
    const scope = element(
      "select",
      { disabled: !!template },
      option("", "Installation-wide"),
      ...namespaces.map((item) => option(item.id, item.name)),
    );
    if (template?.namespaceId && !namespaces.some((item) => item.id === template.namespaceId)) {
      scope.append(option(template.namespaceId, template.namespaceId));
    }
    scope.value = template?.namespaceId ?? "";
    const mode = element(
      "select",
      { id: "connection-template-mode" },
      option("manual", "Enter OAuth details manually"),
      option("mcp_discovery", "Discover from an MCP server URL"),
    );
    mode.value = version?.mode ?? "manual";
    const issuer = element("input", { type: "url", required: true, value: version?.issuer ?? "" });
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
    const revocationUrl = element("input", { type: "url", value: version?.revocationUrl ?? "" });
    const host = element("input", { required: true, value: version?.recipient.host ?? "" });
    const port = element("input", {
      type: "number",
      required: true,
      min: 1,
      max: 65535,
      value: String(version?.recipient.port ?? 443),
    });
    const path = element("input", {
      required: true,
      pattern: "/.*",
      value: version?.recipient.path ?? "/**",
    });
    const access = element(
      "select",
      {},
      option("read-only", "Read only"),
      option("full", "Read and write"),
    );
    access.value = version?.recipient.access ?? "read-only";
    const manual = element(
      "fieldset",
      { className: "connection-template-fields" },
      element("legend", {}, "OAuth provider and allowed destination"),
      field({ label: "Issuer URL", control: issuer }),
      field({ label: "Authorization URL", control: authorizationUrl }),
      field({ label: "Token URL", control: tokenUrl }),
      field({ label: "Revocation URL (optional)", control: revocationUrl }),
      field({ label: "Destination host", control: host }),
      field({ label: "Port", control: port }),
      field({ label: "Path", control: path }),
      field({ label: "Destination access", control: access }),
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
    const scopes = element("textarea", { rows: 2 });
    scopes.value = version?.scopes.join("\n") ?? "";
    const parameters = element("textarea", { rows: 2 });
    parameters.value = Object.entries(version?.authorizationParameters ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const client = element("select");
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
    const secretField = field({ label: "Client secret", control: secret });
    const register = button("Register OAuth client", () => void registerClient(), { size: "sm" });
    const registerPanel = element(
      "details",
      {},
      element("summary", {}, "Register a new OAuth client"),
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
    const status = element("p", { className: "hint", role: "status" });
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
        label: "Approved OAuth scopes",
        control: scopes,
        help: "Enter the scopes to request, separated by spaces or new lines.",
      }),
      field({
        label: "Authorization parameters (optional)",
        control: parameters,
        help: "Enter one name=value per line for additional provider consent parameters.",
      }),
      field({
        label: "OAuth client",
        control: client,
        help: "Only compatible clients in this scope appear here. You can save a draft and assign a client later.",
      }),
      registerPanel,
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
    section.append(dialog);
    dialog.addEventListener("close", () => {
      secret.value = "";
      dialog.remove();
      if (uncertain) {
        void refresh();
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
          ? "Review the discovered settings and choose the scopes to approve."
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
    async function registerClient() {
      if (busy) {
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
      setBusy(true);
      status.textContent = "Registering OAuth client…";
      try {
        const created = (await context.request("/oauth-clients", {
          method: "POST",
          expectedStatus: 201,
          body: {
            displayName: clientName.value.trim(),
            ...(scope.value && { namespaceId: scope.value }),
            issuer: oauth.issuer,
            tokenUrl: oauth.tokenUrl,
            ...(oauth.revocationUrl && { revocationUrl: oauth.revocationUrl }),
            clientId: clientId.value.trim(),
            tokenEndpointAuthMethod: method.value,
            ...(method.value !== "none" && { clientSecret: secret.value }),
          },
        })) as PublicClient;
        if (!context.isCurrent() || !dialog.open) {
          return;
        }
        if (
          !created.id ||
          created.issuer !== oauth.issuer ||
          created.tokenUrl !== oauth.tokenUrl ||
          created.clientId !== clientId.value.trim() ||
          (created.namespaceId ?? "") !== scope.value
        ) {
          throw Error("Unconfirmed OAuth client");
        }
        clients.push(created);
        clientChoices(created.id);
        registerPanel.open = false;
        status.textContent = `Registered ${created.displayName}. Save the template to associate this client.`;
      } catch (cause) {
        const code = requestFailure(cause).status;
        uncertain = code === undefined || code >= 500 || code === 408;
        if (dialog.open) {
          status.textContent = failure(cause, "OAuth client registration");
        }
      } finally {
        secret.value = "";
        setBusy(false);
      }
    }
    async function submit() {
      if (
        busy ||
        !validateFields([
          name,
          ...(mode.value === "manual"
            ? [issuer, authorizationUrl, tokenUrl, revocationUrl, host, port, path]
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
      const approved = [...new Set(scopes.value.trim().split(/\s+/).filter(Boolean))];
      const body = {
        displayName: name.value.trim(),
        ...(!template && scope.value && { namespaceId: scope.value }),
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
              recipient: {
                host: host.value.trim(),
                port: Number(port.value),
                path: path.value.trim(),
                access: access.value,
              },
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
            (saved.id !== template.id || saved.current.version <= template.current.version)) ||
          saved.displayName !== body.displayName ||
          (saved.current.oauthClientId ?? "") !== client.value ||
          saved.current.issuer !== body.issuer
        ) {
          throw Error("Unconfirmed connection template");
        }
        dialog.close();
        void refresh(`Saved ${saved.displayName}, version ${saved.current.version}.`);
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
    method.addEventListener("change", () => {
      secretField.hidden = secret.disabled = method.value === "none";
      secret.value = "";
    });
    showMode();
    clientChoices(version?.oauthClientId);
    dialog.showModal();
    name.focus();
  }
  void refresh();
  return section;
}
