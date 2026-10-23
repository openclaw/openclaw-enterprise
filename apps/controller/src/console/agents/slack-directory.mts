import type {
  ChannelDirectoryLookupInput,
  ChannelDirectoryResult,
} from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import { button, element, statusBlock } from "../dom.mjs";
import { namespacePath } from "./list.mjs";

const USER_ID = /^[UW][A-Z0-9]{1,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{1,31}$/;
const PAGE_SIZE = 5;
type DirectoryKind = ChannelDirectoryLookupInput["kind"];
type Candidate = ChannelDirectoryResult["candidates"][number];
type Workspace = { workspaceId: string; workspaceName?: string | undefined };

export interface SlackDirectoryContext {
  namespaceId: string;
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
}

interface DirectoryOptions {
  context: SlackDirectoryContext;
  kind: DirectoryKind;
  getSecretId(): string | null | undefined;
  agentId?: string | undefined;
  configurationId?: string | undefined;
}

interface NameState {
  names: Map<string, Candidate>;
  workspaceId?: string | undefined;
  workspaceName?: string | undefined;
  requestedIds?: readonly string[];
  truncated?: boolean;
  loading?: boolean;
  error?: string;
}

const nameLookupCache = new WeakMap<
  SlackDirectoryContext,
  Map<string, Promise<ChannelDirectoryResult>>
>();

// Both search and name resolution are reads, including when the view tracks POST as a mutation.
function lookup(
  context: SlackDirectoryContext,
  body: { secretId: string; kind: DirectoryKind; agentId?: string; configurationId?: string } & (
    { ids: string[] } | { query?: string; cursor?: string }
  ),
  signal?: AbortSignal,
) {
  return context.request(`${namespacePath(context.namespaceId)}/channel-directory/lookup`, {
    method: "POST",
    readOnly: true,
    body,
    ...(signal ? { signal } : {}),
  }) as Promise<ChannelDirectoryResult>;
}

export function isSlackId(value: string, kind: DirectoryKind) {
  return (kind === "users" ? USER_ID : CHANNEL_ID).test(value);
}

export function isSlackConfigTarget(value: string, kind: DirectoryKind) {
  const qualified = /^team:(T[A-Z0-9]+):(user|channel):([A-Z][A-Z0-9]+)$/.exec(value);
  if (qualified) {
    return (
      qualified[2] === (kind === "users" ? "user" : "channel") &&
      (kind === "users" ? /^[BUW][A-Z0-9]+$/ : /^[CDG][A-Z0-9]+$/).test(qualified[3]!)
    );
  }
  return kind === "users"
    ? /^(?:(?:user|slack):)?[BUW][A-Z0-9]+$/.test(value) || /^<@[BUW][A-Z0-9]+>$/.test(value)
    : /^(?:channel:)?[CDG][A-Z0-9]+$/.test(value);
}

function directoryTarget(
  value: string,
  kind: DirectoryKind,
): { id: string; teamId?: string } | null {
  const qualified = /^team:(T[A-Z0-9]+):(user|channel):([A-Z][A-Z0-9]+)$/i.exec(value);
  if (qualified) {
    const id = qualified[3]!.toUpperCase();
    return qualified[2]!.toLowerCase() === (kind === "users" ? "user" : "channel") &&
      isSlackId(id, kind)
      ? { id, teamId: qualified[1]!.toUpperCase() }
      : null;
  }
  const unqualified =
    kind === "users"
      ? (/^(?:(?:user|slack):)?([UW][A-Z0-9]+)$/i.exec(value) ??
        /^<@([UW][A-Z0-9]+)>$/i.exec(value))
      : /^(?:channel:)?([CG][A-Z0-9]+)$/i.exec(value);
  const id = unqualified?.[1]?.toUpperCase();
  return id && isSlackId(id, kind) ? { id } : null;
}

function searchTarget(value: string, kind: DirectoryKind) {
  // Bare Slack IDs are canonical uppercase; native saved targets may use older casings.
  if (value.length >= 8 && isSlackId(value, kind)) {
    return directoryTarget(value, kind);
  }
  return /^(?:team:|user:|slack:|channel:|<@)/i.test(value) ? directoryTarget(value, kind) : null;
}

export function matchesSlackDirectoryCandidate(
  value: string,
  kind: DirectoryKind,
  candidate: Pick<Candidate, "id"> & Workspace,
) {
  const target = directoryTarget(value, kind);
  return target?.id === candidate.id && (!target.teamId || target.teamId === candidate.workspaceId);
}

function lookupError(error: ReturnType<typeof requestFailure>, cause: unknown) {
  const reasons: Record<string, string> = {
    CHANNEL_DIRECTORY_CREDENTIALS_REJECTED:
      "The selected Secret is not a usable Slack bot token. Check the selected Secret.",
    CHANNEL_DIRECTORY_MISSING_SCOPE:
      "The Slack bot token needs users:read for people and channel read scopes for channels.",
    CHANNEL_DIRECTORY_RATE_LIMITED: "Slack rate limited the directory. Try again shortly.",
    CHANNEL_DIRECTORY_UNAVAILABLE: "Slack directory is unavailable. Try again shortly.",
    CHANNEL_DIRECTORY_INVALID_RESPONSE: "Slack returned an unexpected directory response.",
  };
  const reason = error.code ? reasons[error.code] : undefined;
  if (error.status === 403) {
    return "You need access to this Agent or Configuration and permission to use its selected Slack bot Secret.";
  }
  if (error.status === 501) {
    return "Slack directory lookup is unavailable. Ask your operator to configure the API channel directory proxy, or enter exact IDs.";
  }
  return (
    reason ?? (cause instanceof Error ? cause.message : "Slack directory could not be loaded.")
  );
}

// Names are a transient view of exact IDs; the selected Secret remains the authority for lookup.
export function createSlackNameResolver({
  context,
  kind,
  getSecretId,
  agentId,
  configurationId,
  onUpdate,
}: DirectoryOptions & { onUpdate(state: NameState): void }) {
  let generation = 0;
  const invalidate = () => {
    generation += 1;
    onUpdate({ names: new Map() });
  };
  const refresh = async (ids: readonly string[]) => {
    const active = ++generation;
    const secretId = getSecretId();
    const uniqueIds = [...new Set(ids.filter((id) => isSlackId(id, kind)))];
    const requestedIds = uniqueIds.slice(0, 20);
    const truncated = uniqueIds.length > requestedIds.length;
    onUpdate({ names: new Map(), truncated, loading: Boolean(secretId && requestedIds.length) });
    if (!secretId || requestedIds.length === 0) {
      return;
    }
    try {
      let cache = nameLookupCache.get(context);
      if (!cache) {
        cache = new Map();
        nameLookupCache.set(context, cache);
      }
      const key = JSON.stringify([
        secretId,
        kind,
        agentId ?? null,
        configurationId ?? null,
        [...requestedIds].sort(),
      ]);
      let request = cache.get(key);
      if (!request) {
        if (cache.size >= 100) {
          cache.delete(cache.keys().next().value!);
        }
        request = lookup(context, {
          secretId,
          kind,
          ids: requestedIds,
          ...(agentId ? { agentId } : {}),
          ...(configurationId ? { configurationId } : {}),
        });
        cache.set(key, request);
        // Share simultaneous fields, then reread the Secret for later views of the same ID.
        const clear = () => {
          if (cache.get(key) === request) {
            cache.delete(key);
          }
        };
        request.then(clear, clear);
      }
      const page = await request;
      if (!context.isCurrent() || active !== generation || getSecretId() !== secretId) {
        return;
      }
      const names = new Map(
        page.candidates
          .filter((candidate) => requestedIds.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate]),
      );
      onUpdate({
        names,
        workspaceId: page.workspaceId,
        workspaceName: page.workspaceName,
        requestedIds,
        truncated,
      });
    } catch (cause) {
      if (!context.isCurrent() || active !== generation) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      onUpdate({ names: new Map(), truncated, error: lookupError(error, cause) });
    }
  };
  return { refresh, invalidate };
}

