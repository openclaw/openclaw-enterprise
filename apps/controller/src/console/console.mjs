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
// The Installation-access probe still being answered, for the session owner that sent it.
let installationAccessProbe = null;
// Whether that owner administers the Installation: true, false, or null when unknown.
let installationAdmin = null;
const installationAccessStorageKey = "occ.console.installationAccess";
const deniedReadsStorageKey = "occ.console.deniedReads";
const deniedReadsLimit = 200;
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
  oidc: "occ.console.oidcAttempt",
};
// The last discovered OIDC label, kept per tab so messages after the IdP round trip, which
// reloads the Console before discovery answers, name the provider the person chose.
const oidcLabelStorageKey = "occ.console.oidcLabel";
const loginIntentStorageKey = "occ.console.loginIntent";
const loginIntentLifetimeMs = 10 * 60 * 1000;
let pendingIntent = null;
// Google gradient G: https://commons.wikimedia.org/wiki/File_talk:Google_Favicon_2025.svg
// GitHub mark: https://github.com/primer/octicons/blob/main/icons/mark-github-24.svg
// A retained view revalidates each read it made. A paged read keeps its cursor, so it compares
// data and meta, without the request ID that differs on every call.
function readSignature(result, includeMeta = false) {
  return JSON.stringify(
    includeMeta ? { data: result.data, meta: { ...result.meta, requestId: undefined } } : result,
  );
}

function providerIcon(provider) {
  if (provider !== "github" && provider !== "google") {
    return null;
  }
  const namespace = "http://www.w3.org/2000/svg";
  const node = (tag, attributes) => {
    const item = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) {
      item.setAttribute(name, value);
    }
    return item;
  };
  const svg = node("svg", {
    class: "auth-provider-icon",
    "aria-hidden": "true",
    focusable: "false",
    viewBox: provider === "github" ? "0 0 24 24" : "0 0 23.5 24",
  });
  if (provider === "github") {
    svg.append(
      node("path", {
        d: "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943",
      }),
    );
    return svg;
  }
  const clip = node("clipPath", { id: "auth-google-logo-clip" });
  clip.append(
    node("path", {
      d: "M12 10v4.5h6.47c-.5 2.7-3 4.74-6.47 4.74-3.9 0-7.1-3.3-7.1-7.25S8.1 4.75 12 4.75c1.8 0 3.35.6 4.6 1.8l3.4-3.4C18 1.2 15.24 0 12 0 5.4 0 0 5.4 0 12s5.4 12 12 12c7 0 11.5-4.9 11.5-11.7 0-.8-.1-1.54-.2-2.3z",
    }),
  );
  const filter = node("filter", { id: "auth-google-logo-blur" });
  filter.append(node("feGaussianBlur", { stdDeviation: "1" }));
  const group = node("g", { "clip-path": "url(#auth-google-logo-clip)" });
  const colors = node("foreignObject", {
    filter: "url(#auth-google-logo-blur)",
    width: "28",
    height: "28",
    transform: "translate(-2 -2)",
  });
  colors.append(element("div", { className: "auth-google-colors" }));
  group.append(colors, node("path", { fill: "#3186FF", d: "M11 8h16v8H11z" }));
  svg.append(clip, filter, group);
  return svg;
}
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
  // The operator configures the IdP: discovery supplies its label and authorization
  // endpoint, and the start URL must use exactly that HTTPS endpoint.
  oidc: {
    label: rememberedOidcLabel() ?? "single sign-on",
    origin: null,
    pathname: null,
  },
};

// 1 to 40 code points, as the server's discovery schema allows.
function validOidcLabel(label) {
  const length = [...label].length;
  return length > 0 && length <= 40;
}
function rememberedOidcLabel() {
  try {
    const label = sessionStorage.getItem(oidcLabelStorageKey);
    return typeof label === "string" && validOidcLabel(label) ? label : null;
  } catch {
    return null;
  }
}

