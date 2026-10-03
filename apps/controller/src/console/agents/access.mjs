import { button, element } from "../dom.mjs";
import { message, namespacePath, rejectionMessage } from "./list.mjs";

const discoveryPermissions = [{ action: "read", resourceKind: "namespace" }];
const agentReadPermissions = [{ action: "read", resourceKind: "agent" }];
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
const agentPermissions = [...agentReadPermissions, { action: "use", resourceKind: "agent" }];

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
  const runtimeRole = element("select", { id: "share-runtime-role", required: true });
  const roleDetails = element("details", {}, element("summary", {}, "Selected role permissions"));
  const roleSummary = element("pre", { className: "native-document" });
  roleDetails.append(roleSummary);
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
      "div",
      { className: "form-field" },
      element("label", { for: "share-runtime-role" }, "OpenClaw role"),
      runtimeRole,
    ),
    roleDetails,
    element(
      "label",
      { className: "agent-access-consent" },
      acknowledge,
      "I understand the selected role grants access to this Agent’s shared data and tools.",
    ),
    element("div", { className: "form-actions" }, share),
  );
  const state = {
    pending: false,
    loaded: false,
    needsRefresh: false,
    roles: [],
    bindings: [],
    runtimeRoles: [],
    catalogError: null,
    progress: [],
    error: null,
    // Set once the API accepts a write in the current change.
    saved: false,
  };
  section.append(
    element("h2", { id: "agent-access-title" }, "Share Agent"),
    element(
      "p",
      { className: "notice" },
      "Recipients use their own OpenClaw profile and the selected role. This Agent’s files, plugins and provider accounts remain shared.",
    ),
    element(
      "p",
      { className: "muted" },
      "Sharing adds Namespace discovery, Agent read and OpenClaw entry access. The selected OpenClaw role defines runtime permissions; OCE deployment administration is separate.",
    ),
    feedback,
    form,
    element("h3", {}, "Direct Agent grants"),
    element(
      "p",
      { className: "hint" },
      "These are direct grants to this Agent, not all effective access. OpenClaw requires an explicit role assignment for the person and Agent. Removing that assignment keeps Namespace discovery access.",
    ),
    grants,
    refresh,
  );

  function render() {
    const blocked = state.pending || !state.loaded || state.needsRefresh;
    principal.disabled = blocked;
    acknowledge.disabled = blocked;
    share.disabled = blocked || state.runtimeRoles.length === 0;
    runtimeRole.disabled = blocked || state.runtimeRoles.length === 0;
    const selected = runtimeRole.value;
    runtimeRole.replaceChildren(
      ...state.runtimeRoles.map((role) => element("option", { value: role.id }, role.id)),
    );
    if (state.runtimeRoles.some((role) => role.id === selected)) {
      runtimeRole.value = selected;
    }
    roleSummary.textContent = JSON.stringify(
      state.runtimeRoles.find((role) => role.id === runtimeRole.value)?.permissions ?? {},
      null,
      2,
    );
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
      ...(state.catalogError ? [element("p", { className: "notice" }, state.catalogError)] : []),
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
      const change =
        binding.runtimeRole === undefined
          ? null
          : element(
              "select",
              {
                "aria-label": `OpenClaw role for ${binding.subjectId}`,
                disabled: blocked || state.runtimeRoles.length === 0,
              },
              ...state.runtimeRoles.map((role) => element("option", { value: role.id }, role.id)),
            );
      if (change) {
        if (!state.runtimeRoles.some((role) => role.id === binding.runtimeRole)) {
          change.append(
            element(
              "option",
              { value: binding.runtimeRole },
              `${binding.runtimeRole} (unavailable)`,
            ),
          );
        }
        change.value = binding.runtimeRole;
        change.addEventListener("change", () => void changeRole(binding, change.value));
      }
      grants.append(
        element(
          "div",
          { className: "agent-access-grant" },
          element(
            "div",
            {},
            element("p", {}, `${binding.subjectKind}: ${binding.subjectId}`),
            element("p", { className: "hint" }, permissions),
            ...(binding.runtimeRole === undefined
              ? []
              : [element("p", {}, `OpenClaw role: ${binding.runtimeRole}`)]),
            element("p", { className: "resource-id" }, binding.id),
          ),
          ...(change ? [element("div", { className: "form-field" }, change)] : []),
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

  async function readRuntimeRoles() {
    try {
      state.runtimeRoles = await context.request(
        `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agent.id)}/runtime-roles`,
      );
      state.catalogError =
        state.runtimeRoles.length === 0
          ? "Configure gateway.roles and deploy this Agent before assigning OpenClaw access."
          : null;
    } catch (error) {
      if (error.status === 401 || error.name === "AbortError") {
        throw error;
      }
      state.runtimeRoles = [];
      state.catalogError =
        "The deployed OpenClaw role catalog is unavailable. Existing assignments can still be removed.";
    }
    if (!context.isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
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
    // A rejected write shows the API's sentence; once a write in this change was accepted,
    // later failures keep the generic text.
    state.error =
      error.status === 403
        ? "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions."
        : sharing && (error.status === 404 || unavailableShareInput(error))
          ? "No existing person with that Principal ID can be granted access here, or this Agent is no longer available. Check the Principal ID."
          : mutation && !state.saved
            ? rejectionMessage(error, mutation)
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
      await readRuntimeRoles();
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

  async function write(url, options) {
    const result = await context.request(url, options);
    state.saved = true;
    return result;
  }

  async function ensureGrant(
    subjectId,
    resourceKind,
    resourceId,
    permissions,
    label,
    selectedRuntimeRole,
  ) {
    const direct = state.bindings.filter(
      (binding) =>
        binding.namespaceId === namespaceId &&
        binding.subjectKind === "identity" &&
        binding.subjectId === subjectId &&
        binding.resourceKind === resourceKind &&
        binding.resourceId === resourceId,
    );
    const assignment =
      selectedRuntimeRole === undefined
        ? undefined
        : direct.find((binding) => binding.runtimeRole !== undefined);
    if (assignment) {
      const hasReadGrant = direct.some((binding) =>
        state.roles.some(
          (role) =>
            role.id === binding.roleId &&
            role.permissions.some(
              (permission) => permission.action === "read" && permission.resourceKind === "agent",
            ),
        ),
      );
      if (!hasReadGrant) {
        await ensureGrant(subjectId, "agent", resourceId, agentReadPermissions, "Agent read");
      }
      if (assignment.runtimeRole !== selectedRuntimeRole) {
        await writeRuntimeRole(assignment, selectedRuntimeRole);
      }
      return;
    }
    let role = state.roles.find((candidate) => matchesRole(candidate, namespaceId, permissions));
    if (!role) {
      role = await write(`${path}/roles`, {
        method: "POST",
        body: { name: label, permissions },
      });
      if (!context.isCurrent()) {
        throw new DOMException("View closed", "AbortError");
      }
      state.roles.push(role);
    }
    const existing = direct.find((binding) =>
      state.roles.some(
        (candidate) =>
          candidate.id === binding.roleId && matchesRole(candidate, namespaceId, permissions),
      ),
    );
    if (existing && selectedRuntimeRole === undefined) {
      return;
    }
    const binding = await write(`${path}/access-bindings`, {
      method: "POST",
      body: {
        subjectKind: "identity",
        subjectId,
        roleId: role.id,
        resourceKind,
        resourceId,
        ...(selectedRuntimeRole === undefined ? {} : { runtimeRole: selectedRuntimeRole }),
      },
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
    state.saved = false;
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

  async function writeRuntimeRole(binding, selectedRole) {
    const updated = await write(
      `${path}/access-bindings/${encodeURIComponent(binding.id)}/runtime-role`,
      { method: "PATCH", body: { runtimeRole: selectedRole } },
    );
    if (!context.isCurrent()) {
      return;
    }
    state.bindings = state.bindings.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    );
  }

  function changeRole(binding, selectedRole) {
    return mutate(async () => {
      await writeRuntimeRole(binding, selectedRole);
      state.progress.push(
        "OpenClaw role changed. Existing connections close within 30 seconds; reconnect to use the new role.",
      );
    });
  }

  function removeBinding(binding) {
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
        binding.runtimeRole === undefined
          ? "Binding removed. Namespace discovery is unchanged. Other grants may still provide OCE access to this Agent."
          : "OpenClaw access revoked. Existing connections close within 30 seconds. Namespace discovery is unchanged; other grants may still provide OCE access to this Agent.",
      );
    });
  }

  runtimeRole.addEventListener("change", render);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const subjectId = principal.value.trim();
    const selectedRole = runtimeRole.value;
    if (!subjectId || !acknowledge.checked || !selectedRole) {
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
        "Agent OpenClaw access",
        selectedRole,
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