// The committed control holds IDs; search text never becomes configuration by itself.
export function createSlackDirectoryField({
  context,
  kind,
  getSecretId,
  agentId,
  configurationId,
  control,
  label,
  qualifyUsers = false,
  lazyNames = false,
  onWorkspace,
}: DirectoryOptions & {
  control: HTMLInputElement;
  label: string;
  qualifyUsers?: boolean;
  lazyNames?: boolean;
  onWorkspace?(page: Workspace | null): void;
}) {
  control.type = "hidden";
  const search = element("input", {
    id: `${control.id}-search`,
    type: "text",
    role: "combobox",
    "aria-label": label,
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": `${control.id}-results`,
    autocomplete: "off",
    placeholder: qualifyUsers
      ? "Search people…"
      : kind === "channels"
        ? "Search channels or paste IDs…"
        : "Search people or paste IDs…",
  });
  const chips = element("div", { className: "slack-directory-chips" });
  const nameStatus = element("p", { className: "hint", role: "status" });
  const workspace = element("p", { className: "hint slack-directory-workspace" });
  const status = element("p", { className: "hint", role: "status" });
  const errorText = statusBlock("danger", null, null);
  const results = element("div", {
    id: `${control.id}-results`,
    className: "slack-directory-results",
    role: "listbox",
    "aria-label": `${label} results`,
    "aria-multiselectable": "true",
  });
  const addExact = button("Add exact ID", () => {
    search.focus();
    commitManual();
  });
  const previous = button("Previous page", () => {
    search.focus();
    void load(pageIndex - 1);
  });
  const next = button("Next page", () => {
    search.focus();
    void load(pageIndex + 1);
  });
  const pagination = element(
    "div",
    { className: "slack-directory-pagination", hidden: true },
    previous,
    next,
  );
  const panel = element(
    "div",
    { className: "slack-directory-panel", hidden: true },
    addExact,
    status,
    errorText,
    results,
    pagination,
  );
  const field = element(
    "div",
    { className: "slack-directory-field" },
    element("label", { for: search.id }, label),
    control,
    element("div", { className: "slack-directory-input" }, chips, search),
    panel,
    workspace,
    nameStatus,
  );
  let nameState: NameState = { names: new Map() };
  let namesActive = !lazyNames;
  let boundSecretId = getSecretId();
  let workspaceIdentity: string | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | null = null;
  let pageIndex = 0;
  let pages: ChannelDirectoryResult[] = [];
  let query = "";
  let nextCursor: string | null = null;
  let searchAsName = false;
  let activeOption = -1;
  const values = () => [
    ...new Set(
      control.value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const manualValues = () =>
    search.value
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  const validManual = (id: string) =>
    qualifyUsers
      ? /^(?:[UW][A-Z0-9]{1,31}|team:T[A-Z0-9]{1,31}:user:[UW][A-Z0-9]{1,31})$/.test(id)
      : isSlackConfigTarget(id, kind);
  const current = (active: number, secretId: string) =>
    !panel.hidden && context.isCurrent() && active === generation && getSecretId() === secretId;

  function updateWorkspace(page: Workspace) {
    workspaceIdentity = page.workspaceId;
    if (nameState.workspaceId && nameState.workspaceId !== page.workspaceId) {
      nameState = { names: new Map(), workspaceId: page.workspaceId };
      renderValues();
    }
    if (onWorkspace) {
      onWorkspace(page);
    } else {
      workspace.textContent = `Workspace: ${page.workspaceName || page.workspaceId}`;
      workspace.title = page.workspaceId;
    }
  }
  function cancelSearch() {
    clearTimeout(timer);
    generation += 1;
    requestController?.abort();
    requestController = null;
  }
  function close() {
    cancelSearch();
    panel.hidden = true;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    activeOption = -1;
    nameStatus.style.visibility = "visible";
  }
  function renderValues() {
    let resolvingNames = false;
    chips.replaceChildren(
      ...values().map((id, index) => {
        const target = directoryTarget(id, kind);
        const candidate =
          target && (!target.teamId || target.teamId === nameState.workspaceId)
            ? nameState.names.get(target.id)
            : null;
        let name = id;
        if (candidate) {
          name =
            kind === "channels"
              ? `#${candidate.name}`
              : candidate.displayName
                ? `${candidate.displayName} (@${candidate.name})`
                : `@${candidate.name}`;
        } else {
          resolvingNames ||= nameState.loading === true;
          if (qualifyUsers) {
            name = nameState.loading ? "Loading name…" : "Name unavailable";
          }
        }
        const removeLabel = !qualifyUsers
          ? id
          : candidate
            ? name
            : `selected person ${index + 1} (${name.toLowerCase()})`;
        return element(
          "span",
          {
            className: "slack-directory-chip",
            "data-value": id,
            ...(qualifyUsers ? {} : { title: id }),
          },
          element("span", {}, name),
          button("×", () => commit(values().filter((value) => value !== id)), {
            "aria-label": `Remove ${removeLabel}`,
            disabled: control.disabled,
          }),
        );
      }),
    );
    search.disabled = control.disabled;
    if (control.disabled) {
      close();
    }
    const mismatched = values().some((id) => {
      const target = directoryTarget(id, kind);
      return target?.teamId && nameState.workspaceId && target.teamId !== nameState.workspaceId;
    });
    nameStatus.textContent = nameState.error
      ? `${nameState.error} Saved selections are retained.`
      : resolvingNames
        ? "Resolving saved names…"
        : mismatched
          ? "Some saved selections belong to another workspace."
          : !getSecretId()
            ? "Select a Slack bot token Secret to search by name. You can still paste exact IDs."
            : "";
    if (nameState.truncated) {
      nameStatus.textContent += " Name lookup includes the first 20 selections.";
    }
  }
  const resolver = createSlackNameResolver({
    context,
    kind,
    getSecretId,
    agentId,
    configurationId,
    onUpdate: (state) => {
      // A limited lookup cannot update names it did not request. Never carry names across workspaces.
      if (
        qualifyUsers &&
        state.requestedIds &&
        state.truncated &&
        state.workspaceId === nameState.workspaceId
      ) {
        for (const [id, candidate] of nameState.names) {
          if (!state.requestedIds.includes(id)) {
            state.names.set(id, candidate);
          }
        }
      }
      nameState =
        qualifyUsers && (state.loading || state.error)
          ? { ...state, names: nameState.names, workspaceId: nameState.workspaceId }
          : state;
      if (state.workspaceId) {
        updateWorkspace({ workspaceId: state.workspaceId, workspaceName: state.workspaceName });
      }
      renderValues();
    },
  });
  function refresh() {
    if (boundSecretId !== getSecretId()) {
      boundSecretId = getSecretId();
      nameState = { names: new Map() };
      workspaceIdentity = null;
      workspace.textContent = "";
      onWorkspace?.(null);
      close();
    }
    renderValues();
    if (namesActive) {
      void resolver.refresh(
        values()
          .map((id) => directoryTarget(id, kind)?.id)
          .filter((id) => id !== undefined),
      );
    }
  }
  function commit(ids: readonly string[]) {
    control.value = [...new Set(ids)].join(", ");
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    search.value = "";
    close();
  }
  function commitManual() {
    const ids = manualValues();
    if (!ids.length || !ids.every(validManual)) {
      errorText.textContent = qualifyUsers
        ? "Enter Slack user IDs such as U123 or full selectors such as team:T123:user:U456."
        : "Choose a search result or paste exact Slack IDs, separated by commas or spaces.";
      return;
    }
    if (
      qualifyUsers &&
      boundSecretId === getSecretId() &&
      workspaceIdentity &&
      ids.some((id) => {
        const teamId = directoryTarget(id, kind)?.teamId;
        return teamId && teamId !== workspaceIdentity;
      })
    ) {
      errorText.textContent = `This bot belongs to workspace ${workspaceIdentity}. Enter a user in that workspace.`;
      return;
    }
    commit([...values(), ...ids]);
  }
  function selectCandidate(candidate: Candidate & Workspace) {
    const id = qualifyUsers ? `team:${candidate.workspaceId}:user:${candidate.id}` : candidate.id;
    const selected = values();
    if (qualifyUsers) {
      // The directory result supplies the label now; only the workspace-qualified ID is committed.
      if (candidate.workspaceId !== workspaceIdentity) {
        // A concurrent name lookup may have discovered that the bot changed workspaces.
        void startSearch();
        return;
      }
      if (candidate.workspaceId !== nameState.workspaceId) {
        nameState = { workspaceId: candidate.workspaceId, names: new Map() };
      }
      nameState.names.set(candidate.id, candidate);
    }
    search.focus();
    commit(
      selected.some((value) => matchesSlackDirectoryCandidate(value, kind, candidate))
        ? selected
        : [...selected, id],
    );
  }
  function prepareSearch() {
    cancelSearch();
    panel.hidden = false;
    nameStatus.style.visibility = "hidden";
    search.setAttribute("aria-expanded", "true");
    search.removeAttribute("aria-activedescendant");
    activeOption = -1;
    results.replaceChildren();
    pagination.hidden = true;
    errorText.textContent = "";
    const ids = manualValues();
    addExact.hidden = !ids.length || !ids.every(validManual);
    addExact.textContent =
      ids.length > 1 ? `Add ${ids.length} exact IDs` : `Add ${ids[0] || "exact ID"}`;
    status.textContent = getSecretId()
      ? "Searching Slack directory…"
      : "Select a Slack bot token Secret to search by name. You can still paste exact IDs.";
    query = search.value.trim();
    pages = [];
    pageIndex = 0;
    nextCursor = null;
    searchAsName = false;
  }
  function startSearch() {
    prepareSearch();
    return load(0);
  }
  async function load(index: number): Promise<void> {
    const secretId = getSecretId();
    if (!secretId || (index >= pages.length && pages.length > 0 && !nextCursor)) {
      return;
    }
    cancelSearch();
    const searchWorkspace = workspaceIdentity;
    const exactTarget = searchAsName ? null : searchTarget(query, kind);
    const active = generation;
    activeOption = -1;
    search.removeAttribute("aria-activedescendant");
    previous.disabled = true;
    next.disabled = true;
    results.replaceChildren();
    pagination.hidden = true;
    status.textContent = "Searching Slack directory…";
    errorText.textContent = "";
    try {
      let page = pages[index];
      if (!page) {
        requestController = new AbortController();
        const signal = requestController.signal;
        const requestPage = (selection: { ids: string[] } | { query?: string; cursor?: string }) =>
          lookup(
            context,
            {
              secretId,
              kind,
              ...selection,
              ...(agentId ? { agentId } : {}),
              ...(configurationId ? { configurationId } : {}),
            },
            signal,
          );
        let searchedAsName = exactTarget === null;
        page = await requestPage(
          exactTarget
            ? { ids: [exactTarget.id] }
            : { ...(query ? { query } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) },
        );
        if (
          exactTarget &&
          query.length >= 8 &&
          isSlackId(query, kind) &&
          page.candidates.length === 0 &&
          current(active, secretId)
        ) {
          const exactWorkspaceId = page.workspaceId;
          page = await requestPage({ query });
          if (page.workspaceId !== exactWorkspaceId) {
            if (current(active, secretId)) {
              status.textContent = "The Slack bot workspace changed. Search again.";
            }
            return;
          }
          searchedAsName = true;
        }
        if (!current(active, secretId)) {
          return;
        }
        if (
          qualifyUsers &&
          workspaceIdentity !== searchWorkspace &&
          workspaceIdentity !== page.workspaceId
        ) {
          // A newer name lookup observed a different workspace while this search was pending.
          return startSearch();
        }
        if (index > 0 && workspaceIdentity && workspaceIdentity !== page.workspaceId) {
          status.textContent = "The Slack bot workspace changed. Search again.";
          return;
        }
        searchAsName = searchedAsName;
        nextCursor = page.nextCursor ?? null;
        const candidates = page.candidates.filter((candidate) => isSlackId(candidate.id, kind));
        // Keep every match from the provider batch before following its continuation cursor.
        // An empty batch still gets a page so a sparse search can continue explicitly.
        for (let offset = 0; offset < Math.max(candidates.length, 1); offset += PAGE_SIZE) {
          pages.push({ ...page, candidates: candidates.slice(offset, offset + PAGE_SIZE) });
        }
        page = pages[index]!;
      }
      updateWorkspace(page);
      pageIndex = index;
      const wrongWorkspace = exactTarget?.teamId && exactTarget.teamId !== page.workspaceId;
      const candidates = wrongWorkspace ? [] : page.candidates;
      const hasNext = index + 1 < pages.length || Boolean(nextCursor);
      results.replaceChildren(
        ...candidates.map((candidate, index) => {
          const selected = values().some((id) =>
            matchesSlackDirectoryCandidate(id, kind, {
              ...candidate,
              workspaceId: page.workspaceId,
            }),
          );
          return button(
            element(
              "span",
              {},
              element(
                "strong",
                {},
                kind === "channels"
                  ? `#${candidate.name}`
                  : candidate.displayName || candidate.name,
              ),
              kind === "users"
                ? element("span", { className: "hint" }, `@${candidate.name}`)
                : null,
              qualifyUsers ? null : element("code", {}, candidate.id),
              selected ? element("span", {}, "Selected") : null,
            ),
            () => selectCandidate({ ...candidate, workspaceId: page.workspaceId }),
            {
              id: `${control.id}-option-${index}`,
              role: "option",
              "aria-selected": String(selected),
              tabindex: "-1",
              className: "slack-directory-result",
            },
          );
        }),
      );
      status.textContent = wrongWorkspace
        ? `That ID belongs to workspace ${exactTarget.teamId}; this bot belongs to ${page.workspaceId}.`
        : candidates.length
          ? `${candidates.length} result${candidates.length === 1 ? "" : "s"}${hasNext ? " · more results may be available" : ""}`
          : !hasNext
            ? "No matches found. Try another name or paste an exact ID."
            : "No results on this page. More results may be available.";
      pagination.hidden = index === 0 && !hasNext;
      previous.disabled = index === 0;
      next.disabled = !hasNext;
    } catch (cause) {
      if (!current(active, secretId)) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      errorText.textContent = lookupError(error, cause);
      status.textContent = "You can still add an exact ID above.";
    }
  }
  search.addEventListener("focus", () => {
    if (panel.hidden) {
      void startSearch();
    }
  });
  search.addEventListener("input", () => {
    prepareSearch();
    timer = setTimeout(() => {
      if (field.isConnected && context.isCurrent()) {
        void load(0);
      }
    }, 300);
  });
  search.addEventListener("keydown", (event) => {
    const options = [...results.querySelectorAll("button")];
    if (!panel.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
      event.preventDefault();
      activeOption =
        activeOption < 0
          ? event.key === "ArrowDown"
            ? 0
            : options.length - 1
          : (activeOption + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options.forEach((option, index) => option.classList.toggle("active", index === activeOption));
      const active = options[activeOption]!;
      search.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = options[activeOption];
      if (!panel.hidden && active) {
        active.click();
      } else if (manualValues().length && manualValues().every(validManual)) {
        commitManual();
      } else {
        void startSearch();
      }
    }
  });
  field.addEventListener("focusout", (event) => {
    // Access revalidation makes this view inert before restoring input focus.
    // Keep the open search through that blur or a browser tab switch.
    if (
      !(event.relatedTarget instanceof Node && field.contains(event.relatedTarget)) &&
      !field.closest("[inert]") &&
      document.hasFocus()
    ) {
      close();
    }
  });
  control.addEventListener("change", refresh);
  refresh();
  return Object.assign(field, {
    refreshValue: refresh,
    refreshNames() {
      namesActive = true;
      refresh();
    },
    pauseNames() {
      namesActive = false;
      resolver.invalidate();
      close();
    },
  });
}
