import { element, button } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";
import {
  repositoryProfiles,
  repositoryProfile,
  repositoryWriteAccessHelp,
} from "./repository-profiles.mjs";

export function createRepositoryFields(context, onChange, initialBindings = []) {
  const status = element(
    "p",
    { className: "hint", role: "status", "aria-live": "polite" },
    "Loading approved repositories…",
  );
  const choices = element("div", { className: "repository-options", "aria-busy": "true" });
  const profileChoices = element("div", { className: "repository-profiles" });
  const writeAccess = element(
    "p",
    { className: "hint repository-write-access", hidden: true, "aria-live": "polite" },
    repositoryWriteAccessHelp,
  );
  const issueAccess = element("input", { id: "repository-issue-access", type: "checkbox" });
  const issueHelp = element("p", { className: "hint", id: "repository-issue-help" });
  issueAccess.setAttribute("aria-describedby", issueHelp.id);
  const accessSummary = element("p", { className: "hint", role: "status" });
  const customize = element(
    "details",
    { className: "repository-customize", hidden: true },
    element("summary", {}, "Customize access"),
    element(
      "p",
      { className: "hint" },
      "Push code and pull request access are included together. Issue management is optional.",
    ),
    element(
      "label",
      { className: "repository-option", for: issueAccess.id },
      issueAccess,
      element("span", {}, element("strong", {}, "Create and manage issues"), issueHelp),
    ),
    writeAccess,
  );
  issueAccess.addEventListener("change", () => {
    state.profile = issueAccess.checked ? "git-full" : "git-write";
    updateAccessDetails();
    validation.hidden = true;
    onChange(true);
  });
  const profileGroup = element(
    "fieldset",
    { className: "repository-profile-group", hidden: true },
    element("legend", {}, "Access level"),
    element(
      "p",
      { className: "hint" },
      "Applies to every selected repository. Choose what this Agent can do.",
    ),
    profileChoices,
    accessSummary,
    customize,
  );
  const validation = element("p", { className: "error", role: "alert", hidden: true });
  const retry = button("Retry repository choices", async () => {
    if (state.disabled || !state.settled) {
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
    element(
      "p",
      { className: "muted" },
      "Choose the repositories this Agent can work with, or skip to continue without repository access.",
    ),
    status,
    retry,
    choices,
    profileGroup,
    validation,
    element(
      "details",
      { className: "repository-access-details" },
      element("summary", {}, "Runtime support and access limits"),
      element(
        "p",
        { className: "hint" },
        element("strong", {}, "Supported runtimes. "),
        "Embedded OpenClaw and Dedicated Codex on Kubernetes, without a Sandbox Driver. Deployment rechecks runtime compatibility. Model authentication is configured separately.",
      ),
      element(
        "p",
        { className: "hint" },
        element("strong", {}, "Credential handling. "),
        "GitHub App keys and installation tokens stay outside the Agent. The Agent receives bounded gateway authentication material and client configuration.",
      ),
      element(
        "p",
        { className: "hint" },
        element("strong", {}, "GitHub API scope. "),
        "API access is bounded by the selected level and installation token. GraphQL can also return public information allowed by GitHub. Unselected private repositories remain outside the grant.",
      ),
    ),
  );
  const state = {
    options: [],
    selected: new Set(initialBindings.map((binding) => binding.repositoryRef)),
    profile: initialBindings[0]?.profile ?? "",
    settled: false,
    draftOnly: false,
    blockingFailure: undefined,
    disabled: false,
  };

  function selectedOptions() {
    return state.options.filter((option) => state.selected.has(option.repositoryRef));
  }

  function commonProfiles() {
    const selected = selectedOptions();
    return selected.length === 0
      ? []
      : repositoryProfiles.filter((profile) =>
          selected.every((option) => option.allowedProfiles.includes(profile.id)),
        );
  }

  function updateAccessDetails() {
    const available = commonProfiles();
    const writable = repositoryProfile(state.profile)?.writes;
    customize.hidden = !writable;
    writeAccess.hidden = !writable;
    issueAccess.checked = state.profile === "git-full";
    issueAccess.disabled =
      state.disabled ||
      !available.some((p) => p.id === "git-full") ||
      !available.some((p) => p.id === "git-write");
    if (!available.some((p) => p.id === "git-full")) {
      issueHelp.textContent = "Issue management is not approved for every selected repository.";
    } else if (!available.some((p) => p.id === "git-write")) {
      issueHelp.textContent =
        "Required by the approved Contributor profile for these repositories.";
    } else {
      issueHelp.textContent =
        "Turn off to keep code and pull request access without issue management.";
    }
    accessSummary.textContent = "";
    if (state.profile === "git-write") {
      accessSummary.textContent =
        "Contributor · push code and work with pull requests. Issue management is off.";
    } else if (state.profile === "git-full") {
      accessSummary.textContent =
        "Contributor · push code, work with pull requests, and manage issues.";
    }
    accessSummary.hidden = !writable;
  }

  function renderProfiles() {
    const selected = selectedOptions();
    const available = commonProfiles();
    if (!available.some((profile) => profile.id === state.profile)) {
      state.profile = "";
    }
    profileGroup.hidden = selected.length === 0;
    // Keep the enforced profile IDs; only the Console's two choices are grouped.
    const reader = available.find((profile) => profile.id === "git-read");
    const contributor =
      available.find((profile) => profile.id === "git-full") ??
      available.find((profile) => profile.id === "git-write");
    profileChoices.replaceChildren(
      ...[reader, contributor].filter(Boolean).map((profile) => {
        const writable = profile.writes;
        const id = `repository-profile-${profile.id}`;
        const input = element("input", {
          id,
          type: "radio",
          name: "repository-profile",
          value: profile.id,
          checked: writable
            ? !!repositoryProfile(state.profile)?.writes
            : state.profile === profile.id,
          required: true,
          disabled: state.disabled,
        });
        input.addEventListener("change", () => {
          state.profile = profile.id;
          customize.open = false;
          updateAccessDetails();
          validation.hidden = true;
          onChange(true);
        });
        return element(
          "label",
          { className: "repository-profile", for: id },
          input,
          element(
            "span",
            {},
            element("strong", {}, writable ? "Contributor" : "Read-only"),
            element("span", { className: "hint" }, profile.help),
          ),
        );
      }),
    );
    updateAccessDetails();
    if (selected.length > 0 && available.length === 0) {
      validation.textContent =
        "These repositories have no authorization level in common. Remove a repository to continue.";
      validation.hidden = false;
    } else {
      validation.hidden = true;
    }
  }

  function updateChoiceControls() {
    for (const input of choices.querySelectorAll('input[type="checkbox"]')) {
      const selected = state.selected.has(input.value);
      input.checked = selected;
      input.disabled = state.disabled || (state.selected.size >= 16 && !selected);
    }
  }

  function updateProfileControls() {
    for (const input of profileChoices.querySelectorAll('input[type="radio"]')) {
      input.disabled = state.disabled;
    }
  }

  function renderChoices() {
    choices.replaceChildren(
      ...state.options.map((option) => {
        const id = `repository-${option.repositoryRef}`;
        const input = element("input", {
          id,
          type: "checkbox",
          value: option.repositoryRef,
          checked: state.selected.has(option.repositoryRef),
          disabled:
            state.disabled ||
            (state.selected.size >= 16 && !state.selected.has(option.repositoryRef)),
        });
        input.addEventListener("change", () => {
          if (input.checked) {
            state.selected.add(option.repositoryRef);
          } else {
            state.selected.delete(option.repositoryRef);
          }
          validation.hidden = true;
          updateChoiceControls();
          renderProfiles();
          onChange(true);
        });
        return element(
          "label",
          { className: "repository-option", for: id },
          input,
          element(
            "span",
            {},
            element("strong", {}, option.displayName),
            element("span", { className: "hint" }, `Repository alias: ${option.repositoryRef}`),
          ),
        );
      }),
    );
  }

  function hasValidSelection() {
    return (
      selectedOptions().length > 0 &&
      commonProfiles().some((profile) => profile.id === state.profile)
    );
  }

  function validate({ required = false } = {}) {
    validation.hidden = true;
    if (!state.settled || state.blockingFailure !== undefined) {
      section.focus();
      return false;
    }
    if (state.selected.size === 0) {
      if (!required) {
        return true;
      }
      validation.textContent =
        "Select at least one current repository and an authorization level to retry this Agent, or start a new draft.";
      validation.hidden = false;
      section.focus();
      return false;
    }
    if (commonProfiles().length === 0) {
      validation.textContent =
        "These repositories have no authorization level in common. Remove a repository to continue.";
      validation.hidden = false;
      section.focus();
      return false;
    }
    if (!commonProfiles().some((profile) => profile.id === state.profile)) {
      validation.textContent = "Select one authorization level for the chosen repositories.";
      validation.hidden = false;
      profileChoices.querySelector("input")?.focus();
      return false;
    }
    return true;
  }

  function bindings() {
    return selectedOptions().map((option) => ({
      repositoryRef: option.repositoryRef,
      profile: state.profile,
    }));
  }

  function draftBindings() {
    return [...state.selected].map((repositoryRef) => ({
      repositoryRef,
      profile: state.profile,
    }));
  }

  function setDisabled(disabled) {
    state.disabled = disabled;
    retry.disabled = disabled || !state.settled;
    updateChoiceControls();
    updateProfileControls();
    updateAccessDetails();
  }

  async function load(clearSelections = false) {
    state.settled = false;
    state.draftOnly = false;
    state.blockingFailure = undefined;
    retry.hidden = true;
    choices.setAttribute("aria-busy", "true");
    status.className = "hint";
    status.textContent = "Loading approved repositories…";
    if (clearSelections) {
      state.options = [];
      state.selected.clear();
      state.profile = "";
      renderChoices();
      renderProfiles();
    }
    try {
      const options = await context.request(
        `${namespacePath(context.namespaceId)}/agents/repository-options`,
        { expectedStatus: 200 },
      );
      if (!context.isCurrent()) {
        return { kind: "obsolete" };
      }
      if (
        !Array.isArray(options) ||
        !options.every(
          (option) =>
            typeof option?.repositoryRef === "string" &&
            option.repositoryRef.length > 0 &&
            typeof option.displayName === "string" &&
            Array.isArray(option.allowedProfiles) &&
            option.allowedProfiles.length > 0 &&
            option.allowedProfiles.every((id) => repositoryProfile(id)),
        ) ||
        new Set(options.map((option) => option.repositoryRef)).size !== options.length
      ) {
        throw new Error("Invalid repository choices response.");
      }
      state.options = options;
      state.selected = new Set(
        [...state.selected].filter((repositoryRef) =>
          options.some((option) => option.repositoryRef === repositoryRef),
        ),
      );
      state.settled = true;
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
      renderChoices();
      renderProfiles();
      onChange(false);
      return { kind: "success" };
    } catch (error) {
      if (error.status === 401) {
        if (context.isCurrent()) {
          context.onExpired();
        }
        return { kind: "expired" };
      }
      if (!context.isCurrent()) {
        return { kind: "obsolete" };
      }
      // A failed read cannot establish which retained choices are still approved.
      state.options = [];
      choices.setAttribute("aria-busy", "false");
      state.settled = true;
      const optionalOutage =
        error.status === 503 && error.code === "REPOSITORY_OPTIONS_UNAVAILABLE";
      state.draftOnly = optionalOutage && !clearSelections && state.selected.size === 0;
      if (error.status === 403) {
        state.blockingFailure = "denied";
      } else if (error.status === 409) {
        state.blockingFailure = "conflict";
      } else if (clearSelections || !optionalOutage || state.selected.size > 0) {
        state.blockingFailure = "unavailable";
      }
      if (state.blockingFailure === "denied") {
        status.className = "error";
        status.textContent =
          "Repository choices are denied because you are not authorized to create Agents in this Namespace.";
      } else if (state.blockingFailure === "conflict") {
        status.className = "error";
        status.textContent = "This Namespace no longer accepts new Agents.";
      } else if (clearSelections) {
        status.className = "error";
        status.textContent = `Repository choices could not be reloaded. ${message(error)} Retry the reload or start a new draft.`;
      } else if (state.selected.size > 0) {
        status.className = "error";
        status.textContent = `Repository choices could not be loaded. ${message(error)} Your selections are retained. Retry repository choices before creating an Agent.`;
      } else if (optionalOutage) {
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
          ". You can save a draft without repositories.",
        );
      } else {
        status.className = "error";
        status.textContent = `Repository choices could not be loaded. ${message(error)} Retry repository choices before creating an Agent.`;
      }
      retry.hidden = clearSelections;
      renderChoices();
      profileGroup.hidden = true;
      profileChoices.replaceChildren();
      validation.hidden = true;
      onChange(false);
      return { kind: state.blockingFailure ?? "unavailable" };
    }
  }

  void load();

  return {
    section,
    bindings,
    draftBindings,
    validate,
    hasValidSelection,
    setDisabled,
    reload: () => load(true),
    isSettled: () => state.settled,
    blocksCreate: () => state.blockingFailure !== undefined,
    draftOnly: () => state.draftOnly,
  };
}
