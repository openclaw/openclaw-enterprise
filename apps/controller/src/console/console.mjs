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
let observabilityUrl = null;
// Session owner whose Installation-admin observability read has settled.
let observabilityOwner = null;
let loggingOut = false;
let navigateAgentTab = null;
let discardCreationOnExit = null;
const drafts = createDraftStore();
let draftUserId = null;
// The session this tab signed in to or first observed; see api-client.mjs.
let pinnedSessionKey = null;
let externalSessionBinding = false;
const externalAttemptStorageKeys = {
  github: "occ.console.githubAttempt",
  google: "occ.console.googleAttempt",
};
const externalProviders = {
  github: {
    label: "GitHub",
    origin: "https://github.com",
    pathname: "/login/oauth/authorize",
  },
  google: {
    label: "Google",
    origin: "https://accounts.google.com",
    pathname: "/o/oauth2/v2/auth",
  },
};
const bindingValue = /^[A-Za-z0-9_-]{43}$/;

function pinSessionKey(value) {
  pinnedSessionKey = typeof value === "string" && value.length > 0 ? value : null;
}

// The attemptId is per tab: another tab's provider callback cannot complete this tab's sign-in.
function rememberExternalAttempt(provider, attemptId) {
  try {
    for (const key of Object.values(externalAttemptStorageKeys)) {
      sessionStorage.removeItem(key);
    }
    sessionStorage.setItem(externalAttemptStorageKeys[provider], attemptId);
  } catch {
    // Without tab storage the callback still signs in; this tab adopts the session it sees.
  }
}

// Returns and clears this tab's pending attempt as { provider, attemptId }, or null.
function takeExternalAttempt() {
  let pendingAttempt = null;
  for (const [provider, key] of Object.entries(externalAttemptStorageKeys)) {
    try {
      const attemptId = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (pendingAttempt === null && attemptId !== null && bindingValue.test(attemptId)) {
        pendingAttempt = { provider, attemptId };
      }
    } catch {
      // Unavailable tab storage leaves no attempt to adopt.
    }
  }
  return pendingAttempt;
}
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
  sessionKey: () => pinnedSessionKey,
});
const retainedViews = new Map();
let mountedRouteKey = null;
let mountedAgent = null;
let mountedViewState = null;
let resumePending = null;

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
    if (input.value) {
      if (mountedViewState) {
        mountedViewState.reusable = false;
      }
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (input.dataset.supplied !== undefined) {
        input.dataset.supplied = "false";
      }
    }
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
    snapshot:
      mountedViewState?.reusable && mountedViewState.pending === 0 ? view : view.cloneNode(true),
    state: mountedViewState?.reusable && mountedViewState.pending === 0 ? mountedViewState : null,
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
  const shell = renderShell(current.feature, true);
  if (retained.title) {
    app.querySelector(".content h1").textContent = retained.title;
  }
  if (retained.scope) {
    app.querySelector(".content .scope").textContent = retained.scope;
  }
  shell.view.replaceWith(retained.snapshot);
  shell.view = retained.snapshot;
  shell.retained = retained;
  if (shell.diagnostics && retained.state?.diagnostics) {
    shell.diagnostics.replaceWith(retained.state.diagnostics);
    shell.diagnostics = retained.state.diagnostics;
    shell.diagnostics.inert = true;
  }
  shell.view.setAttribute("aria-busy", "true");
  shell.view.setAttribute("inert", "");
  shell.blockedControls = [
    ...shell.view.querySelectorAll("button, input, select, textarea"),
  ].filter((control) => !control.disabled);
  for (const control of shell.blockedControls) {
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
  const resumeDrafts = drafts.suspend();
  if (mountedViewState) {
    mountedViewState.resumeDrafts = resumeDrafts;
    mountedViewState.active = null;
  }
  navigateAgentTab = null;
  mountedAgent = null;
  clearPasswordInputs();
  shellUI.reset();
  if (retainView) {
    retainMountedView();
  } else {
    mountedRouteKey = null;
  }
  mountedViewState = null;
  return lifetime.reset();
}

