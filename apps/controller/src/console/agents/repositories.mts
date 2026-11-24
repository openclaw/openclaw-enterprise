import type {
  RepositoryAccess,
  RepositoryBindingSelection,
  RepositoryOption as CatalogOption,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";
import { resourceActionIcon } from "../resource-actions.mjs";
import { requestFailure, responseFields } from "../api-client.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import { element, button, field, setStatusTone } from "../dom.mjs";
import {
  AGENT_CREATE_DENIED,
  askAdministratorTo,
  REPOSITORY_CHOICES_AGENT_DENIED,
} from "./access-reasons.mjs";
import { describeFailure, namespacePath } from "./list.mjs";
import { visibleText } from "./logs-view.mjs";
import {
  repositoryProfiles,
  repositoryProfile,
  repositoryWriteAccessHelp,
} from "./repository-profiles.mjs";

export function repositorySelections(access: RepositoryAccess | undefined) {
  return (
    access?.repositories.map(({ repositoryRef, profile }) => ({
      repositoryRef,
      profile: profile ?? access.defaultProfile,
    })) ?? []
  );
}

type RepositoryOption = CatalogOption & { githubAccess?: RepositoryNetworkGrant };

type RepositoryContext = Pick<NamespacePageContext, "request" | "isCurrent" | "onExpired"> & {
  namespaceId: string;
  operatorId?: string;
  installationAdmin?: boolean | null;
};

export const FIRST_REPOSITORY_DEPLOYMENT_WARNING =
  "Deploying without a repository policy can require a new Agent to add per-repository access later.";

// An Installation without repository access (no Repo Driver selected, or draft-only discovery).
const REPOSITORY_ACCESS_NOT_CONFIGURED =
  "This Installation has no repository access, so this Agent cannot use repositories.";
// Create Agent holds the new-Agent read until the permission answer allows Agent create: the API
// refuses it otherwise, and audits each refusal (finding 2909).
const REPOSITORY_CHOICES_HELD = "Repository choices load after your permission check.";
const REPOSITORY_SETUP_GUIDE =
  "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md";

interface SearchState {
  query: string;
  browsing: boolean;
  dismissed: boolean;
  page: number;
}

type DiscoveryFailure = "denied" | "conflict" | "draft-only" | "not-configured" | "unavailable";
type LoadResult = "success" | "obsolete" | "expired" | "denied" | "conflict" | "unavailable";

interface PickerState {
  options: readonly RepositoryOption[];
  /** A null override inherits the Agent default. Preserve unapproved selections for explicit repair. */
  selected: Map<string, string | null>;
  profile: string;
  discovery: "held" | "loading" | "ready" | DiscoveryFailure;
  disabled: boolean;
  showAll: boolean;
  expanded: Set<string>;
  undo: { ref: string; override: string | null; index: number } | undefined;
}

const MAX_SELECTED = 16;
const PAGE_SIZE = 20;
const RECENT_LIMIT = 32;
// A description shows like a log line (visibleText escapes invisible and bidi characters), except
// for the joiners and the England, Scotland and Wales flags (group 1), so emoji and Persian
// or Indic words display intact.
const DESCRIPTION_CHARACTER =
  /((?<=[\p{L}\p{M}\p{S}])[\u200c\u200d](?=[\p{L}\p{M}\p{S}])|\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f})|[^]/gu;

function descriptionText(value: string) {
  return value.replace(
    DESCRIPTION_CHARACTER,
    (character: string, kept: string | undefined) => kept ?? visibleText(character),
  );
}

function repositoryDescription(value: string | undefined) {
  return value?.trim()
    ? element("span", { className: "repository-description" }, descriptionText(value))
    : null;
}

function grantIdentity(name: string, description?: string) {
  return element(
    "span",
    { className: "repository-identity" },
    resourceActionIcon("repository"),
    element("strong", {}, name),
    repositoryDescription(description),
  );
}

// Search casing that does not follow the browser locale (#2317): en-US lower case, where the
// Turkish capital İ lowers to i and a combining dot above, so the dot is dropped, and the
// dotless ı reads as i, so a query of İstanbul or ıstanbul finds istanbul (finding 1252).
const searchCase = (value: string) =>
  value.toLocaleLowerCase("en-US").replaceAll("ı", "i").replaceAll("i\u0307", "i");

function recentRepositories(key: string | undefined): string[] {
  if (!key) {
    return [];
  }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(stored)
      ? stored
          .filter((ref: unknown): ref is string => typeof ref === "string")
          .slice(0, RECENT_LIMIT)
      : [];
  } catch {
    // Browser storage is optional; discovery remains usable when it is unavailable.
    return [];
  }
}

function repositoryResults(
  options: readonly RepositoryOption[],
  recent: readonly string[],
  { query: queryText, browsing, page: requestedPage }: SearchState,
) {
  const small = options.length <= 5;
  const query = searchCase(queryText.trim());
  const rank = (entry: RepositoryOption) => {
    const names = [entry.displayName, entry.repositoryRef].flatMap((value) => {
      const name = searchCase(value);
      return [name, name.slice(name.lastIndexOf("/") + 1)];
    });
    if (names.includes(query)) {
      return 0;
    }
    return names.some((name) => name.startsWith(query)) ? 1 : 2;
  };
  const priority = (entry: RepositoryOption) => {
    if (query) {
      return rank(entry);
    }
    if (small || browsing) {
      return 0;
    }
    const index = recent.indexOf(entry.repositoryRef);
    return index === -1 ? RECENT_LIMIT : index;
  };
  const matches = options
    .filter(
      (entry) =>
        !query ||
        [entry.displayName, entry.repositoryRef].some((v) => searchCase(v).includes(query)),
    )
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        a.displayName.localeCompare(b.displayName) ||
        a.repositoryRef.localeCompare(b.repositoryRef),
    );
  const count = browsing && !small ? PAGE_SIZE : Math.min(options.length, 6);
  const pageCount = count === 0 ? 0 : Math.ceil(matches.length / count);
  const page = Math.min(requestedPage, Math.max(0, pageCount - 1));
  const visible = matches.slice(page * count, (page + 1) * count);
  return { small, query, matches, count, page, visible };
}

