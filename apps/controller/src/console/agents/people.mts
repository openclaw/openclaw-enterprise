import type { AgentGatewayPerson } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import type { ConsolePageContext } from "../page-context.mjs";
import { button, element } from "../dom.mjs";
import { renderControlUiBookmark } from "./control-ui-bookmark.mjs";

const configuredUsersHelp =
  "Configured identities for direct Control UI sign-in. No OCC account required. Manage access in Gateway and ingress configuration.";

export function renderGatewayPeople(
  context: Omit<AgentAccessContext, "namespaceId" | "request"> &
    Pick<ConsolePageContext, "request"> & {
      deniedReads?: { has(path: string): boolean; remember(path: string): void };
    },
  path: string,
  administerAllowed?: () => Promise<boolean | undefined>,
  isActive: () => boolean = () => true,
  updateAllowed: () => Promise<boolean | undefined> = async () => false,
) {
  const endpoint = `${path}/gateway/people`;
  const bookmark = renderControlUiBookmark(context, path, updateAllowed, isActive);
  const count = element("span", {
    className: "gateway-people-count",
    "aria-hidden": "true",
    hidden: true,
  });
  const status = element("p", { className: "hint", role: "status" }, "Loading configured users…");
  const error = element("p", { className: "error", role: "alert" });
  const list = element("ul", {
    className: "gateway-people-list",
    "aria-label": "Configured Control UI users",
  });
  const refresh = button("Refresh users", () => void load(), {
    className: "overview-text-button",
  });
  let people: AgentGatewayPerson[] = [];
  let available: boolean | undefined;
  const search = element("input", {
    id: "gateway-people-search",
    type: "search",
    placeholder: "Search by name or identity",
  });
  const results = element("p", { className: "hint", role: "status" });
  const searchField = element(
    "div",
    { className: "form-field gateway-people-search", hidden: true },
    element("label", { for: "gateway-people-search" }, "Search configured users"),
    search,
    results,
  );
  search.addEventListener("input", renderList);

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = people.filter(
      (person) =>
        person.identity.toLocaleLowerCase().includes(query) ||
        person.displayName.toLocaleLowerCase().includes(query),
    );
    list.replaceChildren(...filtered.map(renderPerson));
    if (!query) {
      results.textContent = `${people.length} configured ${people.length === 1 ? "user" : "users"}`;
    } else {
      results.textContent = filtered.length
        ? `${filtered.length} of ${people.length} users`
        : "No configured users match your search.";
    }
  }

  function renderPerson(person: AgentGatewayPerson) {
    const name = person.displayName.trim() || person.identity;
    const hasFriendlyName = name !== person.identity;
    const initials = name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toUpperCase();
    const fallback = element(
      "span",
      { className: "gateway-person-avatar", "aria-hidden": "true" },
      initials,
    );
    const avatar =
      person.hasAvatar && person.profileId !== null
        ? element("img", {
            className: "gateway-person-avatar",
            alt: "",
            loading: "lazy",
            src: `${endpoint}/${encodeURIComponent(person.profileId)}/avatar`,
          })
        : fallback;
    if (avatar !== fallback) {
      avatar.addEventListener("error", () => avatar.replaceWith(fallback), { once: true });
    }
    return element(
      "li",
      {},
      avatar,
      element(
        "span",
        { className: "gateway-person-details" },
        element(
          "span",
          { className: `gateway-person-name${hasFriendlyName ? "" : " resource-id"}` },
          name,
        ),
        hasFriendlyName
          ? element("span", { className: "gateway-person-identity resource-id" }, person.identity)
          : null,
        person.role
          ? element("span", { className: "gateway-person-role" }, `Gateway role: ${person.role}`)
          : null,
      ),
    );
  }

  function clearPeople() {
    people = [];
    search.value = "";
    list.replaceChildren();
    count.hidden = true;
    searchField.hidden = true;
    results.textContent = "";
  }

  const roster = element(
    "div",
    { className: "gateway-people-roster", hidden: true },
    element("p", { className: "gateway-people-source" }, "Current serving Gateway · Read-only"),
    element("p", { className: "hint" }, configuredUsersHelp),
    status,
    error,
    searchField,
    list,
  );
  refresh.hidden = true;
  const section = element(
    "section",
    {
      className: "agent-card gateway-people",
      "aria-labelledby": "gateway-people-title",
    },
    element(
      "div",
      { className: "gateway-people-heading" },
      element("h2", { id: "gateway-people-title" }, "Direct Control UI access", count),
      refresh,
    ),
    bookmark.section,
    roster,
  );
  let pending = false;
  let refreshPending = false;

  async function load() {
    if (!context.isCurrent() || !isActive()) {
      return;
    }
    if (pending) {
      refreshPending = true;
      return;
    }
    if (context.deniedReads?.has(endpoint)) {
      clearPeople();
      roster.hidden = true;
      refresh.hidden = true;
      return;
    }
    pending = true;
    refresh.disabled = true;
    error.textContent = "";
    status.textContent = "Loading configured users…";
    try {
      // A known denial needs no audited probe; an unknown advisory answer still asks the API.
      const allowed = await administerAllowed?.();
      if (!context.isCurrent() || !isActive() || refreshPending) {
        return;
      }
      if (allowed === false) {
        clearPeople();
        roster.hidden = true;
        refresh.hidden = true;
        return;
      }
      // An unsupported adapter stays absent during later revalidation, without flashing
      // a loading card above the independent sharing form.
      if (available !== false) {
        roster.hidden = false;
        refresh.hidden = false;
      }
      // Access owns this live read. Cached pages must not replay it while another tab is active.
      const data = responseFields(await context.request(endpoint, { revalidate: false }));
      // Re-entry or a newer runtime refresh supersedes this admitted read.
      if (!context.isCurrent() || !isActive() || refreshPending) {
        return;
      }
      available = data.people !== null;
      roster.hidden = !available;
      refresh.hidden = !available;
      if (data.people === null) {
        clearPeople();
        return;
      }
      people = readPeople(data.people).sort(
        (a, b) =>
          (a.displayName.trim() || a.identity).localeCompare(b.displayName.trim() || b.identity) ||
          a.identity.localeCompare(b.identity),
      );
      // Only a successful roster determines whole-card visibility. Keep a confirmed
      // empty card hidden during later reads; failures do not establish membership.
      section.hidden = people.length === 0;
      searchField.hidden = people.length === 0;
      renderList();
      count.textContent = String(people.length);
      count.hidden = false;
      status.textContent = people.length ? "" : "No configured human identities.";
    } catch (cause) {
      if (!context.isCurrent() || !isActive() || refreshPending) {
        return;
      }
      const { status: failureStatus } = requestFailure(cause);
      clearPeople();
      if (failureStatus === 401) {
        context.onExpired();
        return;
      }
      status.textContent = "";
      roster.hidden = failureStatus === 403;
      refresh.hidden = failureStatus === 403;
      if (failureStatus === 403) {
        context.deniedReads?.remember(endpoint);
      } else if (failureStatus === 409) {
        status.textContent = "Configured users will appear when this Agent has a serving Gateway.";
      } else {
        error.textContent = "Couldn’t load configured users from the Gateway. Try refreshing.";
      }
    } finally {
      pending = false;
      refresh.disabled = false;
      const refreshAgain = refreshPending;
      refreshPending = false;
      if (refreshAgain && context.isCurrent() && isActive()) {
        void load();
      }
    }
  }
  return {
    section,
    async refresh() {
      if (!isActive()) {
        return;
      }
      await Promise.all([bookmark.refresh(), load()]);
    },
  };
}

function readPeople(value: unknown): AgentGatewayPerson[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid Gateway people response");
  }
  return value.map((item) => {
    const { identity, profileId, displayName, role, hasAvatar } = responseFields(item);
    if (
      typeof identity !== "string" ||
      (profileId !== null && typeof profileId !== "string") ||
      typeof displayName !== "string" ||
      (role !== null && typeof role !== "string") ||
      typeof hasAvatar !== "boolean"
    ) {
      throw new Error("Invalid Gateway person");
    }
    return { identity, profileId, displayName, role, hasAvatar };
  });
}
