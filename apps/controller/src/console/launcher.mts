import type { Agent, Namespace } from "@openclaw-enterprise/contracts";
import { requestFailure, type createApiClient } from "./api-client.mjs";
import { button, element } from "./dom.mjs";
import { brandContents, panel, sorted } from "./shell.mjs";

type Request = ReturnType<typeof createApiClient>;
type Availability = "available" | "disabled" | "stopped" | "unsupported" | "unavailable";

interface Destination {
  name: string;
  status: Availability;
  url?: string;
  namespaceName?: string;
  administration?: true;
}

interface LauncherContext {
  app: HTMLElement;
  request: Request;
  session: { user: { name?: string; email?: string } };
  /** `/console/launch?choose=1`: show the chooser even for one available destination. */
  choose: boolean;
  isCurrent(): boolean;
  logout(): void;
  /** Opens Fleet administration inside this console, keeping the tab's pinned session. */
  openAdministration(replace: boolean): void;
}

// Copy for each native admin status: a badge, its tone and what the person can do.
const availability = {
  available: ["Available", "success", "Your OpenClaw workspace."],
  disabled: ["Not enabled", null, "Browser access has not been enabled for this workspace."],
  stopped: [
    "Stopped",
    "warning",
    "Your workspace is stopped. Contact your administrator to start it.",
  ],
  unsupported: ["Not available", null, "This workspace is not configured for browser access."],
  unavailable: [
    "Unavailable",
    "warning",
    "Your workspace is temporarily unavailable. Try again shortly.",
  ],
} as const satisfies Record<Availability, readonly [string, "success" | "warning" | null, string]>;

const ADMINISTRATION: Destination = {
  name: "Fleet administration",
  status: "available",
  url: "/console/namespaces",
  administration: true,
};

function collection<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid destination collection");
  }
  return value as T[];
}

// Native URLs come only from the authenticated native-admin response, never from the page URL.
function nativeUrl(value: unknown) {
  const url = new URL(String(value));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid native UI destination");
  }
  return url.href;
}

// One Agent as a destination, or null when the person may read but not administer it. The
// advisory permission answer audits nothing, so a member's readable Agents cost no audited denial.
// A 403 from the status read is a grant removed since; other failures may be a concurrent change,
// so they fail the whole discovery instead of presenting a partial list.
async function agentDestination(request: Request, namespace: Namespace, agent: Agent) {
  const path = `/namespaces/${encodeURIComponent(namespace.id)}/agents/${encodeURIComponent(agent.id)}`;
  const permissions = (await request(`${path}/permissions`)) as { administer?: unknown } | null;
  if (permissions?.administer === false) {
    return null;
  }
  let access: { status?: unknown; url?: unknown } | null;
  try {
    access = (await request(`${path}/native-admin`)) as typeof access;
  } catch (error) {
    if (requestFailure(error).status === 403) {
      return null;
    }
    throw error;
  }
  const status = access?.status;
  if (typeof status !== "string" || !Object.hasOwn(availability, status)) {
    throw new Error("Invalid native UI availability");
  }
  return {
    name: agent.name,
    namespaceName: namespace.name,
    status: status as Availability,
    ...(status === "available" ? { url: nativeUrl(access?.url) } : {}),
  } satisfies Destination;
}

// Whether the person administers the Installation. A readable Namespace's permission answer
// targets the Installation and audits nothing. Without one, the observability read is the probe:
// its 403 means no, and any other failure leaves the answer unknown.
async function administersInstallation(request: Request, namespaces: readonly Namespace[]) {
  const first = namespaces[0];
  if (first) {
    const answer = (await request(`/namespaces/${encodeURIComponent(first.id)}/permissions`)) as {
      installation?: { administer?: unknown };
    } | null;
    const administer = answer?.installation?.administer;
    if (typeof administer !== "boolean") {
      throw new Error("Invalid permission answer");
    }
    return administer;
  }
  try {
    await request("/observability");
    return true;
  } catch (error) {
    if (requestFailure(error).status === 403) {
      return false;
    }
    throw error;
  }
}

