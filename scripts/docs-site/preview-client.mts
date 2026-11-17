import type { PreviewState } from "./preview-build.ts";

const script = document.querySelector("script[data-docs-preview]");
const loaded = script instanceof HTMLScriptElement ? script.dataset.docsPreview : undefined;
if (loaded === undefined) {
  throw new Error("Missing docs preview revision");
}
const events = new EventSource("/__docs_preview/events");
const notice = document.createElement("aside");
notice.setAttribute("role", "alert");
notice.dataset.docsPreviewError = "";
notice.style.cssText =
  "position:fixed;bottom:16px;left:16px;right:16px;z-index:10000;padding:16px;background:#301516;color:#fff;border:2px solid #f88;border-radius:8px;max-height:40vh;overflow:auto;font:14px/1.5 monospace;white-space:pre-wrap";
notice.hidden = true;
document.body.append(notice);
function parsePreviewState(data: string): PreviewState {
  const state: unknown = JSON.parse(data);
  if (
    typeof state !== "object" ||
    state === null ||
    !("revision" in state) ||
    typeof state.revision !== "string" ||
    !("error" in state) ||
    typeof state.error !== "string"
  ) {
    throw new Error("Invalid docs preview state");
  }
  return { revision: state.revision, error: state.error };
}
events.onmessage = ({ data }: MessageEvent<string>) => {
  const state = parsePreviewState(data);
  if (state.revision !== loaded) {
    // reload keeps the pathname, query and fragment, including deep-page bookmarks.
    location.reload();
    return;
  }
  notice.hidden = !state.error;
  notice.textContent = state.error;
};
events.onerror = () => {
  notice.hidden = false;
  notice.textContent =
    "Docs preview disconnected. Reconnecting automatically. Check the preview terminal if this continues.";
};