// Adopts discovery's OIDC settings; false when they are missing or malformed.
function configureOidc(signIn) {
  try {
    const endpoint = new URL(signIn?.authorizationUrl);
    const label = signIn?.label;
    if (endpoint.protocol !== "https:" || typeof label !== "string" || !validOidcLabel(label)) {
      return false;
    }
    externalProviders.oidc = { label, origin: endpoint.origin, pathname: endpoint.pathname };
    try {
      sessionStorage.setItem(oidcLabelStorageKey, label);
    } catch {
      // Without tab storage, post-redirect messages use the default label.
    }
    return true;
  } catch {
    return false;
  }
}
const bindingValue = /^[A-Za-z0-9_-]{43}$/;

// A failed provider sign-in. Where password sign-in is recovery-only, ordinary users
// have no password to fall back on, so the advice depends on provider discovery.
function providerFailure(label) {
  return (password) =>
    password
      ? `Could not sign in with ${label}. Try again or use your password.`
      : `Could not sign in with ${label}. Try again, or ask an administrator to attach your ${label} identity to your account.`;
}

// GitHub sign-in refused by the organization and team allowlist (RFC-0061). The controller
// sends only these reasons; anything else keeps the generic provider message.
const githubMembershipFailures = {
  membership: (password) =>
    `Your GitHub account is not a member of an organization or team allowed to sign in here. If you were invited, accept the invitation on GitHub and try again; otherwise ask an administrator for access${password ? " or use your password" : ""}.`,
  "membership-unavailable": (password) =>
    password
      ? "Could not check your GitHub organization membership. Try again later or use your password."
      : "Could not check your GitHub organization membership. Try again later; if this keeps happening, ask an administrator.",
};

// The provider could not answer, or refused this Installation's client: an outage or a
// configuration fault, not a refusal of the person. Where password sign-in is recovery-only,
// only the recovery administrator has a password to fall back on.
function providerUnavailableFailure(label) {
  return (password) =>
    password
      ? `${label} sign-in is unavailable right now. Try again later or use your password.`
      : `${label} sign-in is unavailable right now. Try again later. If you are an administrator, use Recovery sign-in.`;
}

// The callback failed inside OCE (its database or audit store), so no sign-in can finish.
function signInUnavailableFailure(label) {
  return `Could not finish signing in with ${label}. Sign-in is unavailable right now; try again later.`;
}

// The provider authenticated an identity attached to a disabled account. Retrying, a
// password or an attach cannot help, so only an administrator is named.
function accountDisabledFailure(label) {
  return `Your account is disabled, so you cannot sign in with ${label}. Ask an administrator to enable it.`;
}

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

// The observability read is the console's Installation-administration probe. The API audits
// a 403 as an authorization denial, so this tab keeps the settled answer across reloads for
// the same session owner instead of probing again on every page load. The owner key is a
// noncredential session binding, so another sign-in always probes afresh.
function rememberInstallationAccess(owner, admin, url) {
  try {
    sessionStorage.setItem(installationAccessStorageKey, JSON.stringify({ owner, admin, url }));
  } catch {
    // Without tab storage the next page load probes again.
  }
}

function recalledInstallationAccess(owner) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(installationAccessStorageKey) ?? "null");
    if (
      stored?.owner === owner &&
      typeof stored.admin === "boolean" &&
      (stored.url === null || (stored.admin && typeof stored.url === "string"))
    ) {
      return { admin: stored.admin, url: stored.url };
    }
  } catch {
    // Unreadable tab storage falls back to a fresh probe.
  }
  return null;
}

