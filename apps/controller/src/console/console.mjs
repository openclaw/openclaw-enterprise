import { element, button } from "./dom.mjs";
import { renderAgentList, renderCreateAgent, renderAgentDetail } from "./agents.mjs";
import { createApiClient } from "./api-client.mjs";
import { createViewLifetime } from "./view-lifetime.mjs";
import { createNavigation, pages } from "./navigation.mjs";
import { createShell, panel, sorted } from "./shell.mjs";
import { createDraftStore } from "./drafts.mjs";
import { renderRuntimeImages } from "./runtime-images.mjs";

const app = document.querySelector("#app");
const lifetime = createViewLifetime();
let session = null;
let namespaces = [];
let namespaceId = null;
let loggingOut = false;
let navigateAgentTab = null;
const drafts = createDraftStore();
let draftUserId = null;
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
const retainedViews = new Map();
let mountedRouteKey = null;

function sessionOwnerKey(value) {
  const userId = value?.user?.id;
  const sessionKey = value?.sessionKey;
  return typeof userId === "string" &&
    userId.length > 0 &&
    typeof sessionKey === "string" &&
    sessionKey.length > 0
    ? JSON.stringify([userId, sessionKey])
    : null;
}

function routeKey(current, selection = current.namespace ?? namespaceId) {
  if (!Object.hasOwn(pages, current.feature)) {
    return null;
  }
  return pageUrl(current.target, selection);
}

function clearRetainedViews() {
  retainedViews.clear();
  mountedRouteKey = null;
}

function retainedViewNamespace(key) {
  return new URL(key, location.origin).searchParams.get("namespace");
}

function clearRetainedViewsForNamespace(selection) {
  if (selection === null) {
    return;
  }
  for (const key of retainedViews.keys()) {
    if (retainedViewNamespace(key) === selection) {
      retainedViews.delete(key);
    }
  }
  if (mountedRouteKey && retainedViewNamespace(mountedRouteKey) === selection) {
    mountedRouteKey = null;
  }
}

function clearRetainedViewsOutsideNamespaces(readable) {
  const allowed = new Set(readable.map((item) => item.id));
  const accessRemoved = namespaces.some((item) => !allowed.has(item.id));
  for (const key of retainedViews.keys()) {
    const selection = retainedViewNamespace(key);
    // The global collection represents every readable Namespace, not just its URL selection.
    const revokedCollection =
      accessRemoved && new URL(key, location.origin).pathname === "/console/namespaces";
    if (revokedCollection || (selection !== null && !allowed.has(selection))) {
      retainedViews.delete(key);
    }
  }
  if (mountedRouteKey) {
    const selection = retainedViewNamespace(mountedRouteKey);
    if (selection !== null && !allowed.has(selection)) {
      mountedRouteKey = null;
    }
  }
}

function clearPasswordInputs() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
}

function retainMountedView() {
  const owner = sessionOwnerKey(session);
  const view = app.querySelector('.content [aria-live="polite"]');
  if (!owner || mountedRouteKey === null || !view) {
    return;
  }
  retainedViews.set(mountedRouteKey, {
    owner,
    snapshot: view.cloneNode(true),
    title: app.querySelector(".content h1")?.textContent ?? null,
    scope: app.querySelector(".content .scope")?.textContent ?? null,
    scrollY: window.scrollY,
  });
  while (retainedViews.size > 16) {
    retainedViews.delete(retainedViews.keys().next().value);
  }
  mountedRouteKey = null;
}

