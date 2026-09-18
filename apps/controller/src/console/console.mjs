import { element, button } from "./dom.mjs";
import { renderAgentList, renderCreateAgent, renderAgentDetail } from "./agents.mjs";
import { createApiClient } from "./api-client.mjs";
import { createViewLifetime } from "./view-lifetime.mjs";
import { createNavigation, pages } from "./navigation.mjs";
import { createShell, panel, sorted } from "./shell.mjs";

const app = document.querySelector("#app");
const lifetime = createViewLifetime();
let session = null;
let namespaces = [];
let namespaceId = null;
let loggingOut = false;
const navigation = createNavigation({
  getNamespaceId: () => namespaceId,
  isLoggingOut: () => loggingOut,
  loadPage,
});
const { route, pageUrl, safeReturn, navigate } = navigation;
const shellUI = createShell({ app, pages, route, pageUrl, navigate, loadPage, logout });
const { publicPanel, renderRows, switchNamespace } = shellUI;
const request = createApiClient({
  lifetime,
  hasSession: () => session !== null,
  onExpired: () => showLogin("Your session has expired.", location.pathname + location.search),
});

function resetReads() {
  shellUI.reset();
  return lifetime.reset();
}

function renderShell(feature) {
  return shellUI.renderShell(feature, { session, namespaces, namespaceId });
}

function clearPrivate() {
  session = null;
  namespaces = [];
  namespaceId = null;
}

function showLogin(message = "", returnPath = null) {
  resetReads();
  clearPrivate();
  const url = new URL("/console/login", location.origin);
  const destination = safeReturn(returnPath);
  if (destination) {
    url.searchParams.set("return", destination);
  }
  history.replaceState(null, "", `${url.pathname}${url.search}`);
  const username = element("input", {
    id: "username",
    name: "username",
    type: "email",
    autocomplete: "username",
    required: "",
    "aria-describedby": "username-hint",
  });
  const password = element("input", {
    id: "password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: "",
  });
  const feedback = element("p", { className: "error", role: "alert" }, message);
  const submit = element("button", { type: "submit", className: "primary" }, "Login");
  const form = element(
    "form",
    {},
    element("label", { for: "username" }, "Username"),
    username,
    element("span", { id: "username-hint", className: "hint" }, "Use your account email"),
    element("label", { for: "password" }, "Password"),
    password,
    feedback,
    submit,
  );
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) {
      return;
    }
    pending = true;
    submit.disabled = true;
    feedback.textContent = "";
    const active = lifetime.capture();
    try {
      await request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: username.value, password: password.value },
      });
      if (!lifetime.isCurrent(active)) {
        return;
      }
      password.value = "";
      history.replaceState(null, "", destination ?? "/console/agents");
      await loadPage();
    } catch (error) {
      if (!lifetime.isCurrent(active)) {
        return;
      }
      feedback.textContent =
        error.status === 429
          ? "Too many attempts. Please try again later."
          : error.status === 400 || error.status === 401 || error.status === 403
            ? "Could not sign in. Check your username and password."
            : "Sign-in is unavailable. Please retry.";
    } finally {
      if (lifetime.isCurrent(active)) {
        pending = false;
        submit.disabled = false;
      }
    }
  });
  app.replaceChildren(
    element(
      "main",
      { className: "auth" },
      element("p", { className: "brand" }, "OpenClaw Enterprise"),
      element("h1", {}, "Welcome back"),
      element("p", { className: "muted" }, "Sign in to your Installation."),
      form,
    ),
  );
}

