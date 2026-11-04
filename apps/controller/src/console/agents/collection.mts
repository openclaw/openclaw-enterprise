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
import { resourceActionIcon } from "../resource-actions.mjs";
import {
  button,
  element,
  mayReturnFocus,
  setText,
  setUnavailable,
  statusBlock,
  requestIdLine,
} from "../dom.mjs";
import type { createDraftStore } from "../drafts.mjs";
import {
  DELETE_CONFIRMATION,
  grantRefusal,
  keptResources,
  stopConfirmation,
} from "./lifecycle-confirmation.mjs";
import { credentialRejectedAsk } from "./deployment-recovery.mjs";
import {
  agentCreateDenied,
  AGENT_DELETE_DENIED,
  AGENT_STOP_DENIED,
  deleteRefused,
  notIncluded,
  stopRefused,
  unreadableCurrentVersion,
} from "./access-reasons.mjs";
import {
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
// A refused row action. `text` is set for a refusal that is not about grants: the alert's text,
// which the row's note repeats (finding D812).
interface RowRefusal {
  id: string;
  kind: RowAction;
  text?: string;
  requestId?: string | undefined;
}

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
  /** A refocus recheck rebuilds this list (not Refresh or a navigation). */
  resumed?: boolean;
  request(
    path: string,
    options: RequestOptions & {
      revalidate?: false;
      rereadOnResume?: true;
    },
  ): Promise<unknown>;
}

// Revisions list newest first, one page at a time (finding 1323). A page can be empty when
// its revisions are not readable to the viewer, so follow the cursor to the newest readable one.
// Returns it with the rest of its page, and whether that page lists every readable version: the
// API sends a cursor only when it found an older one the caller can read.
async function latestReadableRevision(
  context: AgentListContext,
  path: string,
  signal: AbortSignal,
) {
  let cursor: string | null = null;
  do {
    const page = (await context.request(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { ...rowRead, signal, includeMeta: true },
    )) as AgentRevisionListResponse;
    cursor = page.meta?.nextCursor ?? null;
    const [latest] = page.data;
    if (latest) {
      return { latest, page: page.data, complete: cursor === null };
    }
  } while (cursor);
  return { latest: null, page: [], complete: true };
}

// A current version the caller cannot read, and whether it is newer than every version they can.
// The alert above the table that reports a refused row action (showOutcome).
const REFUSAL_ID = "agent-row-refusal";
// A refusal not about grants waits for Refresh. A refocus that rebuilds the list, because a
// recheck read changed or a write made the list one it does not reuse, shows it again; any
// other load drops it (finding D812).
let keptRefusal: (RowRefusal & { text: string; namespaceId: string }) | null = null;
const UNREADABLE = "unreadable";
const NEWER_UNREADABLE = "newer-unreadable";
type CurrentVersion = AgentRevisionMetadata | typeof UNREADABLE | typeof NEWER_UNREADABLE | null;