function restoreRetainedView(current) {
  const owner = sessionOwnerKey(session);
  const key = routeKey(current);
  const retained = key && retainedViews.get(key);
  if (!owner || !retained || retained.owner !== owner) {
    return null;
  }
  retainedViews.delete(key);
  const shell = renderShell(current.feature);
  if (retained.title) {
    app.querySelector(".content h1").textContent = retained.title;
  }
  if (retained.scope) {
    app.querySelector(".content .scope").textContent = retained.scope;
  }
  shell.view.replaceChildren(...retained.snapshot.childNodes);
  shell.view.setAttribute("aria-busy", "true");
  shell.view.setAttribute("inert", "");
  for (const control of shell.view.querySelectorAll("button, input, select, textarea")) {
    control.disabled = true;
  }
  mountedRouteKey = key;
  const active = lifetime.capture();
  requestAnimationFrame(() => {
    if (lifetime.isCurrent(active) && mountedRouteKey === key) {
      window.scrollTo({ top: retained.scrollY, left: 0 });
    }
  });
  return shell;
}

function markMountedRoute(current) {
  mountedRouteKey = routeKey(current);
}

function resetReads({ retainView = false } = {}) {
  drafts.flush();
  navigateAgentTab = null;
  clearPasswordInputs();
  shellUI.reset();
  if (retainView) {
    retainMountedView();
  } else {
    mountedRouteKey = null;
  }
  return lifetime.reset();
}

function renderShell(feature) {
  const shell = shellUI.renderShell(feature, { session, namespaces, namespaceId });
  if (shell.diagnostics) {
    void renderRuntimeImages(shell.diagnostics, {
      request,
      namespaceId,
      lifetime,
      active: lifetime.capture(),
    });
  }
  return shell;
}

function clearPrivate() {
  session = null;
  namespaces = [];
  namespaceId = null;
  clearRetainedViews();
}

function clearDrafts() {
  drafts.clear();
  draftUserId = null;
}

function showLogin(message = "", returnPath = null) {
  clearDrafts();
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
      element(
        "p",
        { className: "brand" },
        element("img", { src: "/console/oce-mascot.png", alt: "", width: "40", height: "40" }),
        "OpenClaw Enterprise",
      ),
      element("h1", {}, "Welcome back"),
      element("p", { className: "muted" }, "Sign in to your Installation."),
      form,
    ),
  );
}

