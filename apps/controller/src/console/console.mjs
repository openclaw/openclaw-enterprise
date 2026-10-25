import { renderInstallationConfigurations } from "./driver-configurations.mjs";
import { element, button, statusBlock, trackVisualViewport } from "./dom.mjs";
import {
  clearResolvedSecretNames,
  noteConsoleLoad,
  renderAgentList,
  renderCreateAgent,
  renderAgentDetail,
} from "./agents.mjs";
import { clearRuntimeDenials } from "./agents/logs.mjs";
import { createApiClient } from "./api-client.mjs";
import { createViewLifetime } from "./view-lifetime.mjs";
import { createNavigation, pages } from "./navigation.mjs";
import { brandContents, createShell, initials, panel, sorted } from "./shell.mjs";
import { createDraftStore } from "./drafts.mjs";
import { renderRuntimeImages } from "./runtime-images.mjs";
import { renderNamespaces } from "./namespaces.mjs";
import { renderSecrets } from "./secrets.mjs";

const app = document.querySelector("#app");
const lifetime = createViewLifetime();
let session = null;
let namespaces = [];
let namespaceId = null;
let observabilityUrl = null;
// Set while the last Backends read was denied, so Retry and Refresh do not show the Namespace
// selector again before the same answer hides it (finding 1491).
let backendsDenied = false;
// Session owner whose Installation-admin observability read has settled.
let observabilityOwner = null;
// The Installation-access probe still being answered, for the session owner that sent it.
let installationAccessProbe = null;
// Whether that owner administers the Installation: true, false, or null when unknown.
let installationAdmin = null;
const installationAccessStorageKey = "occ.console.installationAccess";
const deniedReadsStorageKey = "occ.console.deniedReads";
// Set once this tab has a session, until it signs out; see rememberSignedIn.
const signedInStorageKey = "occ.console.signedIn";
const deniedReadsLimit = 200;
let loggingOut = false;
let navigateAgentTab = null;
// The shown page's refusal to leave through the Namespace selector, while a save is unsettled.
let leaveGuard = null;
// Whether the shown page has a write in flight that a reload or tab close would cut short.
let writeInFlight = null;
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

// A read the view shows as refused or missing (a member's native administration status, say) is
// that read's settled answer. A return compares it like data, so a view a member can read only in
// part is still reused, and a read refused since replaces its section (finding 1553).
function refusedRead(status) {
  // Never a JSON body's signature.
  return `\u0000refused ${status}`;
}

const settledRefusal = (error) => error.status === 403 || error.status === 404;

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

// Only a tab that had a session says it expired; a first visit to a deep link, or one after
// signing out, just asks to sign in (finding 1893). The mark is in tab storage, so a reload
// after expiry still says it.
function rememberSignedIn(signedIn) {
  try {
    if (signedIn) {
      sessionStorage.setItem(signedInStorageKey, "1");
    } else {
      sessionStorage.removeItem(signedInStorageKey);
    }
  } catch {
    // Without tab storage a reload after expiry asks to sign in without saying why.
  }
}

function recalledSignedIn() {
  try {
    return sessionStorage.getItem(signedInStorageKey) !== null;
  } catch {
    return false;
  }
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
const { route, pageUrl, captureIntent, validIntent, intentUrl, navigate, replaceUrl } = navigation;
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
  replaceUrl(current.url.pathname + current.url.search);
  return match ? { kind: "native", key: match[1] } : null;
}

const shellUI = createShell({ app, pages, route, pageUrl, navigate, loadPage, logout });
shellUI.setLeaveGuard((options) => Boolean(leaveGuard?.(options)));
const { publicPanel, renderRows, switchNamespace } = shellUI;

