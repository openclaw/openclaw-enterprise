import type { Static } from "typebox";
import type {
  AgentRead,
  Namespace,
  NamespaceCallerPermissionsResponse,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRecheck,
  ConsolePageContext,
  LeaveGuard,
  TabNavigation,
} from "./page-context.mjs";
import { renderOAuthClients } from "./oauth-clients.mjs";
import { renderConnectionTemplates } from "./connection-templates.mjs";
import { renderInstallationConfigurations } from "./driver-configurations.mjs";
import {
  element,
  button,
  requestIdDisclosure,
  setUnavailable,
  statusBlock,
  trackVisualViewport,
} from "./dom.mjs";
import {
  agentPageReadRefusal,
  clearResolvedSecretNames,
  noteConsoleLoad,
  renderAgentList,
  renderCreateAgent,
  renderAgentDetail,
} from "./agents.mjs";
import { clearRuntimeDenials, forgetRuntimeDenials } from "./agents/logs.mjs";
import {
  ASK_INSTALLATION_ADMINISTRATOR,
  askForGrant,
  NAMESPACE_UNAVAILABLE,
} from "./agents/access-reasons.mjs";
import {
  createApiClient,
  requestFailure,
  responseFields,
  type RequestOptions,
} from "./api-client.mjs";
import { createViewLifetime } from "./view-lifetime.mjs";
import {
  connectionTemplatesPage,
  oauthClientsPage,
  createNavigation,
  pages,
} from "./navigation.mjs";
import {
  brandContents,
  createShell,
  initials,
  NAMESPACE_ACCESS_REASON_ID,
  panel,
  sorted,
  type ShellState,
} from "./shell.mjs";
import { createDraftStore } from "./drafts.mjs";
import { renderRuntimeImages } from "./runtime-images.mjs";
import {
  NO_READABLE_NAMESPACES,
  renderNamespaces,
  type NamespacePageContext,
} from "./namespaces.mjs";
import { renderSecrets } from "./secrets.mjs";
import {
  passwordSignInFailure,
  providerCallbackFailure,
  providerExchangeFailure,
  providerIcon,
  providerStartFailure,
} from "./sign-in-presentation.mjs";

type Route = ReturnType<typeof route>;
type Intent = typeof validIntent extends (value: unknown) => value is infer Destination
  ? Destination
  : never;
type Page = keyof typeof pages;
type Shell = ReturnType<typeof shellUI.renderShell>;
// An Agent can render behind the startup status before there is a full shell.
type LoadingShell = Pick<Shell, "view" | "diagnostics"> & Partial<Shell>;
type Session = {
  user: { id: string; name: string; email: string };
  sessionKey: string;
};
type Provider = keyof typeof externalAttemptStorageKeys;
type LoginMessage = string | ((password: boolean) => string);
type NamespacePermissions = Static<typeof NamespaceCallerPermissionsResponse>["data"];
type InstallationAccess = { url: string | null; admin: boolean | null; settled: boolean };
type InstallationAccessProbe = { owner: string | null; answer?: Promise<InstallationAccess> };
type AdministrationMode = NonNullable<RequestOptions["installationAdministration"]>;

function hasKey<T extends object>(object: T, key: string | null): key is Extract<keyof T, string> {
  return key !== null && Object.hasOwn(object, key);
}

interface MountedView {
  active: number | null;
  view: HTMLDivElement;
  user: Session["user"];
  pending: number;
  mutations: number;
  reusable: boolean;
  reads: Map<string, string>;
  readablePaths: Set<string>;
  administrationReads: Map<string, AdministrationMode>;
  administrationEnded: Set<() => void>;
  rechecked: Set<(recheck: AgentRecheck) => void>;
  metaReads: Set<string>;
  resumeHandlers: Set<() => void>;
  revalidators: Set<() => Promise<unknown>>;
  resumeDrafts?: () => void;
  tabNavigation?: TabNavigation;
  leaveGuard?: LeaveGuard;
  writeInFlight?: () => boolean;
  agent?: AgentRead | null;
  pageActions?: HTMLElement;
  diagnostics?: Shell["diagnostics"];
}

interface RetainedView {
  owner: string;
  snapshot: HTMLDivElement;
  state: MountedView | null;
  title: string | null;
  scope: string | null;
  scrollY: number;
  returnHref: string | null;
}

const app = document.querySelector<HTMLElement>("#app")!;
app.querySelector(":scope > .startup-recovery")?.remove();
const lifetime = createViewLifetime();
let session: Session | null = null;
let namespaces: Namespace[] = [];
function setNamespaces(readable: readonly Namespace[]) {
  namespaces = sorted(readable);
}
let namespaceId: string | null = null;
let observabilityUrl: string | null = null;
// Set while the last Backends read was denied, so Retry and Refresh do not show the Namespace
// selector again before the same answer hides it (finding 1491).
let backendsDenied = false;
// Session owner whose Installation-admin answer has settled in this tab.
let observabilityOwner: string | null = null;
// The Installation-access probe still being answered, for the session owner that sent it.
let installationAccessProbe: InstallationAccessProbe | null = null;
// Whether that owner administers the Installation: true, false, or null when unknown.
let installationAdmin: boolean | null = null;
// Set once this page load knows that answer is still true; see administrationRead.
let administrationConfirmed = false;
// The Installation-administration read this page load is waiting on, while it runs.
let administrationCheck: Promise<void> | null = null;
const installationAccessStorageKey = "occ.console.installationAccess";
const deniedReadsStorageKey = "occ.console.deniedReads";
// Set once this tab has a session, until it signs out; see rememberSignedIn.
const signedInStorageKey = "occ.console.signedIn";
const deniedReadsLimit = 200;
let loggingOut = false;
let navigateAgentTab: TabNavigation | null | undefined = null;
// The shown page's refusal to leave through the Namespace selector, while a save is unsettled.
let leaveGuard: LeaveGuard | null = null;
// Whether the shown page has a write in flight that a reload or tab close would cut short.
let writeInFlight: (() => boolean) | null = null;
let discardCreationOnExit: { namespaceId: string | null } | null = null;
const drafts = createDraftStore();
let draftUserId: string | null = null;
// The session this tab signed in to or first observed; see api-client.mjs.
let pinnedSessionKey: string | null = null;
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
let pendingIntent: Intent | null = null;
// A retained view revalidates each read it made. A paged read keeps its cursor, so it compares
// data and meta, without the request ID that differs on every call.
function readSignature(result: unknown, includeMeta = false) {
  const { data, meta } = responseFields(result);
  return JSON.stringify(
    includeMeta ? { data, meta: { ...responseFields(meta), requestId: undefined } } : result,
  );
}

// A read the view shows as refused or missing (a member's native administration status, say) is
// that read's settled answer. A return compares it like data, so a view a member can read only in
// part is still reused, and a read refused since replaces its section (finding 1553).
function refusedRead(status: number) {
  // Never a JSON body's signature.
  return `\u0000refused ${status}`;
}

function isAccessRefusal(status: number | undefined) {
  return status === 400 || status === 403 || status === 404;
}

function settledRefusal(error: unknown): error is { status: 403 | 404 } {
  const { status } = requestFailure(error);
  return status === 403 || status === 404;
}

const externalProviders: Record<
  Provider,
  { label: string; origin: string | null; pathname: string | null }