// One probe per session owner, shared by every page load until it settles. A navigation
// joins the probe in flight instead of aborting it and asking again: the API has usually
// already answered, and audited a denial, by then. A settled answer is kept even when the
// view that asked is gone, as long as the same session owner is signed in.
function probeInstallationAccess(owner) {
  if (owner && installationAccessProbe?.owner === owner) {
    return installationAccessProbe.answer;
  }
  const probe = { owner };
  probe.answer = request("/observability", { outlivesView: true })
    .then(
      (data) => ({
        url: typeof data?.url === "string" ? data.url : null,
        admin: true,
        settled: true,
      }),
      (error) => {
        if (error.status === 401) {
          throw error;
        }
        const denied = error.status === 403;
        return { url: null, admin: denied ? false : null, settled: denied };
      },
    )
    .then((answer) => {
      if (owner && answer.settled && sessionOwnerKey(session) === owner) {
        observabilityUrl = answer.url;
        installationAdmin = answer.admin;
        observabilityOwner = owner;
        rememberInstallationAccess(owner, answer.admin, answer.url);
      }
      return answer;
    })
    .finally(() => {
      if (installationAccessProbe === probe) {
        installationAccessProbe = null;
      }
    });
  installationAccessProbe = owner ? probe : null;
  return probe.answer;
}

function forgetInstallationAccess() {
  try {
    sessionStorage.removeItem(installationAccessStorageKey);
  } catch {
    // Nothing to clear without tab storage.
  }
}

// Agent detail reads that the viewer's grants may not allow (saved settings, native admin
// status) return 403, which the API audits as an authorization denial. This tab remembers
// each denied API path for the same session owner so reloads and revisits do not add a
// denial per view. The first denial is always requested and audited; views offer Retry,
// which forgets the path and asks again. Paths hold resource IDs only, never credentials.
function storedDeniedReads(owner) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(deniedReadsStorageKey) ?? "null");
    if (
      stored?.owner === owner &&
      Array.isArray(stored.paths) &&
      stored.paths.every((path) => typeof path === "string")
    ) {
      return stored.paths;
    }
  } catch {
    // Unreadable tab storage asks again.
  }
  return [];
}

function storeDeniedReads(owner, paths) {
  try {
    sessionStorage.setItem(
      deniedReadsStorageKey,
      JSON.stringify({ owner, paths: paths.slice(-deniedReadsLimit) }),
    );
  } catch {
    // Without tab storage the next view asks again.
  }
}

function deniedReadsFor(owner) {
  return {
    has: (path) => Boolean(owner) && storedDeniedReads(owner).includes(path),
    remember(path) {
      if (owner) {
        storeDeniedReads(owner, [
          ...storedDeniedReads(owner).filter((item) => item !== path),
          path,
        ]);
      }
    },
    forget(path) {
      if (owner) {
        const paths = storedDeniedReads(owner);
        if (paths.includes(path)) {
          storeDeniedReads(
            owner,
            paths.filter((item) => item !== path),
          );
        }
      }
    },
  };
}

