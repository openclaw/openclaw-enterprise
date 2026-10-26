import type { BackendSummary, Namespace } from "@openclaw-enterprise/contracts";
import { displayDate } from "./agents/list.mjs";
import { button, describeDisabled, element, type statusBlock, requestIdLine } from "./dom.mjs";
import type { createNavigation, pages } from "./navigation.mjs";

interface Account {
  name: string;
  email: string;
}

export interface ShellState {
  session: { user: Account } | null;
  namespaces: readonly Namespace[];
  namespaceId: string | null;
  observabilityUrl: string | null;
  namespaceAdmissionPending?: boolean;
  recovery?: boolean;
  page?: { agentId: string; creating?: never } | { creating: true; agentId?: never } | null;
}

type Navigation = ReturnType<typeof createNavigation>;
type ShellOptions = Pick<Navigation, "route" | "pageUrl" | "navigate"> & {
  app: HTMLElement;
  pages: typeof pages;
  loadPage(options?: { fromRefresh: true }): void;
  logout(): void;
};

type LeaveGuard = (options?: { pendingOnly: true } | { refresh: true }) => boolean;

export function brandContents(placement: "navigation" | "sign-in") {
  const displayName =
    document.querySelector<HTMLMetaElement>('meta[name="occ-console-display-name"]')?.content ??
    "OpenClaw Enterprise";
  const mascot = "/console/oce-mascot.png";
  const src =
    document.querySelector<HTMLMetaElement>('meta[name="occ-console-logo"]')?.content ?? mascot;
  const size = placement === "navigation" ? "20" : "40";
  const image = element("img", { src, alt: "", width: size, height: size });
  const logo =
    placement === "navigation" && src === mascot
      ? element(
          "picture",
          { className: "brand-mascot" },
          element("source", {
            media: "(forced-colors: none)",
            srcset: "/console/oce-mascot-inverse.png",
          }),
          image,
        )
      : image;
  return [logo, element("span", { className: "brand-name", title: displayName }, displayName)];
}

// The page panel's sentence that says why no Namespace can be selected. The header's disabled
// selector is described by it (finding D749); the panel renders below the header afterwards.
export const NAMESPACE_ACCESS_REASON_ID = "namespace-access-reason";

export function panel(
  target: HTMLElement,
  title: string,
  description: string,
  actionLabel?: string,
  action?: () => void,
  requestId?: string | null,
) {
  target.replaceChildren(
    element(
      "section",
      { className: "state-panel", role: "status" },
      element("h2", {}, title),
      element("p", {}, description),
      requestId ? requestIdLine(requestId) : null,
      action ? button(actionLabel, action) : null,
    ),
  );
}

function menuItems(menu: HTMLElement) {
  return [
    ...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
  ].filter((item) => item.closest('[role="menu"]') === menu && !item.closest("[hidden]"));
}

function enableMenuKeys(menu: HTMLElement, close: () => void) {
  menu.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element) || event.target.closest('[role="menu"]') !== menu) {
      return;
    }
    const items = menuItems(menu);
    const index = items.findIndex((item) => item === document.activeElement);
    let next: number | undefined;
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
      items[next]?.focus();
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

export function sorted<T extends { id: string; name?: string }>(items: readonly T[]) {
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
} satisfies Record<Namespace["status"], { label: string; tone: Parameters<typeof statusBlock>[0] }>;
const backendTypes = {
  chatgpt: "ChatGPT",
  github: "GitHub",
  openshell: "OpenShell",
} satisfies Record<BackendSummary["type"], string>;

