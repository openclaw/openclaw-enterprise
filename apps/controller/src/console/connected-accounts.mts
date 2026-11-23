import type { ConnectionTemplate, CredentialSourceMetadata } from "@openclaw-enterprise/contracts";
import { requestFailure } from "./api-client.mjs";
import { button, element, field, setUnavailable } from "./dom.mjs";
import { isOAuthTemplate, type OAuthTemplate } from "./oauth-client-registration.mjs";
import { connectionConsentFailure, startConnectionConsent } from "./connection-consent.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<
  ConsolePageContext,
  "request" | "isCurrent" | "view" | "namespaceId" | "namespace"
>;
type OAuthSource = Extract<CredentialSourceMetadata, { type: "oauth2-refresh-token" }>;

export function renderConnectedAccounts(context: Context) {
  const namespaceId = context.namespaceId!;
  const base = `/namespaces/${encodeURIComponent(namespaceId)}`;
  let templates: OAuthTemplate[] = [];
  let accounts: OAuthSource[] = [];
  const notice = element("p", { className: "hint", role: "status" }, "Loading connected accounts…");
  const list = element("div");
  const create = button("Connect account", () => open(), { tone: "primary", size: "sm" });
  const createReason = element("p", { className: "hint" });
  const section = element(
    "section",
    { className: "resource-list oauth-catalog connected-account-catalog" },
    element(
      "header",
      { className: "oauth-catalog-heading" },
      element("h2", {}, "Connected accounts"),
      create,
    ),
    element(
      "p",
      { className: "hint" },
      "Connect an account once, then grant Agents access to it from their plugin settings.",
    ),
    createReason,
    list,
    notice,
  );
  context.view.append(section);

  function showAccounts() {
    if (!accounts.length) {
      list.replaceChildren();
      return;
    }
    const header = element(
      "tr",
      {},
      ...["Account", "Issuer", "Connection template", "Granted scopes"].map((label) =>
        element("th", { scope: "col" }, label),
      ),
    );
    const body = element("tbody");
    for (const account of accounts) {
      const template = templates.find((item) => item.id === account.connectionTemplateId);
      const consent = account.consent;
      body.append(
        element(
          "tr",
          {},
          element("th", { scope: "row" }, account.name),
          element(
            "td",
            { "data-label": "Issuer" },
            consent.kind === "connection_template" ? consent.issuer : "Built-in OAuth",
          ),
          element(
            "td",
            { "data-label": "Connection template" },
            template?.displayName ?? account.connectionTemplateId ?? "Built-in",
          ),
          element(
            "td",
            { "data-label": "Granted scopes" },
            consent.grantedScopes?.join(", ") || "Not reported",
          ),
        ),
      );
    }
    list.replaceChildren(
      element(
        "table",
        { className: "oauth-catalog-table", "aria-label": "Connected accounts" },
        element("thead", {}, header),
        body,
      ),
    );
  }

  async function readTemplates() {
    const values = await context.request(`${base}/connection-templates`);
    if (!Array.isArray(values)) {
      throw new Error("Invalid template response");
    }
    templates = (values as ConnectionTemplate[])
      .filter(isOAuthTemplate)
      .filter(
        (item) =>
          !!item.current.oauthClientId && (!item.namespaceId || item.namespaceId === namespaceId),
      );
  }

  async function refresh(message?: string) {
    create.disabled = true;
    const [sourceResult, templateResult] = await Promise.allSettled([
      context.request(`${base}/credential-sources`),
      readTemplates(),
    ]);
    if (!context.isCurrent()) {
      return;
    }
    if (sourceResult.status === "fulfilled" && Array.isArray(sourceResult.value)) {
      accounts = (sourceResult.value as CredentialSourceMetadata[]).filter(
        (source): source is OAuthSource =>
          source.type === "oauth2-refresh-token" && source.namespaceId === namespaceId,
      );
      showAccounts();
      notice.textContent =
        message ??
        (accounts.length ? "" : "No connected accounts are available in this Namespace.");
    } else {
      accounts = [];
      list.replaceChildren();
      notice.textContent = "Could not load connected accounts. Refresh to try again.";
    }
    let reason: string | undefined;
    if (context.namespace?.status !== "ready") {
      reason = "This Namespace is not ready for new connections.";
    } else if (templateResult.status === "rejected") {
      reason =
        requestFailure(templateResult.reason).status === 403
          ? "Connecting an account requires credential source create permission in this Namespace."
          : "Could not load connection templates. Refresh to try again.";
    } else if (!templates.length) {
      reason =
        "No OAuth template with a registered client is available. Ask an Installation administrator to configure one.";
    }
    create.disabled = false;
    createReason.textContent = reason ?? "";
    createReason.hidden = !reason;
    setUnavailable(create, Boolean(reason), createReason);
  }

  function open() {
    const dialog = element("dialog", {
      className: "dialog",
      "aria-labelledby": "connect-account-title",
    });
    const choice = element(
      "select",
      { id: "connect-account-template", required: true },
      element("option", { value: "" }, "Choose a connection template"),
      ...templates.map((item) =>
        element("option", { value: item.id }, `${item.displayName} · v${item.current.version}`),
      ),
    );
    const scopes = element("input", {
      id: "connect-account-scopes",
      type: "text",
      spellcheck: false,
    });
    const status = element("p", { className: "hint", role: "status" });
    let pending: ReturnType<typeof startConnectionConsent> | undefined;
    const connect = button("Continue to consent", () => begin(), { tone: "primary" });
    const cancel = button("Cancel", () => dialog.close());
    const reload = button("Refresh templates", () => void reloadTemplates(), { size: "sm" });
    reload.hidden = true;
    function configureScopes(selected: OAuthTemplate | undefined, preserve = false) {
      const fixed = selected?.current.mode === "manual" && selected.current.scopes.length > 0;
      scopes.readOnly = Boolean(fixed);
      if (fixed || !preserve) {
        scopes.value = (
          selected?.current.scopes.length
            ? selected.current.scopes
            : (selected?.current.observed?.requestedScopes ?? [])
        ).join(" ");
      }
      scopeHelp.textContent = fixed
        ? "This template fixes the scopes requested at consent. The provider decides which scopes it grants."
        : "Separate scopes with spaces. The provider decides which scopes it grants.";
    }
    choice.addEventListener("change", () => {
      const selected = templates.find((item) => item.id === choice.value);
      configureScopes(selected);
      status.textContent = "";
      reload.hidden = true;
      connect.textContent = "Continue to consent";
    });
    async function reloadTemplates() {
      const previous = choice.value;
      try {
        await readTemplates();
        choice.replaceChildren(
          element("option", { value: "" }, "Choose a connection template"),
          ...templates.map((item) =>
            element("option", { value: item.id }, `${item.displayName} · v${item.current.version}`),
          ),
        );
        if (templates.some((item) => item.id === previous)) {
          choice.value = previous;
        }
        configureScopes(
          templates.find((item) => item.id === choice.value),
          true,
        );
        status.textContent = "Templates refreshed. Review the selection and try again.";
        reload.hidden = true;
      } catch {
        status.textContent = "Could not refresh templates. Try again.";
      }
    }
    function begin() {
      const template = templates.find((item) => item.id === choice.value);
      if (!template) {
        status.textContent = "Choose a connection template first.";
        return;
      }
      pending?.cancel();
      const selectedScopes = [...new Set(scopes.value.trim().split(/\s+/).filter(Boolean))];
      const fixedScopes = template.current.mode === "manual" && template.current.scopes.length > 0;
      const attempt = startConnectionConsent({
        context,
        namespaceId,
        template,
        ...(!fixedScopes && selectedScopes.length ? { selectedScopes } : {}),
        onDisconnected: () => {
          if (pending !== attempt || !dialog.open) {
            return;
          }
          status.textContent =
            "The consent tab was closed or disconnected. If it is still open, finish there, or close it before retrying or canceling to avoid creating another account.";
          connect.textContent = "Try again";
          connect.disabled = false;
        },
      });
      pending = attempt;
      choice.disabled = scopes.disabled = connect.disabled = true;
      status.textContent = "Complete authorization in the consent tab.";
      void attempt.result
        .then((source) => {
          if (pending !== attempt || !context.isCurrent() || !dialog.open) {
            return;
          }
          dialog.close();
          void refresh(`Connected ${source.name}. You can now grant an Agent access.`);
        })
        .catch((error: unknown) => {
          if (pending !== attempt || !context.isCurrent() || !dialog.open) {
            return;
          }
          status.textContent = connectionConsentFailure(error);
          connect.textContent = "Try again";
          reload.hidden = false;
        })
        .finally(() => {
          if (pending !== attempt) {
            return;
          }
          pending = undefined;
          choice.disabled = scopes.disabled = connect.disabled = false;
        });
    }
    dialog.addEventListener("close", () => {
      pending?.cancel();
      dialog.remove();
      create.focus();
    });
    const scopeField = field({
      label: "Requested scopes (optional)",
      control: scopes,
      help: "Separate scopes with spaces. The provider decides which scopes it grants.",
    });
    const scopeHelp = scopeField.querySelector<HTMLElement>(".field-help")!;
    dialog.append(
      element("h2", { id: "connect-account-title" }, "Connect account"),
      field({ label: "Connection template", control: choice }),
      scopeField,
      status,
      reload,
      element("div", { className: "dialog-actions" }, cancel, connect),
    );
    section.append(dialog);
    dialog.showModal();
    choice.focus();
  }
  void refresh();
}
