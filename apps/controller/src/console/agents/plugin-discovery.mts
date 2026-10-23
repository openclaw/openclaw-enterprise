import type { PluginCatalogEntry, PluginCatalogPage } from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import {
  type CatalogDirection,
  type CatalogEntry,
  type PluginFieldCatalog,
  type PluginFieldsOptions,
  createPluginFields,
} from "./plugin-fields.mjs";
import { namespacePath } from "./list.mjs";

export interface PluginDiscoveryContext {
  namespaceId: string;
  // Discovery is a read-only POST. The view owner uses this flag when deciding whether to retain it.
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
}

type Message = string | (() => string);
type CatalogRequest = { cursor?: string; q?: string } | { pluginId: string };

interface PluginDiscoveryOptions extends Pick<
  PluginFieldsOptions,
  "input" | "saveHint" | "createApproverField"
> {
  context: PluginDiscoveryContext;
  canDiscover(): boolean;
  canPrefetch?(): boolean;
  isPending(): boolean;
  unavailableMessage: Message;
  catalogPath?: string;
  // Create Agent adds the discovery credential. An existing Agent's path identifies its saved one.
  requestBody(body: CatalogRequest): unknown;
  deniedMessage?: Message;
  unsupportedMessage?: string;
  availableMessage?: Message;
}

function discoveryError(
  error: ReturnType<typeof requestFailure>,
  deniedMessage: Message,
  unsupportedMessage: string,
) {
  if (error.status === 403) {
    return typeof deniedMessage === "function" ? deniedMessage() : deniedMessage;
  }
  if (error.status === 501) {
    return unsupportedMessage;
  }
  const reasons: Record<string, string> = {
    PLUGIN_DISCOVERY_CREDENTIALS_REJECTED:
      "The credential was rejected or cannot access plugins. Check its permissions.",
    PLUGIN_DISCOVERY_RATE_LIMITED: "The plugin service rate limit was reached. Try again later.",
    PLUGIN_DISCOVERY_UNAVAILABLE:
      "The plugin service is unavailable. Check the server's plugin service access and retry.",
    PLUGIN_DISCOVERY_INVALID_RESPONSE:
      "The plugin service returned an unsupported response. Retry or contact your operator.",
  };
  const reason = error.code ? reasons[error.code] : undefined;
  return `${reason ?? "Plugins could not be loaded. Check the credential and retry."}${error.requestId ? ` Request: ${error.requestId}` : ""}`;
}

