export const pages = Object.freeze({
  agents: "Agents",
  backends: "Backends",
  namespaces: "Namespaces",
  settings: "Settings",
});

export function createNavigation({ getNamespaceId, isLoggingOut, loadPage }) {
  let previousCollection = "agents";

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

  function pageUrl(feature, selection = getNamespaceId()) {
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
    "logs",
  ]);

  function validIntent(intent) {
    if (intent?.kind === "native") {
      return typeof intent.key === "string" && /^[0-9a-f]{32}$/.test(intent.key);
    }
    if (intent?.kind !== "console" || typeof intent.feature !== "string") {
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
      (intent.tab === null || (detail && agentTabs.has(intent.tab)))
    );
  }

  function captureIntent(value) {
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

  function intentUrl(intent) {
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

  function navigate(feature, selection = getNamespaceId(), replace = false) {
    if (isLoggingOut()) {
      return;
    }
    const current = route().feature;
    if (feature === "settings" && ["agents", "backends", "namespaces"].includes(current)) {
      previousCollection = current;
    }
    history[replace ? "replaceState" : "pushState"](
      { previousCollection },
      "",
      pageUrl(feature, selection),
    );
    void loadPage({ fromNavigation: true });
  }

  return {
    route,
    pageUrl,
    captureIntent,
    validIntent,
    intentUrl,
    navigate,
    get previousCollection() {
      return previousCollection;
    },
    restoreHistory() {
      if (["agents", "backends", "namespaces"].includes(history.state?.previousCollection)) {
        previousCollection = history.state.previousCollection;
      }
    },
    resetHistory() {
      previousCollection = "agents";
    },
  };
}
