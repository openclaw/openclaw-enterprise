import { element, button } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";
import {
  repositoryProfiles,
  repositoryProfile,
  repositoryWriteAccessHelp,
} from "./repository-profiles.mjs";

const MAX_SELECTED = 16;
const PAGE_SIZE = 20;
const RECENT_LIMIT = 32;
const DESCRIPTION_REQUEST_DELAY = 250;
const DESCRIPTION_REFRESH_DELAY = 2_000;
const DESCRIPTION_REFRESH_MAX_DELAY = 30_000;
const DESCRIPTION_REFRESH_TIMEOUT = 30 * 60_000;

function recentRepositories(key) {
  if (!key) {
    return [];
  }
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return Array.isArray(stored)
      ? stored.filter((ref) => typeof ref === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    // Browser storage is optional; discovery remains usable when it is unavailable.
    return [];
  }
}

function repositoryResults(options, recent, { query: queryText, browsing, page: requestedPage }) {
  const small = options.length <= 5;
  const query = queryText.trim().toLocaleLowerCase();
  const rank = (entry) => {
    const names = [entry.displayName, entry.repositoryRef].flatMap((value) => {
      const name = value.toLocaleLowerCase();
      return [name, name.split("/").at(-1)];
    });
    if (names.includes(query)) {
      return 0;
    }
    return names.some((name) => name.startsWith(query)) ? 1 : 2;
  };
  const priority = (entry) => {
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
        [entry.displayName, entry.repositoryRef].some((v) => v.toLocaleLowerCase().includes(query)),
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

function discoveryFailure(error, { allowDraft }) {
  if (error.status === 403) {
    return "denied";
  }
  if (error.status === 409) {
    return "conflict";
  }
  if (allowDraft && error.status === 503 && error.code === "REPOSITORY_OPTIONS_UNAVAILABLE") {
    return "draft-only";
  }
  return "unavailable";
}

function validOptions(options) {
  return (
    Array.isArray(options) &&
    options.every(
      (option) =>
        typeof option?.repositoryRef === "string" &&
        option.repositoryRef.length > 0 &&
        typeof option.displayName === "string" &&
        (option.description === undefined || typeof option.description === "string") &&
        Array.isArray(option.allowedProfiles) &&
        option.allowedProfiles.length > 0 &&
        option.allowedProfiles.every((id) => repositoryProfile(id)),
    ) &&
    new Set(options.map((option) => option.repositoryRef)).size === options.length
  );
}

export function createRepositoryFields(context, onChange, initial = {}) {
  const intent = initial.repositoryAccess;
  const recentKey = context.operatorId
    ? `oce.repository-recency:${JSON.stringify([context.operatorId, context.namespaceId])}`
    : undefined;
  let recent = recentRepositories(recentKey);
  const state = {
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
  let searchState;
  let loadGeneration = 0;
  let descriptionGeneration = 0;
  let descriptionKey;
  let descriptionTimer;
  let descriptionAbort;
  const status = element(
    "p",
    { className: "hint", role: "status", "aria-live": "polite" },
    "Loading approved repositories…",
  );
  const validation = element("p", { className: "error", role: "alert", hidden: true });
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
  const option = (ref) => state.options.find((entry) => entry.repositoryRef === ref);
  const effective = (ref) => state.selected.get(ref) ?? state.profile;
  const invalid = (ref) => !option(ref)?.allowedProfiles.includes(effective(ref));
  const profileLabel = (profile) => repositoryProfile(profile)?.label ?? "Unknown access level";
  const isSettled = () => state.discovery !== "loading";
  const blocksCreate = () => !["loading", "ready", "draft-only"].includes(state.discovery);
  const editable = () => !state.disabled && isSettled() && !blocksCreate();
  const isDirty = () => JSON.stringify(accessIntent()) !== initialAccess;

  function accessSummary(ref, override) {
    if (!isSettled() || blocksCreate()) {
      return "Access awaiting verification";
    }
    if (invalid(ref)) {
      return "Choose approved access";
    }
    return `${profileLabel(effective(ref))} · ${override === null ? "Agent default" : "Custom"}`;
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
  function controls(profile, allowed, id, change) {
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
    ]) {
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
          .querySelector(`input[value="${profile === "git-write" ? "git-full" : profile}"]`)
          ?.focus();
      }),
      element(
        "p",
        { className: "hint", role: "status" },
        `${profileLabel(state.profile)} applies to repositories using the Agent default.${custom ? ` ${custom} custom ${custom === 1 ? "repository keeps" : "repositories keep"} broader access.` : ""}`,
      ),
    );
    if (expanded) {
      access.querySelector("details").open = true;
    }
  }
  function focusDiscovery() {
    (search.isConnected
      ? search
      : (results.querySelector('input[type="checkbox"]:not(:disabled)') ??
        cards.querySelector(".repository-card:last-of-type .repository-card-toggle") ??
        section)
    ).focus();
  }
  function add(ref) {
    if (!editable() || state.selected.has(ref) || state.selected.size >= MAX_SELECTED) {
      return;
    }
    if (state.undo?.ref === ref) {
      restoreUndo();
    } else {
      state.selected.set(ref, null);
    }
    state.undo = undefined;
    announcements.textContent = `${option(ref).displayName} added.`;
    changed({ preserveResults: true });
  }
  function removeSelection(ref) {
    const index = [...state.selected.keys()].indexOf(ref);
    if (state.disabled || index < 0) {
      return;
    }
    state.undo = { ref, override: state.selected.get(ref), index };
    state.selected.delete(ref);
    announcements.textContent = `${option(ref)?.displayName ?? ref} removed.`;
  }
  function restoreUndo() {
    const entries = [...state.selected];
    entries.splice(state.undo.index, 0, [state.undo.ref, state.undo.override]);
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
      results.querySelector('input[type="checkbox"]:not(:disabled)')?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (searchState.dismissed) {
        searchState.dismissed = false;
        renderResults();
        return;
      }
      results.querySelector('input[type="checkbox"]:not(:checked):not(:disabled)')?.click();
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
      requestVisibleDescriptions([]);
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
      const displayName = entry.displayName.toLocaleLowerCase();
      const reference = entry.repositoryRef.toLocaleLowerCase();
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
            ? element("span", { className: "repository-description" }, entry.description)
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
        const inputs = [...results.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
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
            results.querySelector('input[type="checkbox"]:not(:disabled)')?.focus();
          },
          { className: "repository-text-action", disabled: !editable() },
        ),
      );
    }
    if (searchState.browsing && matches.length > count) {
      const pager = element("div", { className: "form-actions" });
      for (const [label, delta] of [
        ["Previous repositories", -1],
        ["Next repositories", 1],
      ]) {
        pager.append(
          button(
            label,
            () => {
              searchState.page = page + delta;
              renderResults();
              const focus = results.querySelector(
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
    requestVisibleDescriptions(searchState.dismissed ? [] : visible);
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
          settings.hidden ? state.expanded.delete(ref) : state.expanded.add(ref);
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
              className: invalid(ref)
                ? "repository-access-summary is-error"
                : "repository-access-summary",
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
            { className: "error" },
            state.discovery === "ready"
              ? "This repository is no longer available. Remove it or retry discovery."
              : state.discovery === "loading"
                ? "Checking repository availability…"
                : "Repository availability cannot be verified. Retry repository choices.",
          ),
        );
      } else {
        if (invalid(ref)) {
          settings.append(
            element(
              "p",
              { className: "error" },
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
            cards.lastElementChild.focus();
          },
          { className: "repository-text-action" },
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
            className: "repository-text-action",
          },
        ),
      );
    }
  }
  function render({ preserveResults = false } = {}) {
    const expandedDetails = [
      ...section.querySelectorAll("details[data-access-customize][open]"),
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
      for (const input of results.querySelectorAll('input[type="checkbox"][data-repository-ref]')) {
        input.checked = state.selected.has(input.dataset.repositoryRef);
        input.disabled = !editable() || (!input.checked && state.selected.size >= MAX_SELECTED);
      }
      const limit = results.querySelector(".repository-limit");
      if (limit) {
        limit.hidden = state.selected.size < MAX_SELECTED;
      }
    } else {
      renderResults();
    }
    renderCards();
    for (const details of section.querySelectorAll("details[data-access-customize]")) {
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
  function bindings() {
    return [...state.selected.keys()].map((repositoryRef) => ({
      repositoryRef,
      profile: effective(repositoryRef),
    }));
  }
  function accessIntent() {
    return {
      defaultProfile: state.profile,
      repositories: [...state.selected].map(([repositoryRef, profile]) => ({
        repositoryRef,
        ...(profile === null ? {} : { profile }),
      })),
    };
  }
  function setDisabled(disabled) {
    if (state.disabled === disabled) {
      return;
    }
    state.disabled = disabled;
    retry.disabled = disabled || !isSettled();
    render();
  }
  function updateDescriptions(options, pending, refs) {
    const refreshed = new Map(options.map((entry) => [entry.repositoryRef, entry]));
    for (const entry of state.options) {
      if (!refs.has(entry.repositoryRef)) {
        continue;
      }
      const next = refreshed.get(entry.repositoryRef);
      if (!next || next.displayName !== entry.displayName) {
        continue;
      }
      if (typeof next.description === "string") {
        entry.description = next.description;
      } else if (!pending) {
        delete entry.description;
      }
    }
    for (const input of results.querySelectorAll('input[type="checkbox"][data-repository-ref]')) {
      if (!refs.has(input.dataset.repositoryRef)) {
        continue;
      }
      const entry = option(input.dataset.repositoryRef);
      const identity = input.closest(".repository-result")?.querySelector(".repository-identity");
      if (!entry || !identity) {
        continue;
      }
      let description = identity.querySelector(".repository-description");
      if (typeof entry.description === "string" && entry.description.trim()) {
        if (!description) {
          description = element("span", { className: "repository-description" });
          identity.querySelector("strong").after(description);
        }
        if (description.textContent !== entry.description) {
          description.textContent = entry.description;
        }
      } else {
        description?.remove();
      }
    }
  }
  function refreshDescriptions(
    generation,
    visibleGeneration,
    refs,
    signal,
    deadline = performance.now() + DESCRIPTION_REFRESH_TIMEOUT,
    delay = DESCRIPTION_REQUEST_DELAY,
  ) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return;
    }
    descriptionTimer = setTimeout(
      async () => {
        if (
          !context.isCurrent() ||
          !section.isConnected ||
          generation !== loadGeneration ||
          visibleGeneration !== descriptionGeneration ||
          performance.now() >= deadline
        ) {
          return;
        }
        try {
          const { data, meta } = await context.request(
            `${namespacePath(context.namespaceId)}/agents/${initial.agentId ? `${encodeURIComponent(initial.agentId)}/` : ""}repository-options?descriptionRefs=${[...refs].map(encodeURIComponent).join(",")}`,
            { expectedStatus: 200, includeMeta: true, signal },
          );
          if (
            !context.isCurrent() ||
            !section.isConnected ||
            generation !== loadGeneration ||
            visibleGeneration !== descriptionGeneration
          ) {
            return;
          }
          if (!validOptions(data)) {
            return;
          }
          const pending = meta?.descriptionsPending === true;
          updateDescriptions(data, pending, refs);
          if (pending) {
            refreshDescriptions(
              generation,
              visibleGeneration,
              refs,
              signal,
              deadline,
              Math.min(
                Math.max(delay * 2, DESCRIPTION_REFRESH_DELAY),
                DESCRIPTION_REFRESH_MAX_DELAY,
              ),
            );
          }
        } catch (error) {
          if (error.status === 401 && context.isCurrent()) {
            context.onExpired();
          }
        }
      },
      Math.min(delay, remaining),
    );
  }
  function requestVisibleDescriptions(visible) {
    const refs = new Set(visible.map((entry) => entry.repositoryRef));
    const key = JSON.stringify([...refs]);
    if (descriptionKey === key) {
      return;
    }
    descriptionKey = key;
    descriptionGeneration += 1;
    clearTimeout(descriptionTimer);
    descriptionAbort?.abort();
    if (refs.size) {
      descriptionAbort = new AbortController();
      refreshDescriptions(loadGeneration, descriptionGeneration, refs, descriptionAbort.signal);
    }
  }
  async function load(clearSelections = false) {
    const generation = ++loadGeneration;
    descriptionKey = undefined;
    descriptionGeneration += 1;
    clearTimeout(descriptionTimer);
    descriptionAbort?.abort();
    state.discovery = "loading";
    // A new catalog must not inherit filters or pages whose controls may disappear.
    resetSearch();
    retry.hidden = true;
    choices.setAttribute("aria-busy", "true");
    status.className = "hint";
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
      const options = await context.request(
        `${namespacePath(context.namespaceId)}/agents/${initial.agentId ? `${encodeURIComponent(initial.agentId)}/` : ""}repository-options`,
        { expectedStatus: 200 },
      );
      if (!context.isCurrent() || generation !== loadGeneration) {
        return { kind: "obsolete" };
      }
      if (!validOptions(options)) {
        throw new Error("Invalid repository choices response.");
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
      if (error.status === 401) {
        if (context.isCurrent()) {
          context.onExpired();
        }
        return { kind: "expired" };
      }
      if (!context.isCurrent() || generation !== loadGeneration) {
        return { kind: "obsolete" };
      }
      // A failed read cannot establish which retained choices are still approved.
      state.options = [];
      choices.setAttribute("aria-busy", "false");
      state.discovery = discoveryFailure(error, {
        allowDraft: !clearSelections && !initial.agentId && state.selected.size === 0,
      });
      if (state.discovery === "denied") {
        status.className = "error";
        status.textContent = initial.agentId
          ? "Repository choices are denied because you are not authorized to update this Agent."
          : "Repository choices are denied because you are not authorized to create Agents in this Namespace.";
      } else if (state.discovery === "conflict") {
        status.className = "error";
        status.textContent = initial.agentId
          ? "Repository choices conflict with the current Agent or Namespace. Reload this draft before continuing."
          : "This Namespace no longer accepts new Agents.";
      } else if (clearSelections) {
        status.className = "error";
        status.textContent = `Repository choices could not be reloaded. ${message(error)} Retry the reload or start a new draft.`;
      } else if (state.discovery === "draft-only") {
        status.className = "hint";
        status.replaceChildren(
          "Repository choices are unavailable. ",
          element(
            "a",
            {
              href: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md",
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "Set up repository access",
          ),
          ". You can continue without repository access.",
        );
      } else {
        status.className = "error";
        status.textContent = `Repository choices could not be loaded. ${message(error)} Retry repository choices before ${initial.agentId ? "saving repository access" : "creating an Agent"}.`;
      }
      // Draft-only means fixed Installation composition: retrying cannot succeed.
      retry.hidden = clearSelections || state.discovery === "draft-only";
      revealInvalidSelections();
      render();
      onChange(false);
      return { kind: state.discovery === "draft-only" ? "unavailable" : state.discovery };
    }
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
  };
}