// Every destination the person may open now. Nothing is cached: each visit and refresh asks again.
async function discover(request: Request) {
  const namespaces = sorted(collection<Namespace>(await request("/namespaces")));
  const admin = await administersInstallation(request, namespaces);
  const found: Destination[] = [];
  // One read at a time keeps a large Installation from sending a burst of requests.
  for (const namespace of namespaces) {
    const agents = collection<Agent>(
      await request(`/namespaces/${encodeURIComponent(namespace.id)}/agents`),
    );
    for (const agent of sorted(agents)) {
      const destination = await agentDestination(request, namespace, agent);
      if (destination) {
        found.push(destination);
      }
    }
  }
  return admin ? [...found, ADMINISTRATION] : found;
}

// An open link for a destination. Fleet administration stays in this console for a plain click.
function openLink(item: Destination, openAdministration: LauncherContext["openAdministration"]) {
  const link = element(
    "a",
    { className: "launcher-open", href: item.url },
    item.administration ? "Open administration →" : "Open Claw →",
  );
  if (item.administration) {
    link.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      openAdministration(false);
    });
  }
  return link;
}

function destinationCard(
  item: Destination,
  openAdministration: LauncherContext["openAdministration"],
) {
  const [label, tone, description] = availability[item.status];
  return element(
    "article",
    { className: "card launcher-destination" },
    element("span", { className: "badge", ...(tone ? { "data-tone": tone } : {}) }, label),
    element("h2", {}, item.name),
    element(
      "p",
      { className: "muted" },
      item.administration ? "Manage Agents and team access." : description,
    ),
    item.namespaceName ? element("p", { className: "hint" }, item.namespaceName) : null,
    item.url
      ? openLink(item, openAdministration)
      : element("p", { className: "hint launcher-open" }, "Not available to open"),
  );
}

/**
 * Renders `/console/launch`: discovers the signed-in person's destinations, opens the only
 * available one, and otherwise lets them choose. It sits outside the administration shell.
 */
export function renderLauncher({
  app,
  request,
  session,
  choose,
  isCurrent,
  logout,
  openAdministration,
}: LauncherContext) {
  const view = element("main", { className: "launcher-content" });
  app.replaceChildren(
    element(
      "div",
      { className: "launcher" },
      element(
        "header",
        { className: "launcher-header" },
        element("p", { className: "brand" }, ...brandContents("sign-in")),
        element(
          "div",
          { className: "launcher-account" },
          element(
            "div",
            {},
            element("strong", {}, session.user.name || session.user.email || "Account"),
            session.user.name ? element("span", { className: "muted" }, session.user.email) : null,
          ),
          button("Sign out", () => void logout()),
        ),
      ),
      view,
    ),
  );
  // A refresh supersedes the discovery before it, so a slower earlier answer never replaces it.
  let generation = 0;

  async function show() {
    const run = ++generation;
    const current = () => isCurrent() && run === generation;
    panel(view, "Finding your workspaces…", "Checking your current access.");
    let items: Destination[];
    try {
      items = await discover(request);
    } catch (error) {
      if (current()) {
        panel(
          view,
          "We couldn’t load your workspaces",
          "Something went wrong while checking your destinations. Try again in a moment.",
          "Try again",
          () => void show(),
          requestFailure(error).requestId,
        );
      }
      return;
    }
    if (!current()) {
      return;
    }
    // A complete discovery with one destination, available or not, decides the entry.
    const only = items.length === 1 && !choose ? items[0] : null;
    if (only?.administration) {
      openAdministration(true);
      return;
    }
    if (only?.url) {
      panel(view, `Opening ${only.name}…`, "Taking you to your workspace.");
      view.append(
        element("a", { className: "button button--primary", href: only.url }, "Continue"),
      );
      location.replace(only.url);
      return;
    }
    if (!items.length) {
      panel(
        view,
        "No access assigned",
        "You’re signed in, but no workspaces have been assigned to this account. Contact your administrator to get access.",
        "Check again",
        () => void show(),
      );
      return;
    }
    view.replaceChildren(
      element("h1", {}, only ? "Your workspace is unavailable" : "Where would you like to go?"),
      element(
        "p",
        { className: "muted" },
        only
          ? "Your access is still assigned. Check the status below or try again."
          : "Choose a workspace to continue.",
      ),
      element(
        "div",
        { className: "launcher-destinations" },
        ...items.map((item) => destinationCard(item, openAdministration)),
      ),
      element(
        "div",
        { className: "launcher-footer" },
        element("p", { className: "hint" }, "Only destinations you can access are shown."),
        button("Refresh availability", () => void show()),
      ),
    );
  }

  return show();
}
