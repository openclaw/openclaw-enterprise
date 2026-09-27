import { createPluginFields } from "./plugin-fields.mjs";
import { namespacePath } from "./list.mjs";

function discoveryError(error, deniedMessage, unsupportedMessage) {
  if (error.status === 403) {
    return typeof deniedMessage === "function" ? deniedMessage() : deniedMessage;
  }
  if (error.status === 501) {
    return unsupportedMessage;
  }
  const reason = {
    PLUGIN_DISCOVERY_CREDENTIALS_REJECTED:
      "The service account token was rejected or cannot access plugins. Check its permissions.",
    PLUGIN_DISCOVERY_RATE_LIMITED: "The plugin service rate limit was reached. Try again later.",
    PLUGIN_DISCOVERY_UNAVAILABLE:
      "The plugin service is unavailable. Check the server's plugin service access and retry.",
    PLUGIN_DISCOVERY_INVALID_RESPONSE:
      "The plugin service returned an unsupported response. Retry or contact your operator.",
  }[error.code];
  return `${reason ?? "Plugins could not be loaded. Check the credential and retry."}${error.requestId ? ` Request: ${error.requestId}` : ""}`;
}

export function createPluginDiscovery({
  context,
  input,
  accessToken,
  canDiscover,
  isPending,
  unavailableMessage,
  saveHint,
  catalogPath = `${namespacePath(context.namespaceId)}/agents/plugins`,
  requestBody = (body) => ({ accessToken: accessToken(), ...body }),
  deniedMessage = "Plugin discovery requires Agent create permission in this Namespace. Saved selections can still be edited.",
  unsupportedMessage = "This Installation's Plugin Driver does not offer catalog browsing. You can edit configured selections or JSON, or ask an operator to select a catalog-capable Driver.",
  availableMessage = "Load plugins available to this service account token. Your plugin selections stay unchanged.",
  createApproverField,
}) {
  let generation = 0;
  let catalog = { status: "idle", nextCursor: null };
  const entries = new Map();
  let pageIds = [];
  let cursors = [null];
  let pageIndex = 0;
  const fields = createPluginFields({
    input,
    saveHint,
    createApproverField,
    onLoadPlugins: (direction) => void loadCatalog(direction),
    onLoadTools: (id) => void loadTools(id),
  });

  function update() {
    const canLoad = canDiscover();
    const statusMessage = canLoad ? availableMessage : unavailableMessage;
    fields.setCatalog({
      ...catalog,
      entries: pageIds.map((id) => entries.get(id)),
      knownEntries: [...entries.values()],
      pageNumber: pageIndex + 1,
      hasPrevious: pageIndex > 0,
      canLoad,
      message:
        catalog.message ?? (typeof statusMessage === "function" ? statusMessage() : statusMessage),
    });
  }

  function reset() {
    // A catalog belongs to one entered credential; late responses cannot restore it.
    generation += 1;
    entries.clear();
    pageIds = [];
    cursors = [null];
    pageIndex = 0;
    catalog = { status: "idle", nextCursor: null };
    update();
  }

  async function loadCatalog(direction = "refresh") {
    if (!canDiscover() || isPending() || catalog.status === "loading") {
      return;
    }
    let nextPageIndex = pageIndex;
    let cursor = cursors[nextPageIndex];
    if (direction === "next") {
      if (!catalog.nextCursor) {
        return;
      }
      nextPageIndex += 1;
      cursor = catalog.nextCursor;
    } else if (direction === "previous") {
      if (nextPageIndex === 0) {
        return;
      }
      nextPageIndex -= 1;
      cursor = cursors[nextPageIndex];
    }
    // Every page change invalidates in-flight details; the service owns page boundaries.
    const active = ++generation;
    for (const [id, entry] of entries) {
      entries.set(id, { ...entry, toolStatus: undefined });
    }
    catalog = { ...catalog, status: "loading" };
    update();
    try {
      const page = await context.request(catalogPath, {
        method: "POST",
        body: requestBody(cursor ? { cursor } : {}),
      });
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      for (const entry of page.plugins) {
        entries.set(entry.id, entry);
      }
      pageIds = page.plugins.map((entry) => entry.id);
      cursors = [...cursors.slice(0, nextPageIndex), cursor];
      pageIndex = nextPageIndex;
      catalog = { status: "ready", nextCursor: page.nextCursor, setup: page.setup };
    } catch (error) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      catalog = {
        ...catalog,
        status: "error",
        message: discoveryError(error, deniedMessage, unsupportedMessage),
      };
    } finally {
      if (context.isCurrent() && active === generation) {
        update();
      }
    }
  }

  async function loadTools(id) {
    const entry = entries.get(id);
    if (
      !canDiscover() ||
      isPending() ||
      catalog.status === "loading" ||
      !entry?.remoteId ||
      entry.toolStatus === "loading"
    ) {
      return;
    }
    const active = generation;
    entries.set(id, { ...entry, toolStatus: "loading", toolError: undefined });
    update();
    try {
      const detail = await context.request(`${catalogPath}/details`, {
        method: "POST",
        body: requestBody({ pluginId: entry.remoteId }),
      });
      if (
        !context.isCurrent() ||
        active !== generation ||
        entries.get(id)?.remoteId !== entry.remoteId
      ) {
        return;
      }
      entries.set(id, { ...entry, ...detail, toolStatus: "loaded", toolError: undefined });
    } catch (error) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      entries.set(id, {
        ...entry,
        toolError: discoveryError(error, deniedMessage, unsupportedMessage),
      });
    } finally {
      if (context.isCurrent() && active === generation) {
        update();
      }
    }
  }

  update();
  return { fields, reset, update };
}