// Initials for the account avatar: the first letters of the first and last words of the
// name, or of the email when the account has no name.
export function initials(user: Partial<Account> | null | undefined) {
  const words = (user?.name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words
    .filter((_, index) => index === 0 || index === words.length - 1)
    .map((word) => [...word][0]);
  return (letters.join("") || [...(user?.email ?? "")][0] || "?").toUpperCase();
}

export function createShell({
  app,
  pages,
  route,
  pageUrl,
  navigate,
  loadPage,
  logout,
}: ShellOptions) {
  let session: ShellState["session"] = null;
  let namespaces: readonly Namespace[] = [];
  let namespaceId: string | null = null;
  let observabilityUrl: string | null = null;
  let menuControls: ReturnType<typeof createAccountMenus> | null = null;
  let drawerControls: {
    shell: HTMLElement;
    sidebar: HTMLElement;
    close(focus?: boolean): void;
  } | null = null;
  let namespaceSelect: HTMLSelectElement | null = null;
  let namespaceAdmissionPending = true;
  // Whether the shown page refuses to be left yet; it then says why (finding 1902).
  let refuseLeave: LeaveGuard = () => false;
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
  function lineIcon(d: string) {
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

  // A second action sits beside the first, for example Sign out next to Retry: this panel has
  // no account menu (finding 1894).
  function publicPanel(
    title: string,
    description: string,
    actionLabel?: string,
    action?: () => void,
    secondary?: { label: string; action: () => void },
  ) {
    menuControls = null;
    drawerControls = null;
    const primary = action ? button(actionLabel, action) : null;
    app.replaceChildren(
      element(
        "main",
        { className: "auth" },
        element("p", { className: "brand" }, ...brandContents("sign-in")),
        element("h1", {}, title),
        element("p", { role: "status", className: "muted" }, description),
        secondary
          ? element(
              "div",
              { className: "status-actions" },
              primary,
              button(secondary.label, secondary.action),
            )
          : primary,
      ),
    );
  }

  function accountControl({
    id,
    rootClass,
    toggle,
    menuFirst,
  }: {
    id: string;
    rootClass: string;
    toggle: HTMLButtonElement;
    menuFirst: boolean;
  }) {
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
      if (event.relatedTarget instanceof Node && !account.contains(event.relatedTarget)) {
        closeAccount(false);
      }
    });
    return { account, close: () => closeAccount(false) };
  }

  function createAccountMenus(user: Account) {
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
    return {
      side,
      top,
      contains: (node: Node | null) => side.account.contains(node) || top.account.contains(node),
      close: () => {
        side.close();
        top.close();
      },
    };
  }

  // A reader with no Namespace sees a panel whose sentence says why the selector is disabled
  // (finding D749). Only a shown panel describes it: on any other page, such as Settings, the
  // selector names no reason that is not there.
  function describeNamespaceSelector(select: HTMLSelectElement) {
    describeDisabled(
      select,
      session && !namespaceAdmissionPending && namespaces.length === 0
        ? // The page view may still be detached from the document while it renders.
          (select.closest(".shell") ?? document).querySelector<HTMLElement>(
            `#${NAMESPACE_ACCESS_REASON_ID}`,
          )
        : null,
    );
  }

  function updateNamespaceSelector(select: HTMLSelectElement) {
    const readable = namespaceAdmissionPending ? [] : namespaces;
    select.disabled = namespaceAdmissionPending || !session || readable.length === 0;
    describeNamespaceSelector(select);
    select.replaceChildren();
    if (!readable.some((item) => item.id === namespaceId)) {
      // Once this session knows the Namespace list, admission names the selection instead of
      // flashing "Checking access…"; the choices stay hidden until access is confirmed.
      let placeholder = namespaceAdmissionPending
        ? (namespaces.find((item) => item.id === namespaceId)?.name ?? "Checking access…")
        : "Checking access…";
      if (session && !namespaceAdmissionPending) {
        // The page's panel names the missing access; the disabled selector only says it is empty
        // (finding 2371). Its "Namespace" label already names the kind, so the compact control
        // fits the whole word (finding 2423).
        placeholder = namespaceId === null ? "None" : "Unavailable";
      }
      select.append(element("option", { value: "", disabled: true, selected: true }, placeholder));
    }
    for (const item of readable) {
      select.append(
        element("option", { value: item.id, selected: item.id === namespaceId }, item.name),
      );
    }
  }

  // The page header's selector is compact (UX spec 3.2): one 32 px control whose label sits
  // inside it as a muted prefix. The Namespace recovery panel keeps the full-size field.
  function namespaceSelector(label = "Namespace", { compact = false } = {}) {
    const select = element("select", { id: "namespace-selector" });
    namespaceSelect = select;
    updateNamespaceSelector(select);
    select.addEventListener("change", () => {
      if (
        namespaceAdmissionPending ||
        select !== namespaceSelect ||
        !namespaces.some((item) => item.id === select.value)
      ) {
        return;
      }
      // A page that cannot be left yet keeps its Namespace and says why (finding 1902).
      if (refuseLeave()) {
        select.value = namespaceId ?? "";
        return;
      }
      navigate(route().feature, select.value);
    });
    return element(
      "div",
      {
        className: compact
          ? "namespace-selector namespace-selector--compact"
          : "namespace-selector",
      },
      element("label", { for: "namespace-selector" }, label),
      select,
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
  function agentIdentity(agentId: string) {
    const id = element("span", { className: "resource-id", title: "Agent ID" }, agentId);
    const copied = element("span", { className: "page-meta-copied", role: "status" });
    let clearCopied: number | undefined;
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
        if (typeof navigator.clipboard?.writeText === "function") {
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

  function updateNamespaces(readable: readonly Namespace[], { preservePageScope = false } = {}) {
    if (!namespaceSelect?.isConnected) {
      return;
    }
    if (
      !namespaceAdmissionPending &&
      readable.length === namespaces.length &&
      readable.every(
        (item, index) => item.id === namespaces[index]?.id && item.name === namespaces[index].name,
      )
    ) {
      return;
    }
    namespaces = readable;
    namespaceAdmissionPending = false;
    updateNamespaceSelector(namespaceSelect);
    if (preservePageScope) {
      return;
    }
    const scope = app.querySelector(".content .scope");
    if (scope && ["agents", "secrets"].includes(route().feature)) {
      scope.textContent = `Namespace · ${readable.find((item) => item.id === namespaceId)?.name ?? "No available selection"}`;
    }
  }

  function renderShell(feature: keyof typeof pages, state: ShellState) {
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
    const focused = document.activeElement;
    const menuFocus =
      focused instanceof HTMLElement && menuControls?.contains(focused) ? focused : null;
    // Like the menu, a mobile drawer opened between a page load's two renders stays open.
    // After reset() or publicPanel(), or in a render without a session, it starts closed.
    const drawerOpen =
      Boolean(session) &&
      mobileLayout.matches &&
      Boolean(drawerControls?.shell.classList.contains("drawer-open"));
    const drawerFocus =
      drawerOpen && !menuFocus && drawerControls?.sidebar.contains(focused) ? focused : null;
    // Focus the person moved to a sidebar control during a load stays on it through the load's
    // later renders (loading, then the page). reset() runs as each load starts, so the first
    // render keeps none.
    const sidebarFocus =
      !drawerOpen && !menuFocus && drawerControls?.sidebar.contains(focused) ? focused : null;
    // A load renders a preview, then the page. Reuse its menus so one opened in between stays
    // usable. Navigation, publicPanel() and a render without a session start with closed menus.
    menuControls = session ? (menuControls ?? createAccountMenus(session.user)) : null;
    const nav = element("nav", { className: "nav", "aria-label": "Main navigation" });
    const icons = { agents: "◇", secrets: "⚿", namespaces: "▤" };
    for (const name of ["agents", "secrets", "namespaces"] as const) {
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
    const revision =
      document.querySelector<HTMLMetaElement>('meta[name="occ-build-revision"]')?.content ?? "";
    const knownRevision = /^[a-f0-9]{40}$/.test(revision);
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
        ...brandContents("navigation"),
        debug
          ? element(
              "span",
              {
                className: "occ-version",
                title: knownRevision
                  ? `Control plane commit ${revision}`
                  : "Control plane build revision unavailable",
              },
              knownRevision ? revision.slice(0, 8) : "dev",
            )
          : null,
      ),
      nav,
      diagnostics,
      menuControls?.side.account,
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
      element("p", { className: "brand brand--bar" }, ...brandContents("navigation")),
      menuControls?.top.account,
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
        nav.querySelector("a")?.focus();
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
    drawerControls = { shell, sidebar, close: closeDrawer };
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

  // Match a nav link by its feature: its href gains ?namespace= once the Namespaces load.
  // Other links (Observability) keep the href comparison.
  function isSameControl(candidate: Element, node: Element) {
    const nav = node.getAttribute("data-nav");
    return (
      candidate.localName === node.localName &&
      candidate.className === node.className &&
      (nav
        ? candidate.getAttribute("data-nav") === nav
        : candidate.getAttribute("href") === node.getAttribute("href")) &&
      candidate.textContent === node.textContent
    );
  }

  function sameControl(node: Element, root: HTMLElement) {
    return (
      [...root.querySelectorAll<HTMLElement>(node.localName)].find((candidate) =>
        isSameControl(candidate, node),
      ) ?? null
    );
  }

  function renderRows(
    view: HTMLElement,
    ...[feature, items]:
      ["namespaces", readonly Namespace[]] | ["backends", readonly BackendSummary[]]
  ) {
    if (!items.length) {
      panel(
        view,
        feature === "backends"
          ? "No backends configured"
          : `No accessible ${pages[feature].toLowerCase()}`,
        feature === "backends"
          ? "No experimental Backends are configured for this Installation."
          : "Ask an Installation administrator to provision resources or grant access, then refresh.",
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
            element("p", { className: "resource-name" }, element("span", {}, item.id)),
          ),
          element("span", { className: "badge" }, backendTypes[item.type] ?? item.type),
        ),
      );
    }
    view.replaceChildren(list);
  }

  // Namespaces read as a table (UX spec 3.12): Namespace with its ID beneath, Status, Created.
  // The rows stay a list, so each row is one item to a screen reader, and the column names
  // above them are visual only: each cell carries its own name. A row opens that Namespace's
  // Agents (finding 1897).
  function renderNamespaceRows(view: HTMLElement, items: readonly Namespace[]) {
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

  function namespaceLink(name: string, id: string) {
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
      if (control && event.target instanceof Node && !control.account.contains(event.target)) {
        control.close();
      }
    }
  });
  // Each render of a load replaces the shell (the held page, "Loading…", then the page). A press
  // on a sidebar, top bar or page header control that a render replaces before the release gets
  // no click on its replacement: the browser drops the click or sends it to an ancestor, so the
  // control's handler never runs (finding 2505). A release on that control in the shown shell
  // activates it instead. Taps send their mouse events together on release, so only a held mouse
  // press can straddle a render.
  const shellControls =
    ".sidebar a[href], .sidebar button, .topbar button, .page-header a[href], .page-header button";
  let pressedControl: Element | null = null;
  let activatedOnRelease: Element | null = null;
  document.addEventListener(
    "mousedown",
    (event) => {
      pressedControl =
        event.button === 0 && event.target instanceof Element
          ? event.target.closest(shellControls)
          : null;
    },
    { capture: true },
  );
  document.addEventListener("mouseup", (event) => {
    const pressed = pressedControl;
    pressedControl = null;
    const released =
      event.target instanceof Element ? event.target.closest<HTMLElement>(shellControls) : null;
    if (
      !pressed ||
      pressed.isConnected ||
      !released ||
      !event.isTrusted ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !isSameControl(released, pressed)
    ) {
      return;
    }
    // A browser that still sends this release's click to the control must not activate it twice.
    activatedOnRelease = released;
    setTimeout(() => {
      activatedOnRelease = null;
    });
    released.click();
  });
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.isTrusted &&
        event.target instanceof Node &&
        activatedOnRelease?.contains(event.target)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  document.addEventListener("keydown", (event) => {
    if (!drawerControls?.shell.classList.contains("drawer-open")) {
      return;
    }
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      drawerControls.close();
    }
    if (event.key === "Tab") {
      const items = [...drawerControls.sidebar.querySelectorAll<HTMLElement>("a,button")].filter(
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
    // The page view calls this once it shows (or replaces) the no-Namespace panel.
    describeNamespaceSelector() {
      if (namespaceSelect) {
        describeNamespaceSelector(namespaceSelect);
      }
    },
    // The shown shell's control, outside its page view, that matches one from an earlier
    // render: the same sidebar link or button, Namespace selector, Refresh, heading or navigation
    // toggle. A new shell's account menus start closed, so their items give way to their toggle (the
    // account row, or the top bar's avatar). At
    // phone width its navigation drawer starts closed too, so every control from the open drawer
    // gives way to the drawer's toggle (finding 1680).
    matchingControl(node: Element) {
      const shell = app.querySelector<HTMLElement>(":scope > .shell");
      if (!shell) {
        return null;
      }
      if (
        mobileLayout.matches &&
        node.closest(".sidebar") &&
        !shell.classList.contains("drawer-open")
      ) {
        return shell.querySelector<HTMLButtonElement>(".mobile-toggle");
      }
      if (node.closest(".account")) {
        return shell.querySelector<HTMLButtonElement>(".account-toggle");
      }
      if (node.closest(".topbar-account")) {
        return shell.querySelector<HTMLButtonElement>(".topbar-avatar");
      }
      // The sidebar, toggle and header precede the page view, so their match is found first.
      return sameControl(node, shell);
    },
    setLeaveGuard(guard: LeaveGuard) {
      refuseLeave = guard;
    },
    reset() {
      document
        .querySelectorAll<HTMLDialogElement>("dialog[open]")
        .forEach((dialog) => dialog.close());
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
