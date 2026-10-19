import { element, button, statusBlock } from "../dom.mjs";

export const displayDate = (value) => new Date(value).toLocaleString();
export const shortId = (value) => `${value.slice(0, 12)}…${value.slice(-6)}`;
export const namespacePath = (id) => `/namespaces/${encodeURIComponent(id)}`;

export function link(label, target, context) {
  const node = element("a", { href: context.pageUrl(target) }, label);
  node.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    context.navigate(target);
  });
  return node;
}

// A Namespace that is still provisioning (or failed to) refuses Agent, Configuration and
// deployment writes with NAMESPACE_NOT_READY; "conflicts with the saved state" would send the
// operator to the wrong place.
export const NAMESPACE_NOT_READY_MESSAGE =
  "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings).";

// Why a Namespace can't take new Agents, by status. Neither becomes ready by waiting.
const NOT_READY_REASONS = {
  failed:
    "Provisioning this Namespace failed, so it cannot hold new Agents. Ask an operator to check it on the Namespaces page, or choose another Namespace.",
  deleting:
    "This Namespace is being deleted, so it cannot hold new Agents. Choose another Namespace.",
};

// What the selected Namespace's status means where Agent creation starts (finding 1895): null
// when it is ready or its status is unknown, otherwise the status and its consequence, and
// whether the API refuses every new Agent there (`blocked`). A provisioning Namespace still
// accepts Agent drafts, but no Secret, sign-in or deployment until it is ready; one that adopts
// an existing Kubernetes namespace takes no Configuration until then; a failed or deleting one
// takes no new Agent. The API still decides.
export function namespaceCreation(namespace) {
  const status = namespace?.status;
  if (typeof status !== "string" || status === "" || status === "ready") {
    return null;
  }
  const label = `Namespace status: ${status[0].toUpperCase()}${status.slice(1)}.`;
  if (status === "provisioning" && namespace.existingNamespace === undefined) {
    return {
      blocked: false,
      note: `${label} ${NAMESPACE_NOT_READY_MESSAGE} Until then, Agents can be saved as drafts that need no new Secret or sign-in, but none can be deployed.`,
    };
  }
  return {
    blocked: Object.hasOwn(NOT_READY_REASONS, status) || status === "provisioning",
    note: `${label} ${NOT_READY_REASONS[status] ?? NAMESPACE_NOT_READY_MESSAGE}`,
  };
}

// The API's catch-all answers: a caller's own denial and an untyped conflict. They name nothing
// the caller can act on, so views keep their own guidance instead of showing them.
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
export const GENERIC_CONFLICT = "The requested platform resource already exists.";

// The API records these deployment endings as failed, but nothing went wrong with the version,
// so the console shows a neutral outcome instead. A newer version took over before this one
// became current (finding 1353; the record never names the newer version, so neither does the
// console), or the owner stopped the Agent while this version was deploying (finding 1375).
// REPOSITORY_REVISION_STOPPED stays a failure: it can also mean the Namespace is not ready.
const NEUTRAL_DEPLOYMENT_OUTCOMES = new Map([
  ["REVISION_SUPERSEDED", "superseded"],
  ["REPOSITORY_REVISION_SUPERSEDED", "superseded"],
  ["REVISION_STOPPED", "stopped"],
]);

// "superseded" or "stopped" for a neutral ending, otherwise null.
export function neutralDeploymentOutcome(status) {
  return status?.status === "failed"
    ? (NEUTRAL_DEPLOYMENT_OUTCOMES.get(status.error?.code) ?? null)
    : null;
}

// The recorded outcome to show: the API's status, except that a neutral ending is not a failure.
export function deploymentOutcome(status) {
  return neutralDeploymentOutcome(status) ?? status.status;
}

export const NEUTRAL_DEPLOYMENT_NOTES = {
  superseded: "Superseded by a newer version",
  stopped: "Stopped before it finished",
};

// Revisions list newest first, one page at a time (finding 1323). A page can be empty when
// its revisions are not readable to the viewer, so follow the cursor to the newest readable one.
async function latestReadableRevision(context, path, options) {
  let cursor = null;
  do {
    const page = await context.request(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { ...options, includeMeta: true },
    );
    if (page.data.length > 0) {
      return page.data[0];
    }
    cursor = page.meta?.nextCursor ?? null;
  } while (cursor);
  return null;
}

