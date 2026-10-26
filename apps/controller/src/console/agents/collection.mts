import type {
  AgentCallerPermissionsResponse,
  AgentDeploymentStatusWire,
  AgentRead,
  AgentRevisionListResponse,
  AgentRevisionMetadata,
  Namespace,
  NamespaceCallerPermissionsResponse,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import { type RequestOptions, requestFailure } from "../api-client.mjs";
import { button, element, setText, statusBlock } from "../dom.mjs";
import type { createDraftStore } from "../drafts.mjs";
import {
  DELETE_CONFIRMATION,
  STOP_CONFIRMATION,
  keptResources,
} from "./lifecycle-confirmation.mjs";
import {
  AGENT_CREATE_DENIED,
  type AgentNavigation,
  NAMESPACE_MISSING,
  NAMESPACE_RECHECK_MS,
  NEUTRAL_DEPLOYMENT_NOTES,
  deploymentOutcome,
  describeFailure,
  displayDate,
  hasUnbrokenRun,
  link,
  namespaceCreation,
  namespacePath,
  neutralDeploymentOutcome,
  outcomeLabel,
  shortId,
} from "./list.mjs";

type AgentPermissions = Static<typeof AgentCallerPermissionsResponse>["data"];
type RowAction = "stop" | "delete";

interface AgentListContext extends AgentNavigation {
  view: HTMLElement;
  items: readonly AgentRead[];
  namespaceId: string;
  namespace: Namespace | undefined;
  permissions?: Static<typeof NamespaceCallerPermissionsResponse>["data"] | null;
  drafts: ReturnType<ReturnType<typeof createDraftStore>["scope"]>;
  deniedReads?: { has(path: string): boolean; remember(path: string): void };
  isCurrent(): boolean;
  onExpired(): void;
  onResume?(resume: () => void): void;
  request(
    path: string,
    options: RequestOptions & {
      revalidate?: false;
      rereadOnResume?: true;
    },
  ): Promise<unknown>;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Stroke icons on a 24-unit grid: a square for Stop and a trash can for Delete.
const ACTION_ICONS = {
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
  delete: [
    ["path", { d: "M4 7h16" }],
    ["path", { d: "M10 11v6M14 11v6" }],
    ["path", { d: "M6 7l1 13h10l1-13" }],
    ["path", { d: "M9 7V4h6v3" }],
  ],
} as const;

function actionIcon(name: RowAction) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const attributes = {
    class: "action-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [key, value] of Object.entries(attributes)) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, shapeAttributes] of ACTION_ICONS[name]) {
    const shape = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(shapeAttributes)) {
      shape.setAttribute(key, String(value));
    }
    svg.append(shape);
  }
  return svg;
}

// Revisions list newest first, one page at a time (finding 1323). A page can be empty when
// its revisions are not readable to the viewer, so follow the cursor to the newest readable one.
// Returns it with the rest of its page.
async function latestReadableRevision(context: AgentListContext, path: string) {
  let cursor: string | null = null;
  do {
    const page = (await context.request(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { ...rowRead, includeMeta: true },
    )) as AgentRevisionListResponse;
    const [latest] = page.data;
    if (latest) {
      return { latest, page: page.data };
    }
    cursor = page.meta?.nextCursor ?? null;
  } while (cursor);
  return { latest: null, page: [] };
}

// The current version, `activeId`, for the Agents list (finding 2093). It is usually on the
// newest readable page; otherwise it is older or unreadable, so it is read on its own. That page
// lists only readable versions, so a refusal is remembered like the Agent page's denied reads
// (an audited 403 per list view otherwise). An unreadable or unread version is null.
async function currentRevision(
  context: AgentListContext,
  path: string,
  activeId: string | undefined,
  page: readonly AgentRevisionMetadata[],
) {
  const listed = page.find((revision) => revision.id === activeId);
  if (!activeId || listed || !page.length) {
    return listed ?? null;
  }
  const activePath = `${path}/${encodeURIComponent(activeId)}`;
  if (context.deniedReads?.has(activePath)) {
    return null;
  }
  try {
    return (await context.request(activePath, rowRead)) as AgentRevisionMetadata;
  } catch (error) {
    const { status } = requestFailure(error);
    if (status === 401) {
      throw error;
    }
    if (status === 403) {
      context.deniedReads?.remember(activePath);
    }
    return null;
  }
}

