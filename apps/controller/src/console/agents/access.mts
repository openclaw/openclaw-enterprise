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
import { describeFailure, message, namespacePath } from "./list.mjs";

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

// The Agent page's Access tab (spec 3.8). `onDenied` runs when the policy read is refused, after
// the panel hides itself. `onWriting` runs with true when a share or removal starts and false
// when it ends: the page holds version and page changes meanwhile (finding 2108). `recheck` reads
// the policy again for a reader who returns to the tab.
export function renderAgentAccess(
  context: AgentAccessContext,
  agent: Pick<Agent, "id">,
  { onDenied, onWriting }: { onDenied?(): void; onWriting?(writing: boolean): void } = {},
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
  const refresh = button("Refresh sharing", () => void load(), { size: "sm" });
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
    progress: [] as string[],
    error: null as string | null,
    // Set once the API accepts a write in the current change.
    saved: false,
  };
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
        "These are explicit bindings to this Agent, not all effective access. Groups, other grants and Installation administration can still provide access. Removing a binding keeps Namespace discovery access.",
      ),
      grants,
      refresh,
    ),
  );

  function render() {
    const blocked = state.pending || !state.loaded || state.needsRefresh;
    principal.disabled = blocked;
    acknowledge.disabled = blocked;
    share.disabled = blocked;
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
      // Removal deletes the binding at once, so it takes the destructive tone (finding 1967).
      const remove = button("Remove binding", () => void removeBinding(binding), {
        tone: "danger",
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

  // A recheck reads one list at a time: a reader whose administration ended is refused, and
  // audited, once.
  async function readPolicy({ oneAtATime = false } = {}) {
    const readRoles = () => context.request(`${path}/roles`, INSTALLATION_ADMINISTRATION);
    const readBindings = () =>
      context.request(`${path}/access-bindings`, INSTALLATION_ADMINISTRATION);
    const [roles, bindings] = oneAtATime
      ? [await readRoles(), await readBindings()]
      : await Promise.all([readRoles(), readBindings()]);
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

  async function load({ recheck = false } = {}) {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    // Refresh is disabled while it reads, which drops its focus; give it back (finding 1446).
    const refocus = document.activeElement === refresh;
    state.pending = true;
    state.error = null;
    render();
    try {
      await readPolicy({ oneAtATime: recheck });
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
    state.pending = true;
    state.error = null;
    state.progress = [];
    state.saved = false;
    let mutationStarted = false;
    render();
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
        // Share disables while it runs, which dropped focus to the page and left a refusal
        // above the form unread; it takes focus and comes into view (findings 1862, 1864).
        revealStatus(feedback.querySelector("[role=alert]"), section);
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
