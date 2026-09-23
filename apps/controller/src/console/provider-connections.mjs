import { element, button } from "./dom.mjs";
import { message, namespacePath } from "./agents/list.mjs";

export function connectionAuth(catalog, connection) {
  const provider = catalog.find((item) => item.id === connection.providerId);
  return {
    provider,
    method: provider?.authMethods.find((item) => item.id === connection.authMethodId),
  };
}

export function connectionLabel(catalog, connection) {
  const { provider, method } = connectionAuth(catalog, connection);
  return `${provider?.label ?? connection.providerId} / ${method?.label ?? connection.authMethodId} / ${connection.name}`;
}

export function connectionStatus(method) {
  if (!method) {
    return "Provider authentication method unavailable.";
  }
  return "Model access has not been tested. Verify connectivity and authentication from the deployed runtime.";
}

export async function renderProviderConnections(context) {
  const setup = element("section", { className: "agent-card" });
  const installation = element("section", { className: "agent-card" });
  context.view.replaceChildren(setup, installation);
  async function loadInstallation() {
    installation.replaceChildren(element("h2", {}, "Installation Providers"));
    try {
      const providers = await context.request("/providers");
      if (!context.isCurrent()) {
        return;
      }
      installation.append(
        element(
          "p",
          { className: "hint" },
          "Configured by the Installation operator for control-plane services.",
        ),
        providers.length
          ? element(
              "ul",
              { className: "collection", "aria-label": "Installation Providers" },
              ...providers.map((provider) =>
                element(
                  "li",
                  { className: "resource" },
                  element("strong", {}, provider.name ?? provider.id),
                  element("span", { className: "badge" }, provider.type),
                ),
              ),
            )
          : element("p", {}, "No Providers are configured for this Installation."),
      );
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      installation.append(
        element(
          "p",
          { className: "error", role: "alert" },
          `Provider discovery unavailable. ${message(error)}`,
        ),
        button("Retry Installation Providers", loadInstallation),
      );
    }
  }
  async function loadConnections() {
    setup.replaceChildren(element("h2", {}, "Provider connections"));
    if (!context.namespaceId) {
      setup.append(
        element("p", {}, "Choose an accessible Namespace to save provider connections."),
      );
      return;
    }
    const path = `${namespacePath(context.namespaceId)}/provider-connections`;
    try {
      const [catalog, connections] = await Promise.all([
        context.request("/provider-catalog"),
        context.request(path),
      ]);
      if (!context.isCurrent()) {
        return;
      }
      let pending = false;
      function setPending(value) {
        pending = value;
        for (const action of setup.querySelectorAll("button, input, select")) {
          action.disabled = value;
        }
      }
      const feedback = element("p", { className: "error", role: "alert" });
      const rows = element("ul", { className: "collection", "aria-label": "Provider connections" });
      for (const connection of connections) {
        const { method } = connectionAuth(catalog, connection);
        const remove = button(
          "Remove",
          async () => {
            if (pending) {
              return;
            }
            setPending(true);
            feedback.textContent = "";
            try {
              await context.request(`${path}/${encodeURIComponent(connection.id)}`, {
                method: "DELETE",
              });
              if (context.isCurrent()) {
                await loadConnections();
              }
            } catch (error) {
              if (!context.isCurrent()) {
                return;
              }
              if (error.status === 401) {
                context.onExpired();
              } else {
                feedback.textContent =
                  error.status === 409
                    ? "This connection is used by an Agent or revision and cannot be removed."
                    : message(error, true);
                setPending(false);
              }
            }
          },
          { "aria-label": `Remove ${connection.name}` },
        );
        rows.append(
          element(
            "li",
            { className: "resource" },
            element(
              "div",
              {},
              element("strong", {}, connectionLabel(catalog, connection)),
              element("p", { className: "hint" }, connectionStatus(method)),
              connection.baseUrl ? element("p", {}, connection.baseUrl) : null,
            ),
            remove,
          ),
        );
      }
      const name = element("input", { id: "connection-name", required: true, maxlength: "200" });
      const provider = element(
        "select",
        { id: "connection-provider", required: true },
        ...catalog.map((item) => element("option", { value: item.id }, item.label)),
      );
      const auth = element("select", { id: "connection-auth", required: true });
      const credentialSource = element(
        "select",
        { id: "connection-credential-source" },
        element("option", { value: "new" }, "Enter a new credential"),
        element("option", { value: "existing" }, "Use an existing Secret ID"),
      );
      const credentialValue = element("input", {
        id: "connection-credential-value",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        maxlength: "65536",
      });
      const secret = element("input", {
        id: "connection-secret",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "sec_…",
      });
      const baseUrl = element("input", {
        id: "connection-url",
        type: "url",
        placeholder: "http://model-server:11434",
      });
      const field = (label, input, ...children) =>
        element(
          "div",
          { className: "form-field" },
          element("label", { for: input.id }, label),
          input,
          ...children,
        );
      const secretField = field(
        "Secret ID",
        secret,
        element(
          "p",
          { className: "hint" },
          "Use an existing Secret in this Namespace. Secret values are never shown.",
        ),
      );
      const credentialField = field(
        "API key",
        credentialValue,
        element(
          "p",
          { className: "hint" },
          "Stored as a Secret in this Namespace. The value is never returned.",
        ),
      );
      const credentialFields = element(
        "div",
        {},
        field("Credential source", credentialSource),
        credentialField,
        secretField,
      );
      const urlField = field(
        "Base URL",
        baseUrl,
        element(
          "p",
          { className: "hint" },
          "Configure network access from the runtime to this server and select a matching model in the Agent Configuration. Saving does not probe the URL or change network access.",
        ),
      );
      const status = element("p", { className: "hint", role: "status" });
      function updateAuth() {
        const selected = catalog.find((item) => item.id === provider.value);
        const method = selected?.authMethods.find((item) => item.id === auth.value);
        credentialFields.hidden = method?.credentialKind !== "secret";
        secretField.hidden = credentialFields.hidden || credentialSource.value !== "existing";
        credentialField.hidden = credentialFields.hidden || credentialSource.value !== "new";
        secret.required = !secretField.hidden;
        credentialValue.required = !credentialField.hidden;
        urlField.hidden = !selected?.requiresBaseUrl;
        baseUrl.required = selected?.requiresBaseUrl ?? false;
        status.textContent = connectionStatus(method);
      }
      function updateProvider() {
        const selected = catalog.find((item) => item.id === provider.value);
        auth.replaceChildren(
          ...(selected?.authMethods ?? []).map((item) =>
            element("option", { value: item.id }, item.label),
          ),
        );
        secret.value = "";
        credentialValue.value = "";
        baseUrl.value = "";
        updateAuth();
      }
      provider.addEventListener("change", updateProvider);
      auth.addEventListener("change", () => {
        secret.value = "";
        credentialValue.value = "";
        updateAuth();
      });
      credentialSource.addEventListener("change", () => {
        credentialValue.value = "";
        updateAuth();
      });
      updateProvider();
      const submit = element(
        "button",
        { type: "submit", className: "primary", disabled: catalog.length === 0 },
        "Save provider connection",
      );
      const form = element(
        "form",
        {},
        element("h3", {}, "Add provider"),
        field("Connection name", name),
        field("Provider", provider),
        field("Authentication method", auth),
        credentialFields,
        urlField,
        status,
        submit,
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pending || !form.reportValidity()) {
          return;
        }
        setPending(true);
        feedback.textContent = "";
        const body = {
          name: name.value.trim(),
          providerId: provider.value,
          authMethodId: auth.value,
        };
        if (!secretField.hidden && secret.value.trim()) {
          body.source = {
            kind: "secret",
            namespaceId: context.namespaceId,
            id: secret.value.trim(),
          };
        }
        if (!credentialField.hidden) {
          body.secretValue = credentialValue.value;
        }
        if (!urlField.hidden) {
          body.baseUrl = baseUrl.value.trim();
        }
        try {
          await context.request(path, { method: "POST", body });
          credentialValue.value = "";
          if (context.isCurrent()) {
            await loadConnections();
          }
        } catch (error) {
          credentialValue.value = "";
          if (!context.isCurrent()) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
          } else {
            if (error.code === "SECRET_DRIVER_UNAVAILABLE") {
              feedback.textContent =
                "Credential storage is not configured for this Installation. Ask the Installation operator to configure a Secret Driver. No provider connection was saved.";
            } else {
              feedback.textContent =
                error.status === 409
                  ? "A provider connection with this name already exists. Choose another name."
                  : message(error, true);
            }
            // An uncertain save may already have created the Secret and connection.
            // Require a fresh read before allowing another credential creation.
            if (
              error.code === "SECRET_DRIVER_UNAVAILABLE" ||
              [400, 403, 404, 409, 429].includes(error.status)
            ) {
              setPending(false);
            }
          }
        }
      });
      setup.append(
        element(
          "p",
          { className: "hint" },
          "Save a provider and authentication method for Agents in this Namespace. Saving does not test model access.",
        ),
        connections.length ? rows : element("p", {}, "No provider connections saved."),
        feedback,
        form,
      );
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      setup.append(
        element(
          "p",
          { className: "error", role: "alert" },
          `Provider connections unavailable. ${message(error)}`,
        ),
        button("Retry provider connections", loadConnections),
      );
    }
  }
  await Promise.all([loadConnections(), loadInstallation()]);
}