export function message(error, mutation = false) {
  if (error.code === "SAVED_CONFIGURATION_UNREADABLE") {
    const field = {
      plugins: "plugin selections",
      pluginApprovers: "plugin approvers",
      repositoryBindings: "repository access",
      harnessAuth: "harness authentication",
      secretBindings: "Secret bindings",
      repositoryCredentials: "repository credentials",
      configuration: "native configuration",
    }[error.field];
    return `Saved ${field ?? "configuration"} could not be read. Editing and deployment are unavailable for these settings. Ask an administrator to repair the saved configuration, then refresh this page.`;
  }
  if (error.status === 403) {
    return error.refusal ?? "Access denied. You do not have permission for this operation.";
  }
  if (error.status === 404) {
    return "Resource unavailable in this Namespace. Check the ID and your access.";
  }
  if (error.status === 409 && error.code === "NAMESPACE_NOT_READY") {
    return NAMESPACE_NOT_READY_MESSAGE;
  }
  if (error.status === 409) {
    return "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.";
  }
  if (error.status === 400) {
    return "Check the entered values and resource IDs, then try again.";
  }
  if (error.status === 429) {
    return "Too many requests. Wait before trying again.";
  }
  return mutation
    ? "Outcome unknown. The result could not be confirmed. Refresh and inspect the saved state before trying again."
    : error.name === "TypeError" || error.name === "TimeoutError"
      ? "Request interrupted. Retry to check current access and saved state."
      : "Service unavailable. The read could not be completed. Try again.";
}

// The 503 codes POST /agents/provision sends only before its own admission, so that request
// stored nothing and queued no job (finding 1635); an earlier attempt with the same request ID
// may have, which is why Retry stays. They are a named dependency outage, whose transaction
// rolled back, and channel credential validation, which runs before the transaction (the API
// throws if it runs inside one). Create Agent shows their reason. A cluster denial of runtime credentials is met
// by the provisioning worker, deploy and the runtime credential routes, not by this request.
// tests/conformance/http-errors.test.mjs classifies every other API error code.
export const PROVISIONING_REFUSAL_CODES = Object.freeze([
  "DEPENDENCY_UNAVAILABLE",
  "CHANNEL_CREDENTIAL_UNAVAILABLE",
]);

// The API's 503 answers that name no reason: the catch-all outage, and a commit whose outcome
// the API itself could not confirm.
const UNNAMED_DEPENDENCY_FAILURES = new Set([
  "A required platform dependency is unavailable.",
  "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
]);

// The server's own sentence for a 503 that refused the request before admission: one of
// PROVISIONING_REFUSAL_CODES with a named reason. POST /agents/{id}/deploy sends these codes
// only before its revision commits too: channel credential validation runs before its
// transaction, and the only named DEPENDENCY_UNAVAILABLE answers, the Secret and credential
// source driver-ownership refusals, roll it back (finding 1638). Any other 503, including an
// unnamed one, leaves the outcome unknown and returns undefined.
export function preAdmissionRefusal(error) {
  return error.status === 503 &&
    PROVISIONING_REFUSAL_CODES.includes(error.code) &&
    error.serverMessage !== undefined &&
    !UNNAMED_DEPENDENCY_FAILURES.has(error.serverMessage)
    ? error.serverMessage
    : undefined;
}

// A refused save names the grants it needs, as Stop, Delete and occ do (finding 1530). Each save
// shows one fixed text for every 403, so it says nothing the server did not: no IDs, and nothing
// about whether a resource exists.
export const SAVE_REFUSALS = Object.freeze({
  configuration:
    "You do not have permission to save this Configuration. Ask an administrator for Configuration update access, plus Secret operate on each Secret it binds.",
  agent:
    "You do not have permission to save this Agent. Ask an administrator for Agent update and Configuration read access, plus access to the Secrets, credential sources and Service Account it binds.",
  // A save first rereads the Agent and its Configuration; a refused read is not a refused
  // update (finding 1540).
  read: "You do not have permission to read this Agent's saved settings. Ask an administrator for Agent read and Configuration read access.",
});

// Shown beside Agent-side save controls when the caller's permission answer denies Agent update.
// Gating only: an unknown answer keeps the controls, and the API still decides.
export const AGENT_UPDATE_DENIED =
  "Your access does not include updating this Agent. Ask an administrator for Agent update access to save these settings.";

// Marks a 403 from a save so message() names the grants it needs: the save's own when the
// write itself was refused (`written`), read access when a read before it was (finding 1540).
export function refusedSave(error, save, written) {
  if (error?.status === 403) {
    error.refusal = SAVE_REFUSALS[written ? save : "read"];
  }
  return error;
}

// The API refused a Configuration update because another save moved its generation, which a
// reread recovers from. Other Configuration conflicts, such as a provisioning reservation, carry
// no such detail and a reread meets them again (finding 1511).
export function isStaleGeneration(error) {
  return (
    error?.status === 409 &&
    error.code === "RESOURCE_CONFLICT" &&
    (error.detailPaths ?? []).includes("/expectedGeneration")
  );
}

