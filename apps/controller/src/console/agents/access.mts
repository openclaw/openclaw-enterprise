import type { Agent, Permission } from "@openclaw-enterprise/contracts";
import {
  INSTALLATION_ADMINISTRATION,
  type RequestOptions,
  requestFailure,
  responseFields,
} from "../api-client.mjs";
import {
  button,
  element,
  revealStatus,
  setStatusTone,
  setUnavailable,
  statusBlock,
  validateOnSubmit,
  withRequestId,
} from "../dom.mjs";
import {
  type AgentAccessContext,
  createdPolicyRole,
  matchesRole,
  policyBinding,
  policyList,
  policyRole,
} from "./credential-access.mjs";
import { describeFailure, message, namespacePath, shortId } from "./list.mjs";

const discoveryPermissions = [{ action: "read", resourceKind: "namespace" }] satisfies Permission[];
// People receive `prn_` Principal IDs; emails and other text never name an IAM subject.
const principalIdPattern = /^prn_[A-Za-z0-9-]{1,196}$/;

function principalIdProblem(value: string) {
  if (principalIdPattern.test(value)) {
    return null;
  }
  return value.includes("@")
    ? "Enter the person’s Principal ID (it starts with prn_), not an email address. Sharing does not look up accounts by email."
    : "Enter a Principal ID that starts with prn_, exactly as returned when the person was provisioned.";
}
const agentPermissions = [
  { action: "read", resourceKind: "agent" },
  { action: "administer", resourceKind: "agent" },
] satisfies Permission[];

type PolicyBinding = ReturnType<typeof policyBinding>;
type PolicyRole = ReturnType<typeof policyRole>;
type DirectGrant = { binding: PolicyBinding; role: PolicyRole | undefined };

function subjectLabel({ subjectKind, subjectId }: PolicyBinding) {
  if (subjectKind === "group") {
    return "Group";
  }
  if (principalIdPattern.test(subjectId)) {
    return "Principal";
  }
  if (subjectId.startsWith("spn_") || subjectId.startsWith("service-agent-")) {
    return "Service Principal";
  }
  return "Identity";
}

const viewAgentLabel = "View Agent in OCC";

function bindingCapabilities(role: PolicyRole | undefined, isPrincipal: boolean): string {
  if (!role) {
    return "Permissions unavailable";
  }
  if (!role.permissions.length) {
    return "No permissions listed";
  }
  const labels = new Set<string>();
  for (const { resourceKind, action } of role.permissions) {
    if (resourceKind === "agent" && action === "read") {
      labels.add(viewAgentLabel);
    } else if (resourceKind === "agent" && action === "operate") {
      labels.add(isPrincipal ? "Chat access" : "Operate Agent");
    } else if (resourceKind === "agent" && action === "administer") {
      labels.add("Administer Agent");
    } else {
      labels.add("Other permissions");
    }
  }
  return [...labels].join(" · ");
}

function isReadOnlyAgentRole(role: PolicyRole | undefined) {
  return (
    role?.permissions.length === 1 &&
    role.permissions.some(
      ({ resourceKind, action }) => resourceKind === "agent" && action === "read",
    )
  );
}

function directGrantLabel(grants: readonly DirectGrant[]) {
  const has = (action: "administer" | "operate") =>
    grants.some(({ role }) =>
      role?.permissions.some(
        (permission) => permission.resourceKind === "agent" && permission.action === action,
      ),
    );
  // The native launcher checks administer before operate. These labels describe only the grants
  // in this list, not the result of a browser admission check for this Principal.
  if (has("administer")) {
    return "Open Agent UI · administer";
  }
  if (has("operate")) {
    return "Chat access · operate";
  }
  if (grants.every(({ role }) => isReadOnlyAgentRole(role))) {
    return viewAgentLabel;
  }
  return grants.some(({ role }) => role === undefined)
    ? "Browser grant unknown"
    : "No direct browser grant";
}

