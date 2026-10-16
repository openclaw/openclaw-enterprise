import { element, button } from "../dom.mjs";

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

export function renderAgentList(context) {
  const { view, items } = context;
  const search = element("input", {
    type: "search",
    "aria-label": "Search Agents",
    placeholder: "Search Agents by name or ID",
  });
  search.value = context.drafts.get("agent-search") ?? "";
  context.drafts.track("agent-search", () => search.value || undefined);
  const rows = element("div");
  const deployments = new Map();
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
    rows,
  );
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
          ...["Agent", "Execution mode", "Current version", "Latest deployment", "Created"].map(
            (label) => element("th", { scope: "col" }, label),
          ),
        ),
      ),
    );
    const body = element("tbody");
    for (const item of matches) {
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
            link(item.name, `agents/${item.id}`, context),
            element("span", { className: "resource-id" }, item.id),
            item.status === "deleting" ? element("span", { className: "badge" }, "Deleting") : null,
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
        ),
      );
    }
    table.append(body);
    rows.replaceChildren(element("div", { className: "table-scroll" }, table));
  }
  search.addEventListener("input", render);
  render();
}