// For a refused Configuration write, show the reason the API gave this caller (for
// example, reserved for provisioning). Never infer that a reload will fix it from the prose.
// The catch-all conflict names nothing (a Kubernetes resourceVersion conflict answers it), so
// the caller's own conflict text applies instead (finding 1639).
export function configurationConflictMessage(error, submitted) {
  if (
    submitted &&
    error.status === 409 &&
    error.code === "RESOURCE_CONFLICT" &&
    error.serverMessage !== GENERIC_CONFLICT
  ) {
    return error.serverMessage ?? "The Configuration could not be saved in its current state.";
  }
}

// A rejected write shows the API's own sentence, which names the field to fix (for example
// an inline model credential); other failures keep the generic status text.
export function rejectionMessage(error, mutation = false) {
  return error.status === 400 && error.serverMessage !== undefined
    ? error.serverMessage
    : message(error, mutation);
}

export function assertReadableConfiguration(resource) {
  if (resource.configurationReadError) {
    throw Object.assign(
      new Error(message(resource.configurationReadError)),
      resource.configurationReadError,
    );
  }
}

// A row's deployment while it is read. The text follows the 250 ms rule, so a read that lands
// sooner, as most do on a return to a retained list, never paints it (finding 1656). Text that a
// focusable holder wraps stays readable to a screen reader meanwhile.
const readingDeployment = (className = "delayed-status") =>
  element("span", { className }, "Reading deployment…");
// With a dozen rows, reads that landed just after the 250 ms rule's delay (console.css
// .delayed-status and .delayed-text) replaced the text a frame or a few after it showed (16-133
// ms, finding 1683), so once shown it stays at least READING_SHOWN_MS.
const READING_SHOWN_MS = 150;

// A run of more characters than any ordinary word cannot wrap, so it would set the table's width
// (finding 1955). Only a name with one breaks anywhere (console.css); others wrap as before. The
// run ends only where a line can break: a breaking space, a zero-width space, a soft hyphen or a
// hyphen or dash (a name holds no control or line-separator characters). No-break spaces
// (U+00A0, U+2007, U+202F, U+FEFF), which `\s` counts, do not end it. The browser does not
// break after a hyphen-minus before a digit ("1000-1001", UAX #14 LB25) or after a hyphen or
// dash before another one (LB21), and a run of em dashes breaks only at its ends (LB17), so it
// is a run of its own (finding 1971).
const UNBROKEN_RUN =
  /\u2014{21,}|(?:[^ \u1680\u2000-\u2006\u2008-\u200b\u205f\u3000\u00ad\u2010\u2012-\u2014-]|-(?=[\p{Nd}\u2010\u2012\u2013-])|[\u2010\u2012\u2013](?=[\u2010\u2012\u2013-])){21,}/u;

function agentNameLink(item, context) {
  const node = link(item.name, `agents/${item.id}`, context);
  if (UNBROKEN_RUN.test(item.name)) {
    node.classList.add("agent-name-unbroken");
  }
  return node;
}