function discoveryFailure(
  error: ReturnType<typeof requestFailure>,
  { allowDraft, agentScoped }: { allowDraft: boolean; agentScoped: boolean },
): DiscoveryFailure {
  if (error.status === 403) {
    return "denied";
  }
  if (error.status === 409) {
    return "conflict";
  }
  // The API answers this code only for the Installation's fixed composition (no compatible
  // Compute or Sandbox Driver), so retrying cannot succeed until an operator changes it.
  if (error.status === 503 && error.code === "REPOSITORY_OPTIONS_UNAVAILABLE") {
    if (allowDraft) {
      return "draft-only";
    }
    if (agentScoped) {
      return "not-configured";
    }
  }
  return "unavailable";
}

function validOptions(value: unknown): value is RepositoryOption[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const refs = new Set<string>();
  return value.every((entry: unknown) => {
    const { repositoryRef, displayName, description, allowedProfiles } = responseFields(entry);
    if (
      typeof repositoryRef !== "string" ||
      !repositoryRef ||
      typeof displayName !== "string" ||
      (description !== undefined && typeof description !== "string") ||
      !Array.isArray(allowedProfiles) ||
      allowedProfiles.length === 0 ||
      !allowedProfiles.every(
        (id: unknown) => id === "github-installation" || repositoryProfile(id),
      ) ||
      refs.has(repositoryRef)
    ) {
      return false;
    }
    refs.add(repositoryRef);
    return true;
  });
}

