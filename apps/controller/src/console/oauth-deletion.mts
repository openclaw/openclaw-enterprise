import { requestFailure } from "./api-client.mjs";
import { button, element, requestIdLine } from "./dom.mjs";
import type { ConsolePageContext } from "./page-context.mjs";
import { resourceActionIcon } from "./resource-actions.mjs";

export function oauthDeleteButton(
  context: Pick<ConsolePageContext, "request" | "isCurrent">,
  kind: "connection template" | "OAuth client",
  item: { id: string; displayName: string },
  scope: string,
  refresh: (message?: string) => Promise<unknown>,
  fallbackFocus: HTMLButtonElement,
) {
  const label = `Delete ${item.displayName} (${scope})`;
  const opener = button(resourceActionIcon("delete"), open, {
    className: "icon-button",
    title: label,
    "aria-label": label,
  });
  return opener;

  function open() {
    const title = `Delete ${kind}`;
    const dialog = element("dialog", {
      className: "dialog dialog--framed",
      "aria-label": title,
      "aria-describedby": "oauth-delete-identity oauth-delete-effect",
    });
    const feedback = element("div", { role: "alert" });
    const close = button("Cancel", () => dialog.close());
    const confirm = button(title, () => void remove(), { tone: "danger" });
    let pending = false;
    let reload = false;
    let result: string | undefined;
    dialog.append(
      element("header", { className: "dialog-header" }, element("h2", {}, title)),
      element(
        "div",
        { className: "dialog-body" },
        element(
          "p",
          { id: "oauth-delete-identity" },
          element("strong", {}, item.displayName),
          ` · ${scope}`,
        ),
        element("p", { className: "resource-id" }, item.id),
        element(
          "p",
          { id: "oauth-delete-effect" },
          kind === "connection template"
            ? "This permanently deletes the template and its saved versions. Its registered OAuth clients stay available."
            : "This permanently removes the client registration from OCE.",
        ),
        feedback,
      ),
      element("div", { className: "dialog-actions" }, close, confirm),
    );
    opener.after(dialog);
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    dialog.addEventListener(
      "close",
      async () => {
        dialog.remove();
        if (reload && context.isCurrent()) {
          await refresh(result);
          if (context.isCurrent() && document.activeElement === document.body) {
            fallbackFocus.focus();
          }
        }
      },
      { once: true },
    );
    dialog.showModal();
    close.focus();

    async function remove() {
      if (pending || !dialog.open || !context.isCurrent()) {
        return;
      }
      pending = true;
      close.disabled = true;
      confirm.disabled = true;
      confirm.textContent = "Deleting…";
      const collection =
        kind === "connection template" ? "/connection-templates" : "/oauth-clients";
      try {
        await context.request(`${collection}/${encodeURIComponent(item.id)}`, {
          method: "DELETE",
          expectedStatus: 204,
          installationAdministration: "required",
        });
        if (context.isCurrent()) {
          result = `Deleted ${item.displayName}.`;
          reload = true;
          dialog.close();
        }
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        const { status, serverMessage, requestId } = requestFailure(cause);
        const uncertain = status === undefined || status < 400 || status === 408 || status >= 500;
        reload = uncertain || status === 404 || status === 403;
        let message = serverMessage ?? `OCE refused to delete this ${kind}.`;
        if (uncertain) {
          message = "Could not confirm deletion. Close to reload the list before trying again.";
        } else if (
          status === 409 &&
          serverMessage === "A template version still references this OAuth client."
        ) {
          message +=
            " Earlier versions can still reference it after the template selects another client.";
        }
        feedback.append(element("p", {}, message));
        if (requestId) {
          feedback.append(requestIdLine(requestId));
        }
        confirm.remove();
        close.textContent = "Close";
        close.disabled = false;
        close.focus();
      } finally {
        pending = false;
      }
    }
  }
}