function renderShell(feature, namespaceAdmissionPending = false) {
  return shellUI.renderShell(feature, {
    session,
    namespaces,
    namespaceId,
    observabilityUrl,
    namespaceAdmissionPending,
  });
}

function clearPrivate() {
  session = null;
  namespaces = [];
  namespaceId = null;
  observabilityUrl = null;
  observabilityOwner = null;
  clearRetainedViews();
}

function clearDrafts() {
  discardCreationOnExit = null;
  drafts.clear();
  draftUserId = null;
}

function showLogin(message = "", returnPath = null) {
  clearDrafts();
  const loginView = resetReads();
  clearPrivate();
  pinSessionKey(null);
  // A pending exchange runs before any login view; an abandoned attempt must not
  // turn a later password sign-in into a provider failure.
  takeExternalAttempt();
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
  const providerButton = (provider) => {
    const { label, origin, pathname } = externalProviders[provider];
    const control = button(`Continue with ${label}`, async () => {
      if (pending) {
        return;
      }
      pending = true;
      setDisabled(true);
      feedback.textContent = "";
      try {
        const result = await request(`/api/auth/providers/${provider}/start`, { method: "POST" });
        if (!lifetime.isCurrent(loginView)) {
          return;
        }
        const authorization = new URL(result.url);
        if (
          authorization.origin !== origin ||
          authorization.pathname !== pathname ||
          (externalSessionBinding && !bindingValue.test(result.attemptId ?? ""))
        ) {
          throw new Error("Invalid authorization URL");
        }
        if (externalSessionBinding) {
          rememberExternalAttempt(provider, result.attemptId);
        }
        location.assign(authorization.href);
      } catch (error) {
        if (!lifetime.isCurrent(loginView)) {
          return;
        }
        feedback.textContent =
          error.status === 429
            ? "Too many attempts. Please try again later."
            : `${label} sign-in is unavailable. Try again or use your password.`;
        pending = false;
        setDisabled(false);
      }
    });
    return control;
  };
  const github = providerButton("github");
  const google = providerButton("google");
  function setDisabled(disabled) {
    submit.disabled = disabled;
    github.disabled = disabled;
    google.disabled = disabled;
  }
  const providers = element("div", { className: "auth-providers" });
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) {
      return;
    }
    pending = true;
    setDisabled(true);
    feedback.textContent = "";
    takeExternalAttempt();
    const active = lifetime.capture();
    try {
      const signedIn = await request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: username.value, password: password.value },
      });
      if (!lifetime.isCurrent(active)) {
        return;
      }
      pinSessionKey(signedIn?.sessionKey);
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
        setDisabled(false);
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
      providers,
    ),
  );
  void request("/api/auth/providers")
    .then((available) => {
      if (lifetime.isCurrent(loginView)) {
        externalSessionBinding = available?.sessionBinding === true;
        if (available?.github === true) {
          providers.append(github);
        }
        if (available?.google === true) {
          providers.append(google);
        }
      }
    })
    .catch(() => {
      // Password sign-in remains available when provider discovery fails.
    });
}