> = {
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
function validOidcLabel(label: string) {
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
function configureOidc(signIn: unknown) {
  try {
    const { authorizationUrl, label } = responseFields(signIn);
    if (typeof authorizationUrl !== "string") {
      return false;
    }
    const endpoint = new URL(authorizationUrl);
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

// Only a tab that had a session says it expired; a first visit to a deep link, or one after
// signing out, just asks to sign in (finding 1893). The mark is in tab storage, so a reload
// after expiry still says it.
function rememberSignedIn(signedIn: boolean) {
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

function pinSessionKey(value: unknown) {
  pinnedSessionKey = typeof value === "string" && value.length > 0 ? value : null;
}

// The attemptId is per tab: another tab's provider callback cannot complete this tab's sign-in.
function rememberExternalAttempt(provider: Provider, attemptId: string) {
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
function rememberInstallationAccess(owner: string, admin: boolean | null, url: string | null) {
  try {
    sessionStorage.setItem(installationAccessStorageKey, JSON.stringify({ owner, admin, url }));
  } catch {
    // Without tab storage the next page load probes again.
  }
}

function recalledInstallationAccess(owner: string) {
  try {
    const stored = responseFields(
      JSON.parse(sessionStorage.getItem(installationAccessStorageKey) ?? "null"),
    );
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
function probeInstallationAccess(owner: string | null): Promise<InstallationAccess> {
  if (owner && installationAccessProbe?.owner === owner && installationAccessProbe.answer) {
    return installationAccessProbe.answer;
  }
  // A page load asks the permission answer first, so an earlier view's probe can settle while
  // that read runs: reuse its answer instead of sending (and auditing) the probe again.
  if (owner && observabilityOwner === owner) {
    return Promise.resolve({ url: observabilityUrl, admin: installationAdmin, settled: true });
  }
  const probe: InstallationAccessProbe = { owner };
  probe.answer = request("/observability", { outlivesView: true })
    .then(
      (data) => {
        const { url } = responseFields(data);
        return { url: typeof url === "string" ? url : null, admin: true, settled: true };
      },
      (error: unknown) => {
        const { status } = requestFailure(error);
        if (status === 401) {
          throw error;
        }
        const denied = status === 403;
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

// Whether the caller administers the Installation, for this page load. The observability read
// is the probe, and the API audits its 403 as an authorization denial, so the console first asks
// a readable Namespace's permission answer, whose `installation.administer` is the same IAM
// decision and audits nothing. Any readable Namespace gives that answer: it checks the
// Installation, not the Namespace. A caller it refuses is not probed (findings D45, 2620). That
// refusal is settled for this tab but not kept across reloads: a reload, or Refresh on the
// Backends refusal, asks again at no audited cost, so a grant reaches the console (finding
// 2622). An administrator is probed for the destination URL, which the API allows. Gating
// only: the API still authorizes every request. With no readable Namespace, or no answer, the
// console probes.
function installationAccess(
  owner: string | null,
  selectedRead: Promise<NamespacePermissions | null> | null,
) {
  const readableId = readableNamespaceId();
  const permissions =
    selectedRead && readableId !== null && readableId === namespaceId
      ? selectedRead
      : readableNamespacePermissions();
  return permissions.then((answer) =>
    answer?.installation?.administer === false
      ? { url: null, admin: false, settled: true }
      : probeInstallationAccess(owner),
  );
}

// The selected Namespace when readable, else the first readable one, else null.
function readableNamespaceId() {
  return namespaces.some((item) => item.id === namespaceId)
    ? namespaceId
    : (namespaces[0]?.id ?? null);
}

// A readable Namespace's permission answer, or null without one or when the read fails. Reading
// it audits nothing.
function readableNamespacePermissions(options = {}) {
  return namespacePermissionsRead(options).catch(() => null);
}

// The same answer, rejecting when the read fails, for a caller that must tell a failure (an
// unknown answer) from no readable Namespace.
// Only permissions routes return this response. Keep the server's data intact for retained reads.
function readNamespacePermissions(path: string, options?: RequestOptions) {
  return request(path, options) as Promise<NamespacePermissions>;
}

function namespacePermissionsRead(options?: RequestOptions): Promise<NamespacePermissions | null> {
  const readableId = readableNamespaceId();
  return readableId === null
    ? Promise.resolve(null)
    : readNamespacePermissions(
        `/namespaces/${encodeURIComponent(readableId)}/permissions`,
        options,
      );
}

function forgetInstallationAccess() {
  try {
    sessionStorage.removeItem(installationAccessStorageKey);
  } catch {
    // Nothing to clear without tab storage.
  }
}

// The caller does not administer the Installation: true for this tab, not kept across reloads,
// which ask the permission answer again at no audited cost. The Observability link goes away.
// A page built while the answer was another one is told, so it takes the new answer in place, as
// its Refresh would (finding D795), and the Namespace list is read again (finding 2917).
function settleNotAdministrator() {
  const ended = installationAdmin !== false;
  forgetInstallationAccess();
  observabilityUrl = null;
  installationAdmin = false;
  observabilityOwner = sessionOwnerKey(session);
  shellUI.dropAdministrationLinks();
  if (ended) {
    for (const handler of mountedViewState?.administrationEnded ?? []) {
      handler();
    }
    void rereadNamespacesAfterAdministration();
  }
}

// Refresh sharing asks again whether a caller this tab settled as no administrator administers
// the Installation. Administration granted again with the Agent page open left Refresh sharing
// refused unsent, the Access tab hidden and the page read-only until Refresh (finding 2943). The
// Namespace permission answer audits nothing; when it confirms administration, the settled answer
// is dropped, as Refresh drops it, and the policy reads are sent again. Any other answer, or none,
// keeps it. Gating only: the API still authorizes every read.
async function recheckAdministration() {
  if (installationAdmin !== false) {
    return;
  }
  const owner = sessionOwnerKey(session);
  let answer: NamespacePermissions | null;
  try {
    answer = await namespacePermissionsRead();
  } catch {
    return;
  }
  if (
    owner === null ||
    owner !== sessionOwnerKey(session) ||
    installationAdmin !== false ||
    answer?.installation?.administer !== true
  ) {
    return;
  }
  forgetInstallationAccess();
  observabilityOwner = null;
  installationAdmin = null;
  administrationConfirmed = true;
}

// An administrator reads every Namespace, so the selector of a page loaded under administration
// kept the Namespaces only administration could read until Refresh (finding 2917). Administration
// ending reads the list once more: a member may list Namespaces, so the read audits nothing. The
// selector keeps a Namespace still readable; a Namespace-scoped page whose Namespace is gone
// settles as a refocus finds it gone. A failed read keeps the list; Refresh reads it again. A page
// load in flight reads the list itself: the answer can settle after the page that asked was left,
// and a Backends refusal settles it within its own load.
async function rereadNamespacesAfterAdministration() {
  if (mountedRouteKey === null) {
    return;
  }
  const owner = sessionOwnerKey(session);
  const active = lifetime.capture();
  let readable: unknown;
  try {
    readable = await request("/namespaces");
  } catch {
    return;
  }
  if (
    !lifetime.isCurrent(active) ||
    owner === null ||
    owner !== sessionOwnerKey(session) ||
    !Array.isArray(readable)
  ) {
    return;
  }
  clearRetainedViewsOutsideNamespaces(readable);
  setNamespaces(readable);
  const current = route();
  if (
    ["agents", "secrets"].includes(current.feature) &&
    !namespaces.some((item) => item.id === namespaceId)
  ) {
    clearRetainedViewsForNamespace(namespaceId);
    resetReads();
    namespaceUnavailablePanel(renderShell(current.feature, false, { page: null }).view);
    return;
  }
  shellUI.updateNamespaces(namespaces);
}

// The refusal of a read only Installation administration may make, refused here without sending
// it: this tab already knows the caller does not administer the Installation.
function administrationRefusal() {
  return Object.assign(new Error("Your access does not include Installation administration."), {
    status: 403,
    code: "FORBIDDEN",
    notAdministrator: true,
  });
}

// Reads the console makes because it takes the caller for an Installation administrator (IAM
// policy lists and Driver configuration schemas, which need that administration; a Secret's
// metadata read by ID, which other grants may allow too), on an answer this tab settled earlier.
// An administrator revoked while signed in keeps that answer until one of them is refused, and the
// API audits each refusal: the Access tab, a bound Secret and Settings added six to the one
// Backends refusal (finding D760). So a page load sends them one at a time until one that needs
// administration succeeds. A refusal asks a readable Namespace's permission answer, which audits
// nothing, because a Restriction can refuse one read to an administrator; unless it confirms
// administration, the refusal settles "not an administrator" for this tab, as a Backends refusal
// does (finding 2627), and the reads still waiting are refused here, unsent. A failed answer
// settles nothing (finding 2637). A probe answered in this page load already confirms the answer.
// Administration can also end while the page is open, after a read confirmed it: a revoked
// administrator's Access tab recheck was refused, and then Credentials sent two more IAM reads
// the API refused and audited (finding D792). So a refusal after confirmation is checked the same
// way, and the reads after it wait for that answer. Refresh on the Agent page asks again, so
// access that returns is used again.
// Gating only: the API still authorizes every read.
function administrationRead(path: string, options: RequestOptions): Promise<unknown> {
  if (installationAdmin === false) {
    return Promise.reject(administrationRefusal());
  }
  if (administrationConfirmed) {
    const owner = sessionOwnerKey(session);
    return sendRequest(path, options).catch(async (error: unknown) => {
      if (requestFailure(error).status === 403) {
        // The first refusal starts the check; refusals of reads sent alongside it wait for it.
        if (administrationConfirmed) {
          administrationConfirmed = false;
          trackAdministrationCheck(settleAdministrationRefusal(error, owner));
        }
        await administrationCheck;
        if (installationAdmin === false) {
          responseFields(error).notAdministrator = true;
        }
      }
      throw error;
    });
  }
  if (administrationCheck) {
    // A read waiting behind the check belongs to this page: leaving it or signing out aborts the
    // check's read, which settles nothing, so the waiter is aborted too instead of being sent
    // under the next page (finding 2643).
    const pageReads = lifetime.signal;
    return administrationCheck.then(() => {
      pageReads.throwIfAborted();
      return administrationRead(path, options);
    });
  }
  const owner = sessionOwnerKey(session);
  const read = sendRequest(path, options);
  const check = read.then(
    () => {
      if (options.installationAdministration === "required") {
        administrationConfirmed = true;
      }
    },
    (error: unknown) => settleAdministrationRefusal(error, owner),
  );
  trackAdministrationCheck(check);
  return check.then(() => read);
}

function trackAdministrationCheck(check: Promise<void>) {
  administrationCheck = check;
  void check.then(() => {
    if (administrationCheck === check) {
      administrationCheck = null;
    }
  });
}

// What a refused read that took the caller for an Installation administrator says, asked of a
// readable Namespace's permission answer (see administrationRead). Never rejects.
async function settleAdministrationRefusal(error: unknown, owner: string | null) {
  if (requestFailure(error).status !== 403) {
    return;
  }
  let answer: NamespacePermissions | null;
  try {
    answer = await namespacePermissionsRead({ outlivesView: true });
  } catch {
    // No answer (a network failure or a 5xx) is unknown, not a refusal: an administrator
    // whose read a Restriction refused keeps that answer, and the next page load asks again
    // (finding 2637).
    return;
  }
  if (owner === null || owner !== sessionOwnerKey(session)) {
    return;
  }
  if (answer?.installation?.administer === true) {
    administrationConfirmed = true;
  } else {
    settleNotAdministrator();
    responseFields(error).notAdministrator = true;
  }
}

// Agent detail reads that the viewer's grants may not allow (saved settings, native admin
// status) return 403, which the API audits as an authorization denial. This tab remembers
// each denied API path for the same session owner so reloads and revisits do not add a
// denial per view. The first denial is always requested and audited; views offer Retry,
// which forgets the path and asks again. Paths hold resource IDs only, never credentials.
function storedDeniedReads(owner: string): string[] {
  try {
    const stored = responseFields(
      JSON.parse(sessionStorage.getItem(deniedReadsStorageKey) ?? "null"),
    );
    if (
      stored?.owner === owner &&
      Array.isArray(stored.paths) &&
      stored.paths.every((path: unknown) => typeof path === "string")
    ) {
      return stored.paths;
    }
  } catch {
    // Unreadable tab storage asks again.
  }
  return [];
}

function storeDeniedReads(owner: string, paths: readonly string[]) {
  try {
    sessionStorage.setItem(
      deniedReadsStorageKey,
      JSON.stringify({ owner, paths: paths.slice(-deniedReadsLimit) }),
    );
  } catch {
    // Without tab storage the next view asks again.
  }
}

function deniedReadsFor(owner: string | null) {
  return {
    has: (path: string) => !!owner && storedDeniedReads(owner).includes(path),
    remember(path: string) {
      if (owner) {
        storeDeniedReads(owner, [
          ...storedDeniedReads(owner).filter((item) => item !== path),
          path,
        ]);
      }
    },
    forget(path: string) {
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

// Refresh checks an Agent's version reads again: a version panel offers no Retry for a refusal
// (finding D753), so Refresh is how a reader granted read since then sees the version.
function forgetAgentRevisionDenials(owner: string | null, namespaceId: string, agentId: string) {
  if (!owner) {
    return;
  }
  const prefix = `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}/revisions/`;
  const paths = storedDeniedReads(owner);
  const kept = paths.filter((path) => !path.startsWith(prefix));
  if (kept.length !== paths.length) {
    storeDeniedReads(owner, kept);
  }
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
  let pendingAttempt: { provider: Provider; attemptId: string } | null = null;
  for (const [provider, key] of Object.entries(externalAttemptStorageKeys)) {
    try {
      const attemptId = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (
        pendingAttempt === null &&
        hasKey(externalAttemptStorageKeys, provider) &&
        attemptId !== null &&
        bindingValue.test(attemptId)
      ) {
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

function rememberLoginIntent(intent: Intent | null, attemptId: string) {
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

function takeLoginIntent(attemptId: string | undefined) {
  let stored: Record<string, unknown> = {};
  try {
    stored = responseFields(JSON.parse(sessionStorage.getItem(loginIntentStorageKey) ?? "null"));
  } catch {
    // Invalid or unavailable storage cannot supply a destination.
  }
  forgetLoginIntent();
  const age = Date.now() - Number(stored.time);
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
function takeNativeFragment(current: Route) {
  if (
    (current.url.pathname !== "/console" && current.url.pathname !== "/console/") ||
    !current.url.hash
  ) {
    return null;
  }
  const match = /^#native-agent=([0-9a-f]{32})$/.exec(current.url.hash);
  replaceUrl(current.url.pathname + current.url.search);
  return match?.[1] === undefined ? null : { kind: "native" as const, key: match[1] };
}

// An Agent page's Secret link (finding D757) opens that Secret on the Secrets page once. Drop the
// parameter in place before the page loads, so the header's Refresh does not reopen it, and keep
// the Secret until the Secrets page shows it or says it is unlisted: a load that ends at sign-in,
// an expired session or a failed load's Retry still opens it (finding 2645). Another navigation
// forgets it.
let linkedSecret: { id: string; namespace: string | null } | null = null;

function takeLinkedSecret(fromNavigation: boolean) {
  const { url } = route();
  const secretId = url.searchParams.get("secret");
  const namespace = url.searchParams.get("namespace");
  if (url.pathname !== "/console/secrets") {
    linkedSecret = null;
  } else if (secretId !== null) {
    url.searchParams.delete("secret");
    replaceUrl(url.pathname + url.search);
    linkedSecret = { id: secretId, namespace };
  } else if (fromNavigation || linkedSecret?.namespace !== namespace) {
    linkedSecret = null;
  }
  return linkedSecret?.id ?? null;
}

// The sign-in destination for a page: its route, with a Secrets page link's Secret not yet shown.
function loginDestination(current: Route) {
  const url = new URL(pageUrl(current.target, current.namespace), location.origin);
  if (current.feature === "secrets" && linkedSecret?.namespace === current.namespace) {
    url.searchParams.set("secret", linkedSecret.id);
  }
  return captureIntent(url.pathname + url.search);
}

const shellUI = createShell({ app, pages, route, pageUrl, navigate, loadPage, logout });
shellUI.setLeaveGuard((options) => Boolean(leaveGuard?.(options)));
const { publicPanel, renderRows, switchNamespace } = shellUI;

// The page names a Namespace the reader cannot read. Switch Namespace focuses the header's
// selector, which is disabled when no Namespace is readable (a member whose only grant was
// revoked, on a bookmarked link), so the panel then points at the header's Refresh, as the
// no-readable-Namespace panel does (findings 2371, 2393).
function namespaceUnavailablePanel(view: HTMLElement) {
  // Deleted, never shared and no longer shared read alike: one sentence for every page (D753).
  const why = NAMESPACE_UNAVAILABLE;
  if (namespaces.length) {
    panel(
      view,
      "Namespace unavailable",
      `${why}. Choose another Namespace.`,
      "Switch Namespace",
      () => switchNamespace(),
    );
    return;
  }
  namespaceAccessPanel(
    view,
    "Namespace unavailable",
    `${why}, and you cannot read any other Namespace. Ask an Installation administrator to give you access to one, then Refresh.`,
  );
}

// A panel for a reader with no Namespace to select: its sentence describes the header's disabled
// selector (finding D749).
function namespaceAccessPanel(view: HTMLElement, title: string, description: string) {
  panel(view, title, description);
  view.querySelector(".state-panel > p")?.setAttribute("id", NAMESPACE_ACCESS_REASON_ID);
  shellUI.describeNamespaceSelector();
}
const sendRequest = createApiClient({
  lifetime,
  hasSession: () => session !== null,
  onExpired: () => showExpiredLogin(),
  sessionKey: () => pinnedSessionKey,
});

function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  return options.installationAdministration
    ? administrationRead(path, options)
    : sendRequest(path, options);
}
const retainedViews = new Map<string, RetainedView>();
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
let mountedRouteKey: string | null = null;
// The page whose shell is on screen. A held page keeps its own navigation and header.
let shownFeature: string | null = null;
// The shown header's page: an Agent's ({ agentId }), Create Agent ({ creating: true }) or null.
let shownPage: Exclude<ShellState["page"], undefined> = null;
let mountedAgent: AgentRead | null | undefined = null;
let mountedViewState: MountedView | null = null;
let resumePending: Promise<void> | null = null;
// Keep the opening panel and its way back until the Agent overview is ready. This load is
// itself the access check, so refocusing the window waits for it (findings 1460, 1516).
let openingAgentLoad: number | null = null;

// Only null confirms a signed-out session. A malformed reply cannot admit private reads.
async function readSession(): Promise<Session | null> {
  const result = await request("/api/auth/session");
  if (result === null) {
    return null;
  }
  const { authenticated, sessionKey, user } = responseFields(result);
  const { id, email, name } = responseFields(user);
  if (
    authenticated !== true ||
    !isNonEmptyString(sessionKey) ||
    !isNonEmptyString(id) ||
    !isNonEmptyString(email) ||
    !isNonEmptyString(name)
  ) {
    throw new Error("Invalid session response");
  }
  return { sessionKey, user: { id, email, name } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sessionOwnerKey(value: Session | null) {
  const userId = value?.user?.id;
  const sessionKey = value?.sessionKey;
  return typeof userId === "string" &&
    userId.length > 0 &&
    typeof sessionKey === "string" &&
    sessionKey.length > 0
    ? JSON.stringify([userId, sessionKey])
    : null;
}

function routeKey(current: Route, selection = current.namespace ?? namespaceId) {
  if (!Object.hasOwn(pages, current.feature)) {
    return null;
  }
  return pageUrl(current.target, selection);
}

function clearRetainedViews() {
  retainedViews.clear();
  mountedRouteKey = null;
}

function retainedViewNamespace(key: string) {
  return new URL(key, location.origin).searchParams.get("namespace");
}

function clearRetainedViewsForNamespace(selection: string | null) {
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

function clearRetainedViewsOutsideNamespaces(readable: readonly Namespace[]) {
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
  document
    .querySelectorAll<HTMLInputElement>('input[type="password"], [data-secret-value]')
    .forEach((input) => {
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

function retainMountedView(returnLink: Element | null) {
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
      mountedViewState?.reusable && mountedViewState.pending === 0
        ? view
        : (view.cloneNode(true) as HTMLDivElement),
    state: mountedViewState?.reusable && mountedViewState.pending === 0 ? mountedViewState : null,
    title: app.querySelector<HTMLHeadingElement>(".content h1")?.textContent ?? null,
    scope: app.querySelector(".content .scope")?.textContent ?? null,
    scrollY: window.scrollY,
    returnHref:
      returnLink instanceof HTMLAnchorElement && view.contains(returnLink) ? returnLink.href : null,
  });
  while (retainedViews.size > 16) {
    retainedViews.delete(retainedViews.keys().next().value!);
  }
  mountedRouteKey = null;
}

// Finds the destination's retained view without removing it. The load forgets it only once it
// mounts or replaces the view; a load abandoned before then (Forward during a return's
// recheck, say) leaves it for the next return (finding 1441).
function peekRetainedView(current: Route) {
  const owner = sessionOwnerKey(session);
  const key = routeKey(current);
  const retained = key && retainedViews.get(key);
  if (!owner || !retained || retained.owner !== owner) {
    return null;
  }
  return { key, retained };
}

function forgetRetainedView(taken: ReturnType<typeof peekRetainedView>) {
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
function holdShownView(current: Route, { busyCue = true, keepFocus = false } = {}) {
  const view = app.querySelector<HTMLDivElement>('.content [aria-live="polite"]');
  if (!view) {
    return null;
  }
  const focused = document.activeElement;
  const title = app.querySelector<HTMLHeadingElement>(".content h1")?.textContent;
  const scope = app.querySelector(".content .scope")?.textContent;
  const diagnostics = app.querySelector<NonNullable<Shell["diagnostics"]>>(".runtime-debug");
  const scrollY = window.scrollY;
  const recovery = app.querySelector(".content > .namespace-recovery, .content > p.scope") !== null;
  // An Agent page's own header actions (Create new version) stay with it, inert like the page.
  const pageActions = app.querySelector<HTMLElement>(".content .page-header .page-view-actions");
  const focusHeld =
    keepFocus &&
    (view.contains(focused) ||
      pageActions?.contains(focused) === true ||
      focused === app.querySelector<HTMLHeadingElement>(".content h1") ||
      app.querySelector(".sidebar")?.contains(focused) === true);
  const shell = renderShell(shownFeature ?? current.feature, true, {
    recovery,
    page: shownFeature ? shownPage : headerPage(current),
  });
  if (title) {
    app.querySelector<HTMLHeadingElement>(".content h1")!.textContent = title;
  }
  if (scope) {
    app.querySelector<HTMLElement>(".content .scope")!.textContent = scope;
  }
  view.inert = true;
  view.setAttribute("aria-busy", "true");
  if (pageActions) {
    pageActions.inert = true;
    shell.actions.append(pageActions);
  }
  // Navigation dims the held page after a moment (finding 1447); a refocus recheck keeps its
  // look. The class lives on this load's shell, so the next shell drops it.
  app.querySelector<HTMLElement>(".content")!.classList.toggle("holding", busyCue);
  shell.view.replaceWith(view);
  shell.view = view;
  if (shell.diagnostics && diagnostics) {
    diagnostics.inert = true;
    shell.diagnostics.replaceWith(diagnostics);
    shell.diagnostics = diagnostics;
  }
  window.scrollTo({ top: scrollY, left: 0 });
  if (focusHeld) {
    app.querySelector<HTMLHeadingElement>(".content h1")!.focus({ preventScroll: true });
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
// (finding 1662). A recheck that rebuilds the page instead gives focus to the control that
// carries the same data-refocus-key, such as an Agents list row's name or icon (finding D814).
// When that control is gone or natively disabled, such as Stop on a row whose Agent another
// person stopped before a version was selected, focus goes to the control its
// data-refocus-fallback names (the row's name), and when the row is gone too, to the page
// heading, not to the body (finding 2967).
function focusInShownView() {
  const view = app.querySelector<HTMLDivElement>('.content [aria-live="polite"]');
  const focused = document.activeElement;
  const inView = view?.contains(focused) === true;
  const shellControl = !inView && focused?.closest?.(".shell") != null;
  if (
    (!(focused instanceof HTMLElement) && !(focused instanceof SVGElement)) ||
    (!inView && !shellControl)
  ) {
    return null;
  }
  const href =
    (focused instanceof HTMLAnchorElement ? focused.href : undefined) ??
    focused.dataset.returnFocusHref ??
    null;
  const key = inView ? (focused.dataset?.refocusKey ?? null) : null;
  const fallbackKey = key ? (focused.dataset.refocusFallback ?? null) : null;
  return {
    restore(remounted: HTMLElement, { rebuilt = false } = {}) {
      if (!document.hasFocus() || document.activeElement !== document.body) {
        return;
      }
      const keyed = (wanted: string | null) =>
        wanted
          ? Array.from(
              remounted.querySelectorAll<HTMLElement & { disabled?: boolean }>(
                "[data-refocus-key]",
              ),
            ).find((item) => item.dataset.refocusKey === wanted && !item.disabled)
          : undefined;
      const target = rebuilt
        ? key &&
          (keyed(key) ?? keyed(fallbackKey) ?? app.querySelector<HTMLHeadingElement>(".content h1"))
        : shellControl
          ? shellUI.matchingControl(focused)
          : remounted.contains(focused)
            ? focused
            : href &&
              Array.from(remounted.querySelectorAll<HTMLElement>("[data-return-focus-href]")).find(
                (item) => item.dataset.returnFocusHref === href,
              );
      if (!target) {
        return;
      }
      target.focus({ preventScroll: true });
      // A rebuilt row can be taller than the one it replaces: a reread that finds the Agent
      // deleting adds its badge above the row's icons. The restored icon then sat cut off at the
      // viewport's bottom with its row note below the fold (finding 2976). Keep the control's
      // area (the cell with its note) in view, moving the page only as far as that needs.
      if (rebuilt && target.dataset.refocusKey !== undefined) {
        (target.closest("[data-refocus-area]") ?? target).scrollIntoView({ block: "nearest" });
      }
    },
  };
}

// Mounts a retained view that revalidated unchanged, active at once.
function mountRetainedView(current: Route, retained: RetainedView) {
  const shell = renderShell(current.feature, false);
  if (retained.title) {
    app.querySelector<HTMLHeadingElement>(".content h1")!.textContent = retained.title;
  }
  if (retained.scope) {
    app.querySelector<HTMLElement>(".content .scope")!.textContent = retained.scope;
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

function markMountedRoute(current: Route) {
  mountedRouteKey = routeKey(current);
}

function resetReads({
  retainView = false,
  returnLink = null,
}: { retainView?: boolean; returnLink?: Element | null } = {}) {
  const resumeDrafts = drafts.suspend();
  if (mountedViewState) {
    mountedViewState.resumeDrafts = resumeDrafts;
    mountedViewState.active = null;
  }
  navigateAgentTab = null;
  leaveGuard = null;
  writeInFlight = null;
  mountedAgent = null;
  // Each page load confirms Installation administration again before its reads that need it.
  administrationConfirmed = false;
  administrationCheck = null;
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
function headerPage(current: Route): NonNullable<ShellState["page"]> | null {
  if (current.feature !== "agents") {
    return null;
  }
  if (current.creating) {
    return { creating: true };
  }
  return current.agentId ? { agentId: current.agentId } : null;
}

function collectionPath(feature: string, namespacePath: string | null) {
  if (feature === "namespaces") {
    return "/namespaces";
  }
  if (feature === "backends") {
    return "/backends";
  }
  return namespacePath !== null && ["secrets", "agents"].includes(feature)
    ? `${namespacePath}/${feature}`
    : null;
}

function renderShell(
  feature: string,
  namespaceAdmissionPending = false,
  { recovery = true, page = headerPage(route()) }: Pick<ShellState, "page" | "recovery"> = {},
) {
  shownFeature = feature;
  shownPage = page;
  const shell = shellUI.renderShell(feature as Page, {
    session,
    namespaces,
    namespaceId,
    observabilityUrl,
    namespaceAdmissionPending,
    installationAdmin: installationAdmin === true,
    recovery,
    page,
  });
  if (feature === "backends" && backendsDenied && shell.scopeSelector) {
    shell.scopeSelector.hidden = true;
  }
  return shell;
}

function renderPendingNamespaceShell(feature: string) {
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
  const destination = pendingIntent ?? loginDestination(current);
  showLogin("Your session has expired.", destination);
}

function showLogin(message: LoginMessage = "", destination: Intent | null = null) {
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
  const providerButton = (provider: Provider) => {
    const { label, origin, pathname } = externalProviders[provider];
    const control = button(`Continue with ${label}`, async () => {
      if (pending) {
        return;
      }
      pending = true;
      setButtonsUnavailable(true);
      feedback.textContent = "";
      try {
        const result = await request(`/api/auth/providers/${provider}/start`, { method: "POST" });
        if (!lifetime.isCurrent(loginView)) {
          return;
        }
        const { url, attemptId } = responseFields(result);
        const authorization = new URL(typeof url === "string" ? url : "");
        if (
          origin === null ||
          authorization.origin !== origin ||
          authorization.pathname !== pathname ||
          (externalSessionBinding &&
            (typeof attemptId !== "string" || !bindingValue.test(attemptId)))
        ) {
          throw new Error("Invalid authorization URL");
        }
        if (externalSessionBinding && typeof attemptId === "string") {
          rememberExternalAttempt(provider, attemptId);
          rememberLoginIntent(destination, attemptId);
        }
        location.assign(authorization.href);
      } catch (error) {
        if (!lifetime.isCurrent(loginView)) {
          return;
        }
        feedback.textContent = providerStartFailure(error, label, recoveryOnly);
        pending = false;
        setButtonsUnavailable(false);
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
  let oidc: HTMLButtonElement | null = null;
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
  function setButtonsUnavailable(unavailable: boolean) {
    setUnavailable(submit, unavailable, null);
    setUnavailable(github, unavailable, null);
    setUnavailable(google, unavailable, null);
    if (oidc !== null) {
      setUnavailable(oidc, unavailable, null);
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
    setButtonsUnavailable(true);
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
      pinSessionKey(responseFields(signedIn).sessionKey);
      password.value = "";
      pendingIntent = destination;
      replaceUrl("/console/agents");
      await loadPage();
    } catch (error) {
      if (!lifetime.isCurrent(active)) {
        return;
      }
      feedback.textContent = passwordSignInFailure(error, recoveryOnly);
    } finally {
      if (lifetime.isCurrent(active)) {
        pending = false;
        setButtonsUnavailable(false);
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
    .then((data) => {
      const available = responseFields(data);
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
          setUnavailable(oidc, pending, null);
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
          if (
            !pending &&
            username.value === "" &&
            password.value === "" &&
            !form.contains(document.activeElement)
          ) {
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
  const revision =
    document.querySelector<HTMLMetaElement>('meta[name="occ-build-revision"]')?.content ?? "";
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
  const first = app.firstElementChild;
  const shown = first instanceof HTMLElement && first.classList.contains("startup") ? first : null;
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
}: {
  fromNavigation?: boolean;
  reuseView?: boolean;
  fromRefresh?: boolean;
  restoreHistory?: ((url: string) => void) | null;
  openingAgent?: boolean;
  chatLinkFailure?: keyof typeof chatLinkFailures | null;
} = {}) {
  noteConsoleLoad();
  if (loggingOut) {
    return;
  }
  // A refocus or visibility recheck of the shown page, as opposed to a navigation.
  const resumingView = reuseView && !fromNavigation;
  const linkedSecretId = takeLinkedSecret(fromNavigation);
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
    (restoreHistory ?? replaceUrl)(mountedRouteKey!);
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
    discardCreationOnExit !== null &&
    (!current.creating || current.namespace !== discardCreationOnExit.namespaceId)
      ? discardCreationOnExit
      : null;
  const previousMountedRouteKey = mountedRouteKey;
  // Save/reload actions navigate to the current URL to discard the editor.
  if (fromNavigation && previousMountedRouteKey === routeKey(current)) {
    reuseView = false;
  }
  namespaceId = current.namespace;
  if (
    fromRefresh &&
    (current.feature === "backends" || current.agentId) &&
    installationAdmin === false
  ) {
    // Refresh on the Backends refusal checks Installation administration again instead of
    // reusing the settled answer (finding 2622): a permission answer, or one probe without one.
    // So does an Agent page's, whose Access tab and administrator-only reads a refusal there
    // turned off while the page was open (finding D792).
    forgetInstallationAccess();
    observabilityOwner = null;
    installationAdmin = null;
  }
  if (fromRefresh && current.agentId && current.namespace) {
    // Refresh checks access again: an Agent's Logs view asks again instead of reusing a denial
    // remembered earlier in this sign-in (finding 2566).
    forgetRuntimeDenials(current.namespace, current.agentId);
    forgetAgentRevisionDenials(sessionOwnerKey(session), current.namespace, current.agentId);
  }
  const active = resetReads({
    retainView: knownPrivateState,
    // A Namespaces row link marks itself too, so Back returns focus to that row.
    returnLink:
      openingAgent || document.activeElement?.matches?.("a[data-return-focus-href]")
        ? document.activeElement
        : null,
  });
  if (abandonedCreation) {
    const creationDrafts = drafts.scope(abandonedCreation.namespaceId, "create");
    creationDrafts.forget("create");
    creationDrafts.forget("channels");
    retainedViews.delete(previousMountedRouteKey!);
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
  let shell: LoadingShell | null =
    knownPrivateState && !openingAgent
      ? holdShownView(current, { busyCue: !resumingView, keepFocus: !resumingView })
      : null;
  let held = shell !== null;
  // The stand-in's heading while it holds focus for the page loading behind it.
  let heldHeading =
    held &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement === app.querySelector<HTMLHeadingElement>(".content h1")
      ? document.activeElement
      : null;
  let agentReturnHref: string | null = null;
  // Gives a refocus its reader's place back once the reused view's shell is usable.
  let restoreRefocus: (() => void) | null = null;
  let pendingAgentHeading: HTMLHeadingElement | null = null;
  let focusAgentResult = false;
  // The page kept on screen while an Agent's overview renders behind it, and the Agent's title
  // until it reveals (findings 1516, 1526).
  let shownStandIn: { view: HTMLElement } | null = null;
  let standInTitle: string | null = null;
  // The shell that says it is checking Namespace access, while it is the one shown.
  let pendingNamespaceShell: Shell | null = null;
  // When the loading delay put a loading page on screen (performance.now()), or null.
  let loadingShownAt: number | null = null;
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
  const backToAgents = (event: MouseEvent) => {
    (event.currentTarget as HTMLButtonElement).setAttribute("aria-disabled", "true");
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
    pendingAgentHeading = app.querySelector<HTMLHeadingElement>(".content h1")!;
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
              heldHeading = headingFocused
                ? app.querySelector<HTMLHeadingElement>(".content h1")
                : null;
              heldHeading?.focus({ preventScroll: true });
            };
            if (!accessResolved) {
              shell = pendingNamespaceShell = renderPendingNamespaceShell(current.feature);
              keepHeadingFocus();
              return;
            }
            // An Agent page rendering hidden behind the startup status keeps rendering behind
            // the loading page that now stands in for it (finding 1537).
            const behind = shownStandIn ? shell!.view : null;
            shell = renderShell(current.feature, false);
            panel(
              shell.view,
              "Loading…",
              current.agentId
                ? "Reading this Agent."
                : `Reading ${pages[current.feature as Page].toLowerCase()}.`,
            );
            if (behind) {
              shownStandIn = shell;
              shell.view.after(behind);
              shell = { ...shell, view: behind, diagnostics: null };
            }
            keepHeadingFocus();
          }, loadingDelay);
  const stopLoadingTimer = () => {
    clearTimeout(loadingTimer ?? undefined);
    loadingTimer = null;
  };
  const authError = current.url.searchParams.get("authError");
  const providerError = hasKey(externalProviders, authError) ? externalProviders[authError] : null;
  const authReason = current.url.searchParams.get("authReason");
  const externalAttempt = takeExternalAttempt();
  const externalIntent = takeLoginIntent(externalAttempt?.attemptId);
  if (externalAttempt !== null && providerError === null) {
    // Adopt only the session this tab's own provider attempt created.
    try {
      const confirmed = responseFields(
        await request(`/api/auth/providers/${externalAttempt.provider}/result`, {
          method: "POST",
          body: { attemptId: externalAttempt.attemptId },
        }),
      );
      if (!lifetime.isCurrent(active)) {
        return;
      }
      if (typeof confirmed?.sessionKey !== "string" || confirmed.sessionKey.length === 0) {
        throw new Error("Missing session binding");
      }
      pinSessionKey(confirmed.sessionKey);
      pendingIntent = externalIntent;
    } catch (error) {
      if (lifetime.isCurrent(active)) {
        showLogin(
          providerExchangeFailure(error, externalProviders[externalAttempt.provider].label),
        );
      }
      return;
    }
  }
  try {
    // A pinned key alone covers a provider exchange that confirmed a session now missing.
    const hadSession = session !== null || pinnedSessionKey !== null || recalledSignedIn();
    const previousOwner = sessionOwnerKey(session);
    const resolvedSession = await readSession();
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
          : (pendingIntent ?? loginDestination(current));
      showLogin(
        providerError !== null
          ? providerCallbackFailure(authError, providerError.label, authReason)
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
      let failure: keyof typeof chatLinkFailures | null = null;
      try {
        const resolved = responseFields(await request(`/native-admin/return/${destination.key}`));
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
        failure = isAccessRefusal(requestFailure(error).status) ? "unavailable" : "interrupted";
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
    // A settled Installation-access answer is kept once per session owner (see
    // installationAccess below for how it is asked).
    const recalled =
      owner && observabilityOwner !== owner ? recalledInstallationAccess(owner) : null;
    const readable = await request("/namespaces");
    if (!lifetime.isCurrent(active)) {
      return;
    }
    if (!Array.isArray(readable)) {
      throw new Error("Invalid collection response");
    }
    clearRetainedViewsOutsideNamespaces(readable);
    setNamespaces(readable);
    accessResolved = true;
    if (recalled) {
      observabilityUrl = recalled.url;
      installationAdmin = recalled.admin;
      observabilityOwner = owner;
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
    const selectedNamespace = namespaceId;
    const namespacePath =
      selectedNamespace === null ? null : `/namespaces/${encodeURIComponent(selectedNamespace)}`;
    const scopedNamespaceUnavailable =
      ["agents", "secrets"].includes(current.feature) &&
      (namespacePath === null || !namespaces.some((item) => item.id === selectedNamespace));
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
    let firstItems: unknown = null;
    let firstAgent: AgentRead | null = null;
    // The Agents and Secrets lists, and Create Agent, paint with the caller's permission answer,
    // never enabled and then refused (findings 1517, 1521, 2365). Gating only: the API still
    // authorizes creation, so an unknown answer (a failed read) keeps the controls.
    const permissionsPath = namespacePath === null ? null : `${namespacePath}/permissions`;
    const agentPath =
      namespacePath !== null && current.agentId
        ? `${namespacePath}/agents/${encodeURIComponent(current.agentId)}`
        : null;
    const itemsPath = collectionPath(current.feature, namespacePath);
    const permissionsRead =
      !scopedNamespaceUnavailable &&
      permissionsPath !== null &&
      ["agents", "secrets"].includes(current.feature) &&
      !current.agentId
        ? readNamespacePermissions(permissionsPath).catch(() => null)
        : null;
    const accessRead =
      owner && observabilityOwner === owner ? null : installationAccess(owner, permissionsRead);
    // Awaited after the first reads; a first read that fails first leaves it unawaited.
    accessRead?.catch(() => {});
    let firstPermissions: NamespacePermissions | null = null;
    if (!scopedNamespaceUnavailable && current.feature !== "settings" && !current.creating) {
      if (agentPath !== null) {
        firstAgent = (await request(agentPath)) as AgentRead;
      } else if (itemsPath !== null) {
        if (current.feature === "backends") {
          // Backends need Installation administration, like the probe. A caller this load knows
          // is no administrator gets the refusal without the read, which the API would audit as
          // a denial nobody attempted (finding 2619). Gating only: an unknown answer reads.
          if (accessRead) {
            const access = await accessRead;
            if (!lifetime.isCurrent(active)) {
              return;
            }
            observabilityUrl = access.url;
            installationAdmin = access.admin;
            observabilityOwner = access.settled ? owner : null;
            administrationConfirmed = access.admin === true;
          }
          if (installationAdmin === false) {
            throw Object.assign(new Error("Access denied."), { status: 403, code: "FORBIDDEN" });
          }
        }
        firstItems = current.feature === "namespaces" ? namespaces : await request(itemsPath);
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
    if (accessRead) {
      const access = await accessRead;
      if (!lifetime.isCurrent(active)) {
        return;
      }
      observabilityUrl = access.url;
      installationAdmin = access.admin;
      observabilityOwner = access.settled ? owner : null;
      administrationConfirmed = access.admin === true;
    }
    const retainedState = retainedView?.state;
    let unchanged = false;
    if (retained && reuseView && retainedState && !scopedNamespaceUnavailable) {
      const fresh = new Map<string, unknown>([["/namespaces", namespaces]]);
      if (firstAgent && agentPath !== null) {
        fresh.set(agentPath, firstAgent);
      } else if (firstItems && itemsPath !== null && current.feature !== "namespaces") {
        fresh.set(itemsPath, firstItems);
      }
      if (firstPermissions !== null && permissionsPath !== null) {
        fresh.set(permissionsPath, firstPermissions);
      }
      const refused = new Map<string, number>();
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
          // An administration read keeps its gate: once this tab knows the caller does not
          // administer the Installation, it is refused here, unsent (finding 2636).
          try {
            const mode = retainedState.administrationReads.get(path);
            fresh.set(
              path,
              await request(path, {
                includeMeta: retainedState.metaReads.has(path),
                ...(mode === undefined ? {} : { installationAdministration: mode }),
              }),
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
        [...retainedState.reads].every(([path, value]) => {
          const refusal = refused.get(path);
          return (
            (refusal === undefined
              ? readSignature(fresh.get(path), retainedState.metaReads.has(path))
              : refusedRead(refusal)) === value
          );
        });
    }
    // Resolve the old link in the admitted list, even if its row reads were unfinished and we
    // must rebuild it. Capture focus before replacing the shell, not after it falls back to body
    // (or leaves the held heading).
    if (
      retained &&
      retainedView &&
      reuseView &&
      !scopedNamespaceUnavailable &&
      (document.activeElement === document.body ||
        (heldHeading !== null && document.activeElement === heldHeading))
    ) {
      agentReturnHref = retainedView.returnHref;
    }
    // Move focus to the Agent's heading only if the opening heading still owns it.
    focusAgentResult = document.activeElement === pendingAgentHeading;
    if (unchanged && retainedView && retainedState) {
      stopLoadingTimer();
      forgetRetainedView(taken);
      // Holding the page made it inert. If the reader moved on, don't reclaim focus even if
      // replacing the shell briefly leaves it on the body again.
      const restoreFocus = document.activeElement === document.body ? refocused : null;
      const restoredShell = mountRetainedView(current, retainedView);
      shell = restoredShell;
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
      restoreRefocus = () => restoreFocus?.restore(restoredShell.view);
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
      agentEntry && !shell && loadingTimer !== null
        ? app.querySelector<HTMLParagraphElement>(":scope > .startup")
        : null;
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
    const viewState: MountedView = {
      active,
      pending: 0,
      reusable: true,
      mutations: 0,
      reads: new Map(),
      readablePaths: new Set(),
      metaReads: new Set(),
      // Each read's Installation-administration option, so a return replays it gated (finding
      // 2636).
      administrationReads: new Map(),
      resumeHandlers: new Set(),
      revalidators: new Set(),
      // Called once Installation administration settles as ended while the view is mounted.
      administrationEnded: new Set(),
      // Called after a refocus recheck of a mounted Agent page found it still readable.
      rechecked: new Set(),
      user: session.user,
      // The view this load renders, retained by its own node (finding 1542).
      view: shell.view,
    };
    mountedViewState = viewState;
    const viewIsCurrent = () => viewState.active !== null && lifetime.isCurrent(viewState.active);
    // A read the view redoes when it resumes (rereadOnResume, the Agents list's row
    // deployments) neither keeps the view from being reused while it runs nor, if it fails,
    // afterwards (finding 1663). Leaving aborts it, and its section rereads it on resume.
    const viewRequest: ConsolePageContext["request"] = async (path, options = {}) => {
      const counted = !options.rereadOnResume;
      if (counted) {
        viewState.pending += 1;
      }
      if ((options.method ?? "GET") !== "GET" && !options.readOnly) {
        viewState.reusable = false;
        viewState.mutations += 1;
        retainedViews.clear();
      }
      // Records a read's answer, and its administration option, for a return to replay.
      const recordRead = (signature: string) => {
        viewState.reads.set(path, signature);
        if (options.installationAdministration) {
          viewState.administrationReads.set(path, options.installationAdministration);
        }
      };
      try {
        const result = await request(path, options);
        // Live reads (runtime status, log pages) differ on every call; replaying them to
        // revalidate a cached view would only spend the reader's rate limit.
        if ((options.method ?? "GET") === "GET" && options.revalidate !== false) {
          viewState.readablePaths.add(path);
          recordRead(readSignature(result, options.includeMeta));
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
            recordRead(refusedRead(error.status));
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
    const attachDiagnostics = (diagnostics: NonNullable<Shell["diagnostics"]>) => {
      viewState.diagnostics = diagnostics;
      void renderRuntimeImages(diagnostics, {
        request: viewRequest,
        namespaceId,
        isCurrent: viewIsCurrent,
      });
    };
    if (shell.diagnostics) {
      attachDiagnostics(shell.diagnostics);
    }
    if (current.feature === connectionTemplatesPage || current.feature === oauthClientsPage) {
      // Re-enter with current administrator access and a fresh editor on history navigation.
      viewState.reusable = false;
      const view = shell.view;
      const showRequiredAccess = () =>
        panel(
          view,
          "Installation administrator access required",
          current.feature === oauthClientsPage
            ? "Installation administrators manage OAuth clients."
            : "Installation administrators manage connection templates.",
        );
      if (installationAdmin) {
        viewState.administrationEnded.add(showRequiredAccess);
        const render =
          current.feature === oauthClientsPage ? renderOAuthClients : renderConnectionTemplates;
        view.append(
          render(
            { request: viewRequest, isCurrent: viewIsCurrent },
            namespaces,
            namespaces.find((item) => item.id === selectedNamespace)?.id ?? null,
          ),
        );
      } else if (installationAdmin === false) {
        showRequiredAccess();
      } else {
        panel(
          view,
          "Could not confirm administrator access",
          "Refresh to check your Installation permissions.",
        );
      }
      markMountedRoute(current);
      return;
    }
    if (current.feature === "settings") {
      shell.view.append(settingsView(session.user));
      if (installationAdmin) {
        shell.view.append(
          renderInstallationConfigurations({
            request,
            isCurrent: viewIsCurrent,
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
        namespaceAccessPanel(
          shell.view,
          NO_READABLE_NAMESPACES,
          "Ask an Installation administrator to create a Namespace or to give you access to one, then Refresh.",
        );
      } else {
        namespaceUnavailablePanel(shell.view);
      }
      return;
    }
    // Inline Create Secret dialogs follow the Namespace's secrets.create answer (finding 2442),
    // and the Agent draft's Compute preflight its agents.create answer (finding 3094). A page that
    // read the answer up front reuses it; the Agent page reads it once, when a Secret field or the
    // preflight first needs it, and only for a Namespace this session can read. A failed read is
    // unknown and keeps the action.
    let namespacePermissionsRead: Promise<NamespacePermissions | null> | null = null;
    const namespacePermissions = () =>
      (namespacePermissionsRead ??=
        firstPermissions !== null
          ? Promise.resolve(firstPermissions)
          : permissionsPath !== null && namespaces.some((item) => item.id === selectedNamespace)
            ? readNamespacePermissions(permissionsPath).catch(() => null)
            : Promise.resolve(null));
    const secretsCreateAllowed = () =>
      namespacePermissions().then((permissions) => permissions?.secrets?.create);
    const agentsCreateAllowed = () =>
      namespacePermissions().then((permissions) => permissions?.agents?.create);
    const agentContext: ConsolePageContext & Pick<NamespacePageContext, "holdWhileWriting"> = {
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
      secretsCreateAllowed,
      agentsCreateAllowed,
      request: viewRequest,
      mutationVersion: () => viewState.mutations,
      navigate,
      pageUrl,
      isCurrent: viewIsCurrent,
      onResume: (handler) => viewState.resumeHandlers.add(handler),
      onRevalidate: (check) => {
        viewState.revalidators.add(check);
        return () => viewState.revalidators.delete(check);
      },
      onAdministrationEnded: (handler) => viewState.administrationEnded.add(handler),
      onRechecked: (handler) => viewState.rechecked.add(handler),
      recheckAdministration,
      onExpired: () => {
        if (viewIsCurrent()) {
          showExpiredLogin();
        }
      },
      setTitle: (title) => {
        if (shownStandIn) {
          standInTitle = title;
          return;
        }
        const heading = app.querySelector<HTMLHeadingElement>("h1")!;
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
        if (viewIsCurrent()) {
          // An Agent page still hidden behind a stand-in leaves tab navigation to a full load: it
          // must not switch tabs, or mark its route mounted, while another page is on screen
          // (finding 1542).
          const navigateTab: TabNavigation = (next) => shownStandIn === null && handler(next);
          viewState.tabNavigation = navigateTab;
          navigateAgentTab = navigateTab;
        }
      },
      // The page's own header actions (an Agent's Create new version) sit beside Refresh. A
      // page rendering behind a stand-in gets them when its shell reveals.
      setPageActions(node) {
        node.classList.add("page-view-actions");
        viewState.pageActions = node;
        if (!shownStandIn && shell?.actions?.isConnected) {
          shell.actions.querySelector(":scope > .page-view-actions")?.remove();
          shell.actions.append(node);
        }
      },
      setLeaveGuard(guard) {
        if (viewIsCurrent()) {
          const refuse: LeaveGuard = (options) => shownStandIn === null && guard(options);
          viewState.leaveGuard = refuse;
          leaveGuard = refuse;
        }
      },
      // A page whose writes hold it open (an Agent's share, a draft's save) says when one is in
      // flight, so a reload or tab close asks first too (finding 2125).
      setWriteInFlight(check) {
        if (viewIsCurrent()) {
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
    if (firstPermissions !== null && permissionsPath !== null) {
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
    if (current.creating && selectedNamespace !== null) {
      const createContext: Parameters<typeof renderCreateAgent>[0] = {
        ...agentContext,
        namespaceId: selectedNamespace,
        permissions: firstPermissions,
        // Create Agent rereads the answer in place, so its Secret fields follow the latest one.
        secretsCreateAllowed: async () => createContext.permissions?.secrets?.create,
        setDiscardOnExit(discard) {
          discardCreationOnExit = discard ? { namespaceId } : null;
        },
        setDraftCapture(capture, unsaved) {
          agentContext.drafts.forget("create");
          if (capture) {
            agentContext.drafts.track("create", capture);
            if (unsaved) {
              // This entry is read only from the creation capture registered above.
              agentContext.drafts.unsavedWhen("create", (value) =>
                unsaved(value as ReturnType<typeof capture>),
              );
            }
          }
        },
      };
      renderCreateAgent(createContext, agentContext.drafts.get("create"));
      markMountedRoute(current);
      return;
    }
    if (current.agentId && selectedNamespace !== null && agentPath !== null) {
      let markRevealed = () => {};
      const revealed = new Promise<void>((resolve) => {
        markRevealed = resolve;
      });
      if (standIn) {
        const detailView = shell.view;
        shownStandIn = standIn;
        let revealWait: number | null = null;
        lifetime.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(revealWait ?? undefined);
            markRevealed();
          },
          { once: true },
        );
        // Runs once the Agent's page is on screen: the page's own reveal steps (scroll, focus).
        const afterReveal: (() => void)[] = [];
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
              agentContext.revealed?.();
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
          const detailShell = renderShell(current.feature, false);
          shell = detailShell;
          detailShell.view.replaceWith(detailView);
          detailShell.view = detailView;
          detailView.hidden = false;
          if (viewState.pageActions) {
            detailShell.actions.append(viewState.pageActions);
          }
          if (shell.diagnostics) {
            attachDiagnostics(shell.diagnostics);
          }
          window.scrollTo({ top: 0, left: 0 });
          if (standInTitle !== null) {
            agentContext.setTitle(standInTitle);
          }
          const heading = app.querySelector<HTMLHeadingElement>(".content h1")!;
          if (focusHeading && document.activeElement !== heading) {
            heading.focus({ preventScroll: true });
          }
          markRevealed();
          runAfterReveal();
        };
      } else {
        markRevealed();
      }
      viewState.reads.set(agentPath, JSON.stringify(firstAgent));
      viewState.readablePaths.add(agentPath);
      const agent = await renderAgentDetail(
        {
          ...agentContext,
          namespaceId: selectedNamespace,
          agentId: current.agentId,
          onProtectedReadDenied(error, receipt) {
            if (viewIsCurrent()) {
              agentContext.drafts.clear();
              showAgentReadFailure(current, namespaceId, error, receipt);
            }
          },
        },
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
    if (!Array.isArray(items) || itemsPath === null) {
      throw new Error("Invalid collection response");
    }
    viewState.reads.set(itemsPath, JSON.stringify(items));
    if (current.feature === "agents" && selectedNamespace !== null) {
      renderAgentList({
        ...agentContext,
        namespaceId: selectedNamespace,
        items,
        permissions: firstPermissions,
        resumed: resumingView,
      });
      showChatLinkFailure(shell.view, chatLinkFailure);
      // A refocus rebuilds the list when its recheck reads changed (a re-grant, a row another
      // person deleted) or after a row write, which makes the list one it never reuses. Focus on
      // a row's name or icon returns to the same control in the rebuilt row instead of falling
      // to the body (finding D814).
      const rebuiltView = shell.view;
      restoreRefocus = () => refocused?.restore(rebuiltView, { rebuilt: true });
    } else if (current.feature === "namespaces") {
      renderNamespaces(
        {
          ...agentContext,
          reload: () => loadPage(),
          fromRefresh,
          sorted,
          onRemoved(namespace) {
            clearRetainedViewsForNamespace(namespace.id);
            setNamespaces(namespaces.filter((item) => item.id !== namespace.id));
            if (namespaceId === namespace.id) {
              namespaceId =
                (
                  namespaces.find((item) => item.status === "ready") ??
                  namespaces.find((item) => item.status !== "deleting") ??
                  namespaces[0]
                )?.id ?? null;
              replaceUrl(pageUrl("namespaces"));
            }
            shellUI.updateNamespaces(namespaces);
          },
        },
        items,
      );
    } else if (current.feature === "secrets" && selectedNamespace !== null) {
      renderSecrets({
        ...agentContext,
        namespaceId: selectedNamespace,
        items,
        sorted,
        permissions: firstPermissions,
        openSecretId: linkedSecretId,
      });
      // Shown (its dialog opened or the unlisted note), so a later load does not reopen it.
      linkedSecret = null;
    } else if (current.feature === "backends") {
      if (backendsDenied) {
        backendsDenied = false;
        if (shell.scopeSelector) {
          shell.scopeSelector.hidden = false;
        }
      }
      renderRows(shell.view, current.feature, items);
    }
    markMountedRoute(current);
  } catch (error) {
    const { status, requestId } = requestFailure(error);
    const { name } = responseFields(error);
    if (!lifetime.isCurrent(active) || name === "AbortError") {
      return;
    }
    stopLoadingTimer();
    forgetRetainedView(taken);
    shownStandIn = null;
    if (status === 401) {
      showExpiredLogin();
      return;
    }
    if (!accessResolved) {
      // Uncertain shared admission invalidates every preview, not just this route. Drafts stay:
      // a later read clears them only if it proves their Namespace or account gone (finding 1935).
      const account = session;
      resetReads();
      clearPrivate();
      shell = null;
      showAdmissionUnavailable(sessionResolved, error, account);
      return;
    }
    mountedRouteKey = null;
    if (isAccessRefusal(status)) {
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
      (focusAgentResult &&
        document.activeElement === app.querySelector<HTMLHeadingElement>(".content h1"));
    if (current.feature === "backends" && status === 403) {
      // Backends need Installation administration, so their 403 settles that answer as false,
      // as a denied probe would. An administrator revoked mid-session kept a settled true: every
      // Refresh or reload read /backends again and the API audited a denial each time, and the
      // Observability link stayed (finding 2627). Now the shell below drops the link, the
      // refusal's Refresh asks the permission answer again, and a reload, without the tab's
      // stored answer, asks it too. Neither is audited.
      settleNotAdministrator();
    }
    shell = renderShell(current.feature);
    if (current.agentId && status === 404 && current.namespace === null) {
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
        requestId,
      );
      return;
    }
    if (current.agentId && status === 404) {
      panel(
        shell.view,
        "Resource unavailable",
        "This Agent may have been deleted or is no longer available in this Namespace.",
        "Back to Agents",
        () => navigate("agents"),
        requestId,
      );
      return;
    }
    const title =
      status === 403
        ? "Access denied"
        : status === 404
          ? "Resource unavailable"
          : status === 400
            ? "Namespace unavailable"
            : name === "TypeError" || name === "TimeoutError"
              ? "Request interrupted"
              : current.feature === "backends"
                ? "Backend discovery unavailable"
                : "Request unavailable";
    if (openingAgent && !isAccessRefusal(status)) {
      app.querySelector<HTMLHeadingElement>(".content h1")!.textContent = openingAgentTitle;
      panel(
        shell.view,
        "Could not load agent details",
        "Try again to check access and load this Agent.",
        "Try again",
        () => void loadPage({ openingAgent: true }),
        requestId,
      );
      shell.view.querySelector(".state-panel")!.append(button("Back to Agents", backToAgents));
      return;
    }
    const agentDenied = current.agentId && status === 403;
    // Backends are Installation-wide: another Namespace cannot change a denial (finding 1491).
    const installationDenied = current.feature === "backends" && status === 403;
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
        ? `You do not have access to this Agent or its settings, or it was deleted. ${askForGrant("Agent read on it")}`
        : installationDenied
          ? `Your account does not have access to Backends. Backends apply to the whole Installation, so choosing another Namespace would not change this. ${askForGrant("access")}`
          : status === 403
            ? `Your account does not have access to this page in this Namespace. Choose another Namespace, or ${ASK_INSTALLATION_ADMINISTRATOR} for access.`
            : "The read could not be completed. Retry to check current access and saved state.",
      // Retrying a permission refusal gives the same answer; the header's Refresh checks access
      // again after a grant (finding 2549). The Request ID stays for whoever traces the denial,
      // behind a disclosure (finding D770).
      status === 403 ? undefined : "Retry",
      status === 403 ? undefined : () => void loadPage(),
      status === 403 ? null : requestId,
    );
    if (status === 403 && requestId) {
      shell.view.querySelector(".state-panel")!.append(requestIdDisclosure(requestId));
    }
  } finally {
    stopLoadingTimer();
    if (openingAgentLoad === active) {
      openingAgentLoad = null;
    }
    if (lifetime.isCurrent(active) && shell) {
      shell.refresh!.disabled = false;
      shell.view.setAttribute("aria-busy", "false");
      restoreRefocus?.();
      if (focusAgentResult && document.activeElement === document.body) {
        const heading =
          shell.view.querySelector<HTMLHeadingElement>(":scope > .state-panel > h2") ??
          app.querySelector<HTMLHeadingElement>(".content h1")!;
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
          Array.from(
            shell.view.querySelectorAll<HTMLElement & { href?: string }>(
              "a[href], [data-return-focus-href]",
            ),
          ).find((item) => (item.dataset.returnFocusHref ?? item.href) === agentReturnHref);
        (focusTarget || app.querySelector<HTMLHeadingElement>(".content h1"))?.focus({
          preventScroll: true,
        });
      }
      if (fromRefresh && document.activeElement === document.body) {
        // The held page's shell, and the Refresh button pressed in it, were replaced.
        (shell.refresh!.isConnected
          ? shell.refresh
          : app.querySelector<HTMLHeadingElement>(".content h1")
        )?.focus({
          preventScroll: true,
        });
      }
    }
  }
}

// Static text only: a refused lookup never says whether the link expired or was denied.
const chatLinkFailures = {
  unavailable:
    "This Gateway link could not be opened. It may be out of date, or you may not have access to the Gateway.",
  interrupted: "This Gateway link could not be opened. Try the link again.",
};

function showChatLinkFailure(view: HTMLElement, failure: keyof typeof chatLinkFailures | null) {
  if (hasKey(chatLinkFailures, failure)) {
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
async function locateAgentNamespace(agentId: string, excluded: string | null) {
  const candidates = namespaces.filter((item) => item.id !== excluded);
  const probed = candidates.slice(0, agentLookupNamespaceLimit);
  const results = await Promise.allSettled(
    probed.map((item) =>
      request(`/namespaces/${encodeURIComponent(item.id)}/agents/${encodeURIComponent(agentId)}`),
    ),
  );
  const found = probed.filter((_, index) => {
    const result = results[index];
    return result?.status === "fulfilled" && responseFields(result.value).id === agentId;
  });
  if (found.length === 1 && found[0]) {
    return { namespaceId: found[0].id, complete: true };
  }
  const complete =
    candidates.length === probed.length &&
    results.every((result) => result.status === "rejected" && settledRefusal(result.reason));
  return { namespaceId: null, complete };
}

function showAgentReadFailure(
  current: Route,
  selectedNamespace: string | null,
  error: unknown,
  receipt?: HTMLElement,
) {
  const { status, requestId } = requestFailure(error);
  resetReads();
  if (isAccessRefusal(status)) {
    clearRetainedViewsForNamespace(selectedNamespace);
  }
  const shell = renderShell(current.feature);
  panel(
    shell.view,
    status === 403
      ? "Access denied"
      : status === 404
        ? "Resource unavailable"
        : "Request unavailable",
    status === 403
      ? agentPageReadRefusal(error)
      : "The read could not be completed. Retry to check current access and saved state.",
    // A permission refusal offers the header's Refresh, not a Retry that repeats it.
    status === 403 ? undefined : "Retry",
    status === 403 ? undefined : () => void loadPage(),
    receipt ? undefined : requestId,
  );
  if (receipt) {
    shell.view.append(receipt);
  }
  if (status === 403) {
    shell.refresh.disabled = false;
  }
  return shell.view;
}

async function revalidateMountedAgent(current: Route) {
  const key = routeKey(current);
  const view = app.querySelector<HTMLDivElement>('.content [aria-live="polite"]');
  const agent = mountedAgent;
  const owner = sessionOwnerKey(session);
  const selectedNamespace = namespaceId;
  if (!view || !agent || !owner || !key || selectedNamespace === null) {
    await loadPage();
    return;
  }
  const active = lifetime.capture();
  const isCurrent = () =>
    lifetime.isCurrent(active) &&
    mountedRouteKey === key &&
    routeKey(route()) === key &&
    view.isConnected;
  const namespacePath = `/namespaces/${encodeURIComponent(selectedNamespace)}`;
  const path = `${namespacePath}/agents/${encodeURIComponent(agent.id)}`;
  const pageActions = mountedViewState?.pageActions?.isConnected
    ? mountedViewState.pageActions
    : null;
  const activeElement = document.activeElement;
  const focused =
    (activeElement instanceof HTMLElement || activeElement instanceof SVGElement) &&
    (view.contains(activeElement) || pageActions?.contains(activeElement))
      ? activeElement
      : null;
  const textField =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const selection =
    typeof textField?.selectionStart === "number"
      ? ([textField.selectionStart, textField.selectionEnd] as const)
      : null;
  let checking = "session";
  // Block stale controls during admission without losing focus or an editor's caret on return.
  view.inert = true;
  if (pageActions) {
    pageActions.inert = true;
  }
  let clearStillChecking: (() => void) | undefined;
  const stillChecking = setTimeout(() => {
    if (isCurrent()) {
      clearStillChecking = showStillChecking();
    }
  }, stillCheckingDelayMs);
  try {
    const resolvedSession = await readSession();
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
    setNamespaces(readable);
    if (!namespaces.some((item) => item.id === selectedNamespace)) {
      clearRetainedViewsForNamespace(selectedNamespace);
      resetReads();
      namespaceUnavailablePanel(renderShell(current.feature, false, { page: null }).view);
      return;
    }
    checking = "detail";
    // The page applies this answer once the recheck settles (finding 3000).
    const readStartedAt = performance.now();
    const rechecked = { agent: await request(path), readStartedAt };
    if (!isCurrent()) {
      return;
    }
    shellUI.updateNamespaces(namespaces);
    if (current.url.searchParams.get("tab") !== "workspace") {
      const selected =
        current.url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
      const snapshotPath =
        selected === "draft"
          ? `${namespacePath}/configurations/${encodeURIComponent(agent.configurationId)}`
          : `${path}/revisions/${encodeURIComponent(selected)}`;
      const previousSnapshotRead = mountedViewState?.reads.get(snapshotPath);
      const snapshotWasReadable = mountedViewState?.readablePaths.has(snapshotPath);
      // A refusal this page already showed, or this tab already settled, for a read it never had.
      const refusalSettled =
        snapshotWasReadable === false &&
        (previousSnapshotRead === refusedRead(403) || deniedReadsFor(owner).has(snapshotPath));
      const versions = request(`${path}/revisions`, { includeMeta: true });
      // A version this page showed as unreadable has nothing on screen to scrub: its read would
      // only be refused and audited again on every refocus, and the refusal would replace the
      // page (finding D799). The page proved it on load as the version's own view does: a settled
      // refusal, or a current version left out of a newest page of versions that lists every
      // version the caller can read (finding D791). Refresh reads it again.
      const shownUnreadable = async () =>
        selected !== "draft" &&
        snapshotWasReadable === false &&
        (refusalSettled ||
          (selected === agent.activeRevisionId &&
            (await versions.then((answer) => {
              const { data, meta } = responseFields(answer);
              if (!Array.isArray(data)) {
                throw new Error("Invalid collection response");
              }
              if ((responseFields(meta).nextCursor ?? null) !== null) {
                return false;
              }
              // A complete page proves omission only when every row identifies a revision.
              const ids = data.map((item: unknown) => {
                const { id } = responseFields(item);
                if (typeof id !== "string") {
                  throw new Error("Invalid collection response");
                }
                return id;
              });
              return !ids.includes(selected);
            }))));
      await Promise.all([
        versions,
        shownUnreadable()
          .then((unreadable) => (unreadable ? undefined : request(snapshotPath)))
          .catch((error: unknown) => {
            // Initial admission can show an Agent with its draft Configuration denied. Keep
            // that same refusal, but scrub a page whose previously readable data was revoked.
            if (selected === "draft" && requestFailure(error).status === 403 && refusalSettled) {
              return;
            }
            throw error;
          }),
      ]);
    }
    // The page's own answers follow the recheck: a grant or revocation since the page loaded
    // applies without Refresh, as on the Agents list (r54 row 11).
    if (!isCurrent()) {
      return;
    }
    for (const handler of mountedViewState?.rechecked ?? []) {
      handler(rechecked);
    }
  } catch (error) {
    if (!isCurrent() || responseFields(error).name === "AbortError") {
      return;
    }
    if (requestFailure(error).status === 401) {
      showExpiredLogin();
      return;
    }
    if (checking !== "detail") {
      resetReads();
      // Drafts survive an unavailable check, as in loadPage (finding 1935).
      const account = session;
      clearPrivate();
      showAdmissionUnavailable(checking !== "session", error, account);
      return;
    }
    showAgentReadFailure(current, selectedNamespace, error);
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
          textField?.setSelectionRange(selection[0], selection[1]);
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
function settingsView(user: Session["user"]) {
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

const UNREACHABLE_TITLE = "Could not reach OpenClaw Enterprise";
const UNREACHABLE_TEXT = "Check your connection, then try again.";

// A read that never reached the API: the browser is offline, or the API did not answer in time.
function unreachable(error: unknown) {
  const { status, name } = responseFields(error);
  return status === undefined && (name === "TypeError" || name === "TimeoutError");
}

// The shared session or Namespace read failed, so no private page can show. Once the session
// is confirmed, a refusal can be lasting (an account whose access was removed), and this panel
// has no account menu, so it offers Sign out beside Retry (finding 1894).
// A read that never reached the API says nothing about the session (finding 1896). A tab that
// was signed in as `account` keeps its shell, without Namespace or page data, names the
// connection and puts focus on Retry. Any answer from the API (401, 403, 503) is shown below.
function showAdmissionUnavailable(
  sessionChecked: boolean,
  error: unknown,
  account: Session | null,
) {
  const current = route();
  if (unreachable(error) && account && Object.hasOwn(pages, current.feature)) {
    // The account alone stays known, so Retry, Refresh and a refocus hold this shell while they
    // check again, and a 401 then still signs the tab out.
    session = account;
    const shell = renderShell(current.feature, true, { recovery: false });
    panel(shell.view, UNREACHABLE_TITLE, UNREACHABLE_TEXT, "Retry", () => void loadPage());
    shell.refresh.disabled = false;
    shell.view.setAttribute("aria-busy", "false");
    const reason = shell.view.querySelector<HTMLParagraphElement>(".state-panel > p")!;
    reason.id = "unreachable-reason";
    const retry = shell.view.querySelector<HTMLButtonElement>(".state-panel > button")!;
    retry.setAttribute("aria-describedby", reason.id);
    retry.focus();
    return;
  }
  if (unreachable(error)) {
    publicPanel(UNREACHABLE_TITLE, UNREACHABLE_TEXT, "Retry", () => void loadPage());
    return;
  }
  const { status } = requestFailure(error);
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
// Tab past the page's last control moves focus to the browser's own controls, and the next Tab
// brings it back. That lap is not the reader returning to the page: the refocus recheck it would
// start holds the page inert, so the lap's next Tabs skipped the page (finding 2879). A return
// within TAB_LAP_MS of tabbing out, with the page shown throughout, is not rechecked; a later
// return, or one after the page was hidden, is.
const TAB_LAP_MS = 10_000;
let lastTabKey = -Infinity;
let tabbedOutAt: number | null = null;
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab") {
      lastTabKey = event.timeStamp;
    }
  },
  { capture: true },
);
window.addEventListener("blur", (event) => {
  if (event.target === window) {
    // Focus leaves the page in the Tab key's own default action, right after its keydown.
    tabbedOutAt = !document.hidden && event.timeStamp - lastTabKey < 1000 ? event.timeStamp : null;
  }
});
window.addEventListener("focus", (event) => {
  if (event.target !== window) {
    return;
  }
  const lap = tabbedOutAt !== null && event.timeStamp - tabbedOutAt < TAB_LAP_MS;
  tabbedOutAt = null;
  if (!lap) {
    resumePage();
  }
});
document.addEventListener("visibilitychange", () => {
  tabbedOutAt = null;
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
  document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
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
