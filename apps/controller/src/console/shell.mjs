import { element, button } from "./dom.mjs";

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

  function publicPanel(title, description, actionLabel, action) {
    menuControls = null;
    drawerControls = null;
    app.replaceChildren(
      element(
        "main",
        { className: "auth" },
        element(
          "p",
          { className: "brand" },
          element("img", { src: "/console/oce-mascot.png", alt: "", width: "40", height: "40" }),
          "OpenClaw Enterprise",
        ),
        element("h1", {}, title),
        element("p", { role: "status", className: "muted" }, description),
        action ? button(actionLabel, action) : null,
      ),
    );
  }

  function accountMenu() {
    // A page load can render the shell twice (a Loading or retained preview, then the
    // fresh view). Keep the same menu so one opened in between stays open and clickable.
    // reset(), publicPanel() and a session-less render drop it, so each navigation
    // starts with a closed menu.
    if (menuControls) {
      return menuControls.account;
    }
    const account = element("div", { className: "account" });
    const menu = element("div", {
      className: "menu",
      id: "account-menu",
      role: "menu",
      "aria-label": "Account",
      hidden: "",
    });
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
      button("Logout", () => void logout(), { role: "menuitem", tabindex: "-1" }),
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
    };
    return account;
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

  function namespaceSelector(label = "Namespace") {
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
      { className: "namespace-selector" },
      element("label", { for: "namespace-selector" }, label),
      namespaceSelect,
    );
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
    if (scope && route().feature === "agents") {
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
    // A page held during a navigation shows Namespace recovery only if it already did.
    const recovery = state.recovery ?? true;
    namespaceSelect = null;
    // Moving the retained menu into the new sidebar detaches it; give focus back afterwards.
    const menuFocus = menuControls?.account.contains(document.activeElement)
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
    const icons = { agents: "◇", namespaces: "▤" };
    for (const name of ["agents", "namespaces"]) {
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
        element("img", { src: "/console/oce-mascot.png", alt: "", width: "40", height: "40" }),
        "OCE",
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
      session ? accountMenu() : null,
    );
    const main = element("main", { className: "content", id: "main" });
    const selected = namespaces.find((item) => item.id === namespaceId);
    const scope =
      feature === "agents"
        ? `Namespace · ${selected?.name ?? (session && !namespaceAdmissionPending ? "No available selection" : "Checking access")}`
        : feature === "settings"
          ? "Your account"
          : feature === "backends"
            ? "Installation-wide · Experimental"
            : "Installation-wide";
    const scopeSelector = feature === "namespaces" ? null : namespaceSelector();
    const refresh = button("Refresh", () => void loadPage({ fromRefresh: true }), {
      tone: "ghost",
      size: "sm",
    });
    refresh.disabled = true;
    const header = element(
      "header",
      { className: "page-header" },
      element(
        "div",
        {},
        element("h1", { tabindex: "-1" }, pages[feature]),
        element("p", { className: "scope" }, scope),
      ),
      element(
        "div",
        { className: "page-actions" },
        scopeSelector,
        feature === "settings" ? null : refresh,
      ),
    );
    const view = element("div", { "aria-live": "polite", "aria-busy": "true" });
    main.append(header);
    if (recovery && session && feature !== "agents" && namespaceId !== null && !selected) {
      if (feature === "namespaces" && namespaces.length) {
        main.append(
          element(
            "section",
            { className: "state-panel namespace-recovery", role: "status" },
            element("h2", {}, "Namespace unavailable"),
            namespaceSelector("Choose a valid Namespace"),
          ),
        );
      } else if (feature !== "namespaces") {
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
    function openDrawer(focus = true) {
      shell.classList.add("drawer-open");
      main.inert = true;
      mobileToggle.setAttribute("aria-expanded", "true");
      if (focus) {
        nav.querySelector("a").focus();
      }
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
    return { view, refresh, diagnostics, scopeSelector };
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
    const list = element("ul", { className: "collection", "aria-label": pages[feature] });
    for (const item of sorted(items)) {
      const name = item.name ?? item.id;
      // A Namespace row opens that Namespace's Agents (finding 1897).
      const label =
        feature === "namespaces" ? namespaceLink(name, item.id) : element("span", {}, name);
      const status = feature === "namespaces" ? namespaceStatuses[item.status] : undefined;
      list.append(
        element(
          "li",
          {
            className: feature === "namespaces" ? "card resource resource-linked" : "card resource",
          },
          element(
            "div",
            {},
            element("p", { className: "resource-name" }, label),
            feature === "backends" ? null : element("span", { className: "resource-id" }, item.id),
          ),
          feature === "agents"
            ? null
            : element(
                "span",
                { className: "badge", ...(status ? { "data-tone": status.tone } : {}) },
                feature === "backends"
                  ? (backendTypes[item.type] ?? item.type)
                  : (status?.label ?? item.status),
              ),
        ),
      );
    }
    view.replaceChildren(list);
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
    updateNamespaces,
    // The shown shell's control, outside its page view, that matches one from an earlier
    // render: the same sidebar link or button, Namespace selector, Refresh, heading or navigation
    // toggle. A new shell's account menu starts closed, so its items give way to the toggle. At
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
