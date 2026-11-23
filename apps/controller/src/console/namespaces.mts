import type { Namespace } from "@openclaw-enterprise/contracts";
import { type createApiClient, requestFailure, responseFields } from "./api-client.mjs";
import {
  button,
  dismissOnBackdrop,
  element,
  field,
  setUnavailable,
  statusBlock,
  validateFields,
  requestIdLine,
} from "./dom.mjs";
import type { createNavigation } from "./navigation.mjs";
import { describeFailure, displayDate, explainedConflict } from "./agents/list.mjs";
import { createNamespaceDeletion } from "./namespace-deletion.mjs";
import {
  ASK_INSTALLATION_ADMINISTRATOR,
  askAdministratorTo,
  namespaceCreateDenied,
} from "./agents/access-reasons.mjs";

// The heading wherever a caller reads no Namespace: the Namespaces page and the shell's panel
// say it alike (finding D755).
export const NO_READABLE_NAMESPACES = "No readable Namespaces";

/** The part of the mounted page context used by Namespaces and Secrets. */
export interface NamespacePageContext {
  view: HTMLElement;
  request: ReturnType<typeof createApiClient>;
  navigate: ReturnType<typeof createNavigation>["navigate"];
  isCurrent(): boolean;
  onExpired(): void;
  /** While `writing()`: `held` says why the page stayed; `released` runs when leaving goes ahead. */
  holdWhileWriting(hold: { writing(): boolean; held(): void; released?(): void }): void;
}

// The API's Name rule, mirrored because the console loads no contracts code: PLAIN_TEXT_PATTERN
// and NAME_MAX_CHARACTERS in packages/contracts/src/api/plain-text.ts, counted in characters
// (code points) as Ajv counts maxLength. tests/conformance/console-namespace-name.test.ts keeps
// the two equal.
// eslint-disable-next-line no-control-regex -- the rule refuses control characters by range.
export const NAME_PATTERN = /^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
export const NAME_MAX_CHARACTERS = 200;
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Why the API would refuse `value` as a Namespace name once trimmed (the console sends it
 * trimmed), or "" when it would accept it. An empty name is the required check's to report.
 */
export function namespaceNameProblem(value: string) {
  const name = value.trim();
  if (name === "") {
    return "";
  }
  if (Array.from(name).length > NAME_MAX_CHARACTERS) {
    return `Use at most ${NAME_MAX_CHARACTERS} characters.`;
  }
  if (!NAME_PATTERN.test(name) || LONE_SURROGATE.test(name)) {
    return "Remove tabs, line breaks and other control characters from the name.";
  }
  return "";
}

// The session owner whose Namespace creation the API refused (403) since this page loaded. The
// API has no advisory Installation permission answer, so a refusal is the only exact sign that
// creation is not allowed (finding 2059). The page's Refresh, or a browser reload, offers
// creation again: after an administrator grants access, nothing else would (finding 2083).
let createRefusedFor: string | null = null;