export function renderAgentList(context) {
  const { view, items } = context;
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  search.value = context.drafts.get("agent-search") ?? "";
  context.drafts.track("agent-search", () => search.value || undefined);
  context.drafts.unsavedWhen("agent-search", () => false);
  const rows = element("div");
  const deployments = new Map();
  // The page renders with the caller's permission answer, so Create Agent is never painted
  // enabled and then refused, and the note never pushes the table down (finding 1517). Gating
  // only: the API still authorizes creation, so an unknown answer keeps the control.
  const createDenied = context.permissions?.agents?.create === false;
  // A Namespace that is not ready names its status here, so the first sign is never a refused
  // Secret or submit, and one that takes no new Agent never invites creating one (finding 1895).
  const notReady = namespaceCreation(context.namespace);
  const create = button("Create Agent", () => context.navigate("agents/new"), {
    tone: "primary",
  });
  create.disabled = createDenied || notReady?.blocked === true;
  // A provisioning Namespace still takes drafts, so Create Agent stays enabled, and says why
  // nothing deploys yet (finding 1990).
  if (notReady) {
    create.setAttribute("aria-describedby", "namespace-not-ready");
  }
  view.replaceChildren(
    element("div", { className: "agent-toolbar" }, search, create),
    ...(notReady
      ? [
          statusBlock("warning", null, notReady.note, [], {
            role: "status",
            id: "namespace-not-ready",
          }),
        ]
      : []),
    ...(createDenied
      ? [
          element(
            "p",
            { className: "muted", role: "status" },
            "Your access does not include creating Agents in this Namespace.",
          ),
        ]
      : []),
    rows,
  );
  // Each row's latest deployment, read after the list paints. A return to a retained list
  // revalidates only the list's own reads, so these never hold its reveal (finding 1644); the
  // retained rows read them again in place instead. So one still running doesn't keep the list
  // from being retained either (finding 1663): leaving aborts it, and the list rereads it.
  const cells = new Map(); // The shown rows' deployment cells, each with its Agent.
  const rowRead = { revalidate: false, rereadOnResume: true };
  function readDeployment(item) {
    const agentPath = `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(item.id)}`;
    return latestReadableRevision(context, `${agentPath}/revisions`, rowRead).then(
      async (latest) => {
        if (!latest) {
          return null;
        }
        const status = await context.request(
          `${agentPath}/deployments/${encodeURIComponent(latest.id)}`,
          rowRead,
        );
        return { revision: latest, status };
      },
    );
  }
  // Fills a row's deployment cell. Focus in the cell moves to its new link, or to the row's Agent
  // link when it has none.
  function fillDeployment(deployment, ...content) {
    const focused = deployment.contains(deployment.ownerDocument.activeElement);
    deployment.replaceChildren(...content);
    if (focused) {
      (deployment.querySelector("a") ?? deployment.closest("tr")?.querySelector("a"))?.focus({
        preventScroll: true,
      });
    }
  }
  function showDeployment(item, deployment) {
    if (!deployments.has(item.id)) {
      deployments.set(item.id, readDeployment(item));
    }
    // The cell's "Reading deployment…" (or its focusable holder) and when its text shows: the
    // frame its delay animation ends in, not render time plus the delay. The animation starts
    // with the frame that first styles the text, which can be a frame or two either side of the
    // render, so that estimate let a read landing between the two fill the cell one frame after
    // the text painted (finding 1716).
    const reading = deployment.firstElementChild;
    let shownAt;
    reading.addEventListener("animationend", () => {
      shownAt = performance.now();
    });
    // A read that lands before the text shows, or after it has shown long enough, fills the cell
    // now; otherwise once it has. A later resume or render replaces the text, and its own read
    // fills the cell instead.
    const fill = (...content) => {
      const wait = shownAt === undefined ? 0 : shownAt + READING_SHOWN_MS - performance.now();
      if (wait <= 0) {
        fillDeployment(deployment, ...content);
        return;
      }
      setTimeout(() => {
        if (context.isCurrent() && reading.isConnected) {
          fillDeployment(deployment, ...content);
        }
      }, wait);
    };
    void deployments
      .get(item.id)
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
            `v${result.revision.revision} · ${deploymentOutcome(result.status)}`,
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
        fill(error.status === 403 ? "Deployment access denied" : "Deployment unavailable");
      });
  }
  function render() {
    cells.clear();
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
                  ? context.namespace.status === "provisioning"
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
          ...["Agent", "Execution mode", "Current version", "Latest deployment", "Created"].map(
            (label) => element("th", { scope: "col" }, label),
          ),
        ),
      ),
    );
    const body = element("tbody");
    for (const item of matches) {
      const revision = item.activeRevisionId
        ? link(
            shortId(item.activeRevisionId),
            `agents/${item.id}?revision=${item.activeRevisionId}`,
            context,
          )
        : null;
      revision?.classList.add("agent-revision-link");
      // The cell keeps its column's width once its read lands, and its outcome link and one
      // note line fit the two lines the Agent cell already gives the row (finding 1488).
      const deployment = element(
        "td",
        { className: "agent-deployment", "data-label": "Latest deployment" },
        readingDeployment(),
      );
      cells.set(deployment, item);
      showDeployment(item, deployment);
      body.append(
        element(
          "tr",
          {},
          element(
            "td",
            {},
            agentNameLink(item, context),
            element("span", { className: "resource-id" }, item.id),
            item.status === "deleting"
              ? element("span", { className: "badge", "data-tone": "warning" }, "Deleting")
              : null,
            item.configurationReadError
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
          element("td", { "data-label": "Current version" }, revision ?? "No current version"),
          deployment,
          element("td", { "data-label": "Created" }, displayDate(item.createdAt)),
        ),
      );
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
    ]) {
      for (const part of table.querySelectorAll(parts)) {
        part.setAttribute("role", role);
      }
    }
    rows.replaceChildren(element("div", { className: "table-scroll" }, table));
  }
  // A retained list is mounted without rereading its rows' deployments, so what they showed is
  // not presented as current: each row reads its deployment again from "Reading deployment…",
  // blank for its first 250 ms. Back from a deployment can focus the pending cell. Keep its
  // address only to match that return: until the read settles, the previous revision must not
  // be an active link.
  context.onResume?.(() => {
    deployments.clear();
    for (const [deployment, item] of cells) {
      // A cell still reading from an earlier resume keeps the address it was given.
      const shown =
        deployment.querySelector("a")?.href ??
        deployment.querySelector("[data-return-focus-href]")?.dataset.returnFocusHref;
      deployment.replaceChildren(
        shown
          ? element(
              "span",
              { tabindex: "-1", "data-return-focus-href": shown },
              readingDeployment("delayed-text"),
            )
          : readingDeployment(),
      );
      showDeployment(item, deployment);
    }
  });
  search.addEventListener("input", render);
  render();
}