// A row's deployment while it is read. The text follows the 250 ms rule, so a read that lands
// sooner, as most do on a return to a retained list, never paints it (finding 1656). Text that a
// focusable holder wraps stays readable to a screen reader meanwhile.
const readingDeployment = (className = "delayed-status") =>
  element("span", { className }, "Reading deployment…");
// A row's current version until that read finds its number, on the same 250 ms rule.
const readingVersion = () => element("span", { className: "delayed-status" }, "Reading version…");
// With a dozen rows, reads that landed just after the 250 ms rule's delay (console.css
// .delayed-status and .delayed-text) replaced the text a frame or a few after it showed (16-133
// ms, finding 1683), so once shown it stays at least READING_SHOWN_MS.
const READING_SHOWN_MS = 150;

const rowRead = { revalidate: false, rereadOnResume: true } as const;

function agentNameLink(item: AgentRead, context: AgentNavigation) {
  const node = link(item.name, `agents/${item.id}`, context);
  if (hasUnbrokenRun(item.name)) {
    node.classList.add("agent-name-unbroken");
  }
  return node;
}

export function renderAgentList(context: AgentListContext) {
  const { view } = context;
  // Row actions replace an Agent with the API's response, so the table shows its new state.
  const items = [...context.items];
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  const savedSearch = context.drafts.get("agent-search");
  search.value = typeof savedSearch === "string" ? savedSearch : "";
  context.drafts.track("agent-search", () => search.value || undefined);
  context.drafts.unsavedWhen("agent-search", () => false);
  const rows = element("div");
  const feedback = element("div", { className: "agent-list-feedback" });
  const deployments = new Map<string, ReturnType<typeof readDeployment>>();
  // Agents whose last row action had a conflicting or unconfirmed outcome. Their actions stay
  // disabled until Refresh rereads the list, so the console never repeats an uncertain write.
  const unsettled = new Set<string>();
  const rowControls = new Map<
    string,
    ReturnType<typeof rowActions> & {
      name: HTMLAnchorElement;
      cell: HTMLTableCellElement;
    }
  >();
  // Advisory caller permissions per Agent, read as on Agent detail. A refusal disables that
  // row's icon before confirmation; a failed read keeps the usual path, and the API still
  // authorizes every write.
  const permissionReads = new Set<string>();
  const permissions = new Map<string, AgentPermissions>();
  type RestrictDialog = (id: string, answer: AgentPermissions) => void;
  let restrictOpenDialog: RestrictDialog | null = null;
  // The page renders with the caller's permission answer, so Create Agent is never painted
  // enabled and then refused, and the note never pushes the table down (finding 1517). Gating
  // only: the API still authorizes creation, so an unknown answer keeps the control.
  const createDenied = context.permissions?.agents?.create === false;
  // A Namespace that is not ready names its status here, so the first sign is never a refused
  // Secret or submit, and one that takes no new Agent never invites creating one (finding 1895).
  let notReady = namespaceCreation(context.namespace);
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    tone: "primary",
  });
  // A disabled Create Agent names its reason (UX plan A2), and a provisioning Namespace still
  // takes drafts, so Create Agent stays enabled and says why nothing deploys yet (finding 1990).
  const describeCreate = () => {
    create.disabled = createDenied || notReady?.blocked === true;
    const reasons = [
      ...(createDenied ? ["agents-create-denied"] : []),
      ...(notReady ? ["namespace-not-ready"] : []),
    ];
    if (reasons.length) {
      create.setAttribute("aria-describedby", reasons.join(" "));
    } else {
      create.removeAttribute("aria-describedby");
    }
  };
  describeCreate();
  // The Namespace status block (dom.mjs statusBlock's markup), a polite status on load.
  const namespaceNote = (tone: "warning" | "success", text: string) =>
    element(
      "p",
      {
        className: "status",
        "data-tone": tone,
        role: "status",
        ...(tone === "warning" ? { id: "namespace-not-ready" } : {}),
      },
      text,
    );
  let notReadyNote = notReady ? namespaceNote("warning", notReady.note) : null;
  view.replaceChildren(
    element("div", { className: "collection-toolbar" }, search, create),
    ...(notReadyNote ? [notReadyNote] : []),
    ...(createDenied
      ? [
          element(
            "p",
            { className: "muted", role: "status", id: "agents-create-denied" },
            AGENT_CREATE_DENIED,
          ),
        ]
      : []),
    feedback,
    rows,
  );
  // Each row's latest deployment, read after the list paints. A return to a retained list
  // revalidates only the list's own reads, so these never hold its reveal (finding 1644); the
  // retained rows read them again in place instead. So one still running doesn't keep the list
  // from being retained either (finding 1663): leaving aborts it, and the list rereads it.
  const cells = new Map<HTMLTableCellElement, { item: AgentRead; current: HTMLTableCellElement }>();
  // The row's revisions read, then its latest deployment and its current version side by side.
  function readDeployment(item: AgentRead) {
    const agentPath = agentRequestPath(item.id);
    const revisions = latestReadableRevision(context, `${agentPath}/revisions`);
    return {
      current: revisions.then(({ page }) =>
        currentRevision(context, `${agentPath}/revisions`, item.activeRevisionId, page),
      ),
      deployment: revisions.then(async ({ latest }) => {
        if (!latest) {
          return null;
        }
        const status = (await context.request(
          `${agentPath}/deployments/${encodeURIComponent(latest.id)}`,
          rowRead,
        )) as AgentDeploymentStatusWire;
        return { revision: latest, status };
      }),
    };
  }
  // A read that lands before a cell's reading text shows, or after it has shown long enough,
  // fills the cell now; otherwise once it has. The text shows in the frame its delay animation
  // ends in, not render time plus the delay: the animation starts with the frame that first styles
  // the text, which can be a frame or two either side of the render, so that estimate let a read
  // landing between the two fill the cell one frame after the text painted (finding 1716). A later
  // resume or render replaces the text, and its own read fills the cell instead.
  function fillAfterReading<Content extends unknown[]>(
    reading: Element | null,
    apply: (...content: Content) => void,
  ) {
    let shownAt: number | undefined;
    reading?.addEventListener("animationend", () => {
      shownAt = performance.now();
    });
    return (...content: Content) => {
      const wait = shownAt === undefined ? 0 : shownAt + READING_SHOWN_MS - performance.now();
      if (wait <= 0) {
        apply(...content);
        return;
      }
      setTimeout(() => {
        if (context.isCurrent() && reading?.isConnected) {
          apply(...content);
        }
      }, wait);
    };
  }
  // Fills a row's deployment cell. Focus in the cell moves to its new link, or to the row's Agent
  // link when it has none.
  function fillDeployment(deployment: HTMLTableCellElement, ...content: (Node | string)[]) {
    const focused = deployment.contains(deployment.ownerDocument.activeElement);
    deployment.replaceChildren(...content);
    if (focused) {
      (deployment.querySelector("a") ?? deployment.closest("tr")?.querySelector("a"))?.focus({
        preventScroll: true,
      });
    }
  }
  // Fills a row's Current version cell: the version's number once its row's read finds it, else
  // its ID as before, for a current version the reader cannot read (finding 2093).
  function fillCurrent(
    current: HTMLTableCellElement,
    item: AgentRead,
    active: AgentRevisionMetadata | null,
  ) {
    if (!item.activeRevisionId) {
      return;
    }
    const label = active ? `v${active.revision}` : shortId(item.activeRevisionId);
    const shown = current.querySelector("a");
    if (shown) {
      setText(shown, label);
      shown.classList.toggle("agent-revision-link", !active);
      return;
    }
    const version = link(label, `agents/${item.id}?revision=${item.activeRevisionId}`, context);
    version.classList.toggle("agent-revision-link", !active);
    current.replaceChildren(version);
  }
  function showDeployment(
    item: AgentRead,
    deployment: HTMLTableCellElement,
    current: HTMLTableCellElement,
  ) {
    let reads = deployments.get(item.id);
    if (!reads) {
      reads = readDeployment(item);
      deployments.set(item.id, reads);
    }
    // The cell's "Reading deployment…" (or its focusable holder).
    const fill = fillAfterReading<(Node | string)[]>(deployment.firstElementChild, (...content) =>
      fillDeployment(deployment, ...content),
    );
    const fillVersion = fillAfterReading(
      current.querySelector(".delayed-status"),
      (active: AgentRevisionMetadata | null) => fillCurrent(current, item, active),
    );
    void reads.current.then(
      (active) => context.isCurrent() && fillVersion(active),
      () => context.isCurrent() && fillVersion(null),
    );
    void reads.deployment
      .then((result) => {
        if (!context.isCurrent()) {
          return;
        }
        if (result === null) {
          fill("No visible deployments");
          return;
        }
        const neutral = neutralDeploymentOutcome(result.status);
        const failure =
          !neutral && result.status.status === "failed"
            ? (result.status.error?.message ?? "Deployment failed.")
            : null;
        // A long failure fits one line; its title and the Agent page give the whole text.
        fill(
          link(
            `v${result.revision.revision} · ${outcomeLabel(deploymentOutcome(result.status))}`,
            `agents/${item.id}?revision=${result.revision.id}`,
            context,
          ),
          element(
            "span",
            {
              className: "resource-id agent-deployment-note",
              ...(failure ? { title: failure } : {}),
            },
            failure ??
              (neutral ? `${NEUTRAL_DEPLOYMENT_NOTES[neutral]}.` : "Serving health unverified"),
          ),
        );
      })
      .catch((error) => {
        // A read the list's reset aborted fails here; it never paints the list it left.
        if (!context.isCurrent()) {
          return;
        }
        fill(
          requestFailure(error).status === 403
            ? "Deployment access denied"
            : "Deployment unavailable",
        );
      });
  }
  function agentRequestPath(id: string) {
    return `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(id)}`;
  }

  function showOutcome({
    notice,
    error,
    requestId,
  }: {
    notice?: string;
    error?: string;
    requestId?: string | undefined;
  }) {
    feedback.replaceChildren(
      ...(notice ? [statusBlock("info", null, notice)] : []),
      ...(error
        ? [
            element(
              "div",
              { className: "status", "data-tone": "danger", role: "alert" },
              element("p", { className: "status-body" }, error),
              requestId
                ? element("p", { className: "request-id" }, `Request ID: ${requestId}`)
                : null,
            ),
          ]
        : []),
    );
  }

  function replaceItem(expectedId: string, next: AgentRead) {
    // A write may have succeeded even if its response names a different Agent. Let the caller
    // report the unknown outcome and require Refresh before another action on the requested row.
    if (next.id !== expectedId) {
      throw new Error("The action response identified a different Agent.");
    }
    const index = items.findIndex((item) => item.id === expectedId);
    if (index !== -1) {
      items[index] = next;
    }
    render();
  }

  function focusRow(id: string, kind: RowAction) {
    const controls = rowControls.get(id);
    if (!controls) {
      search.focus();
    } else if (controls[kind] && !controls[kind].disabled) {
      controls[kind].focus();
    } else {
      // At a narrow width the name is scrolled out of view; keep the table where it was.
      controls.name.focus({ preventScroll: true });
    }
  }

  const restricts = (answer: AgentPermissions | undefined) =>
    answer?.operate === false || answer?.delete === false;

  // Read like the rows' deployments (rowRead), so these never hold a retained list's reveal; a
  // resume reads them again.
  function readPermissions(item: AgentRead) {
    if (permissionReads.has(item.id) || item.status === "deleting") {
      return;
    }
    permissionReads.add(item.id);
    void context.request(`${agentRequestPath(item.id)}/permissions`, rowRead).then(
      (result) => {
        if (!context.isCurrent()) {
          return;
        }
        const answer = result as AgentPermissions;
        const previous = permissions.get(item.id);
        permissions.set(item.id, answer);
        if (restricts(answer) || restricts(previous)) {
          restrictOpenDialog?.(item.id, answer);
          updateRowActions(item.id);
        }
      },
      () => {},
    );
  }

  function reportFailure(item: AgentRead, cause: unknown, kind: RowAction) {
    if (!context.isCurrent()) {
      return;
    }
    const error = requestFailure(cause);
    if (error.status === 401) {
      context.onExpired();
      return;
    }
    let text;
    if (error.status === 403) {
      text =
        kind === "stop"
          ? `You do not have permission to stop ${item.name}. Ask an administrator for Agent operate access.`
          : `You do not have permission to delete ${item.name}. Ask an administrator for Agent delete access.`;
    } else if (error.status === 400 || error.status === 429) {
      text = `Could not ${kind === "stop" ? "stop" : "delete"} ${item.name}. ${describeFailure(cause, { mutation: true })}`;
    } else {
      unsettled.add(item.id);
      if (error.status === 404) {
        text = `${item.name} is no longer available. Select Refresh to update the list.`;
      } else if (error.status === 409) {
        // The API's own reason, such as a lifecycle change while the request ran.
        text = `Could not ${kind === "stop" ? "stop" : "delete"} ${item.name}. ${describeFailure(cause, { mutation: true, conflict: `${item.name} changed while the request was sent.`, next: "Select Refresh before trying again." })}`;
      } else {
        text = `Outcome unknown. ${kind === "stop" ? "Stop" : "Deletion"} may have been accepted for ${item.name}. Select Refresh before trying again.`;
      }
    }
    showOutcome({ error: text, requestId: error.requestId });
    render();
  }

  async function stopAgent(item: AgentRead) {
    try {
      const stopped = (await context.request(`${agentRequestPath(item.id)}/stop`, {
        method: "POST",
      })) as AgentRead;
      if (!context.isCurrent()) {
        return;
      }
      if (
        stopped?.status !== "deleting" &&
        (stopped?.status !== "active" || stopped.desiredRuntimeState !== "stopped")
      ) {
        throw new Error("Invalid Agent stop response");
      }
      replaceItem(item.id, stopped);
      showOutcome({
        notice:
          stopped.status === "deleting"
            ? `${item.name} is being deleted.`
            : `Stop requested for ${item.name}. OCC will not start it again until you deploy a new version. Runtime shutdown completion is not exposed in Console.`,
      });
    } catch (error) {
      reportFailure(item, error, "stop");
    }
  }

  async function deleteAgent(item: AgentRead) {
    try {
      const deleting = (await context.request(agentRequestPath(item.id), {
        method: "DELETE",
      })) as AgentRead;
      if (!context.isCurrent()) {
        return;
      }
      if (deleting?.status !== "deleting") {
        throw new Error("Invalid deletion response");
      }
      replaceItem(item.id, deleting);
      showOutcome({
        notice: `Deletion requested for ${item.name}. It leaves this list once cleanup finishes; select Refresh to check.`,
      });
    } catch (error) {
      reportFailure(item, error, "delete");
    }
  }

  function confirmAction(item: AgentRead, kind: RowAction, invoker: HTMLButtonElement) {
    const stopping = kind === "stop";
    const description = element(
      "p",
      { id: "agent-row-confirm-description", "aria-live": "polite" },
      stopping ? STOP_CONFIRMATION : DELETE_CONFIRMATION,
    );
    const kept = stopping ? null : keptResources(item);
    const dialog = element("dialog", {
      className: stopping ? "dialog agent-stop-dialog" : "dialog agent-delete-dialog",
      "aria-labelledby": "agent-row-confirm-title",
      "aria-describedby": kept ? `${description.id} ${kept.summary.id}` : description.id,
    });
    let pending = false;
    let submitted = false;
    const permission = stopping ? "operate" : "delete";
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      stopping ? "Stop Agent" : "Permanently delete Agent",
      async () => {
        if (permissions.get(item.id)?.[permission] === false) {
          return;
        }
        pending = true;
        submitted = true;
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.textContent = stopping ? "Stopping…" : "Deleting…";
        // Busy, not merely disabled: the progress cursor, and "working" for assistive technology.
        confirm.setAttribute("aria-busy", "true");
        await (stopping ? stopAgent(item) : deleteAgent(item));
        pending = false;
        dialog.close();
      },
      { className: "danger" },
    );
    // A refusal that arrives while the dialog is open disables confirmation, as on Agent
    // detail. A late answer cannot recall a request already sent.
    const restrict: RestrictDialog = (id, answer) => {
      if (id !== item.id || !dialog.open || pending || answer?.[permission] !== false) {
        return;
      }
      confirm.disabled = true;
      description.textContent = stopping
        ? "Your access does not include stopping this Agent."
        : "Your access does not include deleting this Agent.";
      cancel.focus();
    };
    restrictOpenDialog = restrict;
    dialog.append(
      element(
        "h2",
        { id: "agent-row-confirm-title" },
        `${stopping ? "Stop" : "Delete"} ${item.name}?`,
      ),
      description,
      ...(kept ? [kept.summary, kept.commands] : []),
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        if (restrictOpenDialog === restrict) {
          restrictOpenDialog = null;
        }
        dialog.remove();
        if (!context.isCurrent()) {
          return;
        }
        // A redraw while the dialog was open (a permission refusal, for example) replaces the
        // invoking icon, so fall back to the row's current controls.
        if (!submitted && invoker.isConnected && !invoker.disabled) {
          invoker.focus();
        } else {
          focusRow(item.id, kind);
        }
      },
      { once: true },
    );
    view.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  // Every disabled icon has a visible reason: a badge, the alert above the table, or a note.
  function rowActions(item: AgentRead) {
    // A deleting Agent keeps its retry and status controls on its detail page.
    const available = item.status !== "deleting" && !unsettled.has(item.id);
    const stopped = item.desiredRuntimeState === "stopped";
    // New Agents start stopped with no version, so there is nothing to stop yet; Agent detail
    // shows no Stop control then either.
    const neverStarted = stopped && !item.activeRevisionId;
    const allowed = permissions.get(item.id);
    const canStop = neverStarted || allowed?.operate !== false;
    const canDelete = allowed?.delete !== false;
    const noteId = `agent-row-note-${item.id}`;
    const badgeId = `agent-row-badge-${item.id}`;
    let restriction = null;
    if (!canStop && !canDelete) {
      restriction = "No access to stop or delete";
    } else if (!canStop) {
      restriction = "No access to stop";
    } else if (!canDelete) {
      restriction = "No access to delete";
    }
    const describedBy = (blocked: boolean, badge: string | null) => {
      const ids = [blocked ? noteId : null, badge].filter(Boolean);
      return ids.length ? { "aria-describedby": ids.join(" ") } : {};
    };
    const stop = neverStarted
      ? null
      : button(
          actionIcon("stop"),
          (event) => confirmAction(item, "stop", event.currentTarget as HTMLButtonElement),
          {
            className: "icon-button",
            "aria-label": `Stop ${item.name}`,
            title: "Stop Agent",
            disabled: !available || stopped || !canStop,
            // A deleting or Stop requested badge explains a stopped Agent's disabled icon.
            ...describedBy(!canStop, stopped ? badgeId : null),
          },
        );
    const remove = button(
      actionIcon("delete"),
      (event) => confirmAction(item, "delete", event.currentTarget as HTMLButtonElement),
      {
        className: "icon-button",
        "aria-label": `Delete ${item.name}`,
        title: "Delete Agent",
        disabled: !available || !canDelete,
        ...describedBy(!canDelete, item.status === "deleting" ? badgeId : null),
      },
    );
    // The note's line is reserved from the first paint, so advice that lands later only fills it.
    const note = element(
      "span",
      { className: "row-action-note", id: noteId, ...(restriction ? { title: restriction } : {}) },
      restriction ?? "",
    );
    return { stop, delete: remove, note };
  }

  function actionCellContent(actions: ReturnType<typeof rowActions>) {
    return [
      element(
        "div",
        { className: "agent-row-actions" },
        actions.stop ?? element("span", { className: "icon-button-spacer" }),
        actions.delete,
      ),
      actions.note,
    ];
  }

  // A permission answer changes only its own row's actions. Redrawing the whole table would
  // drop keyboard focus from wherever the person is, so update that cell in place and move
  // focus only when the focused icon itself is replaced, keeping it in the same row.
  function updateRowActions(id: string) {
    const controls = rowControls.get(id);
    const item = items.find((entry) => entry.id === id);
    if (!controls?.cell.isConnected || !item) {
      return;
    }
    const focused = (["stop", "delete"] as const).find(
      (kind) => controls[kind] && controls[kind] === document.activeElement,
    );
    const actions = rowActions(item);
    controls.cell.replaceChildren(...actionCellContent(actions));
    Object.assign(controls, actions);
    if (focused) {
      focusRow(id, focused);
    }
  }

  function render() {
    cells.clear();
    rowControls.clear();
    const query = search.value.trim().toLowerCase();
    const matches = items
      .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!matches.length) {
      rows.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          element("h2", {}, query ? "No matching Agents" : "No Agents yet"),
          element(
            "p",
            {},
            query
              ? "Try another name or ID."
              : createDenied
                ? // Under the note above: say what the reader can expect, not invite creating
                  // (finding 1521).
                  "Agents in this Namespace that are shared with you appear here."
                : notReady?.blocked
                  ? context.namespace?.status === "provisioning" && !notReady.missing
                    ? "You can create Agents here once this Namespace is ready."
                    : "Agents cannot be created in this Namespace."
                  : notReady
                    ? "You can save an Agent draft here now. It can be deployed once this Namespace is ready."
                    : "Create an Agent in this Namespace using an editable Configuration template.",
          ),
        ),
      );
      return;
    }
    const table = element("table", { className: "agent-table", "aria-label": "Agents" });
    table.append(
      element(
        "thead",
        {},
        element(
          "tr",
          {},
          ...[
            "Agent",
            "Execution mode",
            "Current version",
            "Latest deployment",
            "Created",
            "Actions",
          ].map((label) => element("th", { scope: "col" }, label)),
        ),
      ),
    );
    const body = element("tbody");
    for (const item of matches) {
      readPermissions(item);
      const name = agentNameLink(item, context);
      const actions = rowActions(item);
      const cell = element(
        "td",
        { className: "agent-row-actions-cell", "data-label": "Actions" },
        ...actionCellContent(actions),
      );
      rowControls.set(item.id, { name, cell, ...actions });
      // The current version's number comes with the row's deployment read.
      const current = element(
        "td",
        { className: "agent-current-version", "data-label": "Current version" },
        item.activeRevisionId ? readingVersion() : "No current version",
      );
      // The cell keeps its column's width once its read lands, and its outcome link and one
      // note line fit the two lines the Agent cell already gives the row (finding 1488).
      const deployment = element(
        "td",
        { className: "agent-deployment", "data-label": "Latest deployment" },
        readingDeployment(),
      );
      cells.set(deployment, { item, current });
      showDeployment(item, deployment, current);
      const row = element(
        "tr",
        {},
        element(
          "td",
          {},
          name,
          element("span", { className: "resource-id" }, item.id),
          item.status === "deleting"
            ? element(
                "span",
                { className: "badge", "data-tone": "warning", id: `agent-row-badge-${item.id}` },
                "Deleting",
              )
            : null,
          // New Agents start stopped; only a stop with a selected version awaits shutdown.
          item.status === "active" &&
            item.desiredRuntimeState === "stopped" &&
            item.activeRevisionId
            ? element(
                "span",
                { className: "badge", "data-tone": "info", id: `agent-row-badge-${item.id}` },
                "Stop requested",
              )
            : null,
          "configurationReadError" in item && item.configurationReadError
            ? element(
                "span",
                { className: "badge", "data-tone": "danger" },
                "Saved configuration unreadable",
              )
            : null,
        ),
        // On a phone each cell shows its column's name (console.css, `data-label`).
        element(
          "td",
          { "data-label": "Execution mode" },
          item.executionMode === "dedicated" ? "Dedicated" : "Embedded",
        ),
        current,
        deployment,
        element("td", { "data-label": "Created" }, displayDate(item.createdAt)),
        cell,
      );
      row.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (event.target instanceof Element && event.target.closest("a, button")) ||
          window.getSelection()?.isCollapsed === false
        ) {
          return;
        }
        // Reuse the name link so navigation and return focus follow the same path.
        name.focus({ preventScroll: true });
        name.click();
      });
      body.append(row);
    }
    table.append(body);
    // On a phone the rows stack (console.css), and a table part whose CSS display changes can
    // lose its table role in some browsers. Explicit roles keep the table for screen readers.
    table.setAttribute("role", "table");
    for (const [parts, role] of [
      ["thead, tbody", "rowgroup"],
      ["tr", "row"],
      ["th", "columnheader"],
      ["td", "cell"],
    ] as const) {
      for (const part of table.querySelectorAll(parts)) {
        part.setAttribute("role", role);
      }
    }
    // Row actions redraw the table; keep a narrow viewport's horizontal scroll position.
    const scrollLeft = rows.querySelector(".table-scroll")?.scrollLeft ?? 0;
    const scroller = element("div", { className: "table-scroll" }, table);
    rows.replaceChildren(scroller);
    scroller.scrollLeft = scrollLeft;
  }
  // A retained list is mounted without rereading its rows' deployments, so what they showed is
  // not presented as current: each row reads its deployment again from "Reading deployment…",
  // blank for its first 250 ms. Back from a deployment can focus the pending cell. Keep its
  // address only to match that return: until the read settles, the previous revision must not
  // be an active link.
  context.onResume?.(() => {
    deployments.clear();
    permissionReads.clear();
    for (const [deployment, { item, current }] of cells) {
      readPermissions(item);
      // A cell still reading from an earlier resume keeps the address it was given.
      const shown =
        deployment.querySelector("a")?.href ??
        deployment.querySelector<HTMLElement>("[data-return-focus-href]")?.dataset.returnFocusHref;
      deployment.replaceChildren(
        shown
          ? element(
              "span",
              { tabindex: "-1", "data-return-focus-href": shown },
              readingDeployment("delayed-text"),
            )
          : readingDeployment(),
      );
      showDeployment(item, deployment, current);
    }
  });
  search.addEventListener("input", render);
  render();
  // A provisioning Namespace becomes ready on its own. A refocus, return or Refresh rebuilds the
  // list, but a reader who stayed on it kept seeing "Provisioning" (finding 2058). While the note
  // waits on provisioning, reread the Namespace at Create Agent's cadence and, as Create Agent
  // does, update the note and the gate in place, so search text and focus stay (findings 2012,
  // 2024). A hidden tab reads nothing; the next check after it shows again does.
  if (context.namespace?.status === "provisioning") {
    let timer: number | null = null;
    let reading = false;
    // `null` is a complete list without the Namespace: deleted, or the reader lost access.
    const showNamespace = (namespace: Namespace | null) => {
      if (namespace) {
        context.namespace = namespace;
      }
      notReady = namespace ? namespaceCreation(namespace) : NAMESPACE_MISSING;
      describeCreate();
      // A ready Namespace says so where the warning was. The list holds no field being edited,
      // so the note keeps its own height (Create Agent keeps the warning's, finding 2024).
      const replacement = notReady
        ? namespaceNote("warning", notReady.note)
        : namespaceNote(
            "success",
            "Namespace status: Ready. Agents created here can be deployed now.",
          );
      notReadyNote?.replaceWith(replacement);
      notReadyNote = replacement;
      // Only the empty state's sentence depends on the Namespace; rows keep their focus.
      if (!rows.querySelector("table")) {
        render();
      }
    };
    const recheckNamespace = async () => {
      timer = null;
      if (!context.isCurrent() || reading) {
        return;
      }
      if (document.hidden) {
        waitForNamespace();
        return;
      }
      reading = true;
      let namespaces: readonly Namespace[] | null = null;
      try {
        namespaces = (await context.request("/namespaces", rowRead)) as Namespace[];
      } catch {
        // A failed read changes nothing on screen; the next check comes at the usual cadence.
      } finally {
        reading = false;
      }
      if (!context.isCurrent()) {
        return;
      }
      const namespace = namespaces?.find((item) => item.id === context.namespaceId);
      // A list without the Namespace ends the wait: waiting changes nothing, so the note says so
      // and Create Agent is disabled, as on Create Agent (finding 2081).
      if (namespaces && !namespace) {
        showNamespace(null);
        return;
      }
      if (namespace && namespace.status !== context.namespace?.status) {
        showNamespace(namespace);
      }
      if (context.namespace?.status === "provisioning") {
        waitForNamespace();
      }
    };
    const waitForNamespace = () => {
      if (timer === null) {
        timer = setTimeout(() => void recheckNamespace(), NAMESPACE_RECHECK_MS);
      }
    };
    waitForNamespace();
    // A retained list comes back with its timer stopped, as Create Agent's does.
    context.onResume?.(() => {
      if (context.namespace?.status === "provisioning" && !notReady?.missing) {
        waitForNamespace();
      }
    });
  }
}