async function loadPage({ fromNavigation = false } = {}) {
  if (loggingOut) {
    return;
  }
  const current = route();
  if (fromNavigation && navigateAgentTab?.(current.url)) {
    // The tab handler can reject navigation and restore the previous URL.
    markMountedRoute(route());
    return;
  }
  const knownPrivateState = session !== null && Object.hasOwn(pages, current.feature);
  namespaceId = current.namespace;
  const active = resetReads({ retainView: knownPrivateState });
  let shell = knownPrivateState ? restoreRetainedView(current) : null;
  let retained = shell !== null;
  if (!retained) {
    publicPanel("Loading…", "Checking your session.");
  }
  if (!Object.hasOwn(pages, current.feature) && current.feature !== "login") {
    publicPanel("Page not found", "This console page is unavailable.", "Go to Agents", () =>
      navigate("agents", current.namespace),
    );
    return;
  }
  if (current.feature !== "login" && !retained) {
    shell = renderShell(current.feature);
    panel(shell.view, "Loading…", "Checking your session and Namespace access.");
  }
  let sessionResolved = false;
  let accessResolved = false;
  try {
    const previousOwner = sessionOwnerKey(session);
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
    sessionResolved = true;
    const owner = sessionOwnerKey(session);
    if (!owner || previousOwner !== owner || draftUserId !== owner) {
      clearDrafts();
      clearRetainedViews();
      draftUserId = owner;
      if (retained) {
        retained = false;
        shell = null;
        publicPanel("Loading…", "Checking your session.");
      }
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
    clearRetainedViewsOutsideNamespaces(readable);
    namespaces = sorted(readable);
    accessResolved = true;
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
    const agentsNamespaceUnavailable =
      current.feature === "agents" && !namespaces.some((item) => item.id === namespaceId);
    let retainedItems = null;
    let retainedAgent = null;
    if (
      retained &&
      !agentsNamespaceUnavailable &&
      current.feature !== "settings" &&
      !current.creating
    ) {
      if (current.agentId) {
        retainedAgent = await request(
          `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
        );
      } else {
        retainedItems =
          current.feature === "namespaces"
            ? namespaces
            : await request(
                current.feature === "backends"
                  ? "/backends"
                  : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
              );
      }
      if (!lifetime.isCurrent(active)) {
        return;
      }
    }
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
      markMountedRoute(current);
      return;
    }
    if (agentsNamespaceUnavailable) {
      clearRetainedViewsForNamespace(namespaceId);
      panel(
        shell.view,
        namespaceId === null ? "No readable Namespaces" : "Namespace unavailable",
        namespaceId === null
          ? "Ask an administrator to provision a Namespace or grant access. Namespaces remain available in navigation."
          : "This Namespace is missing or you no longer have access. Choose another Namespace.",
        namespaces.length ? "Switch Namespace" : "Refresh",
        () => (namespaces.length ? switchNamespace() : void loadPage()),
      );
      return;
    }
    const agentContext = {
      drafts: drafts.scope(namespaceId, current.agentId ?? "create"),
      flushDrafts: () => drafts.flush(),
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
      setTabNavigation(handler) {
        if (lifetime.isCurrent(active)) {
          navigateAgentTab = handler;
        }
      },
    };
    if (current.creating) {
      renderCreateAgent(
        {
          ...agentContext,
          setDraftCapture(capture) {
            agentContext.drafts.forget("create");
            if (capture) {
              agentContext.drafts.track("create", capture);
            }
          },
        },
        agentContext.drafts.get("create"),
      );
      markMountedRoute(current);
      return;
    }
    if (current.agentId) {
      await renderAgentDetail(
        { ...agentContext, agentId: current.agentId },
        { agent: retainedAgent },
      );
      if (lifetime.isCurrent(active)) {
        markMountedRoute(current);
      }
      return;
    }
    panel(shell.view, "Loading…", `Reading ${pages[current.feature].toLowerCase()}.`);
    const items =
      retainedItems ??
      (current.feature === "namespaces"
        ? namespaces
        : await request(
            current.feature === "backends"
              ? "/backends"
              : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
          ));
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
    markMountedRoute(current);
  } catch (error) {
    if (!lifetime.isCurrent(active) || error.name === "AbortError") {
      return;
    }
    if (error.status === 401) {
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    if (!accessResolved) {
      // Uncertain shared admission invalidates every preview, not just this route.
      clearDrafts();
      resetReads();
      clearPrivate();
      publicPanel(
        sessionResolved ? "Namespace access unavailable" : "Session unavailable",
        sessionResolved
          ? "Could not check Namespace access. Please retry."
          : "Could not check your session. Please retry.",
        "Retry",
        () => void loadPage(),
      );
      return;
    }
    mountedRouteKey = null;
    if ([400, 403, 404].includes(error.status)) {
      const selection = current.namespace ?? namespaceId;
      // Backend discovery is Installation-scoped, regardless of its Namespace query.
      if (selection === null || current.feature === "backends") {
        clearRetainedViews();
      } else {
        clearRetainedViewsForNamespace(selection);
      }
    }
    shell = renderShell(current.feature);
    if (current.agentId && error.status === 404) {
      panel(
        shell.view,
        "Resource unavailable",
        "This Agent may have been deleted or is no longer available in this Namespace.",
        "Back to Agents",
        () => navigate("agents"),
        error.requestId,
      );
      return;
    }
    const title =
      error.status === 403
        ? "Access denied"
        : error.status === 404
          ? "Resource unavailable"
          : error.status === 400
            ? "Namespace unavailable"
            : error.name === "TypeError" || error.name === "TimeoutError"
              ? "Request interrupted"
              : current.feature === "backends"
                ? "Backend discovery unavailable"
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
  clearDrafts();
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
    void loadPage({ fromNavigation: true });
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
  clearDrafts();
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
