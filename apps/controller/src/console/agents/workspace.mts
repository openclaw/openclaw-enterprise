import type { AgentRead } from "@openclaw-enterprise/contracts";
import {
  type createApiClient,
  namedDenial,
  requestFailure,
  responseFields,
} from "../api-client.mjs";
import {
  element,
  button,
  setFieldError,
  statusBlock,
  validateFields,
  withRequestId,
} from "../dom.mjs";
import type { createDraftStore } from "../drafts.mjs";
import {
  WORKSPACE_READ_DENIED,
  WORKSPACE_SAVE_DENIED,
  WORKSPACE_SAVE_REFUSED,
} from "./access-reasons.mjs";
import { describeFailure } from "./list.mjs";

const filenames = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
// Shown when the caller's permission answer denies Agent operate, which saving a file needs.
const OPERATE_DENIED = WORKSPACE_SAVE_DENIED;

interface WorkspaceContext {
  request: ReturnType<typeof createApiClient>;
  drafts: ReturnType<ReturnType<typeof createDraftStore>["scope"]>;
  isCurrent(): boolean;
  onExpired(): void;
}

interface WorkspaceDraft {
  text: string;
  baseline: string | undefined;
  outcomeUnknown: boolean;
}

type FileFailure = ReturnType<typeof requestFailure>;

// The API's workspace file rule (normalizeInitialWorkspaceFiles in
// packages/contracts/src/workspace-setup.ts and the workspace file write route): valid Unicode,
// no NUL, at most 16 KiB of UTF-8.
const WORKSPACE_FILE_MAX_BYTES = 16384;

/**
 * Why the API would refuse `content` for the workspace file `name`, naming the file and only the
 * rule it breaks, or "" when it would accept it. The Workspace tab and Create Agent's initial
 * workspace files share it (findings 2341, 2366).
 */
export function workspaceFileProblem(name: string, content: string) {
  if (content.includes("\0") || !content.isWellFormed()) {
    return `Use valid Unicode without NUL characters in ${name}.`;
  }
  if (new TextEncoder().encode(content).length > WORKSPACE_FILE_MAX_BYTES) {
    return `Use at most 16 KiB (16,384 UTF-8 bytes) in ${name}.`;
  }
  return "";
}

const WORKSPACE_GATEWAY_UNAVAILABLE =
  "Workspace files could not be reached: the Agent's gateway did not answer. Check that the Agent is running, then reload this file. If it continues, ask an operator to check the gateway.";
const WORKSPACE_API_UNREACHABLE =
  "The request did not reach the API. Check your connection, then reload this file.";

function fileError(error: FileFailure, writing: boolean, failure: unknown) {
  // A failure without its own text below says why by status (finding 2538): a rate limit how
  // long to wait, a conflict the API's reason, a request that never reached the API that, and
  // anything else that the gateway did not answer.
  const { name } = responseFields(failure);
  let text =
    error.status === 409 || error.status === 429
      ? describeFailure(error)
      : error.status === undefined && (name === "TypeError" || name === "TimeoutError")
        ? WORKSPACE_API_UNREACHABLE
        : WORKSPACE_GATEWAY_UNAVAILABLE;
  if (error.status === 403) {
    // Saving a file is an Agent operate action (finding 1540); reading one is Agent read, unless
    // the API names another grant.
    text = writing ? WORKSPACE_SAVE_REFUSED : (namedDenial(error) ?? WORKSPACE_READ_DENIED);
  }
  if (error.status === 404) {
    text = "File unavailable or missing. Check Agent access before creating it.";
  }
  if (error.status === 400 || error.status === 413) {
    text =
      "The file was rejected. Use valid Unicode without NUL characters, within 16 KiB of UTF-8 content.";
  }
  if (writing && writeOutcomeUnknown(error.status)) {
    text =
      "Outcome unknown. Your write may have succeeded. Reload this file and review its current contents before saving again.";
  }
  return withRequestId(text, error.requestId);
}

// Only this answer confirms the file itself is absent. A resource or scope 404 does not establish
// the native file's current state.
function confirmsMissingFile(error: FileFailure) {
  return (
    error.status === 404 &&
    error.code === "NOT_FOUND" &&
    error.serverMessage === "The requested workspace file was not found."
  );
}