export function createRepositoryFields(
  context: RepositoryContext,
  onChange: (edited: boolean) => void,
  initial: {
    agentId?: string;
    repositoryAccess?: RepositoryAccess;
    scopedGrants?: [string, RepositoryNetworkGrant][] | undefined;
  } = {},
  // Read no choices until start(): Create Agent's permission answer is not known yet.
  { held = false }: { held?: boolean } = {},
) {
  const intent = initial.repositoryAccess;
  const recentKey = context.operatorId
    ? `oce.repository-recency:${JSON.stringify([context.operatorId, context.namespaceId])}`
    : undefined;
  let recent = recentRepositories(recentKey);
  const state: PickerState = {
    options: [],
    selected: new Map(
      intent?.repositories.map(({ repositoryRef, profile }) => [repositoryRef, profile ?? null]),
    ),
    profile: intent?.defaultProfile ?? "git-full",
    discovery: held ? "held" : "loading",
    disabled: false,
    showAll: false,
    expanded: new Set(),
    undo: undefined,
  };
  // Set before any render: a held form renders before its first read (finding 2909).
  let searchState: SearchState = { query: "", browsing: false, dismissed: false, page: 0 };
  let loadGeneration = 0;
  let loadedAfterReset = false;
  const status = element(
    "p",
    { className: "hint", role: "status" },
    held ? REPOSITORY_CHOICES_HELD : "Loading approved repositories…",
  );
  const validation = element("p", {
    className: "status",
    "data-tone": "danger",
    role: "alert",
    hidden: true,
  });
  const choices = element("div", {
    className: "repository-options",
    "aria-busy": held ? "false" : "true",
  });
  const cards = element("div", { className: "repository-selected" });
  const announcements = element("p", { className: "hint", role: "status", "aria-live": "polite" });
  const search = element("input", {
    id: "repository-search",
    type: "search",
    autocomplete: "off",
    placeholder: "Search by repository or owner…",
    "aria-controls": "repository-results",
  });
  const results = element("div", { id: "repository-results" });
  const discovery = element("div", { className: "repository-discovery" });
  const access = element("fieldset", { className: "repository-profile-group" });
  const retry = button("Retry repository choices", async () => {
    if (state.disabled || !isSettled()) {
      return;
    }
    const loading = load();
    onChange(false);
    await loading;
  });
  retry.hidden = true;
  const mode = element(
    "select",
    { id: "repository-mode", "aria-describedby": "repository-mode-help" },
    element("option", { value: "scoped" }, "Per-repository access"),
    element("option", { value: "profiles" }, "Access profiles"),
  );
  const scoped = () => mode.value === "scoped";
  const hasPolicy = () => scoped() && state.selected.size > 0;
  // Only a new, blank picker can default to policy. Never reinterpret a Preset,
  // a restored selection or a creator's explicit choice on catalog refresh.
  let chooseDefault = !initial.agentId && !intent && !state.selected.size && !initial.scopedGrants;
  const grants = new Map(initial.scopedGrants);
  mode.value = intent?.githubAppClientId || initial.scopedGrants ? "scoped" : "profiles";
  let selectedClientId = intent?.githubAppClientId ?? "";
  let clientState: "idle" | "loading" | "ready" | "failed" = "idle";
  let clients: { id: string; displayName: string; appId: string }[] = [];
  const clientSelect = element("select", { id: "github-app-client" });
  const clientStatus = element("p", { className: "hint", role: "status" });
  const retryClients = button("Retry GitHub App Clients", () => void loadClients());
  const clientField = element(
    "div",
    {},
    field({
      label: "GitHub App Client",
      control: clientSelect,
      help: "Choose a registered App. OCE creates the finite GitHub credential Source when you deploy; its key and token stay outside the Agent.",
    }),
    clientStatus,
    retryClients,
  );
  clientSelect.addEventListener("change", () => {
    selectedClientId = clientSelect.value;
    changed();
  });
  async function loadClients() {
    if (context.installationAdmin !== true || clientState === "loading") {
      return;
    }
    clientState = "loading";
    renderClient();
    try {
      const result = await context.request("/oauth-clients", {
        installationAdministration: "required",
        expectedStatus: 200,
      });
      if (!context.isCurrent()) {
        return;
      }
      if (!Array.isArray(result)) {
        throw new Error("Invalid Client catalog response.");
      }
      clients = result.flatMap((entry) => {
        const item = responseFields(entry);
        return item.kind === "github-app" &&
          typeof item.id === "string" &&
          typeof item.displayName === "string" &&
          typeof item.appId === "string"
          ? [{ id: item.id, displayName: item.displayName, appId: item.appId }]
          : [];
      });
      clientState = "ready";
    } catch (error) {
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        clientState = "failed";
        clientStatus.textContent = `GitHub App Clients could not be loaded. ${describeFailure(error)} Retry the Client list.`;
        setStatusTone(clientStatus, "danger");
      }
    } finally {
      renderClient();
      onChange(false);
    }
  }
  function renderClient() {
    clientField.hidden = !hasPolicy();
    if (clientField.hidden) {
      return;
    }
    if (context.installationAdmin === true && clientState === "idle") {
      void loadClients();
    }
    const entries = clients.map((item) =>
      element("option", { value: item.id }, `${item.displayName} (App ${item.appId})`),
    );
    if (selectedClientId && !clients.some(({ id }) => id === selectedClientId)) {
      entries.push(
        element(
          "option",
          {
            value: selectedClientId,
            disabled: context.installationAdmin === true && clientState === "ready",
          },
          context.installationAdmin === true && clientState === "ready"
            ? "Unavailable GitHub App Client"
            : "Saved GitHub App Client",
        ),
      );
    }
    clientSelect.replaceChildren(
      element("option", { value: "" }, "Select a GitHub App Client"),
      ...entries,
    );
    clientSelect.value = selectedClientId;
    clientSelect.disabled =
      state.disabled || context.installationAdmin !== true || clientState === "loading";
    retryClients.hidden = clientState !== "failed";
    retryClients.disabled = state.disabled;
    if (clientState !== "failed") {
      setStatusTone(clientStatus, null);
      clientStatus.textContent =
        clientState === "loading"
          ? "Loading registered GitHub App Clients…"
          : context.installationAdmin !== true && !selectedClientId
            ? "Ask an Installation administrator to select a GitHub App Client."
            : clientState === "ready" && !clients.length
              ? "Register a GitHub App Client in Credentials before saving repository access."
              : "";
    }
  }
  function validClient() {
    return (
      Boolean(selectedClientId) &&
      (context.installationAdmin !== true ||
        (clientState === "ready" && clients.some(({ id }) => id === selectedClientId)))
    );
  }
  const scopeHint = element("p", { className: "hint", id: "repository-mode-help" });
  const modeField = element(
    "div",
    { className: "field" },
    element("label", { for: mode.id }, "Repository access mode"),
    mode,
    scopeHint,
  );
  mode.addEventListener("change", () => {
    if (scoped()) {
      for (const ref of state.selected.keys()) {
        selectDefault(ref);
      }
    }
    changed();
  });
  const section = element(
    "section",
    {
      className: "repository-selection",
      "aria-labelledby": "repository-selection-title",
      tabindex: "-1",
    },
    element("h2", { id: "repository-selection-title" }, "Repository access"),
    status,
    retry,
    modeField,
    access,
    choices,
    cards,
    clientField,
    announcements,
    validation,
    initial.agentId
      ? null
      : element(
          "details",
          { className: "repository-access-details" },
          element("summary", {}, "Runtime support and access limits"),
          element(
            "p",
            { className: "hint" },
            "Embedded OpenClaw and Dedicated Codex on Kubernetes, without a Sandbox Driver. Deployment rechecks runtime compatibility. Model authentication is configured separately.",
          ),
          element(
            "p",
            { className: "hint" },
            "GitHub App keys and installation tokens stay outside the Agent. The Agent receives bounded gateway authentication material and client configuration.",
          ),
          element(
            "p",
            { className: "hint" },
            "API access is bounded by the selected level and installation token. GraphQL can also return public information allowed by GitHub. Unselected private repositories remain outside the grant.",
          ),
        ),
  );
  const option = (ref: string) => state.options.find((entry) => entry.repositoryRef === ref);
  // Only new selections may derive the collaborator profile from the Contributor default.
  // Keep this intent through remove/undo; saved inheritance is never inferred from discovery.
  const newCollaborators = new Set<string>();
  const githubLimit = (entry: RepositoryOption | undefined) =>
    entry?.allowedProfiles.includes("github-repository") &&
    typeof entry.githubAccess?.repository === "string" &&
    Object.keys(entry.githubAccess).length === 2 &&
    ["read", "write"].includes(entry.githubAccess.access)
      ? entry.githubAccess
      : undefined;
  const githubName = (ref: string) => githubLimit(option(ref))?.repository;
  // Never derive a grant from a refreshed ceiling. Default only when the
  // creator selects a repository or opts into policy for selected repositories.
  function selectDefault(ref: string) {
    const limit = githubLimit(option(ref));
    if (limit && !grants.has(ref)) {
      grants.set(ref, limit);
    }
  }
  const effective = (ref: string) =>
    scoped()
      ? "github-repository"
      : (state.selected.get(ref) ??
        (newCollaborators.has(ref) && state.profile === "git-full"
          ? "github-repository"
          : state.profile));
  const initialAccess = JSON.stringify(accessIntent());
  const invalid = (ref: string) =>
    scoped()
      ? !githubName(ref) ||
        githubName(ref) !== grants.get(ref)?.repository ||
        (grants.get(ref)?.access === "write" && githubLimit(option(ref))?.access !== "write")
      : !option(ref)?.allowedProfiles.includes(effective(ref));
  const profileLabel = (profile: string) =>
    repositoryProfile(profile)?.label ?? "Unknown access level";
  const isSettled = () => state.discovery !== "loading" && state.discovery !== "held";
  // Without repository settings the API still accepts an empty binding list, so removing every
  // selection unblocks Create Agent and the Repositories tab's Save (findings 2397, 2398).
  const blocksCreate = () =>
    !["held", "loading", "ready", "draft-only", "not-configured"].includes(state.discovery) ||
    (state.discovery === "not-configured" && state.selected.size > 0);
  const editable = () => !state.disabled && isSettled() && !blocksCreate();
  const isDirty = () => JSON.stringify(accessIntent()) !== initialAccess;

  // Why a selected repository has no current option.
  function unlistedSelectionText() {
    switch (state.discovery) {
      case "ready":
        return "This repository is no longer available. Remove it or retry discovery.";
      case "loading":
        return "Checking repository availability…";
      case "held":
        return REPOSITORY_CHOICES_HELD;
      case "not-configured":
        return "Repository availability cannot be verified because repository access is not available in this Installation's configuration.";
      default:
        return "Repository availability cannot be verified. Retry repository choices.";
    }
  }

  function accessSummary(ref: string, override: string | null) {
    if (!isSettled() || blocksCreate()) {
      return "Access awaiting verification";
    }
    if (invalid(ref)) {
      return "Choose approved access";
    }
    return `${profileLabel(effective(ref))} · ${override === null ? "Agent default" : "Custom"}`;
  }

  // Red only for a choice that is not approved. Loading choices is not a problem, and a failed
  // read is a warning, not a refusal (finding 1970).
  function accessTone(ref: string) {
    if (!isSettled()) {
      return "info";
    }
    if (blocksCreate()) {
      return "warning";
    }
    return invalid(ref) ? "danger" : "info";
  }

  function resetSearch() {
    searchState = { query: "", browsing: false, dismissed: false, page: 0 };
    search.value = "";
  }

  function revealInvalidSelections() {
    for (const ref of state.selected.keys()) {
      if (invalid(ref)) {
        state.expanded.add(ref);
      }
    }
  }

  function changed({ preserveResults = false } = {}) {
    if (state.discovery === "draft-only" || state.discovery === "not-configured") {
      showSetupLink();
    }
    validation.hidden = true;
    revealInvalidSelections();
    render({ preserveResults });
    onChange(true);
  }
  function controls(
    profile: string,
    allowed: readonly string[],
    id: string,
    change: (profile: string) => void,
  ) {
    const group = element("div", { className: "repository-profiles" });
    const contributor = allowed.includes("github-repository")
      ? "github-repository"
      : allowed.includes("git-full")
        ? "git-full"
        : "git-write";
    for (const [value, title, help] of [
      ["git-read", "Read-only", "Read code, pull requests, and issues."],
      [
        "git-full",
        "Contributor",
        profile === "git-write" || !allowed.includes("git-full")
          ? "Push code and work with pull requests."
          : "Push code, work with pull requests, and manage issues.",
      ],
    ] as const) {
      const writable = value !== "git-read";
      const input = element("input", {
        id: `${id}-${value}`,
        type: "radio",
        name: id,
        value,
        checked:
          allowed.includes(profile) && (writable ? profile !== "git-read" : profile === value),
        disabled:
          !editable() ||
          (writable ? !allowed.some((p) => p !== "git-read") : !allowed.includes(value)),
      });
      input.addEventListener("change", () => {
        change(writable ? contributor : value);
        document.getElementById(input.id)?.focus();
      });
      group.append(
        element(
          "label",
          { className: "repository-profile", for: input.id },
          input,
          element(
            "span",
            {},
            element("strong", {}, title),
            element("span", { className: "hint" }, help),
          ),
        ),
      );
    }
    const issue = element("input", {
      type: "checkbox",
      id: `${id}-issues`,
      checked: profile === "git-full",
      disabled: !editable() || !allowed.includes("git-full") || !allowed.includes("git-write"),
    });
    issue.addEventListener("change", () => {
      change(issue.checked ? "git-full" : "git-write");
      document.getElementById(issue.id)?.focus();
    });
    const details = element(
      "details",
      {
        className: "repository-customize",
        "data-access-customize": id,
        hidden: profile === "git-read" || profile === "github-repository",
      },
      element(
        "summary",
        {},
        element("span", { className: "repository-chevron", "aria-hidden": "true" }),
        "Customize access",
      ),
      element(
        "label",
        { className: "repository-option", for: issue.id },
        issue,
        "Create and manage issues",
      ),
      element(
        "p",
        { className: "hint" },
        !allowed.includes("git-full")
          ? "Issue management is not approved for this repository."
          : !allowed.includes("git-write")
            ? "Issue management is required by the approved Contributor profile."
            : "Push code and pull request access are included together. Issue management is optional.",
      ),
      element("p", { className: "hint repository-write-access" }, repositoryWriteAccessHelp),
    );
    return [group, details];
  }
  function renderAccess() {
    modeField.hidden =
      !scoped() &&
      (Boolean(initial.agentId) ||
        context.installationAdmin === false ||
        !state.options.some(githubLimit));
    mode.disabled = state.disabled;
    scopeHint.textContent = scoped()
      ? "Read-only Git permits clone and fetch. Read/write Git also permits push. Neither option grants GitHub REST or pull request access."
      : "After deploying with access profiles, you need a new Agent to switch to Per-repository access.";
    const help = section.querySelector<HTMLElement>(".repository-access-details");
    if (help) {
      help.hidden = scoped();
    }
    access.hidden = scoped() || (!state.options.length && !state.selected.size);
    if (scoped()) {
      access.replaceChildren();
      return;
    }
    const expanded = access.querySelector("details")?.open;
    const allowed = repositoryProfiles.filter((p) => p.id !== "github-repository").map((p) => p.id);
    const custom = [...state.selected].filter(
      ([ref, profile]) =>
        profile !== null &&
        ((state.profile === "git-read" && effective(ref) !== "git-read") ||
          (state.profile === "git-write" && effective(ref) === "git-full")),
    ).length;
    access.replaceChildren(
      element("legend", {}, "Default repository access"),
      ...controls(state.profile, allowed, "repository-default", (profile) => {
        state.profile = profile;
        changed();
        access
          .querySelector<HTMLInputElement>(
            `input[value="${profile === "git-write" ? "git-full" : profile}"]`,
          )
          ?.focus();
      }),
      element(
        "p",
        { className: "hint", role: "status" },
        `${profileLabel(state.profile)} applies to repositories using the Agent default.${custom ? ` ${custom} custom ${custom === 1 ? "repository keeps" : "repositories keep"} broader access.` : ""}`,
      ),
    );
    const details = access.querySelector("details");
    if (expanded && details) {
      details.open = true;
    }
  }
  function focusDiscovery() {
    (search.isConnected
      ? search
      : (results.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ??
        cards.querySelector<HTMLButtonElement>(
          ".repository-card:last-of-type .repository-card-toggle",
        ) ??
        section)
    ).focus();
  }
  function add(ref: string) {
    if (!editable() || state.selected.has(ref) || state.selected.size >= MAX_SELECTED) {
      return;
    }
    if (state.undo?.ref === ref) {
      restoreUndo();
    } else {
      const profiles = option(ref)?.allowedProfiles;
      if (profiles?.length === 1 && profiles[0] === "github-repository") {
        newCollaborators.add(ref);
      } else {
        newCollaborators.delete(ref);
      }
      state.selected.set(ref, null);
    }
    if (scoped()) {
      if (grants.get(ref)?.repository !== githubName(ref)) {
        grants.delete(ref);
      }
      selectDefault(ref);
    }
    state.undo = undefined;
    announcements.textContent = `${option(ref)?.displayName ?? ref} added.`;
    changed({ preserveResults: true });
  }
  function removeSelection(ref: string) {
    const index = [...state.selected.keys()].indexOf(ref);
    if (state.disabled || index < 0) {
      return;
    }
    state.undo = { ref, override: state.selected.get(ref) ?? null, index };
    state.selected.delete(ref);
    announcements.textContent = `${option(ref)?.displayName ?? ref} removed.`;
  }
  function restoreUndo() {
    const entries = [...state.selected];
    const undo = state.undo;
    if (!undo) {
      return;
    }
    entries.splice(undo.index, 0, [undo.ref, undo.override]);
    state.selected = new Map(entries);
    if (scoped()) {
      selectDefault(undo.ref);
    }
  }
  search.addEventListener("focus", () => {
    searchState.dismissed = false;
    renderResults();
  });
  search.addEventListener("input", () => {
    searchState.dismissed = false;
    searchState.query = search.value;
    searchState.page = 0;
    searchState.browsing = false;
    renderResults();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      searchState.dismissed = false;
      renderResults();
      results.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (searchState.dismissed) {
        searchState.dismissed = false;
        renderResults();
        return;
      }
      results
        .querySelector<HTMLInputElement>('input[type="checkbox"]:not(:checked):not(:disabled)')
        ?.click();
    }
  });
  discovery.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !search.isConnected) {
      return;
    }
    event.preventDefault();
    search.focus();
    searchState.dismissed = true;
    renderResults();
  });
  function renderResults() {
    results.hidden = searchState.dismissed;
    const { small, query, matches, count, page, visible } = repositoryResults(
      state.options,
      recent,
      searchState,
    );
    results.replaceChildren();
    if (state.discovery !== "ready" || !state.options.length) {
      return;
    }
    const searchSummary = matches.length
      ? `${matches.length} matching ${matches.length === 1 ? "repository" : "repositories"}`
      : "No repositories match this search. If a repository is missing, ask your Namespace operator.";
    results.append(
      element(
        "div",
        { className: "repository-results-heading" },
        element("h3", {}, "Approved repositories"),
        element(
          "p",
          { className: "hint", role: "status" },
          query
            ? searchSummary
            : !small &&
                !searchState.browsing &&
                matches.some((entry) => recent.includes(entry.repositoryRef))
              ? `Recently used · ${state.options.length} total`
              : `${state.options.length} total`,
        ),
      ),
    );
    const list = element("ul", { className: "repository-results-list" });
    for (const entry of visible) {
      const selected = state.selected.has(entry.repositoryRef);
      const displayName = searchCase(entry.displayName);
      const reference = searchCase(entry.repositoryRef);
      const showReference =
        reference !== displayName && reference !== displayName.split("/").at(-1);
      const readOnly = entry.allowedProfiles.every((profile) => profile === "git-read");
      const checkbox = element("input", {
        type: "checkbox",
        "data-repository-ref": entry.repositoryRef,
        checked: selected,
        disabled:
          !editable() ||
          (!selected &&
            (state.selected.size >= MAX_SELECTED ||
              (scoped() && !githubName(entry.repositoryRef)))),
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          add(entry.repositoryRef);
        } else if (editable()) {
          removeSelection(entry.repositoryRef);
          changed({ preserveResults: true });
        }
      });
      const row = element(
        "label",
        { className: "repository-result" },
        checkbox,
        element(
          "span",
          { className: "repository-identity" },
          element(
            "strong",
            {},
            scoped() ? (githubName(entry.repositoryRef) ?? entry.displayName) : entry.displayName,
          ),
          scoped() && !githubName(entry.repositoryRef)
            ? element("span", { className: "hint" }, "Requires profile access")
            : null,
          repositoryDescription(entry.description),
          showReference || readOnly
            ? element(
                "span",
                { className: "repository-result-meta" },
                showReference ? element("span", {}, `Reference: ${entry.repositoryRef}`) : null,
                readOnly
                  ? element("span", { className: "repository-approval" }, "Read-only approved")
                  : null,
              )
            : null,
        ),
      );
      checkbox.addEventListener("keydown", (event) => {
        if (!["ArrowUp", "ArrowDown"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const inputs = [
          ...results.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)'),
        ];
        const next = inputs.indexOf(checkbox) + (event.key === "ArrowDown" ? 1 : -1);
        if (next < 0) {
          focusDiscovery();
        } else {
          inputs[Math.min(next, inputs.length - 1)]?.focus();
        }
      });
      list.append(element("li", { className: "repository-result-row" }, row));
    }
    if (visible.length) {
      results.append(list);
    }
    if (!small && !searchState.browsing && matches.length > count) {
      results.append(
        button(
          "Browse all repositories",
          () => {
            searchState.browsing = true;
            searchState.page = 0;
            renderResults();
            results
              .querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')
              ?.focus();
          },
          { tone: "link", className: "repository-text-action", disabled: !editable() },
        ),
      );
    }
    if (searchState.browsing && matches.length > count) {
      const pager = element("div", { className: "form-actions" });
      for (const [label, delta] of [
        ["Previous repositories", -1],
        ["Next repositories", 1],
      ] as const) {
        pager.append(
          button(
            label,
            () => {
              searchState.page = page + delta;
              renderResults();
              const focus = results.querySelector<HTMLElement>(
                'input[type="checkbox"]:not(:disabled), .form-actions button:not(:disabled)',
              );
              if (focus) {
                focus.focus();
              } else {
                focusDiscovery();
              }
            },
            {
              disabled:
                !editable() || (delta < 0 ? page === 0 : (page + 1) * count >= matches.length),
            },
          ),
        );
      }
      results.append(pager);
    }
    results.append(
      element(
        "p",
        {
          className: "hint repository-limit",
          role: "status",
          hidden: state.selected.size < MAX_SELECTED,
        },
        "16 repositories selected. Deselect one to select another.",
      ),
    );
  }
  function renderCards() {
    announcements.querySelector("button")?.remove();
    cards.hidden = !state.selected.size;
    const custom = [...state.selected.values()].filter((profile) => profile !== null).length;
    cards.replaceChildren(
      element(
        "div",
        { className: "repository-selected-heading" },
        element("h3", {}, `Selected repositories (${state.selected.size})`),
        element(
          "span",
          { className: "hint", hidden: scoped() },
          `${state.selected.size - custom} inherited · ${custom} custom`,
        ),
      ),
    );
    [...state.selected].forEach(([ref, override], index) => {
      const entry = option(ref);
      if (!scoped() && !state.showAll && index >= 5 && !invalid(ref)) {
        return;
      }
      const grant = grants.get(ref);
      const label = (scoped() ? grant?.repository : undefined) ?? entry?.displayName ?? ref;
      const card = element("div", { className: "repository-card" });
      const remove = button(
        resourceActionIcon("remove"),
        () => {
          removeSelection(ref);
          changed();
          if (scoped()) {
            announcements.querySelector("button")?.focus();
          } else {
            focusDiscovery();
          }
        },
        {
          tone: "ghost",
          size: "sm",
          className: "repository-remove",
          "aria-label": `Remove ${label}`,
          title: `Remove ${label}`,
          disabled: state.disabled,
        },
      );
      if (scoped()) {
        const limit = githubLimit(entry);
        const available = limit && grant?.repository === limit.repository;
        const level = element(
          "select",
          { "aria-label": `GitHub access for ${label}`, disabled: !editable() || !available },
          element("option", { value: "read" }, "Read-only Git"),
          limit?.access === "write"
            ? element("option", { value: "write" }, "Read/write Git")
            : grant?.access === "write"
              ? element("option", { value: "write", disabled: true }, "Unavailable")
              : null,
        );
        level.value = grant?.access ?? "read";
        level.addEventListener("change", () => {
          if (grant) {
            grants.set(ref, { ...grant, access: level.value === "write" ? "write" : "read" });
            if (limit?.access === "read" && grant.access === "write") {
              changed();
              cards
                .querySelector<HTMLSelectElement>(
                  `select[aria-label="${CSS.escape(level.ariaLabel!)}"]`,
                )
                ?.focus();
            } else {
              onChange(true);
            }
          }
        });
        card.append(
          element(
            "div",
            { className: "repository-grant" },
            grantIdentity(label, available ? entry?.description : undefined),
            !available
              ? element(
                  "p",
                  { className: "hint" },
                  entry
                    ? "GitHub policy is unavailable or the repository changed. Remove this selection and choose a current GitHub repository."
                    : unlistedSelectionText(),
                )
              : element("div", { className: "field" }, level),
            remove,
            available && invalid(ref)
              ? element(
                  "p",
                  { className: "hint" },
                  "Contributor is no longer available. Choose Read-only or remove this repository.",
                )
              : null,
          ),
        );
        cards.append(card);
        return;
      }
      const settings = element("div", {
        role: "group",
        "aria-label": `Access for ${label}`,
        id: `repository-access-${ref}`,
        className: "repository-card-settings",
        hidden: !state.expanded.has(ref),
      });
      const expand = button(
        "",
        () => {
          settings.hidden = !settings.hidden;
          expand.setAttribute("aria-expanded", String(!settings.hidden));
          if (settings.hidden) {
            state.expanded.delete(ref);
          } else {
            state.expanded.add(ref);
          }
        },
        {
          className: "repository-card-toggle",
          "aria-expanded": String(!settings.hidden),
          "aria-describedby": `repository-summary-${ref}`,
          "aria-controls": settings.id,
          "aria-label": `Access for ${label}`,
        },
      );
      expand.append(
        element("span", { className: "repository-chevron", "aria-hidden": "true" }),
        element(
          "span",
          { className: "repository-identity" },
          element("strong", {}, label),
          element(
            "span",
            {
              id: `repository-summary-${ref}`,
              className: "badge repository-access-summary",
              "data-tone": accessTone(ref),
            },
            accessSummary(ref, override),
          ),
        ),
      );
      card.append(
        element("div", { className: "repository-card-heading" }, expand, remove),
        settings,
      );
      const inherit = element("input", {
        id: `repository-inherit-${ref}`,
        type: "checkbox",
        checked: override === null,
        disabled: !editable(),
      });
      inherit.addEventListener("change", () => {
        state.selected.set(ref, inherit.checked ? null : effective(ref));
        changed();
        document.getElementById(inherit.id)?.focus();
      });
      settings.append(
        element(
          "label",
          { className: "repository-option", for: inherit.id },
          inherit,
          "Use Agent default",
        ),
      );
      if (!entry) {
        settings.append(
          element(
            "p",
            // Checking, or waiting to check, is progress; the others say the repository cannot be
            // used.
            state.discovery === "loading" || state.discovery === "held"
              ? { className: "hint" }
              : { className: "status", "data-tone": "danger" },
            unlistedSelectionText(),
          ),
        );
      } else {
        if (invalid(ref)) {
          settings.append(
            element(
              "p",
              { className: "status", "data-tone": "danger" },
              `Choose approved access: ${entry.allowedProfiles.map(profileLabel).join(", ")}.`,
            ),
          );
        }
        if (override !== null) {
          settings.append(
            ...controls(
              override,
              entry.allowedProfiles,
              `repository-override-${ref}`,
              (profile) => {
                state.selected.set(ref, profile);
                changed();
                document
                  .getElementById(
                    `repository-override-${ref}-${profile === "git-write" ? "git-full" : profile}`,
                  )
                  ?.focus();
              },
            ),
          );
        }
      }
      cards.append(card);
    });
    if (!scoped() && state.selected.size > 5) {
      cards.append(
        button(
          state.showAll ? "Show fewer repositories" : `Show all ${state.selected.size} selected`,
          () => {
            state.showAll = !state.showAll;
            renderCards();
            cards.querySelector<HTMLButtonElement>(":scope > button:last-child")?.focus();
          },
          { tone: "link", className: "repository-text-action" },
        ),
      );
    }
    if (state.undo) {
      announcements.append(
        button(
          "Undo",
          () => {
            if (state.disabled || state.selected.size >= MAX_SELECTED) {
              return;
            }
            const index = state.undo?.index;
            restoreUndo();
            state.undo = undefined;
            announcements.textContent = "Repository restored.";
            changed();
            if (scoped() && index !== undefined) {
              cards.querySelectorAll<HTMLButtonElement>(".repository-remove")[index]?.focus();
            } else {
              focusDiscovery();
            }
          },
          {
            disabled: state.disabled || state.selected.size >= MAX_SELECTED,
            tone: "link",
            className: "repository-text-action",
          },
        ),
      );
    }
  }
  function render({ preserveResults = false } = {}) {
    const expandedDetails = [
      ...section.querySelectorAll<HTMLDetailsElement>("details[data-access-customize][open]"),
    ].map((details) => details.dataset.accessCustomize);
    renderAccess();
    if (state.discovery === "ready") {
      showReadyStatus();
    }
    const needsSearch = state.options.length > 5;
    if (!results.isConnected || needsSearch !== search.isConnected) {
      discovery.replaceChildren(
        ...(needsSearch ? [element("label", { for: search.id }, "Find a repository"), search] : []),
        results,
      );
    }
    if (!discovery.isConnected) {
      choices.replaceChildren(discovery);
    }
    search.disabled = !editable();
    if (preserveResults) {
      for (const input of results.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][data-repository-ref]',
      )) {
        input.checked = state.selected.has(input.dataset.repositoryRef ?? "");
        input.disabled =
          !editable() ||
          (!input.checked &&
            (state.selected.size >= MAX_SELECTED ||
              (scoped() && !githubName(input.dataset.repositoryRef ?? ""))));
      }
      const limit = results.querySelector<HTMLElement>(".repository-limit");
      if (limit) {
        limit.hidden = state.selected.size < MAX_SELECTED;
      }
    } else {
      renderResults();
    }
    renderCards();
    renderClient();
    for (const details of section.querySelectorAll<HTMLDetailsElement>(
      "details[data-access-customize]",
    )) {
      details.open = expandedDetails.includes(details.dataset.accessCustomize);
    }
  }
  function hasValidSelection() {
    return (
      state.discovery === "ready" &&
      state.selected.size > 0 &&
      [...state.selected.keys()].every((ref) => !invalid(ref)) &&
      (!scoped() || validClient())
    );
  }
  function validate({ required = false } = {}) {
    validation.hidden = true;
    if (!isSettled() || blocksCreate()) {
      section.focus();
      return false;
    }
    if (state.selected.size === 0 && !required) {
      return true;
    }
    if (hasPolicy() && !validClient()) {
      validation.textContent =
        "Select an available GitHub App Client before saving repository access.";
      validation.hidden = false;
      clientSelect.focus();
      return false;
    }
    if (!state.selected.size || [...state.selected.keys()].some(invalid)) {
      validation.textContent = scoped()
        ? "Select at least one supported GitHub repository and remove any unavailable selections."
        : state.selected.size
          ? "Choose approved access for each selected repository."
          : "Select at least one current repository and an authorization level to retry this Agent, or start a new draft.";
      validation.hidden = false;
      revealInvalidSelections();
      renderCards();
      section.focus();
      return false;
    }
    return true;
  }
  function bindings(): RepositoryBindingSelection[] {
    return [...state.selected.keys()].map((repositoryRef) => ({
      repositoryRef,
      profile: effective(repositoryRef),
    }));
  }
  function accessIntent(): RepositoryAccess {
    if (hasPolicy()) {
      return {
        defaultProfile: "github-repository",
        ...(selectedClientId ? { githubAppClientId: selectedClientId } : {}),
        repositories: [...state.selected.keys()].map((repositoryRef) => ({
          repositoryRef,
          access:
            grants.get(repositoryRef)?.access ??
            intent?.repositories.find((entry) => entry.repositoryRef === repositoryRef)?.access ??
            "read",
        })),
      };
    }
    return {
      defaultProfile: state.profile,
      repositories: [...state.selected].map(([repositoryRef, profile]) => ({
        repositoryRef,
        ...(profile !== null
          ? { profile }
          : effective(repositoryRef) !== state.profile
            ? { profile: effective(repositoryRef) }
            : {}),
      })),
    };
  }
  function setDisabled(disabled: boolean) {
    if (state.disabled === disabled) {
      return;
    }
    state.disabled = disabled;
    retry.disabled = disabled || !isSettled();
    render();
  }
  async function load(clearSelections = false): Promise<{ kind: LoadResult }> {
    const generation = ++loadGeneration;
    state.discovery = "loading";
    // A new catalog must not inherit filters or pages whose controls may disappear.
    resetSearch();
    retry.hidden = true;
    choices.setAttribute("aria-busy", "true");
    setStatusTone(status, null);
    status.textContent = "Loading approved repositories…";
    if (clearSelections) {
      state.options = [];
      state.selected.clear();
      grants.clear();
      newCollaborators.clear();
      state.undo = undefined;
      state.expanded.clear();
      state.showAll = false;
      state.profile = "git-full";
    }
    render();
    try {
      const { data: options, meta } = (await context.request(
        `${namespacePath(context.namespaceId)}/agents/${initial.agentId ? `${encodeURIComponent(initial.agentId)}/` : ""}repository-options`,
        { expectedStatus: 200, includeMeta: true },
      )) as { data: unknown; meta?: unknown };
      if (!context.isCurrent() || generation !== loadGeneration) {
        return { kind: "obsolete" };
      }
      if (!validOptions(options)) {
        throw new Error("Invalid repository choices response.");
      }
      // An Installation without repository settings answers no options and says so (finding
      // 2387). No retry or reload can change that, so show the setup link in every case.
      if (responseFields(meta).notConfigured === true) {
        return showFailure(
          undefined,
          discoveryContext(false).allowDraft ? "draft-only" : "not-configured",
          false,
        );
      }
      state.options = options.flatMap((option) => {
        const allowedProfiles = option.allowedProfiles.filter((id) => id !== "github-installation");
        return allowedProfiles.length ? [{ ...option, allowedProfiles }] : [];
      });
      if (intent?.githubAppClientId) {
        for (const entry of intent.repositories) {
          const limit = githubLimit(option(entry.repositoryRef));
          if (limit && entry.access && !grants.has(entry.repositoryRef)) {
            grants.set(entry.repositoryRef, { ...limit, access: entry.access });
          }
        }
      }
      if (chooseDefault && context.installationAdmin !== false && state.options.some(githubLimit)) {
        mode.value = "scoped";
      }
      chooseDefault = false;
      state.discovery = "ready";
      choices.setAttribute("aria-busy", "false");
      loadedAfterReset = clearSelections;
      showReadyStatus();
      revealInvalidSelections();
      render();
      onChange(false);
      return { kind: "success" };
    } catch (error) {
      const failure = requestFailure(error);
      if (failure.status === 401) {
        if (context.isCurrent()) {
          context.onExpired();
        }
        return { kind: "expired" };
      }
      if (!context.isCurrent() || generation !== loadGeneration) {
        return { kind: "obsolete" };
      }
      return showFailure(
        error,
        discoveryFailure(failure, discoveryContext(clearSelections)),
        clearSelections,
      );
    }
  }

  function discoveryContext(clearSelections: boolean) {
    return {
      allowDraft: !clearSelections && !initial.agentId && state.selected.size === 0,
      agentScoped: !clearSelections && Boolean(initial.agentId),
    };
  }

  function showFailure(
    error: unknown,
    discovery: DiscoveryFailure,
    clearSelections: boolean,
  ): { kind: LoadResult } {
    // A failed read cannot establish which retained choices are still approved.
    state.options = [];
    choices.setAttribute("aria-busy", "false");
    state.discovery = discovery;
    if (state.discovery === "denied") {
      setStatusTone(status, "danger");
      // Agent options authorize Agent update; new-Agent options, Agent create (finding D753).
      status.textContent = initial.agentId
        ? REPOSITORY_CHOICES_AGENT_DENIED
        : `Repository choices are not shown. ${AGENT_CREATE_DENIED}`;
    } else if (state.discovery === "conflict") {
      setStatusTone(status, "danger");
      // The API's 409 names the state, such as an Agent being deleted.
      status.textContent = initial.agentId
        ? describeFailure(error, {
            conflict: "Repository choices conflict with the current Agent or Namespace.",
            next: "Reload this draft before continuing.",
          })
        : "This Namespace no longer accepts new Agents.";
    } else if (clearSelections) {
      setStatusTone(status, "danger");
      status.textContent = `Repository choices could not be reloaded. ${describeFailure(error)} Retry the reload or start a new draft.`;
    } else if (state.discovery === "draft-only" || state.discovery === "not-configured") {
      showSetupLink();
    } else {
      setStatusTone(status, "danger");
      status.textContent = `Repository choices could not be loaded. ${describeFailure(error)} Retry repository choices before ${initial.agentId ? "saving repository access" : "creating an Agent"}.`;
    }
    retry.hidden = clearSelections || ["draft-only", "not-configured"].includes(state.discovery);
    revealInvalidSelections();
    render();
    onChange(false);
    return {
      kind:
        state.discovery === "draft-only" || state.discovery === "not-configured"
          ? "unavailable"
          : state.discovery,
    };
  }

  function showReadyStatus() {
    if (!state.options.length) {
      const next = loadedAfterReset
        ? " Start a new draft to continue without repository access."
        : " You can continue without repository access.";
      status.textContent = `No approved repositories are available for this Namespace. Ask your Namespace operator about missing repositories.${next}`;
    } else {
      status.textContent = scoped()
        ? "Select approved repositories and choose Git read or write access."
        : loadedAfterReset
          ? "Select current repositories and an authorization level to retry this Agent, or start a new draft."
          : "Select repositories for this Agent. Leave all unselected to continue without repository access.";
    }
  }

  // The status line for an Installation without repository access. Only an Installation
  // administrator can set it up, so only a known administrator gets the setup guide; anyone else
  // is told whom to ask, in the console's words (finding D754).
  function showSetupLink() {
    setStatusTone(status, null);
    const next =
      state.selected.size > 0
        ? ` Remove the selected repositories${initial.agentId ? " and save" : ""} to continue without repository access.`
        : !initial.agentId
          ? " You can continue without repository access."
          : isDirty()
            ? " Save to continue without repository access."
            : "";
    status.replaceChildren(
      `${REPOSITORY_ACCESS_NOT_CONFIGURED} `,
      ...(context.installationAdmin === true
        ? [
            element(
              "a",
              { href: REPOSITORY_SETUP_GUIDE, target: "_blank", rel: "noopener noreferrer" },
              "Set up repository access",
            ),
            ".",
          ]
        : [askAdministratorTo("set it up")]),
      next,
    );
  }

  function recordSuccessfulSave() {
    if (!recentKey) {
      return;
    }
    recent = [...new Set([...state.selected.keys(), ...recent])].slice(0, RECENT_LIMIT);
    try {
      localStorage.setItem(recentKey, JSON.stringify(recent));
    } catch {
      // A successful save does not depend on optional local suggestions.
    }
  }

  if (!held) {
    void load();
  }

  return {
    section,
    scoped: hasPolicy,
    hasUncheckedScopedAccess: () =>
      scoped() &&
      state.selected.size === 0 &&
      state.discovery === "ready" &&
      context.installationAdmin !== false &&
      state.options.some(githubLimit),
    // An empty list retains the picker mode when a draft is rebuilt. Submission
    // requires a selection, since an explicit empty API policy would deny all.
    repositoryNames: () =>
      [...state.selected.keys()].flatMap((ref) => {
        const name = githubName(ref);
        return name ? [name] : [];
      }),
    scopedGrants: () =>
      scoped() ? [...grants].filter(([ref]) => state.selected.has(ref)) : undefined,
    bindings,
    access: accessIntent,
    recordSuccessfulSave,
    validate,
    hasValidSelection,
    setDisabled,
    // Keep scoped intent for comparison with the refreshed catalog. Clearing it
    // here could turn an explicit Read-only selection back into Contributor.
    reload: () => load(!scoped()),
    /** Reads the choices a held form has not read yet; once read, retries go through Retry. */
    start: () => {
      if (state.discovery === "held") {
        void load();
      }
    },
    /**
     * Settles a held form whose permission answer refuses Agent create without the read the API
     * would refuse and audit, and with no retry (finding 2909). Without a reason, a block above
     * the form gives it.
     */
    refuse: (reason?: string) => {
      if (state.discovery !== "held") {
        return;
      }
      state.discovery = "denied";
      setStatusTone(status, "danger");
      status.textContent = ["Repository choices are not shown.", reason].filter(Boolean).join(" ");
      retry.hidden = true;
      revealInvalidSelections();
      render();
      onChange(false);
    },
    isDirty,
    isSettled,
    blocksCreate,
    /** Repository access is not set up in this Installation: only an empty selection saves. */
    notConfigured: () => state.discovery === "not-configured",
    /** The Installation has no repository access to offer: the section shows only its setup link. */
    unavailable: () => state.discovery === "draft-only" || state.discovery === "not-configured",
  };
}
