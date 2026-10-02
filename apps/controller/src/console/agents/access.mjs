import { button, element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

const discoveryPermissions = [{ action: "read", resourceKind: "namespace" }];
// People receive `prn_` Principal IDs; emails and other text never name an IAM subject.
const principalIdPattern = /^prn_[A-Za-z0-9-]{1,196}$/;

function principalIdProblem(value) {
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
];

function matchesRole(role, namespaceId, permissions) {
  return (
    role.namespaceId === namespaceId &&
    role.permissions.length === permissions.length &&
    permissions.every((permission) =>
      role.permissions.some(
        (candidate) =>
          candidate.action === permission.action &&
          candidate.resourceKind === permission.resourceKind,
      ),
    )
  );
}

export function renderAgentAccess(context, agent) {
  const { namespaceId } = context;
  const path = `${namespacePath(namespaceId)}/iam`;
  const section = element("section", {
    className: "agent-card agent-access",
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
  const share = element("button", { type: "submit", className: "primary" }, "Share Agent");
  const refresh = button("Refresh sharing", () => void load());
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
  const state = {
    pending: false,
    loaded: false,
    needsRefresh: false,
    roles: [],
    bindings: [],
    progress: [],
    error: null,
  };
  section.append(
    element("h2", { id: "agent-access-title" }, "Share Agent"),
    element(
      "p",
      { className: "notice" },
      "Recipients can access and administer this Agent’s native conversations, settings, tools and accessible credentials. This is not restricted chat and does not give each chat an automatic personal identity.",
    ),
    element(
      "p",
      { className: "muted" },
      "Sharing adds read access to this Namespace for discovery and read plus native administration for this Agent. It does not grant access to other Agents, OCE configuration, deployment or secrets.",
    ),
    feedback,
    form,
    element("h3", {}, "Direct Agent grants"),
    element(
      "p",
      { className: "hint" },
      "These are explicit bindings to this Agent, not all effective access. Groups, other grants and Installation administration can still provide access. Removing a binding keeps Namespace discovery access.",
    ),
    grants,
    refresh,
  );

  function render() {
    const blocked = state.pending || !state.loaded || state.needsRefresh;
    principal.disabled = blocked;
    acknowledge.disabled = blocked;
    share.disabled = blocked;
    refresh.disabled = state.pending;
    form.hidden = !state.loaded;
    feedback.replaceChildren(
      ...(state.progress.length
        ? [
            element(
              "ul",
              { className: "agent-access-progress" },
              ...state.progress.map((text) => element("li", {}, text)),
            ),
          ]
        : []),
      ...(state.error ? [element("p", { className: "error", role: "alert" }, state.error)] : []),
    );
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
    const direct = state.bindings.filter(
      (binding) =>
        binding.namespaceId === namespaceId &&
        binding.resourceKind === "agent" &&
        binding.resourceId === agent.id,
    );
    if (!direct.length) {
      grants.append(element("p", { className: "muted" }, "No direct Agent grants."));
    }
    for (const binding of direct) {
      const role = state.roles.find((candidate) => candidate.id === binding.roleId);
      const permissions =
        role?.permissions.map((item) => `${item.resourceKind}: ${item.action}`).join(", ") ??
        "Role unavailable";
      const remove = button("Remove binding", () => void removeBinding(binding), {
        disabled: blocked,
      });
      grants.append(
        element(
          "div",
          { className: "agent-access-grant" },
          element(
            "div",
            {},
            element("p", {}, `${binding.subjectKind}: ${binding.subjectId}`),
            element("p", { className: "hint" }, permissions),
            element("p", { className: "resource-id" }, binding.id),
          ),
          remove,
        ),
      );
    }
  }

  async function readPolicy() {
    const [roles, bindings] = await Promise.all([
      context.request(`${path}/roles`),
      context.request(`${path}/access-bindings`),
    ]);
    if (!context.isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
    state.roles = roles;
    state.bindings = bindings;
    state.loaded = true;
  }

  // OCC answers 400 naming /subjectId or /resourceId when the Principal cannot be bound in
  // this Namespace or the Agent is being deleted; both mean the same thing to the sharer.
  function unavailableShareInput(error) {
    return (
      error.status === 400 &&
      (error.detailPaths ?? []).some((path) => path === "/subjectId" || path === "/resourceId")
    );
  }

  function failure(error, mutation, sharing = false) {
    if (error.status === 401) {
      context.onExpired();
      return;
    }
    state.needsRefresh = true;
    state.error =
      error.status === 403
        ? "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions."
        : sharing && (error.status === 404 || unavailableShareInput(error))
          ? "No existing person with that Principal ID can be granted access here, or this Agent is no longer available. Check the Principal ID."
          : message(error, mutation);
    state.error += " Refresh sharing to inspect current policy before another change.";
    if (error.requestId) {
      state.error += ` Request ID: ${error.requestId}`;
    }
  }

  async function load() {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    state.error = null;
    render();
    try {
      await readPolicy();
      section.hidden = false;
      state.needsRefresh = false;
      state.progress = [
        "Current policy loaded. Listed bindings describe present configuration; they do not confirm a previous request’s outcome.",
      ];
    } catch (error) {
      if (context.isCurrent()) {
        state.loaded = false;
        if (error.status === 403) {
          // Sharing is an Installation administration task; hide it rather than show an error.
          section.hidden = true;
        } else {
          failure(error, false);
        }
      }
    } finally {
      if (context.isCurrent()) {
        state.pending = false;
        render();
      }
    }
  }

  async function ensureGrant(subjectId, resourceKind, resourceId, permissions, label) {
    let role = state.roles.find((candidate) => matchesRole(candidate, namespaceId, permissions));
    if (!role) {
      role = await context.request(`${path}/roles`, {
        method: "POST",
        body: { name: label, permissions },
      });
      if (!context.isCurrent()) {
        throw new DOMException("View closed", "AbortError");
      }
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
    const binding = await context.request(`${path}/access-bindings`, {
      method: "POST",
      body: { subjectKind: "identity", subjectId, roleId: role.id, resourceKind, resourceId },
    });
    if (!context.isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
    state.bindings.push(binding);
  }

  async function mutate(work, sharing = false) {
    if (state.pending || !state.loaded || state.needsRefresh || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    state.error = null;
    state.progress = [];
    let mutationStarted = false;
    render();
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
      if (context.isCurrent()) {
        state.pending = false;
        render();
      }
    }
  }

  function removeBinding(binding) {
    return mutate(async () => {
      await context.request(`${path}/access-bindings/${encodeURIComponent(binding.id)}`, {
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
      render();
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
  render();
  void load();
  return section;
}
