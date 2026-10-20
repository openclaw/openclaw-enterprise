import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element } from "../dom.mjs";
import type { ConsolePageContext } from "../page-context.mjs";

type Bookmark = { url: string | null; version: number };

// This is a link, never an ingress configuration or a URL the controller should fetch.
function validUrl(value: string) {
  if (
    value.length > 2048 ||
    /[\\?#]/u.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || (code >= 127 && code <= 159);
    }) ||
    !value.startsWith("https://")
  ) {
    return false;
  }
  const authority = value.slice("https://".length).split("/")[0] ?? "";
  if (!authority || authority.includes("@") || authority.includes("%")) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !value.includes("?") &&
      !value.includes("#")
    );
  } catch {
    return false;
  }
}

function bookmark(value: unknown): Bookmark {
  const { url, version } = responseFields(value);
  if (
    (url !== null && (typeof url !== "string" || !validUrl(url))) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    throw new Error("Invalid Control UI bookmark");
  }
  return { url, version };
}

export function renderControlUiBookmark(
  context: Pick<ConsolePageContext, "request" | "isCurrent">,
  path: string,
  updateAllowed: () => Promise<boolean | undefined>,
  isActive: () => boolean,
) {
  const endpoint = path + "/control-ui-bookmark";
  let current: Bookmark | undefined;
  let editing = false;
  let editVersion = 0;
  let allowed = false;
  let reading = false;
  let refreshPending = false;
  let saving = false;
  let recovery: "conflict" | "uncertain" | null = null;
  const saved = element("div", { className: "control-ui-bookmark-saved" });
  const openEditor = button("Add direct URL", beginEdit, { tone: "link" });
  const input = element("input", {
    id: "control-ui-bookmark-url",
    type: "url",
    maxLength: 2048,
    placeholder: "https://control.example.com/agent",
    autocomplete: "off",
    "aria-describedby": "control-ui-bookmark-help control-ui-bookmark-error",
  });
  const save = button("Save", () => {}, { tone: "primary" });
  save.type = "submit";
  const cancel = button("Cancel", cancelEdit);
  const remove = button("Remove", () => void write(null), { tone: "danger" });
  const refresh = button("Refresh bookmark", () => void read("explicit"), { tone: "link" });
  const status = element("p", { className: "hint", role: "status" });
  const error = element("p", {
    id: "control-ui-bookmark-error",
    className: "error",
    role: "alert",
  });
  const form = element(
    "form",
    { className: "control-ui-bookmark-form", hidden: true, noValidate: true },
    element(
      "div",
      { className: "form-field" },
      element("label", { for: input.id }, "Direct Control UI URL"),
      input,
    ),
    element("div", { className: "form-actions" }, save, cancel, remove),
  );
  const section = element(
    "div",
    { className: "control-ui-bookmark" },
    saved,
    element(
      "p",
      { id: "control-ui-bookmark-help", className: "hint" },
      "Shared bookmark only; it does not grant access. An operator must configure authenticated ingress separately. OCC does not configure or verify ingress or authentication.",
    ),
    form,
    status,
    error,
    refresh,
  );

  function render() {
    saved.replaceChildren();
    if (current?.url) {
      saved.append(
        element(
          "a",
          {
            href: current.url,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "control-ui-bookmark-link",
          },
          "Open direct Control UI",
        ),
        element("span", { className: "hint control-ui-bookmark-url" }, current.url),
      );
    } else if (current) {
      saved.append(element("span", { className: "hint" }, "No direct URL saved."));
    }
    saved.append(openEditor);
    openEditor.textContent = current?.url ? "Edit link" : "Add direct URL";
    openEditor.hidden = !allowed || !current || editing;
    form.hidden = !editing || !allowed;
    input.disabled = saving;
    save.disabled = saving || reading || recovery !== null || !allowed;
    cancel.disabled = saving;
    remove.hidden = !current?.url;
    remove.disabled = saving || reading || recovery !== null || !allowed;
    refresh.hidden = !error.textContent && recovery === null;
    refresh.disabled = saving || reading;
  }

  function beginEdit() {
    if (!current || !allowed) {
      return;
    }
    editing = true;
    editVersion = current.version;
    input.value = current.url ?? "";
    input.removeAttribute("aria-invalid");
    error.textContent = "";
    status.textContent = "";
    render();
    input.focus();
  }
  function cancelEdit() {
    const refreshNeeded = recovery !== null;
    editing = false;
    recovery = null;
    error.textContent = "";
    status.textContent = "";
    render();
    openEditor.focus();
    if (refreshNeeded) {
      void read("explicit");
    }
  }
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validUrl(input.value)) {
      input.setAttribute("aria-invalid", "true");
      error.textContent =
        "Use an HTTPS URL without credentials, a query, a fragment, or whitespace (maximum 2,048 characters).";
      render();
      input.focus();
      return;
    }
    void write(input.value);
  });

  async function read(reason: "automatic" | "explicit" | "reconcile") {
    if (!context.isCurrent() || !isActive() || reading || saving) {
      return;
    }
    // Do not silently advance an edit's version or erase a conflict on refocus.
    if (editing && reason === "automatic") {
      return;
    }
    reading = true;
    status.textContent = "Loading direct URL…";
    render();
    try {
      const value = bookmark(await context.request(endpoint, { revalidate: false }));
      if (!context.isCurrent()) {
        return;
      }
      current = value;
      if (editing) {
        editVersion = value.version;
      }
      recovery = null;
      error.textContent = "";
      status.textContent = "";
      if (editing) {
        status.textContent =
          reason === "reconcile"
            ? "The save response was uncertain. Current bookmark refreshed without retrying the change. Your input is preserved; review it before saving again."
            : "Current bookmark refreshed. Your input is preserved; review it before saving again.";
      }
    } catch (cause) {
      if (context.isCurrent()) {
        status.textContent = "";
        if (requestFailure(cause).status === 403) {
          current = undefined;
          allowed = false;
        }
        error.textContent =
          requestFailure(cause).status === 403
            ? "You do not have permission to read the direct URL."
            : "Couldn’t load the direct URL. Refresh the bookmark to try again.";
      }
    } finally {
      reading = false;
      render();
      const refreshAgain = refreshPending;
      refreshPending = false;
      if (refreshAgain && context.isCurrent() && isActive()) {
        void read("automatic");
      }
    }
  }

  async function write(url: string | null) {
    if (!allowed || saving || reading || recovery !== null || !editing) {
      return;
    }
    saving = true;
    error.textContent = "";
    status.textContent = url === null ? "Removing direct URL…" : "Saving direct URL…";
    render();
    try {
      const value = bookmark(
        await context.request(endpoint, {
          method: "PUT",
          body: { url, expectedVersion: editVersion },
        }),
      );
      current = value;
      editing = false;
      recovery = null;
      status.textContent = url === null ? "Direct URL removed." : "Direct URL saved.";
    } catch (cause) {
      const { status: code } = requestFailure(cause);
      status.textContent = "";
      if (code === 409) {
        recovery = "conflict";
        error.textContent =
          "This bookmark changed elsewhere. Refresh the bookmark, then review and save your changes. Your input is preserved.";
      } else if (code === undefined || code >= 500) {
        recovery = "uncertain";
        error.textContent =
          "Couldn’t confirm whether the change was saved. Refresh the bookmark before trying again; your input is preserved.";
      } else {
        error.textContent =
          code === 403
            ? "You do not have permission to update this bookmark."
            : "Couldn’t save the direct URL. Check the URL and try again.";
        if (code === 403) {
          allowed = false;
        }
      }
    } finally {
      saving = false;
      render();
      if (!editing && allowed && context.isCurrent() && isActive()) {
        openEditor.focus();
      }
    }
    if (recovery === "uncertain" && context.isCurrent() && isActive()) {
      await read("reconcile");
    }
  }

  return {
    section,
    async refresh() {
      if (!context.isCurrent() || !isActive()) {
        return;
      }
      // Agent update gates editing only. A readable bookmark does not wait for config,
      // native administration, the live people adapter, or even the permission summary.
      void updateAllowed().then((value) => {
        allowed = value === true;
        render();
      });
      if (reading) {
        refreshPending = true;
        return;
      }
      await read(recovery === "uncertain" ? "reconcile" : "automatic");
    },
  };
}
