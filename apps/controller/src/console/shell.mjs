import { displayDate } from "./agents/list.mjs";
import { element, button } from "./dom.mjs";

export function brandContents(size) {
  const displayName =
    document.querySelector('meta[name="occ-console-display-name"]')?.content ??
    "OpenClaw Enterprise";
  const src =
    document.querySelector('meta[name="occ-console-logo"]')?.content ?? "/console/oce-mascot.png";
  return [
    element("img", { src, alt: "", width: String(size), height: String(size) }),
    element("span", { className: "brand-name", title: displayName }, displayName),
  ];
}

export function panel(target, title, description, actionLabel, action, requestId) {
  target.replaceChildren(
    element(
      "section",
      { className: "state-panel", role: "status" },
      element("h2", {}, title),
      element("p", {}, description),
      requestId ? element("p", { className: "request-id" }, `Request ID: ${requestId}`) : null,
      action ? button(actionLabel, action) : null,
    ),
  );
}

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter(
    (item) => item.closest('[role="menu"]') === menu && !item.closest("[hidden]"),
  );
}

function enableMenuKeys(menu, close) {
  menu.addEventListener("keydown", (event) => {
    if (event.target.closest('[role="menu"]') !== menu) {
      return;
    }
    const items = menuItems(menu);
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") {
      next = (index + 1) % items.length;
    }
    if (event.key === "ArrowUp") {
      next = (index - 1 + items.length) % items.length;
    }
    if (event.key === "Home") {
      next = 0;
    }
    if (event.key === "End") {
      next = items.length - 1;
    }
    if (next !== undefined && items.length) {
      event.preventDefault();
      items[next].focus();
    }
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  menu.addEventListener("focusin", (event) => {
    for (const item of menuItems(menu)) {
      item.tabIndex = item === event.target ? 0 : -1;
    }
  });
}

export function sorted(items) {
  return [...items].sort(
    (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id),
  );
}

// Status badges speak in words with a tone; Backend types are names, so they stay neutral.
const namespaceStatuses = {
  ready: { label: "Ready", tone: "success" },
  provisioning: { label: "Provisioning", tone: "warning" },
  deleting: { label: "Deleting", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};
const backendTypes = { chatgpt: "ChatGPT", github: "GitHub", openshell: "OpenShell" };

// Initials for the account avatar: the first letters of the first and last words of the
// name, or of the email when the account has no name.
export function initials(user) {
  const words = (user?.name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words.at(-1)] : words).map((word) => [...word][0]);
  return (letters.join("") || [...(user?.email ?? "")][0] || "?").toUpperCase();
}

export function createShell({ app, pages, route, pageUrl, navigate, loadPage, logout }) {
  let session = null;
  let namespaces = [];
  let namespaceId = null;
  let observabilityUrl = null;
  let menuControls = null;
  let drawerControls = null;
  let namespaceSelect = null;
  let namespaceAdmissionPending = true;
  // Whether the shown page refuses to be left yet; it then says why (finding 1902).
  let refuseLeave = () => false;
  const mobileLayout = window.matchMedia("(max-width: 760px)");

  mobileLayout.addEventListener("change", (event) => {
    // The account menu of the layout being left is hidden; close it so it doesn't reappear open.
    menuControls?.close();
    if (!event.matches) {
      drawerControls?.close(false);
    }
  });

  function externalLinkIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "external-link-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M15 3h6v6m0-6L10 14m11-1v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6",
    );
    svg.append(path);
    return svg;
  }

  // A 20 px line icon for the icon-only buttons of the phone top bar and drawer.
  function lineIcon(d) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "line-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  function publicPanel(title, description, actionLabel, action) {
    menuControls = null;
    drawerControls = null;
    app.replaceChildren(
      element(
        "main",
        { className: "auth" },
        element("p", { className: "brand" }, ...brandContents(40)),
        element("h1", {}, title),
        element("p", { role: "status", className: "muted" }, description),
        action ? button(actionLabel, action) : null,
      ),
    );
  }

  function accountControl({ id, rootClass, toggle, menuFirst }) {
    const account = element("div", { className: rootClass });
    const menu = element("div", {
      className: "menu",
      id,
      role: "menu",
      "aria-label": "Account",
      hidden: "",
    });
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", id);
    toggle.addEventListener("click", () => (menu.hidden ? openAccount() : closeAccount()));
    function closeAccount(focus = true) {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (focus) {
        toggle.focus();
      }
    }
    function openAccount(focus = true) {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      if (focus) {
        menuItems(menu)[0]?.focus();
      }
    }
    toggle.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openAccount();
      }
    });
    enableMenuKeys(menu, closeAccount);
    menu.append(
      button("Settings", () => navigate("settings"), { role: "menuitem", tabindex: "-1" }),
      button("Sign out", () => void logout(), { role: "menuitem", tabindex: "-1" }),
    );
    account.append(...(menuFirst ? [menu, toggle] : [toggle, menu]));
    account.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !account.contains(event.relatedTarget)) {
        closeAccount(false);
      }
    });
    return { account, close: () => closeAccount(false) };
  }

  function accountMenus() {
    // A page load can render the shell twice (a Loading or retained preview, then the
    // fresh view). Keep the same menus so one opened in between stays open and clickable.
    // reset(), publicPanel() and a session-less render drop them, so each navigation
    // starts with closed menus.
    if (menuControls) {
      return menuControls;
    }
    const user = session.user;
    const name = user?.name || user?.email || "Account";
    // The sidebar's account row: avatar, name and email. At phone width the sidebar is the
    // navigation drawer, so the top bar's avatar opens its own copy of the menu.
    const toggle = element(
      "button",
      { type: "button", className: "account-toggle" },
      element("span", { className: "account-avatar", "aria-hidden": "true" }, initials(user)),
      element(
        "span",
        { className: "account-text" },
        element("span", { className: "account-name" }, name),
        // Flex items drop this space visually; it keeps the name and email apart in the
        // button's accessible name.
        user?.email && user.email !== name ? " " : null,
        user?.email && user.email !== name
          ? element("span", { className: "account-email" }, user.email)
          : null,
      ),
      element("span", { className: "account-chevron", "aria-hidden": "true" }, "⌃"),
    );
    const avatar = element(
      "button",
      { type: "button", className: "topbar-avatar", "aria-label": `Account: ${name}` },
      element("span", { className: "account-avatar", "aria-hidden": "true" }, initials(user)),
    );
    const side = accountControl({
      id: "account-menu",
      rootClass: "account",
      toggle,
      menuFirst: true,
    });
    const top = accountControl({
      id: "account-menu-top",
      rootClass: "topbar-account",
      toggle: avatar,
      menuFirst: false,
    });
    menuControls = {
      side,
      top,
      contains: (node) => side.account.contains(node) || top.account.contains(node),
      close: () => {
        side.close();
        top.close();
      },
    };
    return menuControls;
  }

  function updateNamespaceSelector() {
    const readable = namespaceAdmissionPending ? [] : namespaces;
    namespaceSelect.disabled = namespaceAdmissionPending || !session || readable.length === 0;
    namespaceSelect.replaceChildren();
    if (!readable.some((item) => item.id === namespaceId)) {
      // Once this session knows the Namespace list, admission names the selection instead of
      // flashing "Checking access…"; the choices stay hidden until access is confirmed.
      let placeholder = namespaceAdmissionPending
        ? (namespaces.find((item) => item.id === namespaceId)?.name ?? "Checking access…")
        : "Checking access…";
      if (session && !namespaceAdmissionPending) {
        placeholder = namespaceId === null ? "No readable Namespaces" : "Namespace unavailable";
      }
      namespaceSelect.append(
        element("option", { value: "", disabled: true, selected: true }, placeholder),
      );
    }
    for (const item of readable) {
      namespaceSelect.append(
        element("option", { value: item.id, selected: item.id === namespaceId }, item.name),
      );
    }
  }

  // The page header's selector is compact (UX spec 3.2): one 32 px control whose label sits
  // inside it as a muted prefix. The Namespace recovery panel keeps the full-size field.
  function namespaceSelector(label = "Namespace", { compact = false } = {}) {
    namespaceSelect = element("select", { id: "namespace-selector" });
    updateNamespaceSelector();
    namespaceSelect.addEventListener("change", (event) => {
      if (
        namespaceAdmissionPending ||
        event.currentTarget !== namespaceSelect ||
        !namespaces.some((item) => item.id === event.target.value)
      ) {
        return;
      }
      // A page that cannot be left yet keeps its Namespace and says why (finding 1902).
      if (refuseLeave()) {
        event.target.value = namespaceId;
        return;
      }
      navigate(route().feature, event.target.value);
    });
    return element(
      "div",
      {
        className: compact
          ? "namespace-selector namespace-selector--compact"
          : "namespace-selector",
      },
      element("label", { for: "namespace-selector" }, label),
      namespaceSelect,
    );
  }

  function copyIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "copy-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const back = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [name, value] of Object.entries({ x: 9, y: 9, width: 12, height: 12, rx: 2 })) {
      back.setAttribute(name, String(value));
    }
    const front = document.createElementNS("http://www.w3.org/2000/svg", "path");
    front.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
    svg.append(back, front);
    return svg;
  }

  // The Agent's ID under its name, with a copy button. Copying falls back to selecting the ID
  // where the clipboard is unavailable (an http origin, say), so it can be copied by hand.
  function agentIdentity(agentId) {
    const id = element("span", { className: "resource-id", title: "Agent ID" }, agentId);
    const copied = element("span", { className: "page-meta-copied", role: "status" });
    let clearCopied = null;
    const copy = button(
      "",
      () => {
        const done = () => {
          copied.textContent = "Copied";
          clearTimeout(clearCopied);
          clearCopied = setTimeout(() => {
            copied.textContent = "";
          }, 2000);
        };
        const select = () => {
          const range = document.createRange();
          range.selectNodeContents(id);
          document.getSelection()?.removeAllRanges();
          document.getSelection()?.addRange(range);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(agentId).then(done, select);
        } else {
          select();
        }
      },
      {
        tone: "ghost",
        size: "sm",
        className: "page-meta-copy",
        "aria-label": "Copy Agent ID",
        title: "Copy Agent ID",
      },
    );
    copy.append(copyIcon());
    return element("span", { className: "page-meta-id" }, id, copy, copied);
  }

  // ← Agents on an Agent's page and on Create Agent. A page that cannot be left yet (an open
  // draft editor, a write in flight) keeps the reader and says why (findings 1902, 1937).
  function backToAgents() {
    const back = element(
      "a",
      { href: pageUrl("agents"), className: "button button--ghost button--sm page-back" },
      "← Agents",
    );
    back.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (refuseLeave()) {
        return;
      }
      navigate("agents");
    });
    return back;
  }

  function updateNamespaces(readable, { preservePageScope = false } = {}) {
    if (!namespaceSelect?.isConnected) {
      return;
    }
    if (
      !namespaceAdmissionPending &&
      readable.length === namespaces.length &&
      readable.every(
        (item, index) => item.id === namespaces[index].id && item.name === namespaces[index].name,
      )
    ) {
      return;
    }
    namespaces = readable;
    namespaceAdmissionPending = false;
    updateNamespaceSelector();
    if (preservePageScope) {
      return;
    }
    const scope = app.querySelector(".content .scope");
    if (scope && ["agents", "secrets"].includes(route().feature)) {
      scope.textContent = `Namespace · ${readable.find((item) => item.id === namespaceId)?.name ?? "No available selection"}`;
    }
  }

  function renderShell(feature, state) {
    ({
      session,
      namespaces,
      namespaceId,
      observabilityUrl,
      namespaceAdmissionPending = true,
    } = state);
    // An Agent's page ({ agentId }) or Create Agent ({ creating: true }): ← Agents above the
    // title, and the ID and Namespace in a meta row under it (UX spec 3.2).
    const subpage = feature === "agents" && state.page ? state.page : null;
    // A page held during a navigation shows Namespace recovery only if it already did.
    const recovery = state.recovery ?? true;
    namespaceSelect = null;
    // Moving the retained menu into the new sidebar detaches it; give focus back afterwards.
    const menuFocus = menuControls?.contains(document.activeElement)
      ? document.activeElement
      : null;
    // Like the menu, a mobile drawer opened between a page load's two renders stays open.
    // After reset() or publicPanel(), or in a render without a session, it starts closed.
    const drawerOpen =
      Boolean(session) &&
      mobileLayout.matches &&
      Boolean(drawerControls?.shell.classList.contains("drawer-open"));
    const drawerFocus =
      drawerOpen && !menuFocus && drawerControls.sidebar.contains(document.activeElement)
        ? document.activeElement
        : null;
    // Focus the person moved to a sidebar control during a load stays on it through the load's
    // later renders (loading, then the page). reset() runs as each load starts, so the first
    // render keeps none.
    const sidebarFocus =
      !drawerOpen && !menuFocus && drawerControls?.sidebar.contains(document.activeElement)
        ? document.activeElement
        : null;
    if (!session) {
      menuControls = null;
    }
    const nav = element("nav", { className: "nav", "aria-label": "Main navigation" });
    const icons = { agents: "◇", secrets: "⚿", namespaces: "▤" };
    for (const name of ["agents", "secrets", "namespaces"]) {
      const link = element(
        "a",
        {
          href: pageUrl(name),
          "data-nav": name,
          ...(feature === name ? { "aria-current": "page" } : {}),
        },
        element("span", { className: "nav-icon", "aria-hidden": "true" }, icons[name]),
        pages[name],
      );
      link.addEventListener("click", (event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        // A page waiting on a write stays and says why, as ← Agents does (finding 1937). On a
        // phone the drawer closes, so the reason is not hidden behind it.
        if (refuseLeave({ pendingOnly: true })) {
          if (drawerControls?.shell.classList.contains("drawer-open")) {
            drawerControls.close();
          }
          return;
        }
        navigate(name);
      });
      nav.append(link);
    }
    if (session && observabilityUrl) {
      nav.append(
        element(
          "a",
          {
            href: observabilityUrl,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          element("span", { className: "nav-icon", "aria-hidden": "true" }, "◉"),
          "Observability",
          externalLinkIcon(),
        ),
      );
    }
    const revision = document.querySelector('meta[name="occ-build-revision"]')?.content;
    const knownRevision = /^[a-f0-9]{40}$/.test(revision ?? "");
    const debug = route().url.searchParams.get("debug") === "true";
    const diagnostics =
      debug && session
        ? element(
            "section",
            {
              className: "runtime-debug",
              "aria-label": "Build and runtime images",
            },
            element("h2", {}, "Debug"),
            element("p", {}, "OCE commit"),
            element("code", {}, knownRevision ? revision : "Unavailable (development build)"),
          )
        : null;
    const sidebar = element(
      "aside",
      { className: "sidebar", id: "navigation-drawer" },
      element(
        "p",
        { className: "brand" },
        ...brandContents(20),
        debug
          ? element(
              "span",
              {
                className: "occ-version",
                title: knownRevision ? `OCC commit ${revision}` : "OCC build revision unavailable",
              },
              knownRevision ? revision.slice(0, 8) : "dev",
            )
          : null,
      ),
      nav,
      diagnostics,
      session ? accountMenus().side.account : null,
    );
    const main = element("main", { className: "content", id: "main" });
    const selected = namespaces.find((item) => item.id === namespaceId);
    const scope = ["agents", "secrets"].includes(feature)
      ? `Namespace · ${selected?.name ?? (session && !namespaceAdmissionPending ? "No available selection" : "Checking access")}`
      : feature === "settings"
        ? "Your account"
        : feature === "backends"
          ? "Installation-wide · Experimental"
          : "Installation-wide";
    // Settings is about the account, and Namespaces lists them: neither has a Namespace scope.
    const scopeSelector =
      feature === "namespaces" || feature === "settings"
        ? null
        : namespaceSelector("Namespace", { compact: true });
    // Refresh rebuilds the page: one whose write must finish here stays and says why.
    const refresh = button(
      "Refresh",
      () => void (refuseLeave({ refresh: true }) || loadPage({ fromRefresh: true })),
      {
        tone: "ghost",
        size: "sm",
      },
    );
    refresh.disabled = true;
    const heading = element("h1", { tabindex: "-1" }, pages[feature]);
    const actions = element(
      "div",
      { className: "page-actions" },
      subpage ? null : scopeSelector,
      feature === "settings" ? null : refresh,
    );
    const header = subpage
      ? element(
          "header",
          {
            className: `page-header page-header--subpage ${subpage.agentId ? "page-header--agent" : "page-header--create"}`,
          },
          backToAgents(),
          heading,
          actions,
          element(
            "div",
            { className: "page-meta" },
            subpage.agentId ? agentIdentity(subpage.agentId) : null,
            scopeSelector,
          ),
        )
      : element(
          "header",
          { className: "page-header" },
          element(
            "div",
            { className: "page-title" },
            heading,
            element("p", { className: "scope" }, scope),
          ),
          actions,
        );
    const view = element("div", { "aria-live": "polite", "aria-busy": "true" });
    main.append(header);
    if (
      recovery &&
      session &&
      !["agents", "secrets"].includes(feature) &&
      namespaceId !== null &&
      !selected
    ) {
      if (feature === "namespaces" && namespaces.length) {
        main.append(
          element(
            "section",
            { className: "state-panel namespace-recovery", role: "status" },
            element("h2", {}, "Namespace unavailable"),
            namespaceSelector("Choose a valid Namespace"),
          ),
        );
      } else if (scopeSelector) {
        // Switch Namespace focuses the header's selector: Settings has none, so it offers none.
        main.append(
          element(
            "p",
            { className: "scope" },
            "Namespace unavailable. ",
            button("Switch Namespace", switchNamespace),
          ),
        );
      }
    }
    main.append(view);
    const mobileToggle = button(lineIcon("M4 6h16M4 12h16M4 18h16"), () => openDrawer(), {
      className: "mobile-toggle",
      "aria-label": "Open navigation",
      "aria-controls": "navigation-drawer",
      "aria-expanded": "false",
    });
    // The phone top bar: navigation toggle, wordmark, and the account avatar.
    const topbar = element(
      "div",
      { className: "topbar" },
      mobileToggle,
      element("p", { className: "brand brand--bar" }, ...brandContents(20)),
      session ? accountMenus().top.account : null,
    );
    const wrapper = element("div", {}, topbar, main);
    const shell = element("div", { className: "shell" }, sidebar, wrapper);
    function closeDrawer(focus = true) {
      shell.classList.remove("drawer-open");
      main.inert = false;
      mobileToggle.setAttribute("aria-expanded", "false");
      if (focus) {
        mobileToggle.focus();
      }
    }
    function openDrawer(focus = true) {
      menuControls?.top.close();
      shell.classList.add("drawer-open");
      main.inert = true;
      mobileToggle.setAttribute("aria-expanded", "true");
      if (focus) {
        nav.querySelector("a").focus();
      }
    }
    sidebar.prepend(
      button(lineIcon("M6 6l12 12M18 6L6 18"), () => closeDrawer(), {
        className: "drawer-close",
        "aria-label": "Close navigation",
      }),
    );
    shell.append(
      button("Close navigation overlay", () => closeDrawer(), {
        className: "scrim",
        tabindex: "-1",
      }),
    );
    drawerControls = { shell, sidebar, close: closeDrawer, open: openDrawer };
    app.replaceChildren(shell);
    if (drawerOpen) {
      // Focus moves to the same control in the new drawer; close if it has none.
      const target = drawerFocus && sameControl(drawerFocus, sidebar);
      if (drawerFocus && !target) {
        closeDrawer();
      } else {
        // Focus left on the page body would stay outside the drawer, behind inert content.
        openDrawer(!target && !menuFocus && document.activeElement === document.body);
        target?.focus({ preventScroll: true });
      }
    }
    if (sidebarFocus) {
      sameControl(sidebarFocus, sidebar)?.focus({ preventScroll: true });
    }
    if (menuFocus) {
      menuFocus.focus({ preventScroll: true });
      // If focus can't return (the menu is hidden), don't leave it open out of sight.
      if (document.activeElement !== menuFocus) {
        menuControls?.close();
      }
    }
    return { view, refresh, diagnostics, scopeSelector, actions };
  }

  function sameControl(node, root) {
    // Match a nav link by its feature: its href gains ?namespace= once the Namespaces load.
    // Other links (Observability) keep the href comparison.
    const nav = node.getAttribute("data-nav");
    return (
      [...root.querySelectorAll(node.localName)].find(
        (candidate) =>
          candidate.className === node.className &&
          (nav
            ? candidate.getAttribute("data-nav") === nav
            : candidate.getAttribute("href") === node.getAttribute("href")) &&
          candidate.textContent === node.textContent,
      ) ?? null
    );
  }

  function renderRows(view, feature, items) {
    if (!items.length) {
      panel(
        view,
        feature === "backends"
          ? "No backends configured"
          : `No accessible ${pages[feature].toLowerCase()}`,
        feature === "backends"
          ? "No experimental Backends are configured for this Installation."
          : "Ask an administrator to provision resources or grant access, then refresh.",
        "Refresh",
        () => void loadPage(),
      );
      return;
    }
    if (feature === "namespaces") {
      renderNamespaceRows(view, items);
      return;
    }
    const list = element("ul", { className: "collection", "aria-label": pages[feature] });
    for (const item of sorted(items)) {
      list.append(
        element(
          "li",
          { className: "card resource" },
          element(
            "div",
            {},
            element("p", { className: "resource-name" }, element("span", {}, item.name ?? item.id)),
            feature === "backends" ? null : element("span", { className: "resource-id" }, item.id),
          ),
          feature === "agents"
            ? null
            : element("span", { className: "badge" }, backendTypes[item.type] ?? item.type),
        ),
      );
    }
    view.replaceChildren(list);
  }

  // Namespaces read as a table (UX spec 3.12): Namespace with its ID beneath, Status, Created.
  // The rows stay a list, so each row is one item to a screen reader, and the column names
  // above them are visual only: each cell carries its own name. A row opens that Namespace's
  // Agents (finding 1897).
  function renderNamespaceRows(view, items) {
    const list = element("ul", {
      className: "collection",
      "aria-label": pages.namespaces,
    });
    for (const item of sorted(items)) {
      const status = namespaceStatuses[item.status];
      list.append(
        element(
          "li",
          { className: "resource-linked namespace-row" },
          element(
            "div",
            { className: "namespace-cell-name" },
            element(
              "p",
              { className: "resource-name" },
              namespaceLink(item.name ?? item.id, item.id),
            ),
            element("span", { className: "resource-id" }, item.id),
          ),
          element(
            "span",
            { className: "namespace-cell-status" },
            element(
              "span",
              { className: "badge", ...(status ? { "data-tone": status.tone } : {}) },
              status?.label ?? item.status,
            ),
          ),
          element(
            "span",
            { className: "namespace-cell-created" },
            element("span", { className: "namespace-cell-label" }, "Created "),
            item.createdAt ? displayDate(item.createdAt) : "Unknown",
          ),
        ),
      );
    }
    view.replaceChildren(
      element(
        "div",
        { className: "resource-list namespace-table" },
        element(
          "div",
          { className: "resource-list-header namespace-table-head", "aria-hidden": "true" },
          element("span", {}, "Namespace"),
          element("span", {}, "Status"),
          element("span", {}, "Created"),
        ),
        list,
      ),
    );
  }

  function namespaceLink(name, id) {
    const node = element("a", { href: pageUrl("agents", id) }, name);
    // A revalidation that remounts the list returns focus to the same row.
    node.dataset.returnFocusHref = node.href;
    node.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate("agents", id);
    });
    return node;
  }

  function switchNamespace() {
    namespaceSelect?.focus();
  }

  document.addEventListener("pointerdown", (event) => {
    for (const control of [menuControls?.side, menuControls?.top]) {
      if (control && !control.account.contains(event.target)) {
        control.close();
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!drawerControls?.shell.classList.contains("drawer-open")) {
      return;
    }
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      drawerControls.close();
    }
    if (event.key === "Tab") {
      const items = [...drawerControls.sidebar.querySelectorAll("a,button")].filter(
        (node) => !node.closest("[hidden]") && node.getClientRects().length,
      );
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
    }
  });
  return {
    publicPanel,
    renderShell,
    renderRows,
    switchNamespace,
    updateNamespaces,
    // The shown shell's control, outside its page view, that matches one from an earlier
    // render: the same sidebar link or button, Namespace selector, Refresh, heading or navigation
    // toggle. A new shell's account menus start closed, so their items give way to their toggle (the
    // account row, or the top bar's avatar). At
    // phone width its navigation drawer starts closed too, so every control from the open drawer
    // gives way to the drawer's toggle (finding 1680).
    matchingControl(node) {
      const shell = app.querySelector(":scope > .shell");
      if (!shell) {
        return null;
      }
      if (
        mobileLayout.matches &&
        node.closest(".sidebar") &&
        !shell.classList.contains("drawer-open")
      ) {
        return shell.querySelector(".mobile-toggle");
      }
      if (node.closest(".account")) {
        return shell.querySelector(".account-toggle");
      }
      if (node.closest(".topbar-account")) {
        return shell.querySelector(".topbar-avatar");
      }
      // The sidebar, toggle and header precede the page view, so their match is found first.
      return sameControl(node, shell);
    },
    setLeaveGuard(guard) {
      refuseLeave = guard;
    },
    reset() {
      document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
      menuControls = null;
      drawerControls = null;
      namespaceSelect = null;
      session = null;
      namespaces = [];
      namespaceId = null;
      observabilityUrl = null;
      namespaceAdmissionPending = true;
    },
  };
}