function writeOutcomeUnknown(status: number | undefined) {
  return status === undefined || ![400, 403, 404, 409, 413, 429].includes(status);
}

// Returns the section and `refresh`, which rereads the files in place after another version
// becomes current. `operateAllowed` is the caller's Agent operate answer: when it is false, every
// Save is marked unavailable with the reason before the reader edits anything (finding 521). A
// missing answer leaves Save on its usual path; the API still refuses the write.
export function renderWorkspaceFiles(
  context: WorkspaceContext,
  agent: Pick<AgentRead, "activeRevisionId">,
  path: string,
  operateAllowed?: Promise<boolean | undefined> | null,
) {
  const refreshers: Array<() => Promise<void>> = [];
  const denials: Array<() => void> = [];
  const restorations: Array<() => void> = [];
  let operateDenied = false;
  const section = element(
    "section",
    { className: "workspace-files" },
    element("h2", {}, "Workspace files"),
  );
  section.append(
    statusBlock(
      "info",
      null,
      "These files belong to the Agent's live workspace. Saving replaces one file immediately and does not change Configuration or Agent versions. Concurrent writes use the last saved contents.",
      [],
      { role: null },
    ),
  );
  const operateNote = element("p", {
    id: "workspace-operate-denied",
    className: "muted",
    role: "status",
    hidden: true,
  });
  section.append(operateNote);
  if (!agent.activeRevisionId) {
    section.append(
      element(
        "p",
        { className: "muted", role: "status" },
        "Workspace files require a deployed Agent with a current version and a reachable gateway. Deploy the Agent to read or edit them.",
      ),
    );
    return { section, refresh: () => {} };
  }
  for (const name of filenames) {
    const draftKey = `workspace:${name}`;
    const retained = context.drafts.get(draftKey) as WorkspaceDraft | undefined;
    const endpoint = `${path}/workspace/files/${encodeURIComponent(name)}`;
    async function readFile(): Promise<string> {
      const file = responseFields(await context.request(endpoint, { expectedStatus: 200 }));
      if (file.name !== name || typeof file.content !== "string") {
        throw new Error("Workspace response did not identify the requested file");
      }
      return file.content;
    }

    const editor = element("textarea", {
      id: `workspace-${name}`,
      rows: "10",
      spellcheck: "false",
      className: "configuration-editor",
      disabled: true,
      "aria-describedby": `workspace-${name}-hint`,
    });
    const status = element("p", { className: "hint", role: "status" }, `Loading ${name}…`);
    const errorNotice = statusBlock("danger", null, null);
    let pending = false;
    let loaded = false;
    let baseline: string | undefined;
    let outcomeUnknown = retained?.outcomeUnknown ?? false;
    let writing = false;
    let initialized = false;
    // Counts reads and saves, so an in-place reread never overwrites a later answer.
    let operations = 0;
    let refreshAfterPending = false;
    // Set while the status says a reread failed, so a later good reread clears it (finding 1878).
    let rereadFailed = false;
    context.drafts.track(draftKey, (): WorkspaceDraft | undefined => {
      if (!loaded && !initialized) {
        return retained;
      }
      return writing || outcomeUnknown || editor.value !== (baseline ?? "")
        ? { text: editor.value, baseline, outcomeUnknown: outcomeUnknown || writing }
        : undefined;
    });
    const save = element(
      "button",
      { type: "submit", className: "button button--primary", disabled: true },
      `Save ${name}`,
    );
    const reload = button(`Reload ${name}`, () => void load(true));
    const missingCreate = `${name} is missing. Save to create it.`;
    const missingText = () => (operateDenied ? `${name} is missing.` : missingCreate);
    const form = element(
      "form",
      { className: "agent-card agent-form", novalidate: "" },
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
      errorNotice,
      element("div", { className: "form-actions" }, reload, save),
    );
    const updateControls = () => {
      editor.disabled = pending || !loaded;
      // The file stays readable and selectable, but an edit no Save can keep is not offered.
      editor.readOnly = operateDenied;
      reload.disabled = pending;
      // aria-disabled, not disabled: Save stays in the Tab order and its description names the
      // grant it needs. The submit handler ignores it.
      save.disabled =
        !operateDenied && (pending || !loaded || outcomeUnknown || editor.value === baseline);
      if (operateDenied) {
        save.setAttribute("aria-disabled", "true");
        save.setAttribute("aria-describedby", operateNote.id);
      } else {
        save.removeAttribute("aria-disabled");
        save.removeAttribute("aria-describedby");
      }
    };
    const missingDenied = `${name} is missing.`;
    denials.push(() => {
      if (status.textContent === missingCreate) {
        status.textContent = missingDenied;
      }
      updateControls();
    });
    restorations.push(() => {
      if (status.textContent === missingDenied) {
        status.textContent = missingCreate;
      }
      updateControls();
    });
    editor.addEventListener("input", () => {
      editor.setCustomValidity("");
      updateControls();
    });
    // Save and Reload are disabled while their request runs, which drops focus to the page.
    // Focus that was in this file's form goes back to `target` when the request settles
    // (finding 2366).
    const returnFocus = (held: boolean, target: HTMLElement) => {
      if (held && context.isCurrent() && document.activeElement === document.body) {
        target.focus();
      }
    };
    async function load(discard = false) {
      if (pending || !context.isCurrent()) {
        return;
      }
      const held = form.contains(document.activeElement);
      operations += 1;
      pending = true;
      rereadFailed = false;
      updateControls();
      errorNotice.textContent = "";
      status.textContent = `Loading ${name}…`;
      try {
        const content = await readFile();
        if (!context.isCurrent()) {
          return;
        }
        editor.value = content;
        // Compare edits in the textarea's LF representation; reading never rewrites the file.
        baseline = editor.value;
        // A file read without an input event drops the last check's error with its validity.
        editor.setCustomValidity("");
        setFieldError(editor, "");
        loaded = true;
        outcomeUnknown = false;
        status.textContent = `${name} loaded.`;
        if (!discard && retained && !initialized) {
          editor.value = retained.text;
          baseline = retained.baseline;
          outcomeUnknown = retained.outcomeUnknown;
          status.textContent = outcomeUnknown
            ? "Outcome unknown. Reload this file before saving again."
            : "Unsaved edits restored. Reload replaces them with the current file.";
        }
        initialized = true;
      } catch (failure) {
        if (!context.isCurrent()) {
          return;
        }
        const cause = requestFailure(failure);
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        // Explicit Reload can settle an unknown write only when the API confirms file absence.
        const canCreate = confirmsMissingFile(cause) && (discard || !outcomeUnknown);
        if (canCreate) {
          editor.value = !discard && retained ? retained.text : "";
          baseline = !discard && retained ? retained.baseline : undefined;
          initialized = true;
          editor.setCustomValidity("");
          setFieldError(editor, "");
          loaded = true;
          outcomeUnknown = false;
        } else {
          loaded = false;
        }
        status.textContent = canCreate ? missingText() : "";
        errorNotice.textContent = canCreate ? "" : fileError(cause, false, failure);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          writing = false;
          updateControls();
          returnFocus(held, reload);
          // A version change during this request may have been answered by the old version.
          if (refreshAfterPending) {
            refreshAfterPending = false;
            void refresh();
          }
        }
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        operateDenied ||
        pending ||
        !loaded ||
        outcomeUnknown ||
        !context.isCurrent() ||
        editor.value === baseline
      ) {
        return;
      }
      const content = editor.value;
      const problem = workspaceFileProblem(name, content);
      if (problem) {
        editor.setCustomValidity(problem);
        // The error goes under the file, without the browser's bubble (UX plan C3).
        validateFields([editor]);
        return;
      }
      const held = form.contains(document.activeElement);
      operations += 1;
      pending = true;
      writing = true;
      rereadFailed = false;
      updateControls();
      errorNotice.textContent = "";
      status.textContent = `Saving ${name}…`;
      try {
        const saved = responseFields(
          await context.request(endpoint, {
            method: "PUT",
            expectedStatus: 200,
            body: { content },
          }),
        );
        if (!context.isCurrent()) {
          return;
        }
        if (saved.name !== name) {
          throw new Error("Workspace save response did not identify the requested file");
        }
        baseline = content;
        outcomeUnknown = false;
        status.textContent = `${name} saved.`;
      } catch (failure) {
        if (!context.isCurrent()) {
          return;
        }
        const cause = requestFailure(failure);
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        outcomeUnknown = writeOutcomeUnknown(cause.status);
        status.textContent = "";
        errorNotice.textContent = fileError(cause, true, failure);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          writing = false;
          updateControls();
          returnFocus(held, editor);
          // A version change during this request may have been answered by the old version.
          if (refreshAfterPending) {
            refreshAfterPending = false;
            void refresh();
          }
        }
      }
    });
    // Rereads a file the reader has not changed without disabling its editor, so focus and caret
    // stay; unsaved edits and an unknown save outcome are kept as they are (finding 1836).
    async function refresh() {
      if (!context.isCurrent()) {
        return;
      }
      if (pending) {
        refreshAfterPending = true;
        return;
      }
      if (!loaded) {
        // A first read that failed is retried. After an explicit Reload failed, an unknown save
        // outcome still waits for the reader's next Reload.
        if (!initialized) {
          await load();
        }
        return;
      }
      const shown = editor.value;
      if (outcomeUnknown || shown !== (baseline ?? "")) {
        return;
      }
      // Only a file the API confirms is missing can be edited without a baseline.
      const missing = baseline === undefined;
      const started = (operations += 1);
      let content: string;
      try {
        content = await readFile();
      } catch (failure) {
        if (!context.isCurrent() || operations !== started) {
          return;
        }
        const cause = requestFailure(failure);
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        if (missing && confirmsMissingFile(cause)) {
          // Still missing, and nothing new failed (finding 1878). After a Reload the status, not
          // the error, says the file is missing, so unless an error is shown, a failed reread's
          // status gives way to that notice again rather than to nothing (finding 1885).
          if (rereadFailed) {
            rereadFailed = false;
            status.textContent = errorNotice.textContent ? "" : missingText();
          }
          return;
        }
        // The file stays as last read, and the reader learns it may be out of date.
        status.textContent = `${name} could not be reread. Reload to check its current contents.`;
        rereadFailed = true;
        return;
      }
      if (!context.isCurrent() || operations !== started || pending || editor.value !== shown) {
        return;
      }
      // An identical value leaves the caret where it was. A different one moves it to the end, where
      // the next key would land, so a reader who clicked into the file without editing gets caret
      // and scroll back at the same offsets; setSelectionRange clamps them to the new length
      // (finding 1889).
      const focused = editor.ownerDocument.activeElement === editor;
      const { selectionStart, selectionEnd, selectionDirection, scrollTop } = editor;
      editor.value = content;
      if (focused && editor.value !== shown) {
        editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
        editor.scrollTop = scrollTop;
      }
      baseline = editor.value;
      if (missing || baseline !== shown) {
        errorNotice.textContent = "";
        status.textContent = `${name} reloaded with its current contents.`;
        rereadFailed = false;
        updateControls();
      } else {
        clearRereadFailure();
      }
    }
    // A reread that answered clears the status left by an earlier failed one.
    function clearRereadFailure() {
      if (rereadFailed) {
        rereadFailed = false;
        status.textContent = "";
      }
    }
    refreshers.push(refresh);
    section.append(form);
    void load();
  }
  // An answer already settled applies before this section is first painted. It also applies while
  // the tab is parked (another tab is shown), since the page restores these nodes on return; it
  // changes only this section's own nodes.
  function applyOperate(allowed: boolean | undefined) {
    const denied = allowed === false;
    if (denied === operateDenied) {
      return;
    }
    operateDenied = denied;
    if (denied) {
      operateNote.textContent = OPERATE_DENIED;
      operateNote.hidden = false;
      for (const deny of denials) {
        deny();
      }
      return;
    }
    operateNote.hidden = true;
    operateNote.textContent = "";
    for (const restore of restorations) {
      restore();
    }
  }
  // Once the page has passed a newer answer, a late first answer must not replace it.
  let operateAnswered = false;
  void operateAllowed?.then((allowed) => {
    if (!operateAnswered) {
      applyOperate(allowed);
    }
  });
  return {
    section,
    applyOperate(allowed: boolean | undefined) {
      operateAnswered = true;
      applyOperate(allowed);
    },
    refresh: () => {
      for (const refresh of refreshers) {
        void refresh();
      }
    },
  };
}
