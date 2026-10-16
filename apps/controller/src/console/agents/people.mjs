import { button, dismissOnBackdrop, element } from "../dom.mjs";

export function renderGatewayPeople(context, path) {
  const endpoint = `${path}/gateway/people`;
  const count = element("span", {
    className: "gateway-people-count",
    "aria-hidden": "true",
    hidden: true,
  });
  const status = element("p", { className: "hint", role: "status" }, "Loading people…");
  const error = element("p", { className: "error", role: "alert" });
  const list = element("ul", { className: "gateway-people-list", "aria-label": "Gateway people" });
  const refresh = button("Refresh people", () => void load(), {
    className: "overview-text-button",
  });
  let people = [];
  const search = element("input", {
    id: "gateway-people-search",
    type: "search",
    placeholder: "Search by name",
  });
  const panelList = element("ul", {
    className: "gateway-people-list",
    "aria-label": "All Gateway people",
  });
  const results = element("p", { className: "hint", role: "status" });
  const dialog = element(
    "dialog",
    { className: "gateway-people-dialog", "aria-labelledby": "gateway-people-dialog-title" },
    element(
      "div",
      { className: "gateway-people-heading" },
      element("h2", { id: "gateway-people-dialog-title" }, "People"),
      button("Close", () => dialog.close(), { "aria-label": "Close people" }),
    ),
    element("p", { className: "hint" }, "Profiles known to this Gateway, not current connections."),
    element(
      "div",
      { className: "form-field" },
      element("label", { for: "gateway-people-search" }, "Search people"),
      search,
    ),
    results,
    panelList,
  );
  dismissOnBackdrop(dialog);
  search.addEventListener("input", renderPanel);
  const viewAll = button(
    "View all people",
    () => {
      search.value = "";
      dialog.showModal();
      renderPanel();
      search.focus();
    },
    { className: "overview-text-button", hidden: true, "aria-haspopup": "dialog" },
  );
  dialog.addEventListener("close", () => {
    if (!viewAll.hidden && context.isCurrent()) {
      viewAll.focus();
    }
  });

  function renderPanel() {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = people.filter((person) =>
      person.displayName.toLocaleLowerCase().includes(query),
    );
    panelList.replaceChildren(...filtered.map(renderPerson));
    panelList.scrollTop = 0;
    results.textContent = filtered.length
      ? `${filtered.length} of ${people.length} people`
      : "No people match your search.";
  }

  function renderPerson(person) {
    const name = person.displayName.trim() || "Unnamed person";
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
    const avatar = person.hasAvatar
      ? element("img", {
          className: "gateway-person-avatar",
          alt: "",
          loading: "lazy",
          src: `${endpoint}/${encodeURIComponent(person.id)}/avatar`,
        })
      : fallback;
    if (person.hasAvatar) {
      avatar.addEventListener("error", () => avatar.replaceWith(fallback), { once: true });
    }
    return element(
      "li",
      {},
      avatar,
      element("span", { className: "gateway-person-name" }, name),
      element("span", { className: "gateway-person-role" }, person.role ?? "Default permissions"),
    );
  }

  function clearPeople() {
    people = [];
    list.replaceChildren();
    panelList.replaceChildren();
    count.hidden = true;
    viewAll.hidden = true;
    if (dialog.open) {
      dialog.close();
    }
  }

  const section = element(
    "section",
    { className: "agent-card gateway-people", "aria-labelledby": "gateway-people-title" },
    element(
      "div",
      { className: "gateway-people-heading" },
      element("h2", { id: "gateway-people-title" }, "People", count),
      refresh,
    ),
    element(
      "p",
      { className: "hint" },
      "Profiles known to this Gateway. Roles are managed in OpenClaw; listing a profile does not grant access.",
    ),
    status,
    error,
    list,
    viewAll,
    dialog,
  );
  let pending = false;
  let refreshPending = false;

  async function load() {
    if (!context.isCurrent()) {
      return;
    }
    if (pending) {
      refreshPending = true;
      return;
    }
    if (context.deniedReads?.has(endpoint)) {
      clearPeople();
      section.hidden = true;
      return;
    }
    pending = true;
    refresh.disabled = true;
    error.textContent = "";
    status.textContent = "Loading people…";
    try {
      const data = await context.request(endpoint);
      if (!context.isCurrent()) {
        return;
      }
      section.hidden = data.people === null;
      if (data.people === null) {
        clearPeople();
        return;
      }
      people = [...data.people].sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
      );
      list.replaceChildren(...people.slice(0, 6).map(renderPerson));
      viewAll.textContent = `View all ${people.length} people`;
      viewAll.hidden = people.length <= 6;
      if (dialog.open) {
        renderPanel();
      }
      count.textContent = String(people.length);
      count.hidden = false;
      status.textContent = people.length
        ? ""
        : "No people yet. Profiles appear after someone connects to the Gateway.";
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      clearPeople();
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      status.textContent = "";
      if (cause.status === 403) {
        context.deniedReads?.remember(endpoint);
        section.hidden = true;
      } else if (cause.status === 409) {
        status.textContent = "People will appear when this Agent has a serving Gateway.";
      } else {
        error.textContent = "Couldn’t load people from the Gateway. Try refreshing.";
      }
    } finally {
      pending = false;
      refresh.disabled = false;
      if (refreshPending && context.isCurrent()) {
        refreshPending = false;
        void load();
      }
    }
  }
  return { section, ready: load(), refresh: load };
}
