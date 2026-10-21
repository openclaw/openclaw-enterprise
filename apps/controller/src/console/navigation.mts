export const pages = Object.freeze({
  agents: "Agents",
  secrets: "Secrets",
  backends: "Backends",
  namespaces: "Namespaces",
  settings: "Settings",
});

interface LoginIntent {
  kind: "console";
  feature: string;
  namespaceId: string | null;
  revision: string | null;
  tab: string | null;
}

interface NavigationOptions {
  getNamespaceId(): string | null;
  isLoggingOut(): boolean;
  loadPage(options: {
    fromNavigation: boolean;
    openingAgent?: boolean;
    restoreHistory?(url: string): void;
  }): void;
}

export function createNavigation({ getNamespaceId, isLoggingOut, loadPage }: NavigationOptions) {
  // The initial entry is position zero. Keep the position on replaceState, including sign-in,
  // so a refused Back or Forward can return to its starting entry without rewriting history.
  let position: number | null = entryPosition() ?? 0;
  let restoring: number | null = null;
  replaceUrl(location.href);

  function route() {
    const url = new URL(location.href);
    const path = url.pathname;
    const feature =
      path === "/console" || path === "/console/" ? "agents" : path.slice("/console/".length);
    const agentPath = /^agents\/(new|agt_[a-f0-9-]+)$/.exec(feature);
    return {
      feature: agentPath ? "agents" : feature,
      agentId: agentPath?.[1] === "new" ? null : agentPath?.[1],
      creating: agentPath?.[1] === "new",
      target: feature + url.search,
      namespace: url.searchParams.get("namespace"),
      url,
    };
  }

  function pageUrl(feature: string, selection = getNamespaceId()) {
    const url = new URL(`/console/${feature}`, location.origin);
    if (
      !url.searchParams.has("debug") &&
      new URL(location.href).searchParams.get("debug") === "true"
    ) {
      url.searchParams.set("debug", "true");
    }
    if (selection !== null) {
      url.searchParams.set("namespace", selection);
    }
    return `${url.pathname}${url.search}`;
  }

  // Login destinations are structured routes, never a URL supplied to the login page.
  const resourceSuffix = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const agentId = new RegExp(`^agt_${resourceSuffix}$`);
  const namespaceId = new RegExp(`^ns_${resourceSuffix}$`);

  const revisionId = new RegExp(`^rev_${resourceSuffix}$`);
  const agentTabs = new Set([
    "configuration",
    "plugins",
    "channels",
    "repositories",
    "credentials",
    "workspace",
    "policy",
    "logs",
    "access",
  ]);

  function validIntent(value: unknown): value is LoginIntent | { kind: "native"; key: string } {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const intent = value as Record<string, unknown>;
    if (intent.kind === "native") {
      return typeof intent.key === "string" && /^[0-9a-f]{32}$/.test(intent.key);
    }
    if (intent.kind !== "console" || typeof intent.feature !== "string") {
      return false;
    }
    const detail = intent.feature.startsWith("agents/") && agentId.test(intent.feature.slice(7));
    return (
      (Object.hasOwn(pages, intent.feature) || intent.feature === "agents/new" || detail) &&
      (intent.namespaceId === null ||
        (typeof intent.namespaceId === "string" && namespaceId.test(intent.namespaceId))) &&
      (intent.revision === null ||
        (detail &&
          typeof intent.revision === "string" &&
          (intent.revision === "draft" || revisionId.test(intent.revision)))) &&
      (intent.tab === null ||
        (detail && typeof intent.tab === "string" && agentTabs.has(intent.tab)))
    );
  }

  function captureIntent(value: unknown) {
    if (typeof value !== "string" || !value.startsWith("/console/")) {
      return null;
    }
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin) {
      return null;
    }
    const intent = {
      kind: "console",
      feature: url.pathname.slice("/console/".length),
      namespaceId: url.searchParams.get("namespace"),
      revision: url.searchParams.get("revision"),
      tab: url.searchParams.get("tab"),
    };
    return validIntent(intent) ? intent : null;
  }

  function intentUrl(intent: unknown) {
    if (!validIntent(intent) || intent.kind !== "console") {
      return null;
    }
    const query = new URLSearchParams();
    if (intent.namespaceId !== null) {
      query.set("namespace", intent.namespaceId);
    }
    if (intent.revision !== null) {
      query.set("revision", intent.revision);
    }
    if (intent.tab !== null) {
      query.set("tab", intent.tab);
    }
    return `/console/${intent.feature}${query.size ? `?${query}` : ""}`;
  }

  function entryPosition() {
    const index: unknown = history.state?.consolePosition;
    return typeof index === "number" && Number.isSafeInteger(index) ? index : null;
  }

  function replaceUrl(url: string) {
    history.replaceState({ consolePosition: position }, "", url);
  }

  function pushUrl(url: string) {
    position = (position ?? 0) + 1;
    history.pushState({ consolePosition: position }, "", url);
  }

  function navigate(feature: string, selection = getNamespaceId(), replace = false) {
    if (isLoggingOut()) {
      return;
    }
    const current = route();
    const url = pageUrl(feature, selection);
    if (replace) {
      replaceUrl(url);
    } else {
      pushUrl(url);
    }
    // A deliberate list → detail navigation, not a refresh, deep link or history traversal.
    const openingAgent =
      !replace && current.url.pathname === "/console/agents" && Boolean(route().agentId);
    void loadPage({ fromNavigation: true, openingAgent });
  }

  function traverse({
    fromNavigation,
    mountedUrl,
  }: {
    fromNavigation: boolean;
    mountedUrl: string | null;
  }) {
    // popstate arrives after the browser has moved. If the page must stay open, go back by the
    // same distance, then consume that popstate without reloading the page we kept mounted.
    const previous = position;
    position = entryPosition();
    const returned = restoring !== null && position === restoring;
    restoring = null;
    // Never skip the admission recheck of an inert or no longer mounted page.
    if (returned && fromNavigation && mountedUrl === location.pathname + location.search) {
      return;
    }
    void loadPage({
      fromNavigation,
      restoreHistory(url) {
        if (position === null || previous === null || position === previous) {
          // An older or untracked entry has no reliable direction. Keep it available to Back
          // without risking history.go(0), which would reload the page during its write.
          pushUrl(url);
        } else {
          restoring = previous;
          history.go(previous - position);
        }
      },
    });
  }

  return {
    traverse,
    replaceUrl,
    route,
    pageUrl,
    captureIntent,
    validIntent,
    intentUrl,
    navigate,
  };
}