// The page names a Namespace the reader cannot read. Switch Namespace focuses the header's
// selector, which is disabled when no Namespace is readable (a member whose only grant was
// revoked, on a bookmarked link), so the panel then points at the header's Refresh, as the
// no-readable-Namespace panel does (findings 2371, 2393).
function namespaceUnavailablePanel(view) {
  if (namespaces.length) {
    panel(
      view,
      "Namespace unavailable",
      "This Namespace is missing or you no longer have access. Choose another Namespace.",
      "Switch Namespace",
      () => switchNamespace(),
    );
    return;
  }
  panel(
    view,
    "Namespace unavailable",
    "This Namespace is missing or you no longer have access, and you cannot read any other Namespace. Ask an administrator to grant you access to one, then Refresh.",
  );
}
const request = createApiClient({
  lifetime,
  hasSession: () => session !== null,
  onExpired: () => showExpiredLogin(),
  sessionKey: () => pinnedSessionKey,
});
const retainedViews = new Map();
// Other first visits that settle sooner swap pages without showing loading (finding 1407).
const loadingDelayMs = 250;
// The startup status stays blank this long (console.css). A fresh load keeps it, not the loading
// page, until then, so reads that settle between the two delays never flash loading (finding 1554).
const startupStatusDelayMs = 400;
// Once the loading page replaces a stand-in, it stays at least this long: an Agent whose reads
// settle just after it appears never flashes it for a frame or two (finding 1587).
const loadingMinimumMs = 300;
// A return or refocus keeps its page until the recheck settles; past this delay it says so.
const stillCheckingDelayMs = 1000;
let mountedRouteKey = null;
// The page whose shell is on screen. A held page keeps its own navigation and header.
let shownFeature = null;
// The shown header's page: an Agent's ({ agentId }), Create Agent ({ creating: true }) or null.
let shownPage = null;
let mountedAgent = null;
let mountedViewState = null;
let resumePending = null;
// Keep the opening panel and its way back until the Agent overview is ready. This load is
// itself the access check, so refocusing the window waits for it (findings 1460, 1516).
let openingAgentLoad = null;

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
  // Drafts are kept until a read proves their Namespace gone, not dropped on a failed read
  // (finding 1935).
  drafts.retainNamespaces(allowed);
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
  document.querySelectorAll('input[type="password"], [data-secret-value]').forEach((input) => {
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

function retainMountedView(returnLink) {
  const owner = sessionOwnerKey(session);
  // The mounted view's own node, never another page shown in its place: an Agent page renders
  // hidden behind the page that stands in for it (finding 1542).
  const view = mountedViewState?.view ?? null;
  if (!owner || mountedRouteKey === null || !view?.isConnected || view.hidden) {
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
    returnHref:
      returnLink instanceof HTMLAnchorElement && view.contains(returnLink) ? returnLink.href : null,
  });
  while (retainedViews.size > 16) {
    retainedViews.delete(retainedViews.keys().next().value);
  }
  mountedRouteKey = null;
}

// Finds the destination's retained view without removing it. The load forgets it only once it
// mounts or replaces the view; a load abandoned before then (Forward during a return's
// recheck, say) leaves it for the next return (finding 1441).
function peekRetainedView(current) {
  const owner = sessionOwnerKey(session);
  const key = routeKey(current);
  const retained = key && retainedViews.get(key);
  if (!owner || !retained || retained.owner !== owner) {
    return null;
  }
  return { key, retained };
}

function forgetRetainedView(taken) {
  if (taken && retainedViews.get(taken.key) === taken.retained) {
    retainedViews.delete(taken.key);
  }
}

// Names a recheck that outlasts stillCheckingDelayMs beside the page's actions, so a held page
// is not mistaken for a stuck one (finding 1442). Returns a function that removes the note.
function showStillChecking() {
  const actions = app.querySelector(".content .page-actions");
  if (!actions) {
    return () => {};
  }
  const note = element("p", { className: "checking-status", role: "status" });
  actions.prepend(note);
  note.textContent = "Still checking…";
  return () => note.remove();
}

// On a return, keeps the page already on screen, inert, in a fresh pending shell while the
// retained route's admission and reads run. A retained view is then never painted before it revalidates
// (finding 1412), and returns do not flash a loading state (finding 1415). The pending shell is
// the shown page's own: the navigation and header change together with the body, never around
// it (finding 1515). Its selector names the destination's Namespace, but a Namespace recovery
// block appears only if the shown page had one (finding 1527). Returns null when no page is shown.
// keepFocus: focus in the shown page, which falls to the body once the page goes inert, on its
// heading (which the console focused, say for a load this one replaces), or in the sidebar, whose
// pressed link the pending shell replaces, moves to the held heading instead (findings 1626,
// 1636, 1653).
function holdShownView(current, { busyCue = true, keepFocus = false } = {}) {
  const view = app.querySelector('.content [aria-live="polite"]');
  if (!view) {
    return null;
  }
  const focused = document.activeElement;
  const title = app.querySelector(".content h1")?.textContent;
  const scope = app.querySelector(".content .scope")?.textContent;
  const diagnostics = app.querySelector(".runtime-debug");
  const scrollY = window.scrollY;
  const recovery = app.querySelector(".content > .namespace-recovery, .content > p.scope") !== null;
  // An Agent page's own header actions (Create new version) stay with it, inert like the page.
  const pageActions = app.querySelector(".content .page-header .page-view-actions");
  const focusHeld =
    keepFocus &&
    (view.contains(focused) ||
      pageActions?.contains(focused) === true ||
      focused === app.querySelector(".content h1") ||
      app.querySelector(".sidebar")?.contains(focused) === true);
  const shell = renderShell(shownFeature ?? current.feature, true, {
    recovery,
    page: shownFeature ? shownPage : headerPage(current),
  });
  if (title) {
    app.querySelector(".content h1").textContent = title;
  }
  if (scope) {
    app.querySelector(".content .scope").textContent = scope;
  }
  view.inert = true;
  view.setAttribute("aria-busy", "true");
  if (pageActions) {
    pageActions.inert = true;
    shell.actions.append(pageActions);
  }
  // Navigation dims the held page after a moment (finding 1447); a refocus recheck keeps its
  // look. The class lives on this load's shell, so the next shell drops it.
  app.querySelector(".content").classList.toggle("holding", busyCue);
  shell.view.replaceWith(view);
  shell.view = view;
  if (shell.diagnostics && diagnostics) {
    diagnostics.inert = true;
    shell.diagnostics.replaceWith(diagnostics);
    shell.diagnostics = diagnostics;
  }
  window.scrollTo({ top: scrollY, left: 0 });
  if (focusHeld) {
    app.querySelector(".content h1").focus({ preventScroll: true });
  }
  return shell;
}

// The control focused in the shown page, which a refocus recheck blurs when it holds the page
// inert (finding 1654). restore() gives focus back once the page remounts (an input keeps its
// caret), unless the reader has moved focus since. A deployment link that the list's reread
// replaced gives it to the cell's pending deployment instead, as Back does, and so does a
// pending deployment that a second refocus's reread replaced (finding 1663). A shell control
// outside the page (sidebar, page header, navigation toggle), which the recheck's shells replace,
// gives it to the same control in the remounted shell, unless that control is gone or disabled
// (finding 1662).
function focusInShownView() {
  const view = app.querySelector('.content [aria-live="polite"]');
  const focused = document.activeElement;
  const inView = view?.contains(focused) === true;
  const shellControl = !inView && focused?.closest?.(".shell") != null;
  if (!inView && !shellControl) {
    return null;
  }
  const href = focused.href ?? focused.dataset?.returnFocusHref ?? null;
  return {
    restore(remounted) {
      if (!document.hasFocus() || document.activeElement !== document.body) {
        return;
      }
      const target = shellControl
        ? shellUI.matchingControl(focused)
        : remounted.contains(focused)
          ? focused
          : href &&
            Array.from(remounted.querySelectorAll("[data-return-focus-href]")).find(
              (item) => item.dataset.returnFocusHref === href,
            );
      target?.focus({ preventScroll: true });
    },
  };
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
  if (retained.state?.pageActions) {
    retained.state.pageActions.inert = false;
    shell.actions.append(retained.state.pageActions);
  }
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

function resetReads({ retainView = false, returnLink = null } = {}) {
  const resumeDrafts = drafts.suspend();
  if (mountedViewState) {
    mountedViewState.resumeDrafts = resumeDrafts;
    mountedViewState.active = null;
  }
  navigateAgentTab = null;
  leaveGuard = null;
  writeInFlight = null;
  mountedAgent = null;
  clearPasswordInputs();
  shellUI.reset();
  if (retainView) {
    retainMountedView(returnLink);
  } else {
    mountedRouteKey = null;
  }
  mountedViewState = null;
  return lifetime.reset();
}

// The header shape for a route: an Agent's page and Create Agent lead with ← Agents and carry a
// meta row (the ID, the Namespace) under the title; collections do not (UX spec 3.2).
function headerPage(current) {
  if (current.feature !== "agents") {
    return null;
  }
  if (current.creating) {
    return { creating: true };
  }
  return current.agentId ? { agentId: current.agentId } : null;
}

function collectionPath(feature, selection) {
  return (
    { namespaces: "/namespaces", backends: "/backends" }[feature] ??
    `/namespaces/${encodeURIComponent(selection)}/${feature}`
  );
}

function renderShell(
  feature,
  namespaceAdmissionPending = false,
  { recovery = true, page = headerPage(route()) } = {},
) {
  shownFeature = feature;
  shownPage = page;
  const shell = shellUI.renderShell(feature, {
    session,
    namespaces,
    namespaceId,
    observabilityUrl,
    namespaceAdmissionPending,
    recovery,
    page,
  });
  if (feature === "backends" && backendsDenied && shell.scopeSelector) {
    shell.scopeSelector.hidden = true;
  }
  return shell;
}

function renderPendingNamespaceShell(feature) {
  const shell = renderShell(feature, true);
  panel(shell.view, "Loading…", "Checking Namespace access.");
  return shell;
}

function clearPrivate() {
  session = null;
  backendsDenied = false;
  namespaces = [];
  namespaceId = null;
  observabilityUrl = null;
  observabilityOwner = null;
  installationAccessProbe = null;
  installationAdmin = null;
  clearRetainedViews();
  clearResolvedSecretNames();
  clearRuntimeDenials();
}

function clearDrafts() {
  discardCreationOnExit = null;
  drafts.clear();
  draftUserId = null;
}

function showExpiredLogin() {
  const current = route();
  // Keep only a validated read destination; reset private views and drafts in showLogin.
  const destination = pendingIntent ?? captureIntent(pageUrl(current.target, current.namespace));
  showLogin("Your session has expired.", destination);
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
  replaceUrl("/console/login");
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
  const feedback = statusBlock("danger", null, describe(true));
  // The page's one line under the title also describes the email field (UX spec 3.12).
  const usernameHint = element(
    "p",
    { id: "username-hint", className: "muted auth-intro" },
    "Use your account email.",
  );
  // Recovery-only password sign-in hides the form until the recovery path is chosen.
  let recoveryOnly = false;
  const submit = element(
    "button",
    { type: "submit", className: "button button--primary" },
    "Sign in",
  );
  const form = element(
    "form",
    {},
    element("label", { for: "username" }, "Email"),
    username,
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
      usernameHint.hidden = false;
      username.focus();
    },
    { tone: "link", className: "auth-recovery", hidden: true },
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
      replaceUrl("/console/agents");
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
              : "Could not sign in. Check your email and password."
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
      element("p", { className: "brand" }, ...brandContents("sign-in")),
      element("h1", {}, "Sign in"),
      usernameHint,
      form,
      providers,
      recovery,
    ),
    ...signInFooter(),
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
          usernameHint.textContent = "Use the recovery account's email.";
          // Never pull the form away from someone already using it.
          if (!pending && username.value === "" && password.value === "") {
            form.hidden = true;
            usernameHint.hidden = true;
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

// The sign-in page footer names the build it serves, from the meta tag the image bakes in; a
// development build has none, so the footer is left out.
function signInFooter() {
  const revision = document.querySelector('meta[name="occ-build-revision"]')?.content ?? "";
  return /^[a-f0-9]{40}$/.test(revision)
    ? [
        element(
          "footer",
          { className: "auth-footer" },
          `OpenClaw Enterprise · build ${revision.slice(0, 8)}`,
        ),
      ]
    : [];
}

function showCheckingSession(checking = () => true) {
  const shown = app.firstElementChild?.classList.contains("startup") ? app.firstElementChild : null;
  // Destination recovery can continue in another loadPage without restarting this status.
  if (shown?.dataset.session !== undefined) {
    return;
  }
  // The shell's static status (index.html) paints before any script, so a slow link never
  // shows a blank page. Take it over in place: the status never blanks or moves (finding 1444).
  const status = shown ?? element("p", { className: "startup", role: "status" });
  status.dataset.session = "";
  if (!shown) {
    app.replaceChildren(status);
  }
  // Delay the announcement, never the session check or the view that replaces it. It waits
  // until the status is visible, so screen readers announce the change.
  setTimeout(() => {
    if (status.isConnected && checking()) {
      status.textContent = "Checking session…";
    }
  }, startupStatusDelayMs);
}

async function loadPage({
  fromNavigation = false,
  reuseView = fromNavigation,
  fromRefresh = false,
  // Set only by Back and Forward (popstate).
  restoreHistory = null,
  openingAgent = false,
  // Set only by the load that follows a chat-link lookup that failed (finding 1450).
  chatLinkFailure = null,
} = {}) {
  noteConsoleLoad();
  if (loggingOut) {
    return;
  }
  // A refocus or visibility recheck of the shown page, as opposed to a navigation.
  const resumingView = reuseView && !fromNavigation;
  const current = route();
  const nativeIntent = takeNativeFragment(current);
  if (fromNavigation && nativeIntent === null) {
    pendingIntent = null;
  }
  if (nativeIntent !== null) {
    pendingIntent = nativeIntent;
  }
  const tabNavigation = fromNavigation && navigateAgentTab?.(current.url);
  if (tabNavigation === "blocked") {
    // Back or Forward already moved to an existing entry. Return to the tab we kept open,
    // leaving that entry intact; only a newly requested navigation needs its URL replaced.
    (restoreHistory ?? replaceUrl)(mountedRouteKey);
    return;
  }
  if (tabNavigation) {
    markMountedRoute(current);
    return;
  }
  // Same-version tab changes stay in the mounted page. Leaving it during a pending write
  // returns the browser to the entry we kept open, preserving both Back and Forward.
  if (restoreHistory && mountedRouteKey !== null && leaveGuard?.({ pendingOnly: true })) {
    restoreHistory(mountedRouteKey);
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
  const active = resetReads({
    retainView: knownPrivateState,
    // A Namespaces row link marks itself too, so Back returns focus to that row.
    returnLink:
      openingAgent || document.activeElement?.matches?.("a[data-return-focus-href]")
        ? document.activeElement
        : null,
  });
  if (abandonedCreation) {
    const creationDrafts = drafts.scope(discardCreationOnExit.namespaceId, "create");
    creationDrafts.forget("create");
    creationDrafts.forget("channels");
    retainedViews.delete(previousMountedRouteKey);
    discardCreationOnExit = null;
  }
  const taken = knownPrivateState ? peekRetainedView(current) : null;
  if (!reuseView) {
    // Refresh and save/reload discard the shown view even if the load is abandoned.
    forgetRetainedView(taken);
  }
  const retainedView = taken?.retained ?? null;
  let retained = retainedView !== null;
  // An Agent link opens its destination immediately. Other visits keep the shown page inert
  // until a retained view revalidates or admission and the destination's first read settle.
  // On a navigation, focus that was in the held page waits on its heading until the destination
  // takes it: the Agent's heading for an Agent page loading behind it (the new version an
  // admitted deployment opens, say; finding 1626), or the Agent's link on a return to the Agents
  // list (finding 1636). The pending shell also replaces a pressed sidebar link (finding 1653).
  // On refocus, restore the reader’s place only if we reuse the view (finding 1654).
  const refocused = resumingView ? focusInShownView() : null;
  let shell =
    knownPrivateState && !openingAgent
      ? holdShownView(current, { busyCue: !resumingView, keepFocus: !resumingView })
      : null;
  let held = shell !== null;
  // The stand-in's heading while it holds focus for the page loading behind it.
  let heldHeading =
    held && document.activeElement === app.querySelector(".content h1")
      ? document.activeElement
      : null;
  let agentReturnHref = null;
  // Gives a refocus its reader's place back once the reused view's shell is usable.
  let restoreRefocus = null;
  let pendingAgentHeading = null;
  let focusAgentResult = false;
  // The page kept on screen while an Agent's overview renders behind it, and the Agent's title
  // until it reveals (findings 1516, 1526).
  let shownStandIn = null;
  let standInTitle = null;
  // The shell that says it is checking Namespace access, while it is the one shown.
  let pendingNamespaceShell = null;
  // When the loading delay put a loading page on screen (performance.now()), or null.
  let loadingShownAt = null;
  let sessionResolved = false;
  let accessResolved = false;
  if (!Object.hasOwn(pages, current.feature) && current.feature !== "login") {
    publicPanel("Page not found", "This console page is unavailable.", "Go to Agents", () =>
      navigate("agents", current.namespace),
    );
    return;
  }
  // A load without a shown private page shows the startup status (no signed-in navigation
  // before the session check) and keeps it, as a held page stays, until the load outlasts
  // startupStatusDelayMs (a held page loadingDelayMs), so a fast one never flashes loading. A
  // load that continues from the startup status (a sign-in destination) keeps it too. A return's
  // held page stays until it revalidates (finding 1415). A signed-in load with no page to hold
  // (an error panel, say) shows the pending shell at once.
  const startup =
    !held && (!knownPrivateState || app.firstElementChild?.classList.contains("startup") === true);
  // Only a link from the open list sets openingAgent, so Back returns to that history entry.
  // No Agent name, fields or controls are shown until the ordinary access checks and read pass.
  // A second press before the first traversal lands would go back twice and can leave the
  // console, so only the first press navigates (finding 1459).
  let leaving = false;
  const backToAgents = (event) => {
    event.currentTarget.setAttribute("aria-disabled", "true");
    if (!leaving) {
      leaving = true;
      history.back();
    }
  };
  const openingAgentTitle = "Agent details";
  const showOpeningPanel = () => {
    shell = renderShell(current.feature, true);
    shell.view.replaceChildren(
      element(
        "section",
        { className: "state-panel" },
        element("p", { role: "status" }, "Loading agent details…"),
        button("Back to Agents", backToAgents),
      ),
    );
    shell.view.setAttribute("aria-busy", "false");
    pendingAgentHeading = app.querySelector(".content h1");
    pendingAgentHeading.textContent = openingAgentTitle;
    pendingAgentHeading.focus();
  };
  if (openingAgent && !startup) {
    openingAgentLoad = active;
    showOpeningPanel();
  } else if (!held) {
    if (startup) {
      // An abandoned load may have left its Agent page hidden beside the status (finding 1537).
      for (const stale of app.querySelectorAll(":scope > .startup ~ *")) {
        stale.remove();
      }
      // Its text names the session check only while that check runs: a resolved load switches
      // to loading at the same delay instead (finding 1554).
      showCheckingSession(() => !sessionResolved);
    } else {
      shell = pendingNamespaceShell = renderPendingNamespaceShell(current.feature);
    }
  }
  // A return or refocus that can reuse its retained view keeps the shown page and, past
  // stillCheckingDelayMs, says it is still checking. Other loads, Refresh included, show
  // loading after loadingDelayMs (finding 1442).
  const recheck = held && retained && reuseView;
  const loadingDelay = startup ? startupStatusDelayMs : loadingDelayMs;
  let loadingTimer =
    !held && !startup
      ? null
      : recheck
        ? setTimeout(() => {
            loadingTimer = null;
            if (lifetime.isCurrent(active) && held) {
              showStillChecking();
            }
          }, stillCheckingDelayMs)
        : setTimeout(() => {
            loadingTimer = null;
            if (!lifetime.isCurrent(active)) {
              return;
            }
            if (startup && !sessionResolved) {
              // The startup status announces the session check itself.
              return;
            }
            held = false;
            loadingShownAt = performance.now();
            // The loading page's heading takes focus from the held one it replaces.
            const headingFocused = heldHeading !== null && document.activeElement === heldHeading;
            const keepHeadingFocus = () => {
              heldHeading = headingFocused ? app.querySelector(".content h1") : null;
              heldHeading?.focus({ preventScroll: true });
            };
            if (!accessResolved) {
              shell = pendingNamespaceShell = renderPendingNamespaceShell(current.feature);
              keepHeadingFocus();
              return;
            }
            // An Agent page rendering hidden behind the startup status keeps rendering behind
            // the loading page that now stands in for it (finding 1537).
            const behind = shownStandIn ? shell.view : null;
            shell = renderShell(current.feature, false);
            panel(
              shell.view,
              "Loading…",
              current.agentId
                ? "Reading this Agent."
                : `Reading ${pages[current.feature].toLowerCase()}.`,
            );
            if (behind) {
              shownStandIn = shell;
              shell.view.after(behind);
              shell = { ...shell, view: behind, diagnostics: null };
            }
            keepHeadingFocus();
          }, loadingDelay);
  const stopLoadingTimer = () => {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  };
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
    // A pinned key alone covers a provider exchange that confirmed a session now missing.
    const hadSession = session !== null || pinnedSessionKey !== null || recalledSignedIn();
    const previousOwner = sessionOwnerKey(session);
    const resolvedSession = await request("/api/auth/session");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (resolvedSession !== null && pinnedSessionKey === null) {
      pinSessionKey(resolvedSession.sessionKey);
    } else if (resolvedSession !== null && resolvedSession.sessionKey !== pinnedSessionKey) {
      // The controller rejects a mismatched key; never act on another session regardless.
      showExpiredLogin();
      return;
    }
    session = resolvedSession;
    if (session === null) {
      const destination =
        providerError !== null || current.feature === "login"
          ? null
          : (pendingIntent ?? captureIntent(pageUrl(current.target, current.namespace)));
      showLogin(
        providerError !== null
          ? (reasonFailure ?? providerFailure(providerError.label))
          : hadSession &&
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
    rememberSignedIn(true);
    const owner = sessionOwnerKey(session);
    // Drafts belong to the session that wrote them: a read retried after an unavailable check
    // keeps them (finding 1935); any other session clears them.
    if (!owner || draftUserId !== owner) {
      clearDrafts();
    }
    if (!owner || previousOwner !== owner || draftUserId !== owner) {
      clearRetainedViews();
      observabilityUrl = null;
      observabilityOwner = null;
      installationAdmin = null;
      draftUserId = owner;
      retained = false;
      if (shell && (!owner || (previousOwner !== null && previousOwner !== owner))) {
        // Another account's page, or a shell naming it, must not stay on screen.
        stopLoadingTimer();
        held = false;
        shell = null;
        showCheckingSession();
      }
    }
    const destination = pendingIntent;
    if (destination?.kind === "native" && validIntent(destination)) {
      let failure = null;
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
        replaceUrl(intentUrl(target) ?? "/console/agents");
      } catch (error) {
        if (!lifetime.isCurrent(active)) {
          return;
        }
        pendingIntent = null;
        failure = [400, 403, 404].includes(error.status) ? "unavailable" : "interrupted";
        replaceUrl("/console/agents");
      }
      void loadPage({ chatLinkFailure: failure });
      return;
    }
    if (destination || current.feature === "login") {
      pendingIntent = null;
      replaceUrl(intentUrl(destination) ?? "/console/agents");
      void loadPage();
      return;
    }
    if (loadingTimer === null) {
      // The loading delay passed while the session was checked (or there was none): show
      // the pending shell now, or an opening Agent's panel. Otherwise the startup status stays
      // until the delay passes or the first reads settle.
      if (!shell && openingAgent && !startup) {
        showOpeningPanel();
      } else if (!shell) {
        shell = pendingNamespaceShell = renderPendingNamespaceShell(current.feature);
        loadingShownAt = performance.now();
      }
    }
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
    // The default pick prefers a ready Namespace and never a deleting one while another remains
    // (finding 1895); with only deleting Namespaces it shows the first, whose status the Agents
    // page then names.
    namespaceId =
      current.namespace ??
      (
        namespaces.find((item) => item.status === "ready") ??
        namespaces.find((item) => item.status !== "deleting") ??
        namespaces[0]
      )?.id ??
      null;
    replaceUrl(pageUrl(current.target));
    const scopedNamespaceUnavailable =
      ["agents", "secrets"].includes(current.feature) &&
      !namespaces.some((item) => item.id === namespaceId);
    if (current.namespace !== null && (!held || shownFeature === current.feature)) {
      // Namespace admission is done, so the header selector, when the shown page has one, is
      // usable while the destination's first read runs. A switch resets the lifetime, discarding
      // these reads. Without a URL selection the full render below picks the default. A held page
      // keeps the scope beside its rows until the destination replaces them. A page held for
      // another page (Agents on the way to Backends, say) keeps its selector disabled: a pick
      // there would open the destination, not the page it heads (finding 1527).
      shellUI.updateNamespaces(namespaces, { preservePageScope: held });
    }
    // The destination's first read runs before its shell renders, so the held page (or
    // loading) is replaced once, by the page itself (finding 1407).
    let firstItems = null;
    let firstAgent = null;
    // The Agents list and Create Agent paint with the caller's permission answer, never enabled
    // and then refused (findings 1517, 1521). Gating only: the API still authorizes creation, so
    // an unknown answer (a failed read) keeps the controls.
    const permissionsPath = `/namespaces/${encodeURIComponent(namespaceId)}/permissions`;
    const permissionsRead =
      !scopedNamespaceUnavailable && current.feature === "agents" && !current.agentId
        ? request(permissionsPath).catch(() => null)
        : null;
    let firstPermissions = null;
    if (!scopedNamespaceUnavailable && current.feature !== "settings" && !current.creating) {
      if (current.agentId) {
        firstAgent = await request(
          `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
        );
      } else {
        firstItems =
          current.feature === "namespaces"
            ? namespaces
            : await request(collectionPath(current.feature, namespaceId));
      }
      if (!lifetime.isCurrent(active)) {
        return;
      }
    }
    if (permissionsRead) {
      firstPermissions = await permissionsRead;
      if (!lifetime.isCurrent(active)) {
        return;
      }
    }
    const retainedState = retainedView?.state;
    let unchanged = false;
    if (retained && reuseView && retainedState && !scopedNamespaceUnavailable) {
      const fresh = new Map([["/namespaces", namespaces]]);
      if (firstAgent) {
        fresh.set(
          `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
          firstAgent,
        );
      } else if (firstItems && current.feature !== "namespaces") {
        fresh.set(collectionPath(current.feature, namespaceId), firstItems);
      }
      if (firstPermissions !== null) {
        fresh.set(permissionsPath, firstPermissions);
      }
      const refused = new Map();
      const deniedReads = deniedReadsFor(owner);
      const validations = await Promise.allSettled([
        ...[...retainedState.reads].map(async ([path, answer]) => {
          if (fresh.has(path)) {
            return;
          }
          // A denial this tab remembers is audited, so it is not asked again; a rebuild would
          // show the same refusal without asking.
          if (answer === refusedRead(403) && deniedReads.has(path)) {
            refused.set(path, 403);
            return;
          }
          try {
            fresh.set(
              path,
              await request(path, { includeMeta: retainedState.metaReads.has(path) }),
            );
          } catch (error) {
            if (!settledRefusal(error)) {
              throw error;
            }
            refused.set(path, error.status);
          }
        }),
        // Live sections check that what they show is still readable (finding 1553).
        ...[...retainedState.revalidators].map((check) => check()),
      ]);
      if (!lifetime.isCurrent(active)) {
        return;
      }
      // A shell restored without a URL selection has none; once a Namespace is readable,
      // the full render below picks the default instead.
      unchanged =
        namespaceId === current.namespace &&
        validations.every((result) => result.status === "fulfilled") &&
        JSON.stringify(retainedState.user) === JSON.stringify(session.user) &&
        [...retainedState.reads].every(
          ([path, value]) =>
            (refused.has(path)
              ? refusedRead(refused.get(path))
              : readSignature(fresh.get(path), retainedState.metaReads.has(path))) === value,
        );
    }
    // Resolve the old link in the admitted list, even if its row reads were unfinished and we
    // must rebuild it. Capture focus before replacing the shell, not after it falls back to body
    // (or leaves the held heading).
    if (
      retained &&
      reuseView &&
      !scopedNamespaceUnavailable &&
      (document.activeElement === document.body ||
        (heldHeading !== null && document.activeElement === heldHeading))
    ) {
      agentReturnHref = retainedView.returnHref;
    }
    // Move focus to the Agent's heading only if the opening heading still owns it.
    focusAgentResult = document.activeElement === pendingAgentHeading;
    if (unchanged) {
      stopLoadingTimer();
      forgetRetainedView(taken);
      // Holding the page made it inert. If the reader moved on, don't reclaim focus even if
      // replacing the shell briefly leaves it on the body again.
      const restoreFocus = document.activeElement === document.body ? refocused : null;
      shell = mountRetainedView(current, retainedView);
      // The chat-link notice belongs to that landing: a refocus keeps it, a return does not.
      if (!resumingView) {
        shell.view.querySelector(":scope > .unopened-chat-link")?.remove();
      }
      mountedViewState = retainedState;
      retainedState.active = active;
      retainedState.resumeDrafts?.();
      // Timers that fired while the view was detached stopped; let them re-arm.
      for (const resume of retainedState.resumeHandlers) {
        resume();
      }
      navigateAgentTab = retainedState.tabNavigation;
      leaveGuard = retainedState.leaveGuard ?? null;
      writeInFlight = retainedState.writeInFlight ?? null;
      mountedAgent = retainedState.agent;
      markMountedRoute(current);
      restoreRefocus = () => restoreFocus?.restore(shell.view);
      return;
    }
    // The destination rebuilds: a retained view that did not match is stale from here on.
    forgetRetainedView(taken);
    // An Agent page renders hidden behind what is on screen (the opening panel, a held page or
    // a loading status), whose shell stays until the overview reveals. The Agent's shell,
    // heading, toolbar and overview then replace it in one frame, however the Agent was
    // entered (findings 1516, 1526). The stand-in's heading and controls keep focus meanwhile,
    // so nothing is focused twice (finding 1528). A fresh load whose reads beat the loading
    // delay has no shell yet: its startup status stands in, until the overview reveals or the
    // delay passes and the loading page takes its place (finding 1537).
    const agentEntry = current.agentId && !current.creating && !scopedNamespaceUnavailable;
    const startupStandIn =
      agentEntry && !shell && loadingTimer !== null ? app.querySelector(":scope > .startup") : null;
    const standIn =
      agentEntry && shell?.view.isConnected
        ? shell
        : startupStandIn
          ? { view: startupStandIn, diagnostics: null }
          : null;
    // A held return keeps saying it is still checking while the Agent renders (finding 1442), and
    // a startup status gives way to loading at the delay. Other timers would replace the
    // stand-in's shell, so they stop here.
    if (!standIn || !(recheck || startupStandIn)) {
      stopLoadingTimer();
    }
    if (standIn && standIn === pendingNamespaceShell) {
      // Admission is done; the stand-in names the read that remains.
      panel(standIn.view, "Loading…", "Reading this Agent.");
    }
    if (standIn) {
      const detailView = element("div", { "aria-live": "polite", "aria-busy": "true", hidden: "" });
      standIn.view.after(detailView);
      // Diagnostics attach to the Agent's own shell when it reveals.
      shell = { ...standIn, view: detailView, diagnostics: null };
    } else {
      // A Namespace the reader cannot read hides its Agent too: the panel takes the Agents list's
      // header, not the Agent page's ID, copy button and ← Agents link (finding 2400).
      shell = renderShell(
        current.feature,
        false,
        scopedNamespaceUnavailable ? { page: null } : undefined,
      );
    }
    const viewState = {
      active,
      pending: 0,
      reusable: true,
      mutations: 0,
      reads: new Map(),
      metaReads: new Set(),
      resumeHandlers: new Set(),
      revalidators: new Set(),
      user: session.user,
      // The view this load renders, retained by its own node (finding 1542).
      view: shell.view,
    };
    mountedViewState = viewState;
    // A read the view redoes when it resumes (rereadOnResume, the Agents list's row
    // deployments) neither keeps the view from being reused while it runs nor, if it fails,
    // afterwards (finding 1663). Leaving aborts it, and its section rereads it on resume.
    const viewRequest = async (path, options = {}) => {
      const counted = !options.rereadOnResume;
      if (counted) {
        viewState.pending += 1;
      }
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
        // A refused or missing read the view shows as its answer keeps the view reusable; live
        // reads leave theirs to their section's own return check (finding 1553).
        if ((options.method ?? "GET") === "GET" && settledRefusal(error)) {
          // Content a later poll was refused may still be on screen: a return rebuilds it.
          const prior = viewState.reads.get(path);
          if (prior !== undefined && prior !== refusedRead(error.status)) {
            viewState.reusable = false;
          }
          if (options.revalidate !== false) {
            viewState.reads.set(path, refusedRead(error.status));
          }
        } else if (counted) {
          // A reread on resume replaces what an unfinished or failed one showed, including a
          // read the next view's reset aborts.
          viewState.reusable = false;
        }
        throw error;
      } finally {
        if (counted) {
          viewState.pending -= 1;
        }
      }
    };
    const attachDiagnostics = (diagnostics) => {
      viewState.diagnostics = diagnostics;
      void renderRuntimeImages(diagnostics, {
        request: viewRequest,
        namespaceId,
        isCurrent: () => lifetime.isCurrent(viewState.active),
      });
    };
    if (shell.diagnostics) {
      attachDiagnostics(shell.diagnostics);
    }
    if (current.feature === "settings") {
      shell.view.append(settingsView());
      if (installationAdmin) {
        shell.view.append(
          renderInstallationConfigurations({
            request,
            isCurrent: () => lifetime.isCurrent(viewState.active),
          }),
        );
      }

      markMountedRoute(current);
      return;
    }
    if (scopedNamespaceUnavailable) {
      clearRetainedViewsForNamespace(namespaceId);
      if (namespaceId === null) {
        // With nothing to switch to, the header's Refresh is the one way to look again, so the
        // panel adds no second Refresh (finding 2371).
        panel(
          shell.view,
          "No readable Namespaces",
          "Ask an administrator to create a Namespace or grant you access to one, then Refresh.",
        );
      } else {
        namespaceUnavailablePanel(shell.view);
      }
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
      // The selected Namespace: the Agents list and Create Agent name its status when it is not
      // ready (finding 1895).
      namespace: namespaces.find((item) => item.id === namespaceId),
      request: viewRequest,
      mutationVersion: () => viewState.mutations,
      navigate,
      pageUrl,
      isCurrent: () => lifetime.isCurrent(viewState.active),
      onResume: (handler) => viewState.resumeHandlers.add(handler),
      onRevalidate: (check) => {
        viewState.revalidators.add(check);
        return () => viewState.revalidators.delete(check);
      },
      onExpired: () => {
        if (lifetime.isCurrent(viewState.active)) {
          showExpiredLogin();
        }
      },
      setTitle: (title) => {
        if (shownStandIn) {
          standInTitle = title;
          return;
        }
        const heading = app.querySelector("h1");
        heading.textContent = title;
        // The opening panel's heading had focus and the shell replaced it. Focus the Agent's
        // heading as it appears, not once its tab's reads settle: on a slow link that left
        // focus on body for 0.5-0.9 s (finding 1483).
        if (
          focusAgentResult &&
          document.activeElement === document.body &&
          lifetime.isCurrent(active)
        ) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
      },
      url: current.url,
      setTabNavigation(handler) {
        if (lifetime.isCurrent(viewState.active)) {
          // An Agent page still hidden behind a stand-in leaves tab navigation to a full load: it
          // must not switch tabs, or mark its route mounted, while another page is on screen
          // (finding 1542).
          const navigateTab = (next) => shownStandIn === null && handler(next);
          viewState.tabNavigation = navigateTab;
          navigateAgentTab = navigateTab;
        }
      },
      // The page's own header actions (an Agent's Create new version) sit beside Refresh. A
      // page rendering behind a stand-in gets them when its shell reveals.
      setPageActions(node) {
        node.classList.add("page-view-actions");
        viewState.pageActions = node;
        if (!shownStandIn && shell.actions?.isConnected) {
          shell.actions.querySelector(":scope > .page-view-actions")?.remove();
          shell.actions.append(node);
        }
      },
      setLeaveGuard(guard) {
        if (lifetime.isCurrent(viewState.active)) {
          const refuse = (options) => shownStandIn === null && guard(options);
          viewState.leaveGuard = refuse;
          leaveGuard = refuse;
        }
      },
      // A page whose writes hold it open (an Agent's share, a draft's save) says when one is in
      // flight, so a reload or tab close asks first too (finding 2125).
      setWriteInFlight(check) {
        if (lifetime.isCurrent(viewState.active)) {
          viewState.writeInFlight = check;
          writeInFlight = check;
        }
      },
      // A page that holds only for its own write sets both guards here, so it cannot hold in-app
      // navigation and still let a reload or tab close cut the write short (finding 2181).
      holdWhileWriting({ writing, held, released }) {
        agentContext.setLeaveGuard(() => {
          if (!writing()) {
            released?.();
            return false;
          }
          held();
          return true;
        });
        agentContext.setWriteInFlight(writing);
      },
    };
    if (firstPermissions !== null) {
      viewState.reads.set(permissionsPath, readSignature(firstPermissions));
    } else if (permissionsRead) {
      // Painted without the permissions answer: a return reads it again instead of reusing this.
      viewState.reusable = false;
    }
    if (current.creating || (["agents", "secrets"].includes(current.feature) && !current.agentId)) {
      // The Agent and Secret pages show the selected Namespace's status (finding 1895), so a
      // return rebuilds them when it changed. Other Namespaces' changes keep the view.
      const shownNamespace = namespaceId;
      const shownStatus = agentContext.namespace?.status;
      viewState.revalidators.add(async () => {
        if (namespaces.find((item) => item.id === shownNamespace)?.status !== shownStatus) {
          throw new Error("Namespace status changed");
        }
      });
    }
    if (current.creating) {
      renderCreateAgent(
        {
          ...agentContext,
          permissions: firstPermissions,
          setDiscardOnExit(discard) {
            discardCreationOnExit = discard ? { namespaceId } : null;
          },
          setDraftCapture(capture, unsaved) {
            agentContext.drafts.forget("create");
            if (capture) {
              agentContext.drafts.track("create", capture);
              agentContext.drafts.unsavedWhen("create", unsaved);
            }
          },
        },
        agentContext.drafts.get("create"),
      );
      markMountedRoute(current);
      return;
    }
    if (current.agentId) {
      let markRevealed = () => {};
      const revealed = new Promise((resolve) => {
        markRevealed = resolve;
      });
      if (standIn) {
        const detailView = shell.view;
        shownStandIn = standIn;
        let revealWait = null;
        lifetime.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(revealWait);
            markRevealed();
          },
          { once: true },
        );
        // Runs once the Agent's page is on screen: the page's own reveal steps (scroll, focus).
        const afterReveal = [];
        const runAfterReveal = () => {
          for (const then of afterReveal.splice(0)) {
            then();
          }
        };
        // The overview's first reads settled, or its bounded wait ran out: replace the stand-in
        // with the Agent's shell, heading, toolbar and overview in one frame, then run `then`.
        agentContext.revealed = (then) => {
          if (then) {
            afterReveal.push(then);
          }
          if (revealWait !== null) {
            return;
          }
          // The stand-in may have given way to the loading page since (finding 1537).
          const shownNow = shownStandIn;
          if (shownNow === null || !lifetime.isCurrent(active)) {
            runAfterReveal();
            return;
          }
          // A loading page that has just appeared stays its minimum time (finding 1587).
          const wait =
            loadingShownAt === null ? 0 : loadingShownAt + loadingMinimumMs - performance.now();
          if (wait > 0) {
            revealWait = setTimeout(() => {
              revealWait = null;
              agentContext.revealed();
            }, wait);
            return;
          }
          shownStandIn = null;
          stopLoadingTimer();
          if (!detailView.isConnected) {
            markRevealed();
            runAfterReveal();
            return;
          }
          // Focus in the stand-in (its heading, or the opening panel's Back to Agents) moves to
          // the Agent's heading, focused once under its name.
          const focusHeading =
            document.activeElement === pendingAgentHeading ||
            (heldHeading !== null && document.activeElement === heldHeading) ||
            shownNow.view.contains(document.activeElement);
          shell = renderShell(current.feature, false);
          shell.view.replaceWith(detailView);
          shell.view = detailView;
          detailView.hidden = false;
          if (viewState.pageActions) {
            shell.actions.append(viewState.pageActions);
          }
          if (shell.diagnostics) {
            attachDiagnostics(shell.diagnostics);
          }
          window.scrollTo({ top: 0, left: 0 });
          if (standInTitle !== null) {
            agentContext.setTitle(standInTitle);
          }
          const heading = app.querySelector(".content h1");
          if (focusHeading && document.activeElement !== heading) {
            heading.focus({ preventScroll: true });
          }
          markRevealed();
          runAfterReveal();
        };
      } else {
        markRevealed();
      }
      viewState.reads.set(
        `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(current.agentId)}`,
        JSON.stringify(firstAgent),
      );
      const agent = await renderAgentDetail(
        { ...agentContext, agentId: current.agentId },
        { agent: firstAgent },
      );
      // The load settles with the Agent's page shown, not its placeholder.
      await revealed;
      if (lifetime.isCurrent(active) && shell.view.isConnected) {
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
    const items = firstItems;
    if (!Array.isArray(items)) {
      throw new Error("Invalid collection response");
    }
    viewState.reads.set(collectionPath(current.feature, namespaceId), JSON.stringify(items));
    if (current.feature === "agents") {
      renderAgentList({ ...agentContext, items, permissions: firstPermissions });
      showChatLinkFailure(shell.view, chatLinkFailure);
    } else if (current.feature === "namespaces") {
      renderNamespaces(
        { ...agentContext, reload: () => loadPage(), fromRefresh },
        items,
        renderRows,
      );
    } else if (current.feature === "secrets") {
      renderSecrets({ ...agentContext, items, sorted });
    } else {
      if (current.feature === "backends" && backendsDenied) {
        backendsDenied = false;
        if (shell.scopeSelector) {
          shell.scopeSelector.hidden = false;
        }
      }
      renderRows(shell.view, current.feature, items);
    }
    markMountedRoute(current);
  } catch (error) {
    if (!lifetime.isCurrent(active) || error.name === "AbortError") {
      return;
    }
    stopLoadingTimer();
    forgetRetainedView(taken);
    shownStandIn = null;
    if (error.status === 401) {
      showExpiredLogin();
      return;
    }
    if (!accessResolved) {
      // Uncertain shared admission invalidates every preview, not just this route. Drafts stay:
      // a later read clears them only if it proves their Namespace or account gone (finding 1935).
      resetReads();
      clearPrivate();
      shell = null;
      showAdmissionUnavailable(sessionResolved, error.status);
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
    // setTitle may already have moved that focus to the Agent's heading (finding 1483).
    focusAgentResult =
      document.activeElement === pendingAgentHeading ||
      (focusAgentResult && document.activeElement === app.querySelector(".content h1"));
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
    if (openingAgent && ![400, 403, 404].includes(error.status)) {
      app.querySelector(".content h1").textContent = openingAgentTitle;
      panel(
        shell.view,
        "Could not load agent details",
        "Try again to check access and load this Agent.",
        "Try again",
        () => void loadPage({ openingAgent: true }),
        error.requestId,
      );
      shell.view.querySelector(".state-panel").append(button("Back to Agents", backToAgents));
      return;
    }
    const agentDenied = current.agentId && error.status === 403;
    // Backends are Installation-wide: another Namespace cannot change a denial (finding 1491).
    const installationDenied = current.feature === "backends" && error.status === 403;
    if (current.feature === "backends") {
      backendsDenied = installationDenied;
    }
    if (installationDenied && shell.scopeSelector) {
      shell.scopeSelector.hidden = true;
    }
    panel(
      shell.view,
      title,
      agentDenied
        ? "You do not have access to this Agent or its settings, or it was deleted. Ask its owner to share it with you."
        : installationDenied
          ? "Your account does not have access to Backends. Backends apply to the whole Installation, so choosing another Namespace would not change this. Ask an Installation administrator for access."
          : error.status === 403
            ? "Your account does not have access to this page in this Namespace. Ask an administrator for access, or choose another Namespace."
            : "The read could not be completed. Retry to check current access and saved state.",
      "Retry",
      () => void loadPage(),
      error.requestId,
    );
  } finally {
    stopLoadingTimer();
    if (openingAgentLoad === active) {
      openingAgentLoad = null;
    }
    if (lifetime.isCurrent(active) && shell) {
      shell.refresh.disabled = false;
      shell.view.setAttribute("aria-busy", "false");
      restoreRefocus?.();
      if (focusAgentResult && document.activeElement === document.body) {
        const heading =
          shell.view.querySelector(":scope > .state-panel > h2") ??
          app.querySelector(".content h1");
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      } else if (
        fromNavigation &&
        previousMountedRouteKey !== routeKey(current) &&
        document.activeElement === document.body
      ) {
        // A deployment being reread can receive return focus, but is not a link until it settles.
        const focusTarget =
          agentReturnHref &&
          Array.from(shell.view.querySelectorAll("a[href], [data-return-focus-href]")).find(
            (item) => (item.dataset.returnFocusHref ?? item.href) === agentReturnHref,
          );
        (focusTarget || app.querySelector(".content h1"))?.focus({ preventScroll: true });
      }
      if (fromRefresh && document.activeElement === document.body) {
        // The held page's shell, and the Refresh button pressed in it, were replaced.
        (shell.refresh.isConnected ? shell.refresh : app.querySelector(".content h1"))?.focus({
          preventScroll: true,
        });
      }
    }
  }
}

// Static text only: a refused lookup never says whether the link expired or was denied.
const chatLinkFailures = {
  unavailable:
    "This Agent chat link could not be opened. It may have expired, or your access may not include its Agent.",
  interrupted: "This Agent chat link could not be opened. Try the link again.",
};

function showChatLinkFailure(view, failure) {
  if (Object.hasOwn(chatLinkFailures, failure ?? "")) {
    view.prepend(
      statusBlock("warning", null, chatLinkFailures[failure], [], {
        className: "unopened-chat-link",
        role: "status",
      }),
    );
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
  const pageActions = mountedViewState?.pageActions?.isConnected
    ? mountedViewState.pageActions
    : null;
  const activeElement = document.activeElement;
  const focused =
    view.contains(activeElement) || pageActions?.contains(activeElement) ? activeElement : null;
  const selection =
    typeof focused?.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  let checking = "session";
  // Block stale controls during admission without losing focus or an editor's caret on return.
  view.inert = true;
  if (pageActions) {
    pageActions.inert = true;
  }
  let clearStillChecking = null;
  const stillChecking = setTimeout(() => {
    if (isCurrent()) {
      clearStillChecking = showStillChecking();
    }
  }, stillCheckingDelayMs);
  try {
    const resolvedSession = await request("/api/auth/session");
    if (!isCurrent()) {
      return;
    }
    if (resolvedSession === null) {
      showExpiredLogin();
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
      namespaceUnavailablePanel(renderShell(current.feature, false, { page: null }).view);
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
      showExpiredLogin();
      return;
    }
    resetReads();
    if (checking !== "detail") {
      // Drafts survive an unavailable check, as in loadPage (finding 1935).
      clearPrivate();
      showAdmissionUnavailable(checking !== "session", error.status);
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
    clearTimeout(stillChecking);
    clearStillChecking?.();
    // A newer load may hold this same node on screen; only this check's lifetime releases it.
    if (view.isConnected && lifetime.isCurrent(active)) {
      view.inert = false;
      if (pageActions?.isConnected) {
        pageActions.inert = false;
      }
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
  if (openingAgentLoad !== null && lifetime.isCurrent(openingAgentLoad)) {
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

// Settings (UX spec 3.10): the signed-in account, and this session with Sign out. The session
// read carries no sign-in method, sign-in time or expiry, so the cards show only what it has.
function settingsView() {
  const { user } = session;
  return element(
    "div",
    { className: "settings-page" },
    element(
      "section",
      { className: "card" },
      element("h2", {}, "Signed-in account"),
      element(
        "div",
        { className: "settings-account" },
        element(
          "span",
          { className: "account-avatar account-avatar--lg", "aria-hidden": "true" },
          initials(user),
        ),
        element(
          "dl",
          { className: "settings" },
          // An account with no display name carries its email as the name; the email row
          // already says it (finding 2099).
          ...(user.name && user.name !== user.email
            ? [element("dt", {}, "Name"), element("dd", {}, user.name)]
            : []),
          element("dt", {}, "Email"),
          element("dd", {}, user.email),
        ),
      ),
    ),
    element(
      "section",
      { className: "card" },
      element("h2", {}, "Session"),
      button("Sign out", () => void logout(), {
        className: "settings-sign-out",
        "aria-describedby": "settings-sign-out-help",
      }),
      element(
        "p",
        { className: "hint", id: "settings-sign-out-help" },
        "Signing out ends this session on this device only.",
      ),
    ),
  );
}

// The shared session or Namespace read failed, so no private page can show. Once the session
// is confirmed, a refusal can be lasting (an account whose access was removed), and this panel
// has no account menu, so it offers Sign out beside Retry (finding 1894).
function showAdmissionUnavailable(sessionChecked, status) {
  if (!sessionChecked) {
    publicPanel(
      "Session unavailable",
      "Could not check your session. Try again.",
      "Retry",
      () => void loadPage(),
    );
    return;
  }
  publicPanel(
    status === 403 ? "No access" : "Namespace access unavailable",
    status === 403
      ? "Your account has no access to this Installation. Try again or sign out."
      : "Could not check Namespace access. Try again.",
    "Retry",
    () => void loadPage(),
    { label: "Sign out", action: () => void logout() },
  );
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
  rememberSignedIn(false);
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

// Phone bottom sheets stay above the on-screen keyboard (finding 1957).
trackVisualViewport();
window.addEventListener("popstate", () => {
  if (!loggingOut) {
    // Browser history can change Agent tabs while the mounted view is inert.
    // Recheck admission for the new route before exposing its cached panel.
    navigation.traverse({ fromNavigation: !resumePending, mountedUrl: mountedRouteKey });
  }
});
window.addEventListener("focus", resumePage);
document.addEventListener("visibilitychange", () => {
  resumePage();
});
// Drafts live only in this document, so a reload or tab close would lose unsaved editor work
// (finding 1902). It would also cut short a write in flight, such as the second of a share's
// two bindings (finding 2125).
window.addEventListener("beforeunload", (event) => {
  if (!loggingOut && (drafts.hasUnsaved() || writeInFlight?.())) {
    event.preventDefault();
    event.returnValue = "";
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
