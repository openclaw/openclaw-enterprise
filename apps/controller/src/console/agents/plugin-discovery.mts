import type { PluginCatalogEntry, PluginCatalogPage } from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import {
  type CatalogDirection,
  type CatalogEntry,
  type ManagedToolConnection,
  type ManagedToolDiscovery,
  type PluginFieldCatalog,
  type PluginFieldsOptions,
  createPluginFields,
} from "./plugin-fields.mjs";
import { withRequestId } from "../dom.mjs";
import { describeFailure, namespacePath } from "./list.mjs";

export interface PluginDiscoveryContext {
  namespaceId: string;
  // Discovery is a read-only POST. The view owner uses this flag when deciding whether to retain it.
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
}

type Message = string | (() => string);
type CatalogRequest = { cursor?: string; q?: string } | { pluginId: string };
type DiscoveryRetryAction = "Load plugins" | "Load tools" | "Retry tools";
type DiscoveryEntry = CatalogEntry & { retryAfterConflict?: true | undefined };

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

function isDiscoveryConflict(error: ReturnType<typeof requestFailure>) {
  return error.status === 409 && error.code === "RESOURCE_CONFLICT";
}

function discoveryConflictMessage(action: DiscoveryRetryAction) {
  return `Plugin discovery could not finish with the current setup. Choose ${action} to try again.`;
}

function discoveryError(
  error: ReturnType<typeof requestFailure>,
  deniedMessage: Message,
  unsupportedMessage: string,
  retryAction: DiscoveryRetryAction,
) {
  if (isDiscoveryConflict(error)) {
    return withRequestId(discoveryConflictMessage(retryAction), error.requestId);
  }
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
  // A rate limit the API itself answered says how long to wait (finding 2538).
  const fallback =
    error.status === 429
      ? describeFailure(error)
      : "Plugins could not be loaded. Check the credential and retry.";
  return withRequestId(reason ?? fallback, error.requestId);
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
  let catalog: Pick<
    PluginFieldCatalog,
    "status" | "message" | "nextCursor" | "setup" | "reloadRequired"
  > = {
    status: "idle",
    nextCursor: null,
  };
  const entries = new Map<string, DiscoveryEntry>();
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
    onLoadTools: (id, connection) => void loadTools(id, connection),
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
      if (entry.managedTools?.status === "loading") {
        entries.set(id, { ...entries.get(id)!, managedTools: undefined });
      }
    }
  }

  function invalidateHostedDetails(failedId: string, message: string) {
    // Hosted details share the catalog binding. Keep row identities for manual retry and
    // discard old tool data, including results that were still in flight at the conflict.
    invalidateRequests();
    for (const { id, name, remoteId, managedTools } of entries.values()) {
      if (remoteId) {
        const toolError = id === failedId ? message : discoveryConflictMessage("Retry tools");
        entries.set(id, {
          id,
          name,
          remoteId,
          managedTools,
          tools: null,
          toolError,
          retryAfterConflict: true,
        });
      }
    }
    render();
  }

  function resetCatalogPage(state: typeof catalog = { status: "idle", nextCursor: null }) {
    pageIds = [];
    cursors = [null];
    pageIndex = 0;
    catalog = state;
  }

  function cancel() {
    const pending = searchTimer !== undefined || catalog.status === "loading";
    invalidateRequests();
    if (pending) {
      resetCatalogPage(
        catalog.reloadRequired
          ? { ...catalog, status: "error" }
          : { status: "idle", nextCursor: null, setup: catalog.setup },
      );
    }
    render();
  }

  function scheduleSearch(q: string) {
    query = q.trim();
    if (catalog.reloadRequired) {
      // Keep the recovery action explicit while still retaining the latest query.
      cancel();
      return;
    }
    // Invalidate on input, before the delay, so an older response cannot fill this query.
    invalidateRequests();
    resetCatalogPage({ status: "idle", nextCursor: null, setup: catalog.setup });
    if (context.isCurrent() && canDiscover() && !isPending()) {
      catalog.status = "loading";
      searchTimer = setTimeout(() => {
        // A form submission or tab change can prevent this deferred read from starting.
        // Release the loading state so reopening a retained tab can load its catalog.
        if (!context.isCurrent() || isPending()) {
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
    resetCatalogPage();
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
      resetCatalogPage(catalog.reloadRequired ? catalog : undefined);
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
      if (isDiscoveryConflict(error)) {
        entries.clear();
        resetCatalogPage({ status: "error", nextCursor: null, reloadRequired: true });
      }
      catalog = {
        ...catalog,
        status: "error",
        message: discoveryError(error, deniedMessage, unsupportedMessage, "Load plugins"),
      };
    } finally {
      if (context.isCurrent() && active === generation) {
        render();
      }
    }
  }

  async function loadTools(id: string, connection?: ManagedToolConnection) {
    const entry = entries.get(id);
    if (!canDiscover() || isPending() || catalog.status === "loading" || !entry) {
      return;
    }
    const pending: ManagedToolDiscovery | undefined = connection && {
      connection,
      status: "loading",
    };
    if (pending) {
      entries.set(id, { ...entry, managedTools: pending });
    } else {
      if (!entry.remoteId || entry.toolStatus === "loading") {
        return;
      }
      entries.set(id, {
        ...entry,
        toolStatus: "loading",
        toolError: entry.retryAfterConflict ? entry.toolError : undefined,
      });
    }
    const active = generation;
    const currentEntry = () => {
      const current = entries.get(id);
      return context.isCurrent() &&
        active === generation &&
        (pending ? current?.managedTools === pending : current?.remoteId === entry.remoteId)
        ? current
        : undefined;
    };
    render();
    try {
      const detail = (await context.request(`${catalogPath}/details`, {
        method: "POST",
        readOnly: true,
        signal: requests.signal,
        body: connection
          ? { pluginId: id, managedConnection: connection }
          : requestBody({ pluginId: entry.remoteId! }),
      })) as PluginCatalogEntry | null | undefined;
      const current = currentEntry();
      if (!current) {
        return;
      }
      if (detail?.id !== id) {
        throw Object.assign(new Error("Plugin details do not match the selected plugin."), {
          code: "PLUGIN_DISCOVERY_INVALID_RESPONSE",
        });
      }
      entries.set(
        id,
        pending
          ? {
              ...current,
              managedTools: { ...pending, status: "loaded", tools: detail.tools ?? [] },
            }
          : {
              ...current,
              ...detail,
              toolStatus: "loaded",
              toolError: undefined,
              retryAfterConflict: undefined,
            },
      );
    } catch (cause) {
      const current = currentEntry();
      if (!current) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      const message = discoveryError(
        error,
        pending
          ? "Tool discovery requires Agent edit access and permission to use the selected credential."
          : deniedMessage,
        pending
          ? "Authenticated tool discovery is unavailable for this connection."
          : unsupportedMessage,
        pending ? "Load tools" : "Retry tools",
      );
      if (!pending && isDiscoveryConflict(error)) {
        invalidateHostedDetails(id, message);
        return;
      }
      entries.set(
        id,
        pending
          ? { ...current, managedTools: { ...pending, status: "error", message } }
          : { ...current, toolStatus: undefined, toolError: message },
      );
    } finally {
      if (context.isCurrent() && active === generation) {
        render();
      }
    }
  }

  render();
  return { fields, reset, update };
}