export function renderNamespaces(
  context: NamespacePageContext & {
    operatorId: string;
    installationAdmin: boolean | null;
    fromRefresh: boolean;
    searchQuery: string;
    reload(): Promise<void>;
    pageUrl: ReturnType<typeof createNavigation>["pageUrl"];
    sorted(items: readonly Namespace[]): Namespace[];
    onRemoved(namespace: Namespace): void;
    onResume?(handler: () => void): void;
  },
  items: readonly Namespace[],
) {
  if (context.fromRefresh) {
    createRefusedFor = null;
  }
  const collection = element("div");
  const outcome = element("div", { className: "namespace-deletion-outcome", tabindex: "-1" });
  const refused = createRefusedFor !== null && createRefusedFor === context.operatorId;
  // A person who does not administer the Installation may still hold a Namespace create grant,
  // so Create Namespace stays available to them, but not as the page's filled primary action or
  // the empty list's invitation (finding 2059). An unknown answer keeps both.
  const administrator = context.installationAdmin !== false;
  const create = button("Create Namespace", openCreate, {
    ...(administrator && !refused ? { tone: "primary" } : {}),
    "data-create-namespace": "",
  });
  const createDenied = namespaceCreateDenied(context.installationAdmin);
  const refusal = element(
    "p",
    { className: "muted", id: "namespace-create-refused" },
    `${createDenied} Then select Refresh.`,
  );
  const emptyText = element("p");
  const empty = element(
    "section",
    { className: "state-panel" },
    element("h2", {}, NO_READABLE_NAMESPACES),
    emptyText,
  );
  // The API refused this person's creation: the control says so instead of offering another
  // attempt that it would refuse again. It stays in the Tab order, described by the refusal (class
  // of finding 2899).
  function showRefused() {
    create.classList.remove("button", "button--primary");
    collection.before(refusal);
    setUnavailable(create, true, refusal);
    if (context.installationAdmin !== false) {
      emptyText.textContent = "No Namespaces are available to view.";
    }
  }
  // Only a known administrator gets the short invitation: a caller whose answer is unknown may
  // be a member, who gets access from an Installation administrator (finding 2583).
  emptyText.textContent =
    context.installationAdmin === true
      ? "Create a Namespace to get started."
      : context.installationAdmin === false
        ? `No Namespaces are shared with you. ${askAdministratorTo("give you access to one")}`
        : `Create a Namespace if your access allows it, or ${ASK_INSTALLATION_ADMINISTRATOR} to give you access to one.`;
  context.view.replaceChildren(
    element(
      "div",
      { className: "namespace-toolbar" },
      element(
        "p",
        { className: "muted" },
        "Separate teams and workloads with their own Agents, Secrets, and access rules.",
      ),
      create,
    ),
    outcome,
    collection,
  );
  if (items.length) {
    const search = element("input", {
      id: "namespace-search",
      type: "search",
      "aria-label": "Search Namespaces",
      "data-refocus-key": "namespace-search",
      placeholder: "Search Namespaces by name or ID",
    });
    search.value = context.searchQuery;
    const clear = button(
      "Clear search",
      () => {
        search.value = "";
        search.focus();
        updateMatches();
      },
      { tone: "ghost", "data-refocus-key": "namespace-clear-search" },
    );
    const searchToolbar = element(
      "div",
      { className: "collection-toolbar namespace-search" },
      search,
      clear,
    );
    const list = element("ul", { className: "collection", "aria-label": "Namespaces" });
    const table = element(
      "div",
      { className: "resource-list namespace-table" },
      element(
        "div",
        { className: "resource-list-header namespace-table-head", "aria-hidden": "true" },
        ...["Namespace", "Status", "Created", "Actions"].map((label) => element("span", {}, label)),
      ),
      list,
    );
    const noMatch = element(
      "section",
      { className: "state-panel" },
      element("h2", {}, "No matching Namespaces"),
      element("p", {}, "Try another name or ID."),
    );
    const rows = new Map<Namespace, HTMLLIElement>();

    // Keep each row mounted so filtering preserves its deletion status and feedback.
    function updateMatches() {
      const query = search.value.trim().toLowerCase();
      let matched = false;
      for (const [item, row] of rows) {
        row.hidden =
          !item.id.toLowerCase().includes(query) && !item.name?.toLowerCase().includes(query);
        matched ||= !row.hidden;
      }
      searchToolbar.hidden = rows.size === 0;
      clear.hidden = !search.value;
      table.hidden = !matched;
      noMatch.hidden = matched || rows.size === 0;
      empty.hidden = rows.size > 0;
    }

    for (const item of context.sorted(items)) {
      const statuses = {
        ready: { label: "Ready", tone: "success" },
        provisioning: { label: "Provisioning", tone: "warning" },
        deleting: { label: "Deleting…", tone: "warning" },
        failed: { label: "Failed", tone: "danger" },
      };
      const badge = element("span", { className: "badge" });
      const setStatus = (status: Namespace["status"] | undefined) => {
        const presentation =
          status === undefined ? { label: "Status unknown", tone: "warning" } : statuses[status];
        if (badge.textContent !== presentation.label) {
          badge.textContent = presentation.label;
        }
        if (badge.dataset.tone !== presentation.tone) {
          badge.dataset.tone = presentation.tone;
        }
      };
      setStatus(item.status);
      const name = element("a", { href: context.pageUrl("agents", item.id) }, item.name ?? item.id);
      name.dataset.returnFocusHref = name.href;
      name.dataset.refocusKey = `${item.id} namespace-name`;
      name.addEventListener("click", (event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        context.navigate("agents", item.id);
      });
      const row = element("li", { className: "resource-linked namespace-row" });
      const deletion = createNamespaceDeletion(
        {
          ...context,
          statusChanged: setStatus,
          onRemoved(namespace, refocus) {
            // The check Refresh requested disabled it while it read, which dropped focus to the
            // page; focus left there goes to the outcome too.
            const active = document.activeElement;
            const focused =
              row.contains(active) ||
              (rows.size === 1 && searchToolbar.contains(active)) ||
              (refocus && (!active || active === document.body));
            row.remove();
            rows.delete(item);
            updateMatches();
            context.onRemoved(namespace);
            outcome.replaceChildren(
              statusBlock(
                "success",
                null,
                `${namespace.name ?? namespace.id} was deleted. Its name remains reserved.`,
              ),
            );
            if (focused) {
              outcome.focus();
            }
          },
        },
        item,
      );
      row.append(
        element(
          "div",
          { className: "namespace-cell-name" },
          element("p", { className: "resource-name" }, name),
          element("span", { className: "resource-id" }, item.id),
        ),
        element("span", { className: "namespace-cell-status" }, badge),
        element(
          "span",
          { className: "namespace-cell-created" },
          element("span", { className: "namespace-cell-label" }, "Created "),
          item.createdAt ? displayDate(item.createdAt) : "Unknown",
        ),
        deletion.actions,
        deletion.feedback,
      );
      rows.set(item, row);
      list.append(row);
    }
    search.addEventListener("input", updateMatches);
    collection.append(searchToolbar, table, noMatch, empty);
    updateMatches();
  } else {
    collection.append(empty);
  }
  if (refused) {
    showRefused();
  }

  function openCreate() {
    const dialog = element("dialog", {
      className: "dialog",
      "aria-labelledby": "create-namespace-title",
      "aria-describedby": "create-namespace-description",
    });
    const title = element("h2", { id: "create-namespace-title" }, "Create Namespace");
    const description = element(
      "p",
      { id: "create-namespace-description", className: "muted" },
      "A Namespace keeps a team's Agents and resources together, with its own access rules.",
    );
    // No maxlength: it counts UTF-16 code units and silently cuts a longer paste, which would
    // then be saved under the cut name. namespaceNameProblem refuses it instead (finding 2046).
    const name = element("input", {
      id: "namespace-name",
      type: "text",
      required: "",
      "data-trim": "",
      autocomplete: "off",
      placeholder: "e.g. Support",
    });
    // The name is refused at the field, as the API would refuse it, as soon as it is typed or
    // pasted (validateFields reports the custom validity). Any edit also clears a server
    // refusal shown on it.
    const checkName = () => name.setCustomValidity(namespaceNameProblem(name.value));
    name.addEventListener("input", () => {
      checkName();
      // An error already shown is rechecked too, so clearing the name swaps it for "required".
      if (name.validity.customError || name.hasAttribute("aria-invalid")) {
        validateFields([name]);
      }
    });
    const feedback = element("div");
    const cancel = button("Cancel", close);
    const submit = element(
      "button",
      { type: "submit", className: "button button--primary" },
      "Create Namespace",
    );
    const form = element(
      "form",
      { novalidate: "" },
      field({
        label: "Namespace name",
        control: name,
        help: "Unique within this Installation. Names cannot currently be changed.",
      }),
      feedback,
      element("div", { className: "dialog-actions" }, cancel, submit),
    );
    let pending = false;
    let unknown = false;
    let forbidden = false;
    let created = false;

    function close() {
      if (pending) {
        return;
      }
      dialog.close();
      if (forbidden) {
        // Announced once, as the answer to this attempt; a later render shows it as page text.
        refusal.setAttribute("role", "status");
        showRefused();
        // The opener the dialog returned focus to is unavailable now; focus the reason instead.
        refusal.tabIndex = -1;
        refusal.focus();
        return;
      }
      if (created || unknown) {
        // The reload replaces the Create Namespace button the dialog returned focus to; focus
        // its replacement, unless the reader has moved focus elsewhere (finding 2045).
        void context.reload().then(() => {
          const active = document.activeElement;
          if (!active || active === document.body || !active.isConnected) {
            document.querySelector<HTMLElement>("[data-create-namespace]")?.focus();
          }
        });
      }
    }

    context.holdWhileWriting({
      writing: () => pending,
      held: () =>
        feedback.replaceChildren(
          statusBlock("info", null, "Wait for Namespace creation to finish before leaving."),
        ),
    });

    function confirmCreation(id: string, createdName: string) {
      title.textContent = "Namespace created";
      description.textContent = `${createdName} has been created.`;
      const access = statusBlock(
        "info",
        null,
        "Checking whether you can view this Namespace…",
        [],
        {
          id: "create-namespace-access",
        },
      );
      dialog.setAttribute(
        "aria-describedby",
        "create-namespace-description create-namespace-access",
      );
      const done = button("Done", close, { "aria-describedby": access.id });
      const retry = button("Check access again", () => void checkAccess(false), {
        tone: "primary",
        "aria-describedby": access.id,
      });
      const actions = element("div", { className: "dialog-actions" }, done);
      dialog.replaceChildren(title, description, access, actions);
      done.focus();
      void checkAccess(true);

      async function checkAccess(initial: boolean) {
        access.textContent = "Checking whether you can view this Namespace…";
        setUnavailable(retry, true, access);
        const result = await context.request("/namespaces", { expectedStatus: 200 }).then(
          (listed) => {
            if (
              !Array.isArray(listed) ||
              !listed.every((item: unknown) => typeof responseFields(item).id === "string")
            ) {
              return "unconfirmed";
            }
            return listed.some((item: unknown) => responseFields(item).id === id)
              ? "readable"
              : "omitted";
          },
          (cause: unknown) => {
            const { status } = requestFailure(cause);
            if (status === 401) {
              return "expired";
            }
            return status === 403 ? "denied" : "unconfirmed";
          },
        );
        if (!dialog.open || !dialog.isConnected || !context.isCurrent()) {
          return;
        }
        if (result === "expired") {
          context.onExpired();
          return;
        }
        const keepDoneFocus = !initial && document.activeElement === done;
        if (result === "readable") {
          access.remove();
          dialog.setAttribute("aria-describedby", description.id);
          done.removeAttribute("aria-describedby");
          const openAgents = button(
            "Open Agents",
            () => {
              dialog.close();
              context.navigate("agents", id);
            },
            { tone: "primary" },
          );
          actions.replaceChildren(done, openAgents);
          (keepDoneFocus ? done : openAgents).focus();
        } else if (result === "denied" || result === "omitted") {
          if (result === "denied") {
            const guidance =
              context.installationAdmin === true
                ? "Check whether an IAM Restriction applies."
                : askAdministratorTo("check your access");
            access.textContent = `Access to the Namespaces list was denied. ${guidance}`;
          } else {
            const guidance =
              context.installationAdmin === true
                ? "Check its status and access."
                : askAdministratorTo("check its status and your access");
            access.textContent = `This Namespace is unavailable to view. ${guidance}`;
          }
          done.classList.add("button", "button--primary");
          actions.replaceChildren(done);
          done.focus();
        } else {
          access.textContent = "Access could not be confirmed.";
          setUnavailable(retry, false, null);
          if (!retry.isConnected) {
            actions.append(retry);
          }
          (keepDoneFocus ? done : retry).focus();
        }
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || created || unknown || forbidden || !validateFields([name])) {
        return;
      }
      pending = true;
      form.setAttribute("aria-busy", "true");
      name.disabled = true;
      cancel.disabled = true;
      submit.disabled = true;
      submit.textContent = "Creating…";
      feedback.replaceChildren();
      try {
        const result = await context.request("/namespaces", {
          method: "POST",
          body: { name: name.value.trim() },
          expectedStatus: 201,
        });
        if (!context.isCurrent()) {
          return;
        }
        const { id, name: createdName, status } = responseFields(result);
        if (
          typeof id !== "string" ||
          typeof createdName !== "string" ||
          status !== "provisioning"
        ) {
          throw new Error("Invalid Namespace creation response");
        }
        created = true;
        confirmCreation(id, createdName);
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        const error = requestFailure(cause);
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        forbidden = error.status === 403;
        if (forbidden) {
          createRefusedFor = context.operatorId;
        }
        unknown = error.status === undefined || ![400, 403, 404, 409, 429].includes(error.status);
        let message;
        if (unknown) {
          message =
            "Outcome unknown. Namespace creation could not be confirmed. Check Namespaces for this name before trying again.";
        } else if (forbidden) {
          message = createDenied;
        } else if (error.status === 409 && explainedConflict(cause) === undefined) {
          message =
            "This Namespace name is already in use or reserved by a deleted Namespace. Choose a different name.";
        } else if (error.status === 409 || error.status === 429) {
          // A typed conflict names the rule, such as adopting a namespace without the bundled
          // Kubernetes Compute Driver.
          message = describeFailure(cause, { mutation: true, form: true });
        } else {
          // A 400 carries the API's own sentence naming what it refused, which other console
          // writes show too (rejectionMessage in agents/list.mts).
          message =
            (error.status === 400 && error.serverMessage) ||
            "Namespace creation was refused. Check the name and try again.";
        }
        // A request ID helps support trace an unexpected failure, and an administrator a denial.
        // A refusal the reader can fix here, a taken name above all, does not need one (finding
        // 2102).
        const requestId =
          (unknown || forbidden) && error.requestId ? [requestIdLine(error.requestId)] : [];
        let refusal: HTMLElement | null = null;
        if (error.status === 400) {
          // The name is the only field: mark it invalid with the refusal linked to it, until
          // it is edited (finding 2046).
          feedback.replaceChildren(...requestId);
          name.setCustomValidity(message);
        } else {
          refusal = statusBlock("danger", null, message, [], { id: "create-namespace-refusal" });
          feedback.replaceChildren(refusal, ...requestId);
        }
        // A refused or unconfirmed creation leaves the name and Create Namespace in the Tab
        // order, described by the alert that says why (finding 2935); focus moves to Cancel.
        for (const control of [name, submit]) {
          setUnavailable(control, unknown || forbidden, refusal);
        }
        submit.textContent = "Create Namespace";
        cancel.disabled = false;
        cancel.textContent = unknown ? "Check Namespaces" : "Cancel";
        if (error.status === 400) {
          validateFields([name]);
        } else {
          (unknown || forbidden ? cancel : name).focus();
        }
      } finally {
        pending = false;
        form.removeAttribute("aria-busy");
      }
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dismissOnBackdrop(dialog);
    dialog.append(title, description, form);
    context.view.append(dialog);
    dialog.showModal();
    name.focus();
  }
}