function forgetDeniedReads() {
  try {
    sessionStorage.removeItem(deniedReadsStorageKey);
  } catch {
    // Nothing to clear without tab storage.
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
const { route, pageUrl, captureIntent, validIntent, intentUrl, navigate } = navigation;
function forgetLoginIntent() {
  try {
    sessionStorage.removeItem(loginIntentStorageKey);
  } catch {
    // Tab storage is optional; no destination survives the external round trip.
  }
}

function rememberLoginIntent(intent, attemptId) {
  forgetLoginIntent();
  if (!validIntent(intent)) {
    return;
  }
  try {
    sessionStorage.setItem(
      loginIntentStorageKey,
      JSON.stringify({ intent, attemptId, time: Date.now() }),
    );
  } catch {
    // Sign-in still works without tab storage.
  }
}

function takeLoginIntent(attemptId) {
  let stored;
  try {
    stored = JSON.parse(sessionStorage.getItem(loginIntentStorageKey) ?? "null");
  } catch {
    // Invalid or unavailable storage cannot supply a destination.
  }
  forgetLoginIntent();
  const age = Date.now() - stored?.time;
  return attemptId &&
    stored?.attemptId === attemptId &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= loginIntentLifetimeMs &&
    validIntent(stored.intent)
    ? stored.intent
    : null;
}

// The recovery fragment contains an opaque key, not an address or authority. Remove it
// before any sign-in redirect and resolve it only after this tab has a confirmed session.
function takeNativeFragment(current) {
  if (
    (current.url.pathname !== "/console" && current.url.pathname !== "/console/") ||
    !current.url.hash
  ) {
    return null;
  }
  const match = /^#native-agent=([0-9a-f]{32})$/.exec(current.url.hash);
  history.replaceState(history.state, "", current.url.pathname + current.url.search);
  return match ? { kind: "native", key: match[1] } : null;
}

const shellUI = createShell({ app, pages, route, pageUrl, navigate, loadPage, logout });
const { publicPanel, renderRows, switchNamespace } = shellUI;
const request = createApiClient({
  lifetime,
  hasSession: () => session !== null,
  onExpired: () => showLogin("Your session has expired."),
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

function takeRetainedView(current) {
  const owner = sessionOwnerKey(session);
  const key = routeKey(current);
  const retained = key && retainedViews.get(key);
  if (!owner || !retained || retained.owner !== owner) {
    return null;
  }
  retainedViews.delete(key);
  return retained;
}

// On a return, keeps the page already on screen, inert, in a fresh pending shell while the
// retained route's admission and reads run. A retained view is then never painted before it revalidates
// (finding 1412), and returns do not flash a loading state (finding 1415). Returns null when
// no page is shown.
function holdShownView(current) {
  const view = app.querySelector('.content [aria-live="polite"]');
  if (!view) {
    return null;
  }
  const title = app.querySelector(".content h1")?.textContent;
  const scope = app.querySelector(".content .scope")?.textContent;
  const diagnostics = app.querySelector(".runtime-debug");
  const scrollY = window.scrollY;
  const shell = renderShell(current.feature, true);
  if (title) {
    app.querySelector(".content h1").textContent = title;
  }
  if (scope) {
    app.querySelector(".content .scope").textContent = scope;
  }
  view.inert = true;
  view.setAttribute("aria-busy", "true");
  shell.view.replaceWith(view);
  shell.view = view;
  if (shell.diagnostics && diagnostics) {
    diagnostics.inert = true;
    shell.diagnostics.replaceWith(diagnostics);
    shell.diagnostics = diagnostics;
  }
  window.scrollTo({ top: scrollY, left: 0 });
  return shell;
}

// Mounts a retained view that revalidated unchanged, active at once.
function mountRetainedView(current, retained) {
  const shell = renderShell(current.feature, false);
  if (retained.title) {
    app.querySelector(".content h1").textContent = retained.title;
  }
  if (retained.scope) {
    app.querySelector(".content .scope").textContent = retained.scope;
  }
  retained.snapshot.inert = false;
  shell.view.replaceWith(retained.snapshot);
  shell.view = retained.snapshot;
  if (shell.diagnostics && retained.state?.diagnostics) {
    retained.state.diagnostics.inert = false;
    shell.diagnostics.replaceWith(retained.state.diagnostics);
    shell.diagnostics = retained.state.diagnostics;
  }
  mountedRouteKey = routeKey(current);
  window.scrollTo({ top: retained.scrollY, left: 0 });
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

function renderPendingNamespaceShell(feature) {
  const shell = renderShell(feature, true);
  panel(shell.view, "Loading…", "Checking Namespace access.");
  return shell;
}

function clearPrivate() {
  session = null;
  namespaces = [];
  namespaceId = null;
  observabilityUrl = null;
  observabilityOwner = null;
  installationAccessProbe = null;
  installationAdmin = null;
  clearRetainedViews();
}

function clearDrafts() {
  discardCreationOnExit = null;
  drafts.clear();
  draftUserId = null;
}

function showLogin(message = "", destination = null) {
  // A message may depend on whether ordinary accounts can use a password.
  const describe = typeof message === "function" ? message : () => message;
  clearDrafts();
  const loginView = resetReads();
  clearPrivate();
  pinSessionKey(null);
  // A pending exchange runs before any login view; an abandoned attempt must not
  // turn a later password sign-in into a provider failure.
  takeExternalAttempt();
  pendingIntent = null;
  forgetLoginIntent();
  history.replaceState(null, "", "/console/login");
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
  const feedback = element("p", { className: "error", role: "alert" }, describe(true));
  const usernameHint = element(
    "span",
    { id: "username-hint", className: "hint" },
    "Use your account email",
  );
  // Recovery-only password sign-in hides the form until the recovery path is chosen.
  let recoveryOnly = false;
  const submit = element("button", { type: "submit", className: "primary" }, "Login");
  const form = element(
    "form",
    {},
    element("label", { for: "username" }, "Username"),
    username,
    usernameHint,
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
          origin === null ||
          authorization.origin !== origin ||
          authorization.pathname !== pathname ||
          (externalSessionBinding && !bindingValue.test(result.attemptId ?? ""))
        ) {
          throw new Error("Invalid authorization URL");
        }
        if (externalSessionBinding) {
          rememberExternalAttempt(provider, result.attemptId);
          rememberLoginIntent(destination, result.attemptId);
        }
        location.assign(authorization.href);
      } catch (error) {
        if (!lifetime.isCurrent(loginView)) {
          return;
        }
        feedback.textContent =
          error.status === 429
            ? "Too many attempts. Try again later."
            : recoveryOnly
              ? `${label} sign-in is unavailable. Try again later.`
              : `${label} sign-in is unavailable. Try again or use your password.`;
        pending = false;
        setDisabled(false);
      }
    });
    const icon = providerIcon(provider);
    if (icon !== null) {
      control.prepend(icon);
    }
    return control;
  };
  const github = providerButton("github");
  const google = providerButton("google");
  // Created once discovery has supplied its label and endpoint.
  let oidc = null;
  const recovery = button(
    "Recovery sign-in",
    () => {
      recovery.hidden = true;
      feedback.textContent = "";
      form.insertBefore(feedback, submit);
      form.hidden = false;
      username.focus();
    },
    { className: "auth-recovery", hidden: true },
  );
  function setDisabled(disabled) {
    submit.disabled = disabled;
    github.disabled = disabled;
    google.disabled = disabled;
    if (oidc !== null) {
      oidc.disabled = disabled;
    }
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
      pendingIntent = destination;
      history.replaceState(null, "", "/console/agents");
      await loadPage();
    } catch (error) {
      if (!lifetime.isCurrent(active)) {
        return;
      }
      feedback.textContent =
        error.status === 429
          ? "Too many attempts. Try again later."
          : error.status === 400 || error.status === 401 || error.status === 403
            ? recoveryOnly
              ? "Could not sign in. Only the recovery account can use a password; other accounts continue with their external sign-in."
              : "Could not sign in. Check your username and password."
            : "Sign-in is unavailable. Try again.";
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
      recovery,
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
        if (available?.oidc === true && configureOidc(available.oidcSignIn)) {
          oidc = providerButton("oidc");
          oidc.disabled = pending;
          providers.append(oidc);
        }
        // Only an explicit false hides the form: failed or older discovery keeps it.
        if (
          available?.password === false &&
          (available.github || available.google || available.oidc)
        ) {
          recoveryOnly = true;
          if (feedback.textContent === describe(true)) {
            feedback.textContent = describe(false);
          }
          usernameHint.textContent = "Use the recovery account's email";
          // Never pull the form away from someone already using it.
          if (!pending && username.value === "" && password.value === "") {
            form.hidden = true;
            providers.after(feedback);
            recovery.hidden = false;
          }
        }
      }
    })
    .catch(() => {
      // Password sign-in remains available when provider discovery fails.
    });
}

