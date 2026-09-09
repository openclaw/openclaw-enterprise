import { element, button } from "../dom.mjs";

const filenames = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];

function fileError(error, writing) {
  let text = "Workspace access is unavailable. Check the Agent gateway and try reloading.";
  if (error.status === 403)
    text = "Access denied. You do not have permission for this file operation.";
  if (error.status === 404)
    text = "File unavailable or missing. Check Agent access before creating it.";
  if (error.status === 400 || error.status === 413)
    text =
      "The file was rejected. Use valid Unicode without NUL characters, within 16 KiB of UTF-8 content.";
  if (writing && ![400, 403, 404, 409, 413, 429].includes(error.status))
    text =
      "Outcome unknown. Your write may have succeeded. Reload this file and review its current contents before saving again.";
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

export function renderWorkspaceFiles(context, agent, path) {
  const section = element(
    "section",
    { className: "workspace-files" },
    element("h2", {}, "Workspace files"),
  );
  section.append(
    element(
      "p",
      { className: "notice" },
      "These files belong to the Agent's live workspace. Saving replaces one file immediately and does not change Configuration or AgentRevisions. Concurrent writes use the last saved contents.",
    ),
  );
  if (!agent.activeRevisionId) {
    section.append(
      element(
        "p",
        { className: "muted", role: "status" },
        "Workspace files require a deployed Agent with an active revision and a reachable gateway.",
      ),
    );
    return section;
  }
  for (const name of filenames) {
    const endpoint = `${path}/workspace/files/${encodeURIComponent(name)}`;
    const editor = element("textarea", {
      id: `workspace-${name}`,
      rows: "10",
      spellcheck: "false",
      className: "configuration-editor",
      disabled: true,
      "aria-describedby": `workspace-${name}-hint`,
    });
    const status = element("p", { className: "hint", role: "status" }, `Loading ${name}…`);
    const error = element("p", { className: "error", role: "alert" });
    let pending = false;
    let loaded = false;
    let baseline;
    let outcomeUnknown = false;
    const save = element(
      "button",
      { type: "submit", className: "primary", disabled: true },
      `Save ${name}`,
    );
    const reload = button(`Reload ${name}`, () => void load());
    const form = element(
      "form",
      { className: "agent-card agent-form" },
      element(
        "div",
        { className: "form-field" },
        element("label", { for: editor.id }, name),
        editor,
        element(
          "p",
          { id: `workspace-${name}-hint`, className: "hint" },
          "Up to 16 KiB of UTF-8 text. Reload replaces your unsaved edits with the current file.",
        ),
      ),
      status,
      error,
      element("div", { className: "form-actions" }, reload, save),
    );
    const updateControls = () => {
      editor.disabled = pending || !loaded;
      reload.disabled = pending;
      save.disabled = pending || !loaded || outcomeUnknown || editor.value === baseline;
    };
    editor.addEventListener("input", () => {
      editor.setCustomValidity("");
      updateControls();
    });
    async function load() {
      if (pending || !context.isCurrent()) return;
      pending = true;
      updateControls();
      error.textContent = "";
      status.textContent = `Loading ${name}…`;
      try {
        const file = await context.request(endpoint);
        if (!context.isCurrent()) return;
        editor.value = file.content;
        baseline = file.content;
        editor.setCustomValidity("");
        loaded = true;
        outcomeUnknown = false;
        status.textContent = `${name} loaded.`;
      } catch (cause) {
        if (!context.isCurrent()) return;
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        // A missing file can be created through PUT. Other read failures never enable a blank overwrite.
        if (cause.status === 404 && !outcomeUnknown) {
          editor.value = "";
          baseline = undefined;
          editor.setCustomValidity("");
          loaded = true;
        } else loaded = false;
        status.textContent = "";
        error.textContent = fileError(cause, false);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateControls();
        }
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || !loaded || outcomeUnknown || !context.isCurrent() || editor.value === baseline)
        return;
      const content = editor.value;
      if (
        content.includes("\0") ||
        !content.isWellFormed() ||
        new TextEncoder().encode(content).length > 16384
      ) {
        editor.setCustomValidity(
          "Use valid Unicode without NUL characters, within 16 KiB of UTF-8 content.",
        );
        editor.reportValidity();
        return;
      }
      pending = true;
      updateControls();
      error.textContent = "";
      status.textContent = `Saving ${name}…`;
      try {
        await context.request(endpoint, { method: "PUT", body: { content } });
        if (!context.isCurrent()) return;
        baseline = content;
        status.textContent = `${name} saved.`;
      } catch (cause) {
        if (!context.isCurrent()) return;
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        outcomeUnknown = ![400, 403, 404, 409, 413, 429].includes(cause.status);
        status.textContent = "";
        error.textContent = fileError(cause, true);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateControls();
        }
      }
    });
    section.append(form);
    void load();
  }
  return section;
}