// The Agent page's Access tab (spec 3.8). `onDenied` runs when the policy read is refused, after
// the panel hides itself. `onWriting` runs with true when a share or removal starts and false
// when it ends: the page holds version and page changes meanwhile (finding 2108). `recheck` reads
// the policy again for a reader who returns to the tab. `rereadAccess` runs before Refresh sharing
// reads the policy: the page rereads the caller's permission answers, which audit nothing.
export function renderAgentAccess(
  context: AgentAccessContext,
  agent: Pick<Agent, "id">,
  {
    onDenied,
    onWriting,
    rereadAccess,
  }: {
    onDenied?(): void;
    onWriting?(writing: boolean): void;
    rereadAccess?(): Promise<unknown>;
  } = {},
) {
  const { namespaceId } = context;
  const path = `${namespacePath(namespaceId)}/iam`;
  const section = element("section", {
    className: "agent-access",
    "aria-labelledby": "agent-access-title",
  });
  // role=status is an implicit polite live region without matching the page-view selector.
  const feedback = element("div", { role: "status" });
  const grants = element("div");
  const principal = element("input", {
    id: "share-principal-id",
    type: "text",
    required: true,
    autocomplete: "off",
    "aria-describedby": "share-principal-help",
  });
  const acknowledge = element("input", { type: "checkbox", required: true });
  // The Agent page's one primary action is its next deployment step, not sharing.
  const share = element("button", { type: "submit" }, "Share Agent");
  const refresh = button("Refresh sharing", () => void load({ reread: true }), { size: "sm" });
  const form = element(
    "form",
    { className: "agent-access-form" },
    element(
      "div",
      { className: "form-field" },
      element("label", { for: "share-principal-id" }, "Existing person’s Principal ID"),
      principal,
    ),
    element(
      "p",
      { id: "share-principal-help", className: "hint" },
      "Use the Principal ID returned when the person was provisioned in this Installation. This does not create an account.",
    ),
    element(
      "label",
      { className: "agent-access-consent" },
      acknowledge,
      "I understand this grants full native administration of this Agent.",
    ),
    element("div", { className: "form-actions" }, share),
  );
  // The console checks the Principal ID and the acknowledgement, not the browser (UX plan C3).
  validateOnSubmit(form);
  const state = {
    pending: false,
    loaded: false,
    needsRefresh: false,
    roles: [] as PolicyRole[],
    bindings: [] as PolicyBinding[],
    names: new Map<string, string>(),
    progress: [] as string[],
    error: null as string | null,
    // Set once the API accepts a write in the current change.
    saved: false,
  };
  let nameRead: AbortController | undefined;
  // Two cards (spec 3.8): sharing, then the direct grants it lists. The region keeps the
  // "Share Agent" name and holds both.
  section.append(
    element(
      "div",
      { className: "card agent-access-share" },
      element("h3", { id: "agent-access-title" }, "Share Agent"),
      statusBlock(
        "info",
        "What sharing grants",
        "Recipients can access and administer this Agent’s native conversations, settings, tools and accessible credentials. This is not restricted chat and does not give each chat an automatic personal identity.",
        [],
        { role: null },
      ),
      element(
        "p",
        { className: "muted" },
        "Sharing adds read access to this Namespace for discovery and read plus native administration for this Agent. It does not grant access to other Agents, OCE configuration, deployment or secrets.",
      ),
      feedback,
      form,
    ),
    element(
      "div",
      { className: "card agent-access-grants" },
      element("h3", {}, "Direct Agent grants"),
      element(
        "p",
        { className: "hint" },
        "These are explicit bindings to this Agent. Labels describe direct grants, not what someone can do now. Other policy can still affect access.",
      ),
      grants,
      refresh,
    ),
  );

  function render({ sharing = false } = {}) {
    const blocked = state.pending || !state.loaded || state.needsRefresh;
    refresh.disabled = state.pending;
    // The form shows disabled while the policy loads, instead of popping in above the grants
    // once it has (finding 1410); it hides only when the policy could not be read.
    form.hidden = !state.loaded && !state.pending;
    // The first read holds the line its "Current policy loaded" result takes, so the form
    // below does not move when it lands.
    const progress =
      state.progress.length || state.loaded || !state.pending || state.error
        ? state.progress
        : ["Reading the current sharing policy…"];
    feedback.replaceChildren(
      ...(progress.length
        ? [
            element(
              "ul",
              { className: "agent-access-progress" },
              ...progress.map((text) => element("li", {}, text)),
            ),
          ]
        : []),
      ...(state.error ? [element("p", { className: "error", role: "alert" }, state.error)] : []),
    );
    // A refusal shows in the danger status block (UX plan C1).
    const refusal = feedback.querySelector<HTMLElement>("[role=alert]");
    if (refusal) {
      setStatusTone(refusal, "danger");
    }
    // A refusal keeps the controls reachable so it can explain why they are unavailable.
    // While sharing, keep focus on the submit button and block repeat activation.
    const reason = state.needsRefresh ? refusal : null;
    for (const control of [principal, acknowledge, share]) {
      const canKeepFocus = reason !== null || (sharing && control === share);
      setUnavailable(control, blocked && canKeepFocus, reason);
      if (blocked && !canKeepFocus) {
        control.disabled = true;
      }
    }
    const openRows = new Set(
      Array.from(
        grants.querySelectorAll<HTMLDetailsElement>("details[open][data-subject]"),
        (row) => row.dataset.subject,
      ),
    );
    const openBindingDetails = new Set(
      Array.from(
        grants.querySelectorAll<HTMLDetailsElement>("details[open][data-binding-details]"),
        (details) => details.dataset.bindingDetails,
      ),
    );
    const active = document.activeElement;
    const focusedSubject =
      active instanceof HTMLElement && grants.contains(active)
        ? active.closest<HTMLElement>("details[data-subject]")?.dataset.subject
        : undefined;
    const focusedBinding = active?.matches(".agent-access-binding-details > summary")
      ? active.closest<HTMLElement>("details[data-binding-details]")?.dataset.bindingDetails
      : undefined;
    grants.replaceChildren();
    if (!state.loaded) {
      grants.append(
        element(
          "p",
          { className: "muted" },
          state.pending ? "Loading sharing policy…" : "Sharing policy unavailable.",
        ),
      );
      return;
    }
    if (state.needsRefresh) {
      grants.append(
        element(
          "p",
          { className: "muted" },
          "Direct grants need a fresh read. Select Refresh sharing to inspect current policy.",
        ),
      );
      return;
    }
    const direct = directBindings();
    if (!direct.length) {
      grants.append(element("p", { className: "muted" }, "No direct Agent grants."));
      if (focusedSubject) {
        refresh.focus({ preventScroll: true });
      }
      return;
    }
    renderRoster(direct, openRows, openBindingDetails, { focusedSubject, focusedBinding, blocked });
  }

  function directBindings() {
    return state.bindings.filter(
      (binding) =>
        binding.namespaceId === namespaceId &&
        binding.resourceKind === "agent" &&
        binding.resourceId === agent.id,
    );
  }

  function renderRoster(
    direct: readonly PolicyBinding[],
    openRows: ReadonlySet<string | undefined>,
    openBindingDetails: ReadonlySet<string | undefined>,
    {
      focusedSubject,
      focusedBinding,
      blocked,
    }: { focusedSubject: string | undefined; focusedBinding: string | undefined; blocked: boolean },
  ) {
    const roles = new Map(
      state.roles.filter((role) => role.namespaceId === namespaceId).map((role) => [role.id, role]),
    );
    const subjects = new Map<string, [DirectGrant, ...DirectGrant[]]>();
    for (const binding of direct) {
      const key = `${binding.subjectKind}:${binding.subjectId}`;
      const entry = { binding, role: roles.get(binding.roleId) };
      const bucket = subjects.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        subjects.set(key, [entry]);
      }
    }
    const principals = element("ul", {
      className: "agent-access-roster",
      role: "list",
      "aria-label": "Principal grants",
    });
    const others = element("ul", {
      className: "agent-access-roster",
      role: "list",
      "aria-label": "Other binding subjects",
    });
    let restoreFocus: HTMLElement | undefined;
    for (const [key, entries] of subjects) {
      const { binding } = entries[0];
      const { subjectId } = binding;
      const label = subjectLabel(binding);
      const isPrincipal = label === "Principal";
      const summary = element(
        "summary",
        {},
        element(
          "span",
          {},
          element("span", { className: "agent-access-subject-kind" }, label),
          isPrincipal
            ? principalLabel(subjectId)
            : element(
                "strong",
                { className: "resource-id" },
                subjectId.length > 20 ? shortId(subjectId) : subjectId,
              ),
        ),
        ...(isPrincipal
          ? [element("span", { className: "badge" }, directGrantLabel(entries))]
          : []),
      );
      const row = element(
        "details",
        { "data-subject": key },
        summary,
        element(
          "p",
          { className: "hint agent-access-subject-id" },
          `${label} ID: `,
          element("code", { className: "resource-id" }, subjectId),
        ),
        element(
          "ul",
          { className: "agent-access-bindings", role: "list", "aria-label": "Direct bindings" },
          ...entries.map(({ binding, role }) =>
            renderBinding(binding, role, {
              blocked,
              isPrincipal,
              detailsOpen: openBindingDetails.has(binding.id),
            }),
          ),
        ),
      );
      row.open = openRows.has(key);
      const list = isPrincipal ? principals : others;
      list.append(element("li", {}, row));
      if (key === focusedSubject) {
        const technicalDetails = Array.from(
          row.querySelectorAll<HTMLDetailsElement>("details[data-binding-details]"),
        ).find((details) => details.dataset.bindingDetails === focusedBinding);
        restoreFocus = technicalDetails?.querySelector<HTMLElement>(":scope > summary") ?? summary;
      }
    }
    if (principals.childElementCount) {
      grants.append(
        element(
          "p",
          { className: "hint" },
          "Expand a row to see the full Principal ID. If no account name is available, the row shows the ID.",
        ),
        principals,
      );
    }
    if (others.childElementCount) {
      grants.append(
        element("h4", { className: "agent-access-other-title" }, "Other binding subjects"),
        others,
      );
    }
    if (focusedSubject) {
      (restoreFocus ?? refresh).focus({ preventScroll: true });
    }
  }

  function principalLabel(principalId: string) {
    const name = state.names.get(principalId);
    return element(
      "strong",
      {
        className: name === undefined ? "resource-id" : "agent-access-display-name",
        "data-principal-label": principalId,
      },
      name ?? principalId,
    );
  }

  async function loadDisplayNames() {
    const principals = new Set(
      directBindings()
        .filter((binding) => subjectLabel(binding) === "Principal")
        .map((binding) => binding.subjectId),
    );
    if (!principals.size || !state.loaded || state.needsRefresh) {
      return;
    }
    const read = new AbortController();
    nameRead = read;
    try {
      // No caller-supplied identities: the server derives the roster from the exact Agent.
      const response = await context.request(
        `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agent.id)}/access-display-names`,
        { signal: read.signal },
      );
      if (!context.isCurrent() || read.signal.aborted || !Array.isArray(response)) {
        return;
      }
      for (const entry of response) {
        const { principalId, displayName } = responseFields(entry);
        if (
          typeof principalId === "string" &&
          principals.has(principalId) &&
          typeof displayName === "string" &&
          displayName.trim()
        ) {
          state.names.set(principalId, displayName.trim());
        }
      }
      // A late name response updates only the label. Keep disclosure, focus and writes intact.
      for (const label of grants.querySelectorAll<HTMLElement>("[data-principal-label]")) {
        const principalId = label.dataset.principalLabel;
        if (principalId && state.names.has(principalId)) {
          label.replaceWith(principalLabel(principalId));
        }
      }
    } catch (cause) {
      if (!read.signal.aborted && context.isCurrent() && requestFailure(cause).status === 401) {
        context.onExpired();
      }
      // Names are optional; denial or failure cannot hide the authorized bindings.
    } finally {
      if (nameRead === read) {
        nameRead = undefined;
      }
    }
  }

  function renderBinding(
    binding: PolicyBinding,
    role: PolicyRole | undefined,
    {
      blocked,
      isPrincipal,
      detailsOpen,
    }: { blocked: boolean; isPrincipal: boolean; detailsOpen: boolean },
  ) {
    const title = role ? (role.name ?? "Unnamed role") : "Role unavailable";
    const permissions = role?.permissions
      .map(({ resourceKind, action }) => `${resourceKind}: ${action}`)
      .join(", ");
    const descriptionId = `agent-access-binding-${encodeURIComponent(binding.id)}`;
    // Removal deletes this binding at once; other bindings for this subject are not changed.
    const remove = button("Remove binding", () => void removeBinding(binding), {
      tone: "danger",
      disabled: blocked,
    });
    remove.setAttribute("aria-describedby", descriptionId);
    const details = element(
      "details",
      { className: "agent-access-binding-details", "data-binding-details": binding.id },
      element("summary", { "aria-describedby": descriptionId }, "Technical details"),
      ...(permissions ? [element("p", { className: "hint" }, permissions)] : []),
      element(
        "p",
        { className: "hint" },
        "Role ID: ",
        element("code", { className: "resource-id" }, binding.roleId),
      ),
      element(
        "p",
        { className: "hint" },
        "Binding ID: ",
        element("code", { className: "resource-id" }, binding.id),
      ),
    );
    details.open = detailsOpen;
    return element(
      "li",
      { className: "agent-access-grant" },
      element(
        "div",
        {},
        element("strong", { id: descriptionId }, title),
        element("p", { className: "hint" }, bindingCapabilities(role, isPrincipal)),
        details,
      ),
      remove,
    );
  }

  // The two lists are read one at a time: a reader whose administration ended is refused, and
  // audited, once. The page confirms administration when it loads and the tab can open much
  // later, so a first open after a revoke was refused twice (finding D804), as a return was
  // (finding D790).
  async function readPolicy() {
    const roles = await context.request(`${path}/roles`, INSTALLATION_ADMINISTRATION);
    const bindings = await context.request(`${path}/access-bindings`, INSTALLATION_ADMINISTRATION);
    if (!context.isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
    state.roles = policyList(roles, policyRole);
    state.bindings = policyList(bindings, policyBinding);
    state.loaded = true;
  }

  // OCC answers 400 naming /subjectId or /resourceId when the Principal cannot be bound in
  // this Namespace or the Agent is being deleted; both mean the same thing to the sharer.
  function unavailableShareInput(cause: unknown) {
    const { detailPaths } = responseFields(cause);
    return (
      Array.isArray(detailPaths) &&
      detailPaths.some((path: unknown) => path === "/subjectId" || path === "/resourceId")
    );
  }

  function failure(error: unknown, mutation: boolean, sharing = false) {
    const { status, requestId } = requestFailure(error);
    if (status === 401) {
      context.onExpired();
      return;
    }
    state.needsRefresh = true;
    // A rejected write shows the API's sentence; once a write in this change was accepted,
    // later failures keep the generic text.
    state.error =
      status === 403
        ? "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions."
        : sharing && (status === 404 || (status === 400 && unavailableShareInput(error)))
          ? "No existing person with that Principal ID can be granted access here, or this Agent is no longer available. Check the Principal ID."
          : mutation && !state.saved
            ? describeFailure(error, { mutation, form: true, next: "" })
            : message(error, mutation);
    state.error += " Refresh sharing to inspect current policy before another change.";
    if (requestId) {
      state.error = withRequestId(state.error, requestId);
    }
  }

  async function load({ recheck = false, reread = false } = {}) {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    // Refresh is disabled while it reads, which drops its focus; give it back (finding 1446).
    const refocus = document.activeElement === refresh;
    nameRead?.abort();
    state.names.clear();
    state.pending = true;
    state.error = null;
    render();
    try {
      // Refresh sharing first rereads the caller's permission answers. Administration granted
      // again after a refused share left this read refused unsent, the tab hidden and the page
      // read-only until Refresh (finding 2943); the page now follows the new answer, and the
      // policy is read when it confirms administration. Still revoked, the read is refused as
      // before, with no added audited refusal.
      if (reread) {
        await rereadAccess?.();
        if (!context.isCurrent()) {
          return;
        }
      }
      await readPolicy();
      section.hidden = false;
      state.needsRefresh = false;
      // What the listed bindings cannot confirm is said once, in the page's disclosure. A recheck
      // keeps what the panel said, a share's outcome too.
      if (!recheck) {
        state.progress = ["Current policy loaded."];
      }
    } catch (error) {
      if (context.isCurrent()) {
        state.loaded = false;
        if (requestFailure(error).status === 403) {
          // Sharing is an Installation administration task; hide it rather than show an error.
          section.hidden = true;
          onDenied?.();
        } else {
          failure(error, false);
        }
      }
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
        if (refocus && !section.hidden && document.activeElement === document.body) {
          refresh.focus({ preventScroll: true });
        }
        void loadDisplayNames();
      }
    }
  }

  async function write(url: string, options: RequestOptions) {
    const result = await context.request(url, options);
    state.saved = true;
    return result;
  }

  async function ensureGrant(
    subjectId: string,
    resourceKind: "agent" | "namespace",
    resourceId: string,
    permissions: readonly Permission[],
    label: string,
  ) {
    let role = state.roles.find((candidate) => matchesRole(candidate, namespaceId, permissions));
    if (!role) {
      const created = await write(`${path}/roles`, {
        method: "POST",
        body: { name: label, permissions },
      });
      if (!context.isCurrent()) {
        throw new DOMException("View closed", "AbortError");
      }
      role = createdPolicyRole(created, namespaceId, permissions);
      state.roles.push(role);
    }
    const existing = state.bindings.find(
      (binding) =>
        binding.namespaceId === namespaceId &&
        binding.subjectKind === "identity" &&
        binding.subjectId === subjectId &&
        binding.resourceKind === resourceKind &&
        binding.resourceId === resourceId &&
        state.roles.some(
          (candidate) =>
            candidate.id === binding.roleId && matchesRole(candidate, namespaceId, permissions),
        ),
    );
    if (existing) {
      return;
    }
    const binding = await write(`${path}/access-bindings`, {
      method: "POST",
      body: { subjectKind: "identity", subjectId, roleId: role.id, resourceKind, resourceId },
    });
    if (!context.isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
    state.bindings.push(policyBinding(binding));
  }

  async function mutate(work: () => Promise<void>, sharing = false) {
    if (state.pending || !state.loaded || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    nameRead?.abort();
    state.names.clear();
    state.pending = true;
    state.error = null;
    state.progress = [];
    state.saved = false;
    let mutationStarted = false;
    render({ sharing });
    onWriting?.(true);
    try {
      // Read first so explicit retries reuse current policy; writes are never replayed automatically.
      await readPolicy();
      mutationStarted = true;
      await work();
    } catch (error) {
      if (context.isCurrent()) {
        failure(error, mutationStarted, sharing && mutationStarted);
      }
    } finally {
      onWriting?.(false);
      if (context.isCurrent()) {
        state.pending = false;
        render();
        // Bring refusals above the form into view while focus is still in this panel or on the page.
        revealStatus(feedback.querySelector("[role=alert]"), section);
        void loadDisplayNames();
      }
    }
  }

  function removeBinding(binding: PolicyBinding) {
    return mutate(async () => {
      await write(`${path}/access-bindings/${encodeURIComponent(binding.id)}`, {
        method: "DELETE",
        expectedStatus: 204,
      });
      if (!context.isCurrent()) {
        return;
      }
      state.bindings = state.bindings.filter((candidate) => candidate.id !== binding.id);
      state.progress.push(
        "Binding removed. Namespace discovery is unchanged. Other policy may still provide Agent access.",
      );
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const subjectId = principal.value.trim();
    if (!subjectId || !acknowledge.checked) {
      return;
    }
    const problem = principalIdProblem(subjectId);
    if (problem) {
      state.progress = [];
      state.error = problem;
      render();
      principal.focus();
      return;
    }
    void mutate(async () => {
      await ensureGrant(
        subjectId,
        "namespace",
        namespaceId,
        discoveryPermissions,
        "Namespace discovery",
      );
      state.progress.push("Namespace discovery is enabled.");
      render({ sharing: true });
      await ensureGrant(
        subjectId,
        "agent",
        agent.id,
        agentPermissions,
        "Agent native administration",
      );
      state.progress.push(
        "Agent access is shared. Effective access remains subject to current IAM policy.",
      );
      acknowledge.checked = false;
    }, true);
  });
  // The panel is built once per page, so a return to the tab shows what it read before, and
  // access can change meanwhile. An administrator revoked with the page open kept the old grants,
  // "Current policy loaded." and an enabled Remove binding (finding D790). A return to a panel
  // that shows the policy reads it again, its controls disabled meanwhile: a refusal takes the
  // member path a page load takes. A panel that shows an error already asks for Refresh sharing.
  function recheck() {
    if (state.loaded && !state.needsRefresh && !state.error) {
      void load({ recheck: true });
    }
  }

  render();
  void load();
  return { section, recheck };
}
