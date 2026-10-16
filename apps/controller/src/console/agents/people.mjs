import { button, element } from "../dom.mjs";

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
        return;
      }
      const people = [...data.people].sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
      );
      list.replaceChildren(
        ...people.map((person) => {
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
            element(
              "span",
              { className: "gateway-person-role" },
              person.role ?? "Default permissions",
            ),
          );
        }),
      );
      count.textContent = String(people.length);
      count.hidden = false;
      status.textContent = people.length
        ? ""
        : "No people yet. Profiles appear after someone connects to the Gateway.";
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      if (cause.status === 401) {
        context.onExpired();
        return;
      }
      list.replaceChildren();
      count.hidden = true;
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