async function loadPage() {
  if (loggingOut) {
    return;
  }
  const current = route();
  const active = resetReads();
  clearPrivate();
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
  publicPanel("Loading…", "Checking your session.");
  if (!Object.hasOwn(pages, current.feature) && current.feature !== "login") {
    publicPanel("Page not found", "This console page is unavailable.", "Go to Agents", () =>
      navigate("agents", current.namespace),
    );
    return;
  }
  let shell;
  if (current.feature !== "login") {
    namespaceId = current.namespace;
    shell = renderShell(current.feature);
    panel(shell.view, "Loading…", "Checking your session and Namespace access.");
  }
  try {
    const resolvedSession = await request("/api/auth/session");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    session = resolvedSession;
    if (session === null) {
      const destination =
        current.feature === "login"
          ? current.url.searchParams.get("return")
          : pageUrl(current.target, current.namespace);
      showLogin(
        current.feature !== "login" &&
          current.url.pathname !== "/console/" &&
          current.url.pathname !== "/console"
          ? "Your session has expired."
          : "",
        destination,
      );
      return;
    }
    if (current.feature === "login") {
      history.replaceState(
        null,
        "",
        safeReturn(current.url.searchParams.get("return")) ?? "/console/agents",
      );
      void loadPage();
      return;
    }
    const readable = await request("/namespaces");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (!Array.isArray(readable)) {
      throw new Error("Invalid collection response");
    }
    namespaces = sorted(readable);
    namespaceId =
      current.namespace ??
      (namespaces.find((item) => item.status === "ready") ?? namespaces[0])?.id ??
      null;
    navigation.restoreHistory();
    history.replaceState(
      { previousCollection: navigation.previousCollection },
      "",
      pageUrl(current.target),
    );
    shell = renderShell(current.feature);
    if (current.feature === "settings") {
      shell.view.append(
        element(
          "section",
          { className: "state-panel" },
          element("h2", {}, "Signed-in account"),
          element(
            "dl",
            { className: "settings" },
            element("dt", {}, "Name"),
            element("dd", {}, session.user.name),
            element("dt", {}, "Email"),
            element("dd", {}, session.user.email),
          ),
          element("p", {}, "No configurable settings in this release."),
          button("Back", () => navigate(navigation.previousCollection)),
        ),
      );
      return;
    }
    if (current.feature === "agents" && !namespaces.some((item) => item.id === namespaceId)) {
      panel(
        shell.view,
        namespaceId === null ? "No readable Namespaces" : "Namespace unavailable",
        namespaceId === null
          ? "Ask an administrator to provision a Namespace or grant access. Providers and Namespaces remain available in navigation."
          : "This Namespace is missing or you no longer have access. Choose another Namespace.",
        namespaces.length ? "Switch Namespace" : "Refresh",
        () => (namespaces.length ? switchNamespace() : void loadPage()),
      );
      return;
    }
    const agentContext = {
      view: shell.view,
      namespaceId,
      request,
      navigate,
      pageUrl,
      isCurrent: () => lifetime.isCurrent(active),
      onExpired: () => {
        if (lifetime.isCurrent(active)) {
          showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
        }
      },
      setTitle: (title) => {
        app.querySelector("h1").textContent = title;
      },
      url: current.url,
    };
    if (current.creating) {
      renderCreateAgent(agentContext);
      return;
    }
    if (current.agentId) {
      await renderAgentDetail({ ...agentContext, agentId: current.agentId });
      return;
    }
    panel(shell.view, "Loading…", `Reading ${pages[current.feature].toLowerCase()}.`);
    const items =
      current.feature === "namespaces"
        ? namespaces
        : await request(
            current.feature === "providers"
              ? "/providers"
              : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
          );
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (!Array.isArray(items)) {
      throw new Error("Invalid collection response");
    }
    if (current.feature === "agents") {
      renderAgentList({ ...agentContext, items });
    } else {
      renderRows(shell.view, current.feature, items);
    }
  } catch (error) {
    if (!lifetime.isCurrent(active) || error.name === "AbortError") {
      return;
    }
    if (error.status === 401) {
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    if (!session) {
      clearPrivate();
      publicPanel(
        "Session unavailable",
        "Could not check your session. Please retry.",
        "Retry",
        () => void loadPage(),
      );
      return;
    }
    shell = renderShell(current.feature);
    const title =
      error.status === 403
        ? "Access denied"
        : error.status === 404
          ? "Resource unavailable"
          : error.status === 400
            ? "Namespace unavailable"
            : error.name === "TypeError" || error.name === "TimeoutError"
              ? "Request interrupted"
              : current.feature === "providers"
                ? "Provider discovery unavailable"
                : "Request unavailable";
    panel(
      shell.view,
      title,
      error.status === 403
        ? "You do not have permission to read this collection."
        : "The read could not be completed. Retry to check current access and saved state.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    if (lifetime.isCurrent(active) && shell) {
      shell.refresh.disabled = false;
      shell.view.setAttribute("aria-busy", "false");
    }
  }
}

async function logout() {
  loggingOut = true;
  const active = resetReads();
  clearPrivate();
  publicPanel("Signing out…", "Confirming that your session has ended.");
  let confirmed = false;
  try {
    await request("/api/auth/sign-out", { method: "POST" });
    confirmed = true;
  } catch {
    try {
      confirmed = (await request("/api/auth/session")) === null;
    } catch {
      /* Keep the blocking view until the server can confirm revocation. */
    }
  }
  if (!lifetime.isCurrent(active)) {
    return;
  }
  if (confirmed) {
    loggingOut = false;
    navigation.resetHistory();
    showLogin();
  } else {
    publicPanel(
      "Could not confirm logout",
      "Private content is hidden. Retry to end your session.",
      "Retry",
      () => void logout(),
    );
  }
}

window.addEventListener("popstate", () => {
  if (!loggingOut) {
    void loadPage();
  }
});
window.addEventListener("focus", () => {
  if (session && !loggingOut && !app.querySelector("form, dialog[open]")) {
    void loadPage();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && session && !loggingOut && !app.querySelector("form, dialog[open]")) {
    void loadPage();
  }
});
window.addEventListener("pagehide", () => {
  resetReads();
  clearPrivate();
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
  app.replaceChildren();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) {
    return;
  }
  if (loggingOut) {
    publicPanel(
      "Could not confirm logout",
      "Private content is hidden. Retry to end your session.",
      "Retry",
      () => void logout(),
    );
  } else {
    void loadPage();
  }
});
void loadPage();