export function createPluginDiscovery({
  context,
  input,
  canDiscover,
  canPrefetch = () => false,
  isPending,
  unavailableMessage,
  saveHint,
  catalogPath = `${namespacePath(context.namespaceId)}/agents/plugins`,
  requestBody,
  deniedMessage = "Plugin discovery requires Agent create permission in this Namespace. Saved selections can still be edited.",
  unsupportedMessage = "This Installation's Plugin Driver does not offer catalog browsing. You can edit configured selections or JSON, or ask an operator to select a catalog-capable Driver.",
  availableMessage = "Load plugins available to this credential. Your plugin selections stay unchanged.",
  createApproverField,
}: PluginDiscoveryOptions) {
  let generation = 0;
  let prefetched = false;
  let searchTimer: number | undefined;
  let requests = new AbortController();
  let catalog: Pick<PluginFieldCatalog, "status" | "message" | "nextCursor" | "setup"> = {
    status: "idle",
    nextCursor: null,
  };
  const entries = new Map<string, CatalogEntry>();
  let pageIds: string[] = [];
  let cursors: (string | null)[] = [null];
  let query = "";
  let pageIndex = 0;
  const fields = createPluginFields({
    input,
    ...(saveHint !== undefined ? { saveHint } : {}),
    ...(createApproverField ? { createApproverField } : {}),
    onLoadPlugins: (direction, q) => {
      if (direction === "search") {
        scheduleSearch(q);
      } else {
        void loadCatalog(direction, q);
      }
    },
    onCancelDiscovery: cancel,
    onLoadTools: (id) => void loadTools(id),
  });

  function render() {
    const canLoad = canDiscover();
    const statusMessage = canLoad ? availableMessage : unavailableMessage;
    fields.setCatalog({
      ...catalog,
      entries: pageIds.map((id) => entries.get(id)).filter((entry) => entry !== undefined),
      knownEntries: [...entries.values()],
      pageNumber: pageIndex + 1,
      hasPrevious: pageIndex > 0,
      canLoad,
      message:
        catalog.message ?? (typeof statusMessage === "function" ? statusMessage() : statusMessage),
    });
  }

  function update() {
    render();
    if (!prefetched && catalog.status === "idle" && canPrefetch() && canDiscover()) {
      if (!context.isCurrent() || isPending()) {
        return;
      }
      prefetched = true;
      scheduleSearch("");
    }
  }

  function invalidateRequests() {
    generation += 1;
    clearTimeout(searchTimer);
    searchTimer = undefined;
    requests.abort();
    requests = new AbortController();
    for (const [id, entry] of entries) {
      if (entry.toolStatus === "loading") {
        entries.set(id, { ...entry, toolStatus: undefined });
      }
    }
  }

  function cancel() {
    const pending = searchTimer !== undefined || catalog.status === "loading";
    invalidateRequests();
    if (pending) {
      pageIds = [];
      cursors = [null];
      pageIndex = 0;
      catalog = { status: "idle", nextCursor: null, setup: catalog.setup };
    }
    render();
  }

  function scheduleSearch(q: string) {
    // Invalidate on input, before the delay, so an older response cannot fill this query.
    invalidateRequests();
    query = q.trim();
    pageIds = [];
    cursors = [null];
    pageIndex = 0;
    catalog = { status: "idle", nextCursor: null, setup: catalog.setup };
    if (context.isCurrent() && canDiscover() && !isPending()) {
      catalog.status = "loading";
      searchTimer = setTimeout(() => {
        // Submitting the form can pause discovery before this delayed read starts.
        if (isPending()) {
          prefetched = false;
          cancel();
          return;
        }
        void loadCatalog("refresh", query);
      }, 300);
    }
    render();
  }

  function reset() {
    // A catalog belongs to one entered credential; late responses cannot restore it.
    invalidateRequests();
    entries.clear();
    prefetched = false;
    query = "";
    fields.resetSearch();
    pageIds = [];
    cursors = [null];
    pageIndex = 0;
    catalog = { status: "idle", nextCursor: null };
    update();
  }

  async function loadCatalog(
    direction: Exclude<CatalogDirection, "search"> = "refresh",
    q = query,
  ) {
    const search = q.trim();
    const queryChanged = search !== query;
    if (
      !context.isCurrent() ||
      !canDiscover() ||
      isPending() ||
      (catalog.status === "loading" && searchTimer === undefined && !queryChanged)
    ) {
      return;
    }
    if (queryChanged) {
      query = search;
      cursors = [null];
      pageIndex = 0;
      pageIds = [];
      catalog = { status: "idle", nextCursor: null };
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
    invalidateRequests();
    const active = generation;
    catalog = { ...catalog, status: "loading" };
    render();
    try {
      const page = (await context.request(catalogPath, {
        method: "POST",
        readOnly: true,
        signal: requests.signal,
        body: requestBody({
          ...(cursor ? { cursor } : {}),
          ...(query ? { q: query } : {}),
        }),
      })) as PluginCatalogPage;
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      for (const entry of page.plugins) {
        entries.set(entry.id, entry);
      }
      pageIds = page.plugins.map((entry) => entry.id);
      cursors = [...cursors.slice(0, nextPageIndex), cursor ?? null];
      pageIndex = nextPageIndex;
      catalog = { status: "ready", nextCursor: page.nextCursor, setup: page.setup };
    } catch (cause) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      const error = requestFailure(cause);
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
        render();
      }
    }
  }

  async function loadTools(id: string) {
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
    render();
    try {
      const detail = (await context.request(`${catalogPath}/details`, {
        method: "POST",
        readOnly: true,
        signal: requests.signal,
        body: requestBody({ pluginId: entry.remoteId }),
      })) as PluginCatalogEntry;
      if (
        !context.isCurrent() ||
        active !== generation ||
        entries.get(id)?.remoteId !== entry.remoteId
      ) {
        return;
      }
      entries.set(id, { ...entry, ...detail, toolStatus: "loaded", toolError: undefined });
    } catch (cause) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      const error = requestFailure(cause);
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
        render();
      }
    }
  }

  render();
  return { fields, reset, update };
}
