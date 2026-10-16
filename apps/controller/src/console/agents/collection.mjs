import { button, element } from "../dom.mjs";
import { DELETE_CONFIRMATION, keptResourcesText } from "./deletion.mjs";
import {
  NEUTRAL_DEPLOYMENT_NOTES,
  deploymentOutcome,
  displayDate,
  link,
  message,
  namespacePath,
  neutralDeploymentOutcome,
  shortId,
} from "./list.mjs";
import { STOP_CONFIRMATION } from "./stop.mjs";

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
};

function actionIcon(name) {
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
async function latestReadableRevision(context, path) {
  let cursor = null;
  do {
    const page = await context.request(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { includeMeta: true },
    );
    if (page.data.length > 0) {
      return page.data[0];
    }
    cursor = page.meta?.nextCursor ?? null;
  } while (cursor);
  return null;
}

export function renderAgentList(context) {
  const { view } = context;
  // Row actions replace an Agent with the API's response, so the table shows its new state.
  const items = [...context.items];
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  search.value = context.drafts.get("agent-search") ?? "";
  context.drafts.track("agent-search", () => search.value || undefined);
  const rows = element("div");
  const feedback = element("div", { className: "agent-list-feedback" });
  const deployments = new Map();
  // Agents whose last row action had a conflicting or unconfirmed outcome. Their actions stay
  // disabled until Refresh rereads the list, so the console never repeats an uncertain write.
  const unsettled = new Set();
  const rowControls = new Map();
  // Advisory caller permissions per Agent, read as on Agent detail. A refusal disables that
  // row's icon before confirmation; a failed read keeps the usual path, and the API still
  // authorizes every write.
  const permissionReads = new Set();
  const permissions = new Map();
  let restrictOpenDialog = null;
  // The page renders with the caller's permission answer, so Create Agent is never painted
  // enabled and then refused, and the note never pushes the table down (finding 1517). Gating
  // only: the API still authorizes creation, so an unknown answer keeps the control.
  const createDenied = context.permissions?.agents?.create === false;
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    className: "primary",
  });
  create.disabled = createDenied;
  view.replaceChildren(
    element("div", { className: "agent-toolbar" }, search, create),
    ...(createDenied
      ? [
          element(
            "p",
            { className: "muted", role: "status" },
            "Your access does not include creating Agents in this Namespace.",
          ),
        ]
      : []),
    feedback,
    rows,
  );

  const agentPath = (id) =>
    `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(id)}`;

  function showOutcome({ notice, error, requestId }) {
    feedback.replaceChildren(
      ...(notice ? [element("p", { className: "notice", role: "status" }, notice)] : []),
      ...(error
        ? [
            element(
              "div",
              { className: "error", role: "alert" },
              element("p", {}, error),
              requestId
                ? element("p", { className: "request-id" }, `Request ID: ${requestId}`)
                : null,
            ),
          ]
        : []),
    );
  }

  function replaceItem(next) {
    const index = items.findIndex((item) => item.id === next.id);
    if (index !== -1) {
      items[index] = next;
    }
    render();
  }

  function focusRow(id, kind) {
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

  function readPermissions(item) {
    if (permissionReads.has(item.id) || item.status === "deleting") {
      return;
    }
    permissionReads.add(item.id);
    void context.request(`${agentPath(item.id)}/permissions`).then(
      (answer) => {
        if (!context.isCurrent()) {
          return;
        }
        permissions.set(item.id, answer);
        if (answer?.operate === false || answer?.delete === false) {
          restrictOpenDialog?.(item.id, answer);
          updateRowActions(item.id);
        }
      },
      () => {},
    );
  }

  function reportFailure(item, error, kind) {
    if (!context.isCurrent()) {
      return;
    }
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
    } else if ([400, 429].includes(error.status)) {
      text = message(error, true);
    } else {
      unsettled.add(item.id);
      if (error.status === 404) {
        text = `${item.name} is no longer available. Select Refresh to update the list.`;
      } else if (error.status === 409) {
        text = `${item.name} changed while the request was sent. Select Refresh before trying again.`;
      } else {
        text = `Outcome unknown. ${kind === "stop" ? "Stop" : "Deletion"} may have been accepted for ${item.name}. Select Refresh before trying again.`;
      }
    }
    showOutcome({ error: text, requestId: error.requestId });
    render();
  }

  async function stopAgent(item) {
    try {
      const stopped = await context.request(`${agentPath(item.id)}/stop`, { method: "POST" });
      if (!context.isCurrent()) {
        return;
      }
      if (
        stopped?.status !== "deleting" &&
        (stopped?.status !== "active" || stopped.desiredRuntimeState !== "stopped")
      ) {
        throw new Error("Invalid Agent stop response");
      }
      replaceItem(stopped);
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

  async function deleteAgent(item) {
    try {
      const deleting = await context.request(agentPath(item.id), { method: "DELETE" });
      if (!context.isCurrent()) {
        return;
      }
      if (deleting?.status !== "deleting") {
        throw new Error("Invalid deletion response");
      }
      replaceItem(deleting);
      showOutcome({
        notice: `Deletion requested for ${item.name}. It leaves this list once cleanup finishes; select Refresh to check.`,
      });
    } catch (error) {
      reportFailure(item, error, "delete");
    }
  }

  function confirmAction(item, kind, invoker) {
    const stopping = kind === "stop";
    const descriptions = stopping
      ? [STOP_CONFIRMATION]
      : [DELETE_CONFIRMATION, keptResourcesText(item)];
    const dialog = element("dialog", {
      className: stopping ? "agent-stop-dialog" : "agent-delete-dialog",
      "aria-labelledby": "agent-row-confirm-title",
      "aria-describedby": descriptions
        .map((_, index) => `agent-row-confirm-description-${index}`)
        .join(" "),
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
        await (stopping ? stopAgent(item) : deleteAgent(item));
        pending = false;
        dialog.close();
      },
      { className: "danger" },
    );
    const descriptionNodes = descriptions.map((text, index) =>
      element(
        "p",
        { id: `agent-row-confirm-description-${index}`, "aria-live": index ? "off" : "polite" },
        text,
      ),
    );
    // A refusal that arrives while the dialog is open disables confirmation, as on Agent
    // detail. A late answer cannot recall a request already sent.
    const restrict = (id, answer) => {
      if (id !== item.id || !dialog.open || pending || answer?.[permission] !== false) {
        return;
      }
      confirm.disabled = true;
      descriptionNodes[0].textContent = stopping
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
      ...descriptionNodes,
      element("div", { className: "form-actions" }, cancel, confirm),
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
  function rowActions(item) {
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
    const describedBy = (blocked, badge) => {
      const ids = [blocked ? noteId : null, badge].filter(Boolean);
      return ids.length ? { "aria-describedby": ids.join(" ") } : {};
    };
    const stop = neverStarted
      ? null
      : button(actionIcon("stop"), (event) => confirmAction(item, "stop", event.currentTarget), {
          className: "icon-button",
          "aria-label": `Stop ${item.name}`,
          title: "Stop Agent",
          disabled: !available || stopped || !canStop,
          // A deleting or Stop requested badge explains a stopped Agent's disabled icon.
          ...describedBy(!canStop, stopped ? badgeId : null),
        });
    const remove = button(
      actionIcon("delete"),
      (event) => confirmAction(item, "delete", event.currentTarget),
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

  function actionCellContent(actions) {
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
  function updateRowActions(id) {
    const controls = rowControls.get(id);
    const item = items.find((entry) => entry.id === id);
    if (!controls?.cell.isConnected || !item) {
      return;
    }
    const focused = ["stop", "delete"].find(
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
    rowControls.clear();
    for (const item of matches) {
      readPermissions(item);
      const name = link(item.name, `agents/${item.id}`, context);
      const actions = rowActions(item);
      const cell = element(
        "td",
        { className: "agent-row-actions-cell" },
        ...actionCellContent(actions),
      );
      rowControls.set(item.id, { name, cell, ...actions });
      // The cell keeps its column's width once its read lands, and its outcome link and one
      // note line fit the two lines the Agent cell already gives the row (finding 1488).
      const deployment = element("td", { className: "agent-deployment" }, "Reading deployment…");
      if (!deployments.has(item.id)) {
        deployments.set(
          item.id,
          latestReadableRevision(
            context,
            `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(item.id)}/revisions`,
          ).then(async (latest) => {
            if (!latest) {
              return null;
            }
            const status = await context.request(
              `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(item.id)}/deployments/${encodeURIComponent(latest.id)}`,
            );
            return { revision: latest, status };
          }),
        );
      }
      void deployments
        .get(item.id)
        .then((result) => {
          if (!context.isCurrent()) {
            return;
          }
          if (result === null) {
            deployment.textContent = "No visible deployments";
            return;
          }
          deployment.replaceChildren(
            link(
              `v${result.revision.revision} · ${deploymentOutcome(result.status)}`,
              `agents/${item.id}?revision=${result.revision.id}`,
              context,
            ),
          );
          const neutral = neutralDeploymentOutcome(result.status);
          const failure =
            !neutral && result.status.status === "failed"
              ? (result.status.error?.message ?? "Deployment failed.")
              : null;
          // A long failure fits one line; its title and the Agent page give the whole text.
          deployment.append(
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
          deployment.textContent =
            error.status === 403 ? "Deployment access denied" : "Deployment unavailable";
        });
      body.append(
        element(
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
                  { className: "badge", id: `agent-row-badge-${item.id}` },
                  "Deleting",
                )
              : null,
            // New Agents start stopped; only a stop with a selected version awaits shutdown.
            item.status === "active" &&
              item.desiredRuntimeState === "stopped" &&
              item.activeRevisionId
              ? element(
                  "span",
                  { className: "badge", id: `agent-row-badge-${item.id}` },
                  "Stop requested",
                )
              : null,
            item.configurationReadError
              ? element("span", { className: "badge" }, "Saved configuration unreadable")
              : null,
          ),
          element("td", {}, item.executionMode === "dedicated" ? "Dedicated" : "Embedded"),
          element(
            "td",
            {},
            item.activeRevisionId
              ? link(
                  shortId(item.activeRevisionId),
                  `agents/${item.id}?revision=${item.activeRevisionId}`,
                  context,
                )
              : "No current version",
          ),
          deployment,
          element("td", {}, displayDate(item.createdAt)),
          cell,
        ),
      );
    }
    table.append(body);
    // Row actions redraw the table; keep a narrow viewport's horizontal scroll position.
    const scrollLeft = rows.querySelector(".table-scroll")?.scrollLeft ?? 0;
    const scroller = element("div", { className: "table-scroll" }, table);
    rows.replaceChildren(scroller);
    scroller.scrollLeft = scrollLeft;
  }
  search.addEventListener("input", render);
  render();
}
