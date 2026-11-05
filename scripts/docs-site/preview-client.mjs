/* global document, EventSource, location */

const loaded = document.querySelector("script[data-docs-preview]").dataset.docsPreview;
const events = new EventSource("/__docs_preview/events");
const notice = document.createElement("aside");
notice.setAttribute("role", "alert");
notice.dataset.docsPreviewError = "";
notice.style.cssText =
  "position:fixed;bottom:16px;left:16px;right:16px;z-index:10000;padding:16px;background:#301516;color:#fff;border:2px solid #f88;border-radius:8px;max-height:40vh;overflow:auto;font:14px/1.5 monospace;white-space:pre-wrap";
notice.hidden = true;
document.body.append(notice);
events.onmessage = ({ data }) => {
  const state = JSON.parse(data);
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
