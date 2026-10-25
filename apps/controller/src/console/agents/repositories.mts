import type {
  RepositoryAccess,
  RepositoryBindingRequest,
  RepositoryBindingSelection,
  RepositoryOption,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import { element, button, setStatusTone } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";
import { visibleText } from "./logs-view.mjs";
import {
  repositoryProfiles,
  repositoryProfile,
  repositoryWriteAccessHelp,
} from "./repository-profiles.mjs";

type RepositoryContext = Pick<NamespacePageContext, "request" | "isCurrent" | "onExpired"> & {
  namespaceId: string;
  operatorId?: string;
};

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
  discovery: "loading" | "ready" | DiscoveryFailure;
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
      !allowedProfiles.every((id: unknown) => repositoryProfile(id)) ||
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
    repositoryBindings?: readonly RepositoryBindingRequest[];
  } = {},
) {
  const intent = initial.repositoryAccess;
  const recentKey = context.operatorId
    ? `oce.repository-recency:${JSON.stringify([context.operatorId, context.namespaceId])}`
    : undefined;
  let recent = recentRepositories(recentKey);
  const state: PickerState = {
    options: [],
    selected: new Map(
      intent
        ? intent.repositories.map(({ repositoryRef, profile }) => [repositoryRef, profile ?? null])
        : (initial.repositoryBindings ?? []).map(({ repositoryRef, profile }) => [
            repositoryRef,
            profile ?? "git-write",
          ]),
    ),
    profile: intent?.defaultProfile ?? "git-full",
    discovery: "loading",
    disabled: false,
    showAll: false,
    expanded: new Set(),
    undo: undefined,
  };
  const initialAccess = JSON.stringify(accessIntent());
  let searchState: SearchState;
  let loadGeneration = 0;
  const status = element(
    "p",
    { className: "hint", role: "status" },
    "Loading approved repositories…",
  );
  const validation = element("p", {
    className: "status",
    "data-tone": "danger",
    role: "alert",
    hidden: true,
  });
  const choices = element("div", { className: "repository-options", "aria-busy": "true" });
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
    access,
    choices,
    cards,
    announcements,
    validation,
    element(
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
  const effective = (ref: string) => state.selected.get(ref) ?? state.profile;
  const invalid = (ref: string) => !option(ref)?.allowedProfiles.includes(effective(ref));
  const profileLabel = (profile: string) =>
    repositoryProfile(profile)?.label ?? "Unknown access level";
  const isSettled = () => state.discovery !== "loading";
  const blocksCreate = () => !["loading", "ready", "draft-only"].includes(state.discovery);
  const editable = () => !state.disabled && isSettled() && !blocksCreate();
  const isDirty = () => JSON.stringify(accessIntent()) !== initialAccess;

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
    const contributor = allowed.includes("git-full") ? "git-full" : "git-write";
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
        hidden: profile === "git-read",
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
    access.hidden = !state.options.length && !state.selected.size;
    const expanded = access.querySelector("details")?.open;
    const allowed = repositoryProfiles.map((p) => p.id);
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
      state.selected.set(ref, null);
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
    results.append(
      element(
        "div",
        { className: "repository-results-heading" },
        element("h3", {}, "Approved repositories"),
        element(
          "p",
          { className: "hint", role: "status" },
          query
            ? `${matches.length} matching ${matches.length === 1 ? "repository" : "repositories"}`
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
        disabled: !editable() || (!selected && state.selected.size >= MAX_SELECTED),
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
          element("strong", {}, entry.displayName),
          typeof entry.description === "string" && entry.description.trim()
            ? element(
                "span",
                { className: "repository-description" },
                descriptionText(entry.description),
              )
            : null,
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
    if (!visible.length) {
      results.append(
        element(
          "p",
          { className: "hint" },
          query ? "No repositories match this search." : "No approved repositories.",
        ),
      );
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
          { className: "hint" },
          `${state.selected.size - custom} inherited · ${custom} custom`,
        ),
      ),
    );
    [...state.selected].forEach(([ref, override], index) => {
      const entry = option(ref);
      if (!state.showAll && index >= 5 && !invalid(ref)) {
        return;
      }
      const label = entry?.displayName ?? ref;
      const card = element("div", { className: "repository-card" });
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
      const remove = button(
        "Remove",
        () => {
          removeSelection(ref);
          changed();
          focusDiscovery();
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
            // Checking is progress; the other three say the repository cannot be used.
            state.discovery === "loading"
              ? { className: "hint" }
              : { className: "status", "data-tone": "danger" },
            state.discovery === "ready"
              ? "This repository is no longer available. Remove it or retry discovery."
              : state.discovery === "loading"
                ? "Checking repository availability…"
                : state.discovery === "not-configured"
                  ? "Repository availability cannot be verified because repository access is not available in this Installation's configuration."
                  : "Repository availability cannot be verified. Retry repository choices.",
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
    if (state.selected.size > 5) {
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
            restoreUndo();
            state.undo = undefined;
            announcements.textContent = "Repository restored.";
            changed();
            focusDiscovery();
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
        input.disabled = !editable() || (!input.checked && state.selected.size >= MAX_SELECTED);
      }
      const limit = results.querySelector<HTMLElement>(".repository-limit");
      if (limit) {
        limit.hidden = state.selected.size < MAX_SELECTED;
      }
    } else {
      renderResults();
    }
    renderCards();
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
      [...state.selected.keys()].every((ref) => !invalid(ref))
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
    if (!state.selected.size || [...state.selected.keys()].some(invalid)) {
      validation.textContent = state.selected.size
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
    return {
      defaultProfile: state.profile,
      repositories: [...state.selected].map(([repositoryRef, profile]) => ({
        repositoryRef,
        ...(profile === null ? {} : { profile }),
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
      state.options = options;
      state.discovery = "ready";
      choices.setAttribute("aria-busy", "false");
      if (clearSelections) {
        status.textContent = options.length
          ? "Select current repositories and an authorization level to retry this Agent, or start a new draft."
          : "No approved repositories are available for this Namespace. Start a new draft to continue without repository access.";
      } else {
        status.textContent = options.length
          ? "Select repositories for this Agent. Leave all unselected to continue without repository access."
          : "No approved repositories are available for this Namespace. You can continue without repository access.";
      }
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
      status.textContent = initial.agentId
        ? "Repository choices are denied because you are not authorized to update this Agent."
        : "Repository choices are denied because you are not authorized to create Agents in this Namespace.";
    } else if (state.discovery === "conflict") {
      setStatusTone(status, "danger");
      status.textContent = initial.agentId
        ? "Repository choices conflict with the current Agent or Namespace. Reload this draft before continuing."
        : "This Namespace no longer accepts new Agents.";
    } else if (clearSelections) {
      setStatusTone(status, "danger");
      status.textContent = `Repository choices could not be reloaded. ${message(error)} Retry the reload or start a new draft.`;
    } else if (state.discovery === "draft-only" || state.discovery === "not-configured") {
      setStatusTone(status, null);
      status.replaceChildren(
        "Repository access is not available in this Installation's configuration. ",
        element(
          "a",
          {
            href: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Set up repository access",
        ),
        state.discovery === "draft-only"
          ? ". You can continue without repository access."
          : ". You can’t save repository changes on this page until an operator sets up repository access.",
      );
    } else {
      setStatusTone(status, "danger");
      status.textContent = `Repository choices could not be loaded. ${message(error)} Retry repository choices before ${initial.agentId ? "saving repository access" : "creating an Agent"}.`;
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

  void load();

  return {
    section,
    bindings,
    access: accessIntent,
    recordSuccessfulSave,
    validate,
    hasValidSelection,
    setDisabled,
    reload: () => load(true),
    isDirty,
    isSettled,
    blocksCreate,
    /** Repository access is not set up in this Installation: no save can succeed here. */
    notConfigured: () => state.discovery === "not-configured",
  };
}
