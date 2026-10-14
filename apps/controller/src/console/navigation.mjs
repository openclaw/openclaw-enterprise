export const pages = Object.freeze({
  agents: "Agents",
  backends: "Backends",
  namespaces: "Namespaces",
  settings: "Settings",
  "cli-login": "Sign in to occ",
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

  function safeReturn(value) {
    if (!value || !value.startsWith("/console/")) {
      return null;
    }
    try {
      const url = new URL(value, location.origin);
      const path = url.pathname.slice(9);
      if (
        url.origin !== location.origin ||
        (!Object.hasOwn(pages, path) && !/^agents\/(new|agt_[a-f0-9-]+)$/.test(path))
      ) {
        return null;
      }
      return pageUrl(path + url.search, url.searchParams.get("namespace"));
    } catch {
      return null;
    }
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
    safeReturn,
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