// The current version, `activeId`, for the Agents list (finding 2093). It is usually on the
// newest readable page. When that page lists every readable version, one it does not list is
// unreadable, and the list says so without reading it, as the Agent page does: the read was an
// audited 403 on every list load (finding D789). Otherwise it may be on an older page, so it is
// read on its own, and a refusal is remembered like the Agent page's denied reads. A version
// that could not be read for another reason is null.
async function currentRevision(
  context: AgentListContext,
  path: string,
  activeId: string | undefined,
  { page, complete }: { page: readonly AgentRevisionMetadata[]; complete: boolean },
  signal: AbortSignal,
): Promise<Exclude<CurrentVersion, typeof NEWER_UNREADABLE>> {
  const listed = page.find((revision) => revision.id === activeId);
  if (!activeId || listed) {
    return listed ?? null;
  }
  const activePath = `${path}/${encodeURIComponent(activeId)}`;
  if (complete || context.deniedReads?.has(activePath)) {
    return UNREADABLE;
  }
  try {
    return (await context.request(activePath, { ...rowRead, signal })) as AgentRevisionMetadata;
  } catch (error) {
    const { status } = requestFailure(error);
    if (status === 401) {
      throw error;
    }
    if (status === 403) {
      context.deniedReads?.remember(activePath);
      return UNREADABLE;
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

// The reads of one row that a search can retire. A search that hides the row aborts them while
// they are unfinished, so the browser never sends the ones it still queues; a row shown again
// reads anew. A finished read stays, so a row is not read twice.
interface RowReads {
  readonly signal: AbortSignal;
  finished: boolean;
  retire(): void;
}

function rowReads(): RowReads {
  const controller = new AbortController();
  return { signal: controller.signal, finished: false, retire: () => controller.abort() };
}

function finishWith(row: RowReads, ...reads: Promise<unknown>[]) {
  void Promise.allSettled(reads).then(() => {
    row.finished = true;
  });
}

// Retires the unfinished reads of rows that are not in `shown`, and forgets them so a row that is
// shown again starts them anew.
function retireHidden<Read>(
  reads: Map<string, Read>,
  shown: ReadonlySet<string>,
  rowOf: (read: Read) => RowReads,
) {
  for (const [id, read] of reads) {
    const row = rowOf(read);
    if (!shown.has(id) && !row.finished) {
      row.retire();
      reads.delete(id);
    }
  }
}

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
  // The row action whose last write the API refused (403). Its icon is described by the alert
  // above the table, which can sit far from the row on a narrow screen (finding 2952).
  let refusal: RowRefusal | null = null;
  // Every refused row action ("<id> <kind>"), with the count of permission reads started before
  // it. Each stays unavailable, and the row's note under its icons names the grant, until a read
  // started after it allows that action (finding 2955), as on the Agent page.
  const refusedActions = new Map<string, number>();
  let permissionReadsStarted = 0;
  // Keep the latest readable outcome for the Stop confirmation copy. It cannot establish
  // whether newer work exists: a queued deployment may be hidden by revision read permissions.
  const latestDeployments = new Map<string, string>();
  function setLatestDeployment(item: AgentRead, outcome: string | null) {
    if (outcome) {
      latestDeployments.set(item.id, outcome);
    } else {
      latestDeployments.delete(item.id);
    }
  }
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
  const permissionReads = new Map<string, RowReads>();
  // Each row's permission answer as it settles (null when it failed), for text that depends on it.
  const permissionAnswers = new Map<string, Promise<AgentPermissions | null>>();
  const permissions = new Map<string, AgentPermissions>();
  type RestrictDialog = (id: string, answer: AgentPermissions) => void;
  let restrictOpenDialog: RestrictDialog | null = null;
  let dismissOpenDialog: (() => void) | null = null;
  // The page renders with the caller's permission answer, so Create Agent is never painted
  // enabled and then refused, and the note never pushes the table down (finding 1517). Gating
  // only: the API still authorizes creation, so an unknown answer keeps the control.
  const createDenied = context.permissions?.agents?.create === false;
  // An administrator a Restriction keeps from creating still reads every Agent here (finding D759).
  const sharedOnly = createDenied && context.permissions?.installation?.administer !== true;
  // A Namespace that is not ready names its status here, so the first sign is never a refused
  // Secret or submit, and one that takes no new Agent never invites creating one (finding 1895).
  let notReady = namespaceCreation(context.namespace);
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    tone: "primary",
  });
  const createDeniedNote = element(
    "p",
    { className: "muted", role: "status", id: "agents-create-denied" },
    agentCreateDenied(context.permissions),
  );
  // A disabled Create Agent names its reason (UX plan A2) and stays in the Tab order while it
  // shows (finding 2899), and a provisioning Namespace still takes drafts, so Create Agent stays
  // enabled and says why nothing deploys yet (finding 1990).
  const describeCreate = () => {
    const reasons = [
      ...(createDenied ? ["agents-create-denied"] : []),
      ...(notReady ? ["namespace-not-ready"] : []),
    ];
    if (reasons.length) {
      create.setAttribute("aria-describedby", reasons.join(" "));
    } else {
      create.removeAttribute("aria-describedby");
    }
    setUnavailable(
      create,
      createDenied || notReady?.blocked === true,
      createDenied ? createDeniedNote : notReadyNoteShown ? notReadyNote : null,
    );
  };
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
  // Only a note shown at first paint is replaced in place later (showNamespace).
  const notReadyNoteShown = notReadyNote !== null;
  describeCreate();
  view.replaceChildren(
    element("div", { className: "collection-toolbar" }, search, create),
    ...(notReadyNote ? [notReadyNote] : []),
    ...(createDenied ? [createDeniedNote] : []),
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
    const row = rowReads();
    const { signal } = row;
    const revisions = latestReadableRevision(context, `${agentPath}/revisions`, signal);
    const deployment = revisions.then(async ({ latest }) => {
      if (!latest) {
        return null;
      }
      const status = (await context.request(
        `${agentPath}/deployments/${encodeURIComponent(latest.id)}`,
        { ...rowRead, signal },
      )) as AgentDeploymentStatusWire;
      // A rejected model credential is worded for the caller, as on the Agent's page (finding
      // D752), so that row waits for its permission answer.
      const code = status.status === "failed" ? status.error?.code : undefined;
      const credentialAsk =
        code === "RUNTIME_AUTHENTICATION_FAILED"
          ? credentialRejectedAsk(
              code,
              "harnessAuth" in item ? item.harnessAuth : undefined,
              await permissionAnswers.get(item.id),
            )
          : undefined;
      return { revision: latest, status, credentialAsk };
    });
    const current = revisions.then(async (found): Promise<CurrentVersion> => {
      const active = await currentRevision(
        context,
        `${agentPath}/revisions`,
        item.activeRevisionId,
        found,
        signal,
      );
      if (active !== UNREADABLE) {
        return active;
      }
      // A succeeded deployment makes its version current, so an unreadable current version
      // beside the newest readable one's succeeded deployment is newer, as on the Agent page.
      const latest = await deployment.catch(() => null);
      return latest && deploymentOutcome(latest.status) === "succeeded"
        ? NEWER_UNREADABLE
        : UNREADABLE;
    });
    finishWith(row, deployment, current);
    return { deployment, current, row };
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
  // Fills a row's Current version cell: the version's number once its row's read finds it
  // (finding 2093), words for one the reader cannot read (finding D789), else its ID.
  function fillCurrent(current: HTMLTableCellElement, item: AgentRead, active: CurrentVersion) {
    if (!item.activeRevisionId) {
      return;
    }
    if (active === UNREADABLE || active === NEWER_UNREADABLE) {
      const text = unreadableCurrentVersion(active === NEWER_UNREADABLE);
      const shown = current.querySelector(".agent-version-unreadable");
      if (shown) {
        setText(shown, text);
        return;
      }
      // A retained row's link gives way to the words; focus on it moves to the row's Agent link.
      const focused = current.contains(current.ownerDocument.activeElement);
      current.replaceChildren(
        element("span", { className: "muted agent-version-unreadable" }, text),
      );
      if (focused) {
        current.closest("tr")?.querySelector("a")?.focus({ preventScroll: true });
      }
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
      (active: CurrentVersion) => fillCurrent(current, item, active),
    );
    // A read a search retired fails here; its row is no longer shown, so it paints nothing.
    const showing = () => context.isCurrent() && !reads.row.signal.aborted;
    void reads.current.then(
      (active) => context.isCurrent() && fillVersion(active),
      () => showing() && fillVersion(null),
    );
    void reads.deployment
      .then((result) => {
        if (!context.isCurrent()) {
          return;
        }
        if (result === null) {
          setLatestDeployment(item, null);
          fill("No visible deployments");
          return;
        }
        const neutral = neutralDeploymentOutcome(result.status);
        // A retained list rereads on resume so the confirmation uses the latest readable outcome.
        setLatestDeployment(item, deploymentOutcome(result.status));
        const failure =
          !neutral && result.status.status === "failed"
            ? (result.credentialAsk ?? result.status.error?.message ?? "Deployment failed.")
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
        if (!showing()) {
          return;
        }
        setLatestDeployment(item, null);
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
    refused,
  }: {
    notice?: string;
    error?: string;
    requestId?: string | undefined;
    refused?: RowRefusal | undefined;
  }) {
    const previous = refusal;
    refusal = refused ?? null;
    keptRefusal = refused?.text
      ? { ...refused, text: refused.text, requestId, namespaceId: context.namespaceId }
      : null;
    feedback.replaceChildren(
      ...(notice ? [statusBlock("info", null, notice)] : []),
      ...(error
        ? [
            element(
              "div",
              {
                className: "status",
                "data-tone": "danger",
                role: "alert",
                ...(refused ? { id: REFUSAL_ID } : {}),
              },
              element("p", { className: "status-body" }, error),
              requestId ? requestIdLine(requestId) : null,
            ),
          ]
        : []),
    );
    for (const id of new Set([previous?.id, refusal?.id])) {
      if (id) {
        updateRowActions(id);
      }
    }
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
      // An unavailable icon whose reason shows is still focusable (aria-disabled, finding 2899),
      // so focus stays on it and its description says why, as setUnavailable keeps focus on a
      // control that becomes unavailable (finding 2926). Only a natively disabled icon, with no
      // reason to read, sends focus to the name.
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
    const row = rowReads();
    permissionReads.set(item.id, row);
    const started = ++permissionReadsStarted;
    const read = context
      .request(`${agentRequestPath(item.id)}/permissions`, { ...rowRead, signal: row.signal })
      .then((result) => result as AgentPermissions);
    finishWith(row, read);
    permissionAnswers.set(
      item.id,
      read.catch(() => null),
    );
    void read.then(
      (answer) => {
        if (!context.isCurrent()) {
          return;
        }
        const previous = permissions.get(item.id);
        permissions.set(item.id, answer);
        let lifted = false;
        for (const [kind, permission] of [
          ["stop", "operate"],
          ["delete", "delete"],
        ] as const) {
          const key = `${item.id} ${kind}`;
          if (answer[permission] === true && (refusedActions.get(key) ?? started) < started) {
            refusedActions.delete(key);
            lifted = true;
          }
        }
        if (restricts(answer) || restricts(previous) || lifted) {
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
    if (notReady?.missing) {
      const refused = [400, 403, 404, 409, 429].includes(error.status ?? 0);
      showOutcome({
        error: refused
          ? "The request was not accepted. This Namespace is no longer available."
          : "Outcome unknown. The request may have been accepted. This Namespace is no longer available; the request has not been repeated.",
      });
      return;
    }
    let text;
    let refused;
    if (error.status === 403 && grantRefusal(cause)) {
      text = kind === "stop" ? stopRefused(item.name) : deleteRefused(item.name);
      refused = { id: item.id, kind };
      refusedActions.set(`${item.id} ${kind}`, permissionReadsStarted);
    } else if (error.status === 400 || error.status === 429) {
      text = `Could not ${kind === "stop" ? "stop" : "delete"} ${item.name}. ${describeFailure(cause, { mutation: true })}`;
    } else {
      unsettled.add(item.id);
      if (error.status === 403) {
        // A refusal that is not about grants, such as another actor's failed deletion on a stale
        // row or an admission refusal, shows as written, as on the Agent page (finding 2958). The
        // row names no grant; its note points to this alert, and it waits for Refresh, since a
        // repeat would be refused the same way (finding D812).
        text = `Could not ${kind === "stop" ? "stop" : "delete"} ${item.name}. ${error.serverMessage} Select Refresh before trying again.`;
        refused = { id: item.id, kind, text };
      } else if (error.status === 404) {
        text = `${item.name} is no longer available. Select Refresh to update the list.`;
      } else if (error.status === 409) {
        // The API's own reason, such as a lifecycle change while the request ran.
        text = `Could not ${kind === "stop" ? "stop" : "delete"} ${item.name}. ${describeFailure(cause, { mutation: true, conflict: `${item.name} changed while the request was sent.`, next: "Select Refresh before trying again." })}`;
      } else {
        text = `Outcome unknown. ${kind === "stop" ? "Stop" : "Deletion"} may have been accepted for ${item.name}. Select Refresh before trying again.`;
      }
    }
    showOutcome({ error: text, requestId: error.requestId, refused });
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
      if (notReady?.missing) {
        showOutcome({ notice: "Stop request accepted. This Namespace is no longer available." });
        return;
      }
      showOutcome({
        notice:
          stopped.status === "deleting"
            ? `${item.name} is being deleted.`
            : `Stop requested for ${item.name}. It will not start again until you deploy a new version. The console does not show when its runtime finishes shutting down.`,
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
        notice: notReady?.missing
          ? "Deletion request accepted. This Namespace is no longer available."
          : `Deletion requested for ${item.name}. It leaves this list once cleanup finishes; select Refresh to check.`,
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
      stopping ? stopConfirmation(item, latestDeployments.get(item.id)) : DELETE_CONFIRMATION,
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
        if (notReady?.missing || pending || permissions.get(item.id)?.[permission] === false) {
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
      description.textContent = stopping ? AGENT_STOP_DENIED : AGENT_DELETE_DENIED;
      // The confirmation stays in the Tab order, described by the refusal (finding 2935).
      setUnavailable(confirm, true, description);
      cancel.focus();
    };
    restrictOpenDialog = restrict;
    const dismiss = () => dialog.close();
    dismissOpenDialog = dismiss;
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
        if (dismissOpenDialog === dismiss) {
          dismissOpenDialog = null;
        }
        dialog.remove();
        if (!context.isCurrent() || !mayReturnFocus(dialog)) {
          return;
        }
        // A redraw while the dialog was open (a permission refusal, for example) replaces the
        // invoking icon, so fall back to the row's current controls. A refused invoker that is
        // still focusable takes focus back, as on a cancelled confirmation.
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
    // A failed readable deployment can hide a newer queued one. Agent operate is sufficient
    // to stop that work, even with no selected version.
    const neverStarted = stopped && !item.activeRevisionId;
    const allowed = permissions.get(item.id);
    const refusedHere = (kind: RowAction) => refusedActions.has(`${item.id} ${kind}`);
    const canStop = neverStarted || (allowed?.operate !== false && !refusedHere("stop"));
    const canDelete = allowed?.delete !== false && !refusedHere("delete");
    // A refusal not about grants leaves the row waiting for Refresh. The alert above the table
    // can be far above the row on a narrow screen, so the row's note points to it and repeats it
    // for assistive technology, and both icons stay reachable, described by it (finding D812).
    const held =
      unsettled.has(item.id) && refusal?.id === item.id && refusal.text !== undefined
        ? refusal
        : null;
    // Other unsettled rows wait for Refresh with only the alert, natively disabled.
    const waiting = unsettled.has(item.id) && !held;
    const stopBlocked = !canStop || held !== null;
    const deleteBlocked = !canDelete || held !== null;
    const noteId = `agent-row-note-${item.id}`;
    // The icons are described by the reason alone, not by the line that repeats its grant.
    const reasonId = `agent-row-reason-${item.id}`;
    const badgeId = `agent-row-badge-${item.id}`;
    // The note names the grant and who gives it (findings 2539, 2548). Its reserved line fits
    // only the grant, so the line shows that and the whole reason is its tooltip and what
    // assistive technology reads.
    let restriction = null;
    let grant = null;
    if (held) {
      restriction = held.text ?? null;
      grant = held.kind === "stop" ? "Not stopped: see above" : "Not deleted: see above";
    } else if (!canStop && !canDelete) {
      restriction = notIncluded(
        "stopping or deleting this Agent",
        "Agent operate and Agent delete on it",
      );
      // "Needs Agent operate and delete" overflows the reserved line on a 1280-pixel viewport;
      // the tooltip and the description name both grants in full.
      grant = "Needs operate and delete";
    } else if (!canStop) {
      restriction = AGENT_STOP_DENIED;
      grant = "Needs Agent operate";
    } else if (!canDelete) {
      restriction = AGENT_DELETE_DENIED;
      grant = "Needs Agent delete";
    }
    // A blocked icon whose refusal is the alert above the table is described by that alert,
    // which names the Agent and keeps the Request ID; any other by the row's reason.
    const reasonOf = (blocked: boolean, kind: RowAction) =>
      !blocked ? null : refusal?.id === item.id && refusal.kind === kind ? REFUSAL_ID : reasonId;
    const describedBy = (blocked: boolean, badge: string | null, kind: RowAction) => {
      const ids = [reasonOf(blocked, kind), badge].filter(Boolean);
      return ids.length ? { "aria-describedby": ids.join(" ") } : {};
    };
    // The row's Deleting or Stop requested badge (render).
    const badgeShown =
      item.status === "deleting" ||
      (item.status === "active" && stopped && Boolean(item.activeRevisionId));
    // An icon unavailable for a reason the row shows, the note or the badge, stays in the Tab
    // order with it (finding 2899); one waiting on Refresh after an uncertain write has only the
    // alert above the table, and is natively disabled.
    const reasonFor = (blocked: boolean, badge: boolean, kind: RowAction) =>
      reasonOf(blocked, kind) ?? (badge && badgeShown ? badgeId : null);
    const stop = neverStarted
      ? null
      : button(
          resourceActionIcon("stop"),
          (event) => confirmAction(item, "stop", event.currentTarget as HTMLButtonElement),
          {
            className: "icon-button",
            "aria-label": `Stop ${item.name}`,
            title: "Stop Agent",
            "data-refocus-key": `${item.id} stop`,
            // A rebuilt row whose Stop is gone or disabled gives focus to its name (finding 2967).
            "data-refocus-fallback": `${item.id} name`,
            // A deleting or Stop requested badge explains a stopped Agent's disabled icon.
            ...describedBy(stopBlocked, stopped ? badgeId : null, "stop"),
          },
        );
    if (stop) {
      setUnavailable(
        stop,
        !available || stopped || !canStop,
        waiting ? null : reasonFor(stopBlocked, stopped, "stop"),
      );
    }
    const remove = button(
      resourceActionIcon("delete"),
      (event) => confirmAction(item, "delete", event.currentTarget as HTMLButtonElement),
      {
        className: "icon-button",
        "aria-label": `Delete ${item.name}`,
        title: "Delete Agent",
        "data-refocus-key": `${item.id} delete`,
        "data-refocus-fallback": `${item.id} name`,
        ...describedBy(deleteBlocked, item.status === "deleting" ? badgeId : null, "delete"),
      },
    );
    setUnavailable(
      remove,
      !available || !canDelete,
      waiting ? null : reasonFor(deleteBlocked, item.status === "deleting", "delete"),
    );
    // The note's line is reserved from the first paint, so advice that lands later only fills it.
    const note = element(
      "span",
      { className: "row-action-note", id: noteId, ...(restriction ? { title: restriction } : {}) },
      ...(restriction
        ? [
            element("span", { "aria-hidden": "true" }, grant ?? ""),
            element("span", { className: "visually-hidden", id: reasonId }, restriction),
          ]
        : []),
    );
    return { stop, delete: remove, note };
  }

  function actionCellContent(actions: ReturnType<typeof rowActions>) {
    return [
      element(
        "div",
        { className: "resource-row-actions" },
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
    if (notReady?.missing) {
      rows.replaceChildren();
      return;
    }
    const query = search.value.trim().toLowerCase();
    const matches = items
      .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const shown = new Set(matches.map((item) => item.id));
    retireHidden(deployments, shown, (reads) => reads.row);
    retireHidden(permissionReads, shown, (row) => row);
    if (!matches.length) {
      rows.replaceChildren(
        element(
          "section",
          { className: "state-panel" },
          // A reader without create sees only Agents shared with them, not every Agent here
          // (finding 2548).
          element(
            "h2",
            {},
            query
              ? "No matching Agents"
              : sharedOnly
                ? "No Agents are shared with you"
                : "No Agents yet",
          ),
          element(
            "p",
            {},
            query
              ? "Try another name or ID."
              : createDenied
                ? // Under the note above: say what the reader can expect, not invite creating
                  // (finding 1521).
                  sharedOnly
                  ? "Agents in this Namespace that are shared with you appear here."
                  : "Agents in this Namespace appear here."
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
      // A refocus that rebuilds the list returns focus to the same row's control (finding D814).
      name.dataset.refocusKey = `${item.id} name`;
      const actions = rowActions(item);
      const cell = element(
        "td",
        // A refocus that rebuilds the list keeps this cell, the icon and its note, in view.
        { className: "agent-row-actions-cell", "data-label": "Actions", "data-refocus-area": "" },
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
  const carried =
    context.resumed &&
    keptRefusal?.namespaceId === context.namespaceId &&
    items.some((item) => item.id === keptRefusal?.id)
      ? keptRefusal
      : null;
  keptRefusal = null;
  if (carried) {
    unsettled.add(carried.id);
    showOutcome({ error: carried.text, requestId: carried.requestId, refused: carried });
  }
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
      describeCreate();
      if (!namespace) {
        // A lost Namespace also removes its retained rows, so search cannot reveal them again.
        const focused =
          rows.contains(document.activeElement) ||
          feedback.contains(document.activeElement) ||
          document.activeElement === create ||
          dismissOpenDialog !== null;
        items.length = 0;
        feedback.replaceChildren();
        refusal = null;
        render();
        // Dismiss stale confirmation without aborting or replaying an already submitted write.
        dismissOpenDialog?.();
        if (focused) {
          search.focus({ preventScroll: true });
        }
      } else if (!rows.querySelector("table")) {
        // Status changes affect the empty state's sentence; readable rows keep their focus.
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