function showCheckingSession() {
  // Destination recovery can continue in another loadPage without restarting this status.
  if (app.firstElementChild?.classList.contains("startup")) {
    return;
  }
  const status = element("p", { className: "startup", role: "status" });
  app.replaceChildren(status);
  // Delay the announcement, never the session check or the view that replaces it.
  setTimeout(() => {
    if (status.isConnected) {
      status.textContent = "Checking session…";
    }
  }, 300);
}

async function loadPage({ fromNavigation = false, reuseView = fromNavigation } = {}) {
  if (loggingOut) {
    return;
  }
  const current = route();
  const nativeIntent = takeNativeFragment(current);
  if (fromNavigation && nativeIntent === null) {
    pendingIntent = null;
  }
  if (nativeIntent !== null) {
    pendingIntent = nativeIntent;
  }
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
  const retainedView = knownPrivateState ? takeRetainedView(current) : null;
  let retained = retainedView !== null;
  // A return keeps the shown page until the retained view revalidates; other loads show loading.
  let shell = retained ? holdShownView(current) : null;
  let held = shell !== null;
  if (!Object.hasOwn(pages, current.feature) && current.feature !== "login") {
    publicPanel("Page not found", "This console page is unavailable.", "Go to Agents", () =>
      navigate("agents", current.namespace),
    );
    return;
  }
  if (!held) {
    if (knownPrivateState) {
      shell = renderPendingNamespaceShell(current.feature);
    } else {
      showCheckingSession();
    }
  }
  let sessionResolved = false;
  let accessResolved = false;
  const authError = current.url.searchParams.get("authError");
  const providerError = Object.hasOwn(externalProviders, authError ?? "")
    ? externalProviders[authError]
    : null;
  const authReason = current.url.searchParams.get("authReason");
  const reasonFailure =
    providerError === null
      ? null
      : authReason === "account-disabled"
        ? accountDisabledFailure(providerError.label)
        : authReason === "provider-unavailable"
          ? providerUnavailableFailure(providerError.label)
          : authReason === "unavailable"
            ? signInUnavailableFailure(providerError.label)
            : authError === "github" && Object.hasOwn(githubMembershipFailures, authReason ?? "")
              ? githubMembershipFailures[authReason]
              : null;
  const externalAttempt = takeExternalAttempt();
  const externalIntent = takeLoginIntent(externalAttempt?.attemptId);
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
      if (typeof confirmed?.sessionKey !== "string" || confirmed.sessionKey.length === 0) {
        throw new Error("Missing session binding");
      }
      pinSessionKey(confirmed.sessionKey);
      pendingIntent = externalIntent;
    } catch {
      if (lifetime.isCurrent(active)) {
        showLogin(providerFailure(externalProviders[externalAttempt.provider].label));
      }
      return;
    }
  }
  try {
    const hadSession = session !== null || pinnedSessionKey !== null;
    const previousOwner = sessionOwnerKey(session);
    const resolvedSession = await request("/api/auth/session");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (resolvedSession !== null && pinnedSessionKey === null) {
      pinSessionKey(resolvedSession.sessionKey);
    } else if (resolvedSession !== null && resolvedSession.sessionKey !== pinnedSessionKey) {
      // The controller rejects a mismatched key; never act on another session regardless.
      showLogin("Your session has expired.");
      return;
    }
    session = resolvedSession;
    if (session === null) {
      const destination =
        providerError !== null || current.feature === "login" || hadSession
          ? null
          : (pendingIntent ?? captureIntent(pageUrl(current.target, current.namespace)));
      showLogin(
        providerError !== null
          ? (reasonFailure ?? providerFailure(providerError.label))
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
      installationAdmin = null;
      draftUserId = owner;
      retained = false;
      if (held) {
        // Another account's page must not stay on screen.
        held = false;
        shell = null;
        showCheckingSession();
      }
    }
    const destination = pendingIntent;
    if (destination?.kind === "native" && validIntent(destination)) {
      try {
        const resolved = await request(`/native-admin/return/${destination.key}`);
        if (!lifetime.isCurrent(active)) {
          return;
        }
        const target = {
          kind: "console",
          feature: `agents/${resolved?.agentId}`,
          namespaceId: resolved?.namespaceId,
          revision: null,
          tab: null,
        };
        pendingIntent = null;
        history.replaceState(null, "", intentUrl(target) ?? "/console/agents");
      } catch {
        if (!lifetime.isCurrent(active)) {
          return;
        }
        pendingIntent = null;
        history.replaceState(null, "", "/console/agents");
      }
      void loadPage();
      return;
    }
    if (destination || current.feature === "login") {
      pendingIntent = null;
      history.replaceState(null, "", intentUrl(destination) ?? "/console/agents");
      void loadPage();
      return;
    }
    shell ??= renderPendingNamespaceShell(current.feature);
    // Read the admin-only destination once per session owner. Non-administrators
    // get 403, which the API audits as a denial, so do not repeat it per navigation
    // or, within this tab, per page load.
    const recalled =
      owner && observabilityOwner !== owner ? recalledInstallationAccess(owner) : null;
    const [readable, observability] = await Promise.all([
      request("/namespaces"),
      owner && observabilityOwner === owner
        ? null
        : recalled
          ? { ...recalled, settled: true }
          : probeInstallationAccess(owner),
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
      installationAdmin = observability.admin;
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
    if (retained && current.namespace !== null) {
      // Namespace admission is done, so the header selector is usable while the destination's
      // reads run, as on first loads. A switch resets the lifetime, discarding these reads.
      // Without a URL selection the full render below picks the default. A held page keeps
      // the scope beside its rows until the destination replaces them.
      shellUI.updateNamespaces(namespaces, { preservePageScope: held });
    }
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
    const retainedState = retainedView?.state;
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
            fresh.set(
              path,
              await request(path, { includeMeta: retainedState.metaReads.has(path) }),
            );
          }
        }),
      );
      if (!lifetime.isCurrent(active)) {
        return;
      }
      // A shell restored without a URL selection has none; once a Namespace is readable,
      // the full render below picks the default instead.
      const unchanged =
        namespaceId === current.namespace &&
        validations.every((result) => result.status === "fulfilled") &&
        JSON.stringify(retainedState.user) === JSON.stringify(session.user) &&
        [...retainedState.reads].every(
          ([path, value]) =>
            readSignature(fresh.get(path), retainedState.metaReads.has(path)) === value,
        );
      if (unchanged) {
        shell = mountRetainedView(current, retainedView);
        mountedViewState = retainedState;
        retainedState.active = active;
        retainedState.resumeDrafts?.();
        // Timers that fired while the view was detached stopped; let them re-arm.
        for (const resume of retainedState.resumeHandlers) {
          resume();
        }
        navigateAgentTab = retainedState.tabNavigation;
        mountedAgent = retainedState.agent;
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
      metaReads: new Set(),
      resumeHandlers: new Set(),
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
        // Live reads (runtime status, log pages) differ on every call; replaying them to
        // revalidate a cached view would only spend the reader's rate limit.
        if ((options.method ?? "GET") === "GET" && options.revalidate !== false) {
          viewState.reads.set(path, readSignature(result, options.includeMeta));
          if (options.includeMeta) {
            viewState.metaReads.add(path);
          }
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
      operatorId: session.user.id,
      installationAdmin,
      deniedReads: deniedReadsFor(owner),
      drafts: drafts.scope(namespaceId, current.agentId ?? "create"),
      suspendDrafts: () => drafts.suspend(),
      view: shell.view,
      namespaceId,
      request: viewRequest,
      mutationVersion: () => viewState.mutations,
      navigate,
      pageUrl,
      isCurrent: () => lifetime.isCurrent(viewState.active),
      onResume: (handler) => viewState.resumeHandlers.add(handler),
      onExpired: () => {
        if (lifetime.isCurrent(viewState.active)) {
          showLogin("Your session has expired.");
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
        // A tab switch while the detail was loading already moved the URL (and the mounted
        // route) in place; keying the view by the URL it was opened with would retain it
        // under the wrong tab.
        markMountedRoute(route());
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
      showLogin("Your session has expired.");
      return;
    }
    if (!accessResolved) {
      // Uncertain shared admission invalidates every preview, not just this route.
      clearDrafts();
      resetReads();
      clearPrivate();
      shell = null;
      publicPanel(
        sessionResolved ? "Namespace access unavailable" : "Session unavailable",
        sessionResolved
          ? "Could not check Namespace access. Try again."
          : "Could not check your session. Try again.",
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
    if (current.agentId && error.status === 404 && current.namespace === null) {
      // A typed or shared link has no Namespace, so the console read the Agent in
      // the default selection. Agent IDs are unique: look in the others.
      panel(shell.view, "Loading…", "Looking for this Agent in your other Namespaces.");
      const located = await locateAgentNamespace(current.agentId, namespaceId);
      if (!lifetime.isCurrent(active)) {
        return;
      }
      if (located.namespaceId) {
        navigate(current.target, located.namespaceId, true);
        return;
      }
      const selected = namespaces.find((item) => item.id === namespaceId);
      panel(
        shell.view,
        located.complete ? "Agent unavailable" : "Agent not in this Namespace",
        located.complete
          ? "None of your Namespaces has this Agent. It may have been deleted, or you no longer have access to it."
          : `This Agent is not in ${selected ? `the ${selected.name} Namespace` : "the selected Namespace"}. Choose the Namespace that contains it.`,
        located.complete ? "Back to Agents" : "Switch Namespace",
        () => (located.complete ? navigate("agents") : switchNamespace()),
        error.requestId,
      );
      return;
    }
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
    const agentDenied = current.agentId && error.status === 403;
    panel(
      shell.view,
      title,
      agentDenied
        ? "You do not have access to this Agent or its settings, or it was deleted. Ask its owner to share it with you."
        : error.status === 403
          ? "Your account does not have access to this page in this Namespace. Ask an administrator for access, or choose another Namespace."
          : "The read could not be completed. Retry to check current access and saved state.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    if (lifetime.isCurrent(active) && shell) {
      shell.refresh.disabled = false;
      shell.view.setAttribute("aria-busy", "false");
      if (
        fromNavigation &&
        previousMountedRouteKey !== routeKey(current) &&
        document.activeElement === document.body
      ) {
        app.querySelector(".content h1")?.focus({ preventScroll: true });
      }
    }
  }
}

// Bounds the reads one Namespace-less Agent link can cause.
const agentLookupNamespaceLimit = 20;

// Finds the readable Namespace that holds agentId, other than the one already
// read. complete is true when every other readable Namespace answered that it
// has no such Agent.
async function locateAgentNamespace(agentId, excluded) {
  const candidates = namespaces.filter((item) => item.id !== excluded);
  const probed = candidates.slice(0, agentLookupNamespaceLimit);
  const results = await Promise.allSettled(
    probed.map((item) =>
      request(`/namespaces/${encodeURIComponent(item.id)}/agents/${encodeURIComponent(agentId)}`),
    ),
  );
  const found = probed.filter(
    (_, index) => results[index].status === "fulfilled" && results[index].value?.id === agentId,
  );
  if (found.length === 1) {
    return { namespaceId: found[0].id, complete: true };
  }
  const complete =
    candidates.length === probed.length &&
    results.every(
      (result) => result.status === "rejected" && [403, 404].includes(result.reason?.status),
    );
  return { namespaceId: null, complete };
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
      showLogin("Your session has expired.");
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
      showLogin("Your session has expired.");
      return;
    }
    resetReads();
    if (checking !== "detail") {
      clearDrafts();
      clearPrivate();
      publicPanel(
        checking === "session" ? "Session unavailable" : "Namespace access unavailable",
        checking === "session"
          ? "Could not check your session. Try again."
          : "Could not check Namespace access. Try again.",
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
        ? "You do not have permission to read this Agent, its versions, or its Configuration."
        : "The read could not be completed. Retry to check current access and saved state.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    // A newer load may hold this same node on screen; only this check's lifetime releases it.
    if (view.isConnected && lifetime.isCurrent(active)) {
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
  if (
    document.hidden ||
    !session ||
    loggingOut ||
    pendingIntent ||
    app.querySelector("dialog[open]")
  ) {
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
  pendingIntent = null;
  forgetLoginIntent();
  takeExternalAttempt();
  clearDrafts();
  const active = resetReads();
  clearPrivate();
  forgetInstallationAccess();
  forgetDeniedReads();
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
