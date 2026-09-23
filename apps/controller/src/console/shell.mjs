import { element, button } from "./dom.mjs";

function supportsDesktopHover() {
  return window.matchMedia("(min-width: 761px) and (hover: hover)").matches;
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

function enableMenuKeys(menu, close, openChild) {
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
    if (event.key === "ArrowRight" && openChild) {
      event.preventDefault();
      openChild(event.target);
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

export function createShell({ app, pages, route, pageUrl, navigate, loadPage, logout }) {
  let session = null;
  let namespaces = [];
  let namespaceId = null;
  let menuControls = null;
  let drawerControls = null;

  function publicPanel(title, description, actionLabel, action) {
    app.replaceChildren(
      element(
        "main",
        { className: "auth" },
        element("p", { className: "brand" }, "OpenClaw Enterprise"),
        element("h1", {}, title),
        element("p", { role: "status", className: "muted" }, description),
        action ? button(actionLabel, action) : null,
      ),
    );
  }

  function accountMenu() {
    const account = element("div", { className: "account" });
    const menu = element("div", {
      className: "menu",
      id: "account-menu",
      role: "menu",
      "aria-label": "Account",
      hidden: "",
    });
    const submenu = element("div", {
      className: "menu namespace-submenu",
      id: "namespace-menu",
      role: "menu",
      "aria-label": "Namespaces",
      hidden: "",
    });
    const selected = namespaces.find((item) => item.id === namespaceId);
    const namespaceButton = button(
      `Namespace: ${selected?.name ?? (namespaceId === null ? "None" : "Unavailable")}`,
      () => openNamespace(true),
      {
        role: "menuitem",
        tabindex: "-1",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": "namespace-menu",
      },
    );
    for (const item of namespaces) {
      submenu.append(
        button(item.name, () => navigate(route().feature, item.id), {
          role: "menuitemradio",
          tabindex: "-1",
          "aria-checked": item.id === namespaceId,
        }),
      );
    }
    if (!namespaces.length) {
      submenu.append(element("p", { className: "muted" }, "No readable Namespaces"));
    }
    const toggle = button(
      "OpenClaw Enterprise",
      () => (menu.hidden ? openAccount() : closeAccount()),
      {
        className: "account-toggle",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": "account-menu",
      },
    );
    toggle.replaceChildren(
      element("span", { className: "account-label" }, "OpenClaw Enterprise"),
      element("span", { className: "account-chevron", "aria-hidden": "true" }, "⌃"),
    );
    function closeNamespace(focus = true) {
      submenu.hidden = true;
      namespaceButton.setAttribute("aria-expanded", "false");
      if (focus) {
        namespaceButton.focus();
      }
    }
    function closeAccount(focus = true) {
      closeNamespace(false);
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
    function openNamespace(focus) {
      submenu.hidden = false;
      namespaceButton.setAttribute("aria-expanded", "true");
      if (focus) {
        menuItems(submenu)[0]?.focus();
      }
    }
    toggle.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openAccount();
      }
    });
    namespaceButton.addEventListener("pointerenter", () => {
      if (supportsDesktopHover()) {
        openNamespace(false);
      }
    });
    enableMenuKeys(menu, closeAccount, (target) => {
      if (target === namespaceButton) {
        openNamespace(true);
      }
    });
    enableMenuKeys(submenu, closeNamespace);
    menu.append(
      namespaceButton,
      button("Settings", () => navigate("settings"), { role: "menuitem", tabindex: "-1" }),
      button("Logout", () => void logout(), { role: "menuitem", tabindex: "-1" }),
      submenu,
    );
    account.append(menu, toggle);
    account.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !account.contains(event.relatedTarget)) {
        closeAccount(false);
      }
    });
    menuControls = {
      account,
      close: () => closeAccount(false),
      openNamespace: () => {
        openAccount(false);
        openNamespace(true);
      },
    };
    return account;
  }

  function renderShell(feature, state) {
    ({ session, namespaces, namespaceId } = state);
    const nav = element("nav", { className: "nav", "aria-label": "Main navigation" });
    const icons = { agents: "◇", providers: "◈", namespaces: "▤" };
    for (const name of ["agents", "providers", "namespaces"]) {
      const link = element(
        "a",
        { href: pageUrl(name), ...(feature === name ? { "aria-current": "page" } : {}) },
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
        navigate(name);
      });
      nav.append(link);
    }
    const revision = document.querySelector('meta[name="occ-build-revision"]')?.content;
    const knownRevision = /^[a-f0-9]{40}$/.test(revision ?? "");
    const sidebar = element(
      "aside",
      { className: "sidebar", id: "navigation-drawer" },
      element(
        "p",
        { className: "brand" },
        "OCE",
        element(
          "span",
          {
            className: "occ-version",
            title: knownRevision ? `OCC commit ${revision}` : "OCC build revision unavailable",
          },
          knownRevision ? revision.slice(0, 8) : "dev",
        ),
      ),
      nav,
      session ? accountMenu() : null,
    );
    const main = element("main", { className: "content", id: "main" });
    const selected = namespaces.find((item) => item.id === namespaceId);
    const scope =
      feature === "agents"
        ? `Namespace · ${session ? (selected?.name ?? "No available selection") : "Checking access"}`
        : feature === "settings"
          ? "Your account"
          : "Installation-wide";
    const refresh = button("Refresh", () => void loadPage());
    refresh.disabled = true;
    const header = element(
      "header",
      { className: "page-header" },
      element(
        "div",
        {},
        element("h1", {}, pages[feature]),
        element("p", { className: "scope" }, scope),
      ),
      feature === "settings" ? null : refresh,
    );
    const view = element("div", { "aria-live": "polite", "aria-busy": "true" });
    main.append(header);
    if (session && feature !== "agents" && namespaceId !== null && !selected) {
      main.append(
        element(
          "p",
          { className: "scope" },
          "Namespace unavailable. ",
          button("Switch Namespace", switchNamespace),
        ),
      );
    }
    main.append(view);
    const mobileToggle = button("Open navigation", () => openDrawer(), {
      className: "mobile-toggle",
      "aria-controls": "navigation-drawer",
      "aria-expanded": "false",
    });
    const wrapper = element("div", {}, mobileToggle, main);
    const shell = element("div", { className: "shell" }, sidebar, wrapper);
    function closeDrawer(focus = true) {
      shell.classList.remove("drawer-open");
      main.inert = false;
      mobileToggle.setAttribute("aria-expanded", "false");
      if (focus) {
        mobileToggle.focus();
      }
    }
    function openDrawer() {
      shell.classList.add("drawer-open");
      main.inert = true;
      mobileToggle.setAttribute("aria-expanded", "true");
      nav.querySelector("a").focus();
    }
    sidebar.prepend(button("Close navigation", () => closeDrawer(), { className: "drawer-close" }));
    shell.append(
      button("Close navigation overlay", () => closeDrawer(), {
        className: "scrim",
        tabindex: "-1",
      }),
    );
    drawerControls = { shell, sidebar, close: closeDrawer, open: openDrawer };
    app.replaceChildren(shell);
    return { view, refresh };
  }

  function renderRows(view, feature, items) {
    if (!items.length) {
      panel(
        view,
        feature === "providers"
          ? "No providers configured"
          : `No accessible ${pages[feature].toLowerCase()}`,
        feature === "providers"
          ? "No Providers are configured for this Installation."
          : "Ask an administrator to provision resources or grant access, then refresh.",
        "Refresh",
        () => void loadPage(),
      );
      return;
    }
    const list = element("ul", { className: "collection", "aria-label": pages[feature] });
    for (const item of sorted(items)) {
      list.append(
        element(
          "li",
          { className: "resource" },
          element(
            "div",
            {},
            element("p", { className: "resource-name" }, item.name ?? item.id),
            feature === "providers" ? null : element("span", { className: "resource-id" }, item.id),
          ),
          feature === "agents"
            ? null
            : element(
                "span",
                { className: "badge" },
                feature === "providers" ? item.type : item.status,
              ),
        ),
      );
    }
    view.replaceChildren(list);
  }

  function switchNamespace() {
    if (window.matchMedia("(max-width: 760px)").matches) {
      drawerControls?.open();
    }
    menuControls?.openNamespace();
  }

  document.addEventListener("pointerdown", (event) => {
    if (menuControls && !menuControls.account.contains(event.target)) {
      menuControls.close();
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
    reset() {
      document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
      menuControls = null;
      drawerControls = null;
      session = null;
      namespaces = [];
      namespaceId = null;
    },
  };
}