async function loadPage({ fromNavigation = false, reuseView = fromNavigation } = {}) {
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
  const abandonedCreation =
    fromNavigation &&
    discardCreationOnExit &&
    (!current.creating || current.namespace !== discardCreationOnExit.namespaceId);
  const previousMountedRouteKey = mountedRouteKey;
  // Save/reload actions navigate to the current URL to discard the editor.
  if (fromNavigation && previousMountedRouteKey === routeKey(current)) {
    reuseView = false;
  }
  namespaceId = current.namespace;
  const active = resetReads({ retainView: knownPrivateState });
  if (abandonedCreation) {
    const creationDrafts = drafts.scope(discardCreationOnExit.namespaceId, "create");
    creationDrafts.forget("create");
    creationDrafts.forget("channels");
    retainedViews.delete(previousMountedRouteKey);
    discardCreationOnExit = null;
  }
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
    shell = renderShell(current.feature, true);
    panel(shell.view, "Loading…", "Checking your session and Namespace access.");
  }
  let sessionResolved = false;
  let accessResolved = false;
  const authError = current.url.searchParams.get("authError");
  const providerError = Object.hasOwn(externalProviders, authError ?? "")
    ? externalProviders[authError]
    : null;
  const externalAttempt = takeExternalAttempt();
  if (externalAttempt !== null && providerError === null) {
    // Adopt only the session this tab's own provider attempt created.
    try {
      const confirmed = await request(`/api/auth/providers/${externalAttempt.provider}/result`, {
        method: "POST",
        body: { attemptId: externalAttempt.attemptId },
      });
      if (!lifetime.isCurrent(active)) {
        return;
      }
      pinSessionKey(confirmed?.sessionKey);
    } catch {
      if (lifetime.isCurrent(active)) {
        showLogin(
          `Could not sign in with ${externalProviders[externalAttempt.provider].label}. Try again or use your password.`,
          "/console/agents",
        );
      }
      return;
    }
  }
  try {
    const previousOwner = sessionOwnerKey(session);
    const resolvedSession = await request("/api/auth/session");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (resolvedSession !== null && pinnedSessionKey === null) {
      pinSessionKey(resolvedSession.sessionKey);
    } else if (resolvedSession !== null && resolvedSession.sessionKey !== pinnedSessionKey) {
      // The controller rejects a mismatched key; never act on another session regardless.
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    session = resolvedSession;
    if (session === null) {
      const destination =
        providerError !== null
          ? "/console/agents"
          : current.feature === "login"
            ? current.url.searchParams.get("return")
            : pageUrl(current.target, current.namespace);
      showLogin(
        providerError !== null
          ? `Could not sign in with ${providerError.label}. Try again or use your password.`
          : current.feature !== "login" &&
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
      observabilityUrl = null;
      observabilityOwner = null;
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
    // Read the admin-only destination once per session owner. Non-administrators
    // get 403, which the API audits as a denial, so do not repeat it per navigation.
    const [readable, observability] = await Promise.all([
      request("/namespaces"),
      owner && observabilityOwner === owner
        ? null
        : request("/observability").then(
            (data) => ({ url: typeof data?.url === "string" ? data.url : null, settled: true }),
            (error) => {
              if (error.status === 401) {
                throw error;
              }
              return { url: null, settled: error.status === 403 };
            },
          ),
    ]);
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (!Array.isArray(readable)) {
      throw new Error("Invalid collection response");
    }
    clearRetainedViewsOutsideNamespaces(readable);
    namespaces = sorted(readable);
    accessResolved = true;
    if (observability) {
      observabilityUrl = observability.url;
      observabilityOwner = observability.settled ? owner : null;
    }
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
    const retainedState = shell?.retained?.state;
    if (retained && reuseView && retainedState && !agentsNamespaceUnavailable) {
      const fresh = new Map([["/namespaces", namespaces]]);
      if (retainedAgent) {
        fresh.set(
          `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
          retainedAgent,
        );
      } else if (retainedItems && current.feature !== "namespaces") {
        fresh.set(
          current.feature === "backends"
            ? "/backends"
            : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
          retainedItems,
        );
      }
      const validations = await Promise.allSettled(
        [...retainedState.reads.keys()].map(async (path) => {
          if (!fresh.has(path)) {
            fresh.set(path, await request(path));
          }
        }),
      );
      if (!lifetime.isCurrent(active)) {
        return;
      }
      const unchanged =
        validations.every((result) => result.status === "fulfilled") &&
        JSON.stringify(retainedState.user) === JSON.stringify(session.user) &&
        [...retainedState.reads].every(
          ([path, value]) => JSON.stringify(fresh.get(path)) === value,
        );
      if (unchanged) {
        mountedViewState = retainedState;
        retainedState.active = active;
        retainedState.resumeDrafts?.();
        navigateAgentTab = retainedState.tabNavigation;
        mountedAgent = retainedState.agent;
        for (const control of shell.blockedControls) {
          control.disabled = false;
        }
        shell.view.removeAttribute("inert");
        if (shell.diagnostics) {
          shell.diagnostics.inert = false;
        }
        shellUI.updateNamespaces(namespaces);
        markMountedRoute(current);
        return;
      }
    }
    shell = renderShell(current.feature, false);
    const viewState = {
      active,
      pending: 0,
      reusable: true,
      mutations: 0,
      reads: new Map(),
      user: session.user,
    };
    mountedViewState = viewState;
    const viewRequest = async (path, options = {}) => {
      viewState.pending += 1;
      if ((options.method ?? "GET") !== "GET" && !options.readOnly) {
        viewState.reusable = false;
        viewState.mutations += 1;
        retainedViews.clear();
      }
      try {
        const result = await request(path, options);
        if ((options.method ?? "GET") === "GET") {
          viewState.reads.set(path, JSON.stringify(result));
        }
        return result;
      } catch (error) {
        viewState.reusable = false;
        throw error;
      } finally {
        viewState.pending -= 1;
      }
    };
    if (shell.diagnostics) {
      viewState.diagnostics = shell.diagnostics;
      void renderRuntimeImages(shell.diagnostics, {
        request: viewRequest,
        namespaceId,
        isCurrent: () => lifetime.isCurrent(viewState.active),
      });
    }
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
      suspendDrafts: () => drafts.suspend(),
      view: shell.view,
      namespaceId,
      request: viewRequest,
      mutationVersion: () => viewState.mutations,
      navigate,
      pageUrl,
      isCurrent: () => lifetime.isCurrent(viewState.active),
      onExpired: () => {
        if (lifetime.isCurrent(viewState.active)) {
          showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
        }
      },
      setTitle: (title) => {
        app.querySelector("h1").textContent = title;
      },
      url: current.url,
      setTabNavigation(handler) {
        if (lifetime.isCurrent(viewState.active)) {
          viewState.tabNavigation = handler;
          navigateAgentTab = handler;
        }
      },
    };
    if (current.creating) {
      renderCreateAgent(
        {
          ...agentContext,
          setDiscardOnExit(discard) {
            discardCreationOnExit = discard ? { namespaceId } : null;
          },
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
      if (retainedAgent) {
        viewState.reads.set(
          `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
          JSON.stringify(retainedAgent),
        );
      }
      const agent = await renderAgentDetail(
        { ...agentContext, agentId: current.agentId },
        { agent: retainedAgent },
      );
      if (lifetime.isCurrent(active)) {
        mountedAgent = agent;
        viewState.agent = agent;
        viewState.reusable &&= agent?.status !== "deleting";
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
    viewState.reads.set(
      current.feature === "namespaces"
        ? "/namespaces"
        : current.feature === "backends"
          ? "/backends"
          : `/namespaces/${encodeURIComponent(namespaceId)}/agents`,
      JSON.stringify(items),
    );
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

async function revalidateMountedAgent(current) {
  const key = routeKey(current);
  const view = app.querySelector('.content [aria-live="polite"]');
  const agent = mountedAgent;
  const owner = sessionOwnerKey(session);
  const selectedNamespace = namespaceId;
  if (!view || !agent || !owner || !key) {
    await loadPage();
    return;
  }
  const active = lifetime.capture();
  const isCurrent = () =>
    lifetime.isCurrent(active) &&
    mountedRouteKey === key &&
    routeKey(route()) === key &&
    view.isConnected;
  const path = `/namespaces/${encodeURIComponent(selectedNamespace)}/agents/${encodeURIComponent(agent.id)}`;
  const focused = view.contains(document.activeElement) ? document.activeElement : null;
  const selection =
    typeof focused?.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  let checking = "session";
  // Block stale controls during admission without losing an editor's caret on return.
  view.inert = true;
  try {
    const resolvedSession = await request("/api/auth/session");
    if (!isCurrent()) {
      return;
    }
    if (resolvedSession === null) {
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    if (sessionOwnerKey(resolvedSession) !== owner) {
      clearDrafts();
      resetReads();
      clearPrivate();
      app.replaceChildren();
      await loadPage();
      return;
    }
    checking = "namespaces";
    const readable = await request("/namespaces");
    if (!isCurrent()) {
      return;
    }
    if (!Array.isArray(readable)) {
      throw new Error("Invalid collection response");
    }
    clearRetainedViewsOutsideNamespaces(readable);
    session = resolvedSession;
    namespaces = sorted(readable);
    if (!namespaces.some((item) => item.id === selectedNamespace)) {
      clearRetainedViewsForNamespace(selectedNamespace);
      resetReads();
      const shell = renderShell(current.feature);
      panel(
        shell.view,
        "Namespace unavailable",
        "This Namespace is missing or you no longer have access. Choose another Namespace.",
        "Switch Namespace",
        () => switchNamespace(),
      );
      return;
    }
    checking = "detail";
    await request(path);
    if (!isCurrent()) {
      return;
    }
    shellUI.updateNamespaces(namespaces);
    if (current.url.searchParams.get("tab") !== "workspace") {
      const selected =
        current.url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
      await Promise.all([
        request(`${path}/revisions`),
        request(
          selected === "draft"
            ? `/namespaces/${encodeURIComponent(selectedNamespace)}/configurations/${encodeURIComponent(agent.configurationId)}`
            : `${path}/revisions/${encodeURIComponent(selected)}`,
        ),
      ]);
    }
  } catch (error) {
    if (!isCurrent() || error.name === "AbortError") {
      return;
    }
    if (error.status === 401) {
      showLogin("Your session has expired.", pageUrl(current.target, current.namespace));
      return;
    }
    resetReads();
    if (checking !== "detail") {
      clearDrafts();
      clearPrivate();
      publicPanel(
        checking === "session" ? "Session unavailable" : "Namespace access unavailable",
        checking === "session"
          ? "Could not check your session. Please retry."
          : "Could not check Namespace access. Please retry.",
        "Retry",
        () => void loadPage(),
      );
      return;
    }
    if ([400, 403, 404].includes(error.status)) {
      clearRetainedViewsForNamespace(selectedNamespace);
    }
    const shell = renderShell(current.feature);
    panel(
      shell.view,
      error.status === 403
        ? "Access denied"
        : error.status === 404
          ? "Resource unavailable"
          : "Request unavailable",
      error.status === 403
        ? "You do not have permission to read this Agent or its revision."
        : "The read could not be completed. Retry to check current access and saved state.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    if (view.isConnected) {
      view.inert = false;
      if (
        isCurrent() &&
        focused?.isConnected &&
        document.hasFocus() &&
        document.activeElement === document.body
      ) {
        focused.focus({ preventScroll: true });
        if (selection) {
          focused.setSelectionRange(...selection);
        }
      }
    }
  }
}

function resumePage() {
  if (document.hidden || !session || loggingOut || app.querySelector("dialog[open]")) {
    return;
  }
  if (resumePending) {
    return;
  }
  const current = route();
  // Agent detail rechecks in place and keeps its forms, so their input must not skip the
  // check. Other pages reload the view, which would discard an unfinished form.
  const inPlace = current.agentId && mountedRouteKey === routeKey(current);
  if (!inPlace && app.querySelector("form")) {
    return;
  }
  const pending = inPlace ? revalidateMountedAgent(current) : loadPage({ reuseView: true });
  resumePending = pending;
  void pending.finally(() => {
    if (resumePending === pending) {
      resumePending = null;
    }
  });
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
    // Browser history can change Agent tabs while the mounted view is inert.
    // Recheck admission for the new route before exposing its cached panel.
    void loadPage({ fromNavigation: !resumePending });
  }
});
window.addEventListener("focus", resumePage);
document.addEventListener("visibilitychange", () => {
  resumePage();
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
