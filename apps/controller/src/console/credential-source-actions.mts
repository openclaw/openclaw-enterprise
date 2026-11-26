import { namedDenial, requestFailure } from "./api-client.mjs";
import {
  readCredentialSourceMetadata,
  type CredentialSourceSummary,
} from "./credential-source-metadata.mjs";
import { credentialValueControl } from "./credential-value.mjs";
import { button, dismissOnBackdrop, element, field, statusBlock, validateFields } from "./dom.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";

type Context = Pick<NamespacePageContext, "view" | "request" | "isCurrent" | "onExpired"> & {
  namespaceId: string;
};
type Action = "replace" | "delete" | "disconnect";
const UPDATED_DELIVERY_FAILED =
  "The credential source was updated, but credential delivery failed.";
const actionDetails: Record<
  Action,
  {
    title: string;
    submit: string;
    success: string;
    confirmation?: string;
    retry?: string;
  }
> = {
  replace: {
    title: "Replace Credential Source value",
    submit: "Replace value",
    success: "updated",
  },
  delete: {
    title: "Delete Credential Source",
    submit: "Delete Source",
    success: "deleted",
    retry: "Retry delete",
    confirmation:
      "Deleting removes the stored credential. Blocking Agent or Plugin references must be removed first.",
  },
  disconnect: {
    title: "Disconnect Credential Source",
    submit: "Disconnect",
    success: "disconnected",
    retry: "Retry disconnect",
    confirmation:
      "Disconnecting retires this saved credential and requests revocation from its owner. Blocking Agent or Plugin references must be removed first.",
  },
};

function failureMessage(cause: unknown, action: Action, source: CredentialSourceSummary) {
  const { status, serverMessage } = requestFailure(cause);
  if (status === 403) {
    if (action === "disconnect") {
      const denial = namedDenial(cause) ?? `This needs Credential Source delete on ${source.id}.`;
      return `${denial} The account owner can instead disconnect with exact Credential Source read and operate on ${source.id}.`;
    }
    const permission = action === "replace" ? "update" : "delete";
    return (
      namedDenial(cause) ??
      `This needs Credential Source ${permission} on ${source.id}. Ask an administrator for access.`
    );
  }
  if (status === 409 && action !== "replace") {
    return (
      serverMessage ??
      "This Source is still referenced. Remove its blocking references before deleting it."
    );
  }
  if (status === 400 || status === 404 || status === 429) {
    return (
      serverMessage ?? "The request was refused. Refresh the Source inventory before trying again."
    );
  }
  if (status === 503 && action === "replace" && serverMessage === UPDATED_DELIVERY_FAILED) {
    return `${serverMessage} Do not repeat the replacement. Retry credential delivery separately.`;
  }
  if (status === 503) {
    return action === "replace"
      ? "A required dependency is unavailable and the replacement outcome is unconfirmed. Refresh the Source inventory and check the credential owner before retrying."
      : "Credential retirement is unconfirmed. Refresh the Source inventory and check the owner before retrying.";
  }
  return "The request outcome is unconfirmed. Refresh the Source inventory and check the credential owner before retrying.";
}

/** Managed TokenService metadata is required here. Protected/proxy rows must not call this component. */
export function createCredentialSourceActions({
  context,
  onChanged,
}: {
  context: Context;
  onChanged(message: string): void | Promise<void>;
}) {
  let dialog: HTMLDialogElement | null = null;
  let pending = false;

  function close() {
    if (pending || !dialog) {
      return;
    }
    dialog.close();
  }

  function open(source: CredentialSourceSummary, action: Action, trigger: HTMLButtonElement) {
    if (dialog || !context.isCurrent()) {
      return;
    }
    const details = actionDetails[action];
    const current = element("dialog", {
      className: "dialog dialog--framed secret-dialog",
      "aria-labelledby": "credential-source-action-title",
    });
    dialog = current;
    const heading = element(
      "h2",
      { id: "credential-source-action-title", tabindex: "-1" },
      details.title,
    );
    const body = element(
      "div",
      { className: "dialog-body" },
      element(
        "p",
        {},
        source.name,
        " · ",
        element("code", { className: "resource-id" }, source.id),
      ),
    );
    const feedback = element("div", { role: "status" });
    const cancel = button("Cancel", close);
    const actions = element("div", { className: "dialog-actions" }, cancel);
    current.append(element("header", { className: "dialog-header" }, heading), body, actions);
    current.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dismissOnBackdrop(current);
    current.addEventListener(
      "close",
      () => {
        for (const input of current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "[data-secret-value]",
        )) {
          input.value = "";
        }
        current.remove();
        if (dialog === current) {
          dialog = null;
        }
        if (context.isCurrent() && trigger.isConnected) {
          trigger.focus();
        }
      },
      { once: true },
    );
    context.view.append(current);
    current.showModal();
    heading.focus();

    const replacing = action === "replace";
    const form = element("form", { id: "credential-source-action-form", novalidate: "" });
    let credential: ReturnType<typeof credentialValueControl> | null = null;
    if (replacing) {
      credential = credentialValueControl("credential-source-replacement-value");
      const valueField = field({
        label: "New credential value",
        control: credential.value,
        className: "secret-value-field",
        help: "The replacement value is write-only.",
      });
      credential.value.before(credential.reveal);
      form.append(
        valueField,
        element(
          "p",
          { className: "hint" },
          "Replacement keeps this Source ID and can update credentials delivered to Agents already using it.",
        ),
      );
    } else {
      form.append(element("p", {}, details.confirmation));
    }
    body.append(form, feedback);
    const submit = element(
      "button",
      {
        type: "submit",
        form: form.id,
        className: `button button--${replacing ? "primary" : "danger"}`,
      },
      details.submit,
    );
    actions.append(submit);
    if (credential) {
      credential.value.focus();
    }
    let blocked = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        pending ||
        blocked ||
        dialog !== current ||
        (credential && !validateFields([credential.value]))
      ) {
        return;
      }
      pending = true;
      cancel.disabled = true;
      submit.disabled = true;
      if (credential) {
        credential.value.disabled = true;
        credential.reveal.disabled = true;
      }
      feedback.replaceChildren(
        element("p", {}, replacing ? "Replacing value…" : "Retiring Source…"),
      );
      let confirmed = false;
      try {
        const path = `/namespaces/${encodeURIComponent(context.namespaceId)}/credential-sources/${encodeURIComponent(source.id)}`;
        if (credential) {
          const request = context.request(path, {
            method: "PATCH",
            expectedStatus: 200,
            body: { secret: credential.value.value },
          });
          credential.value.value = "";
          const updated = readCredentialSourceMetadata(await request, context.namespaceId);
          if (
            !updated ||
            updated.id !== source.id ||
            updated.type !== "static" ||
            updated.state !== "ready"
          ) {
            throw new Error("Unconfirmed Credential Source replacement");
          }
        } else {
          await context.request(path, { method: "DELETE", expectedStatus: 204 });
        }
        confirmed = true;
      } catch (cause) {
        if (credential) {
          credential.value.value = "";
        }
        const { status, serverMessage } = requestFailure(cause);
        if (status === 401) {
          context.onExpired();
        } else if (current.open && context.isCurrent()) {
          let title = "Source not removed";
          if (replacing) {
            title =
              status === 503 && serverMessage === UPDATED_DELIVERY_FAILED
                ? "Credential updated; delivery failed"
                : "Replacement not confirmed";
          }
          feedback.replaceChildren(
            statusBlock("danger", title, failureMessage(cause, action, source)),
          );
          blocked = status !== 400 && status !== 429;
        }
      } finally {
        pending = false;
        cancel.disabled = false;
        submit.disabled = blocked;
        if (credential) {
          credential.value.disabled = blocked;
          credential.reveal.disabled = blocked;
        }
      }
      if (confirmed) {
        close();
        await onChanged(`${source.name} was ${details.success}.`);
      }
    });
  }

  function forSource(source: CredentialSourceSummary) {
    if (source.namespaceId !== context.namespaceId || source.type === "github-app-installation") {
      return null;
    }
    const row = element("div", { className: "resource-row-actions" });
    if (source.type === "static" && source.state === "ready") {
      const replace = button("Replace value", () => open(source, "replace", replace), {
        size: "sm",
      });
      row.append(replace);
    }
    const action = source.type === "oauth2-refresh-token" ? "disconnect" : "delete";
    const details = actionDetails[action];
    const label = source.state === "deleting" ? details.retry! : details.submit;
    const remove = button(label, () => open(source, action, remove), {
      size: "sm",
      tone: "danger",
    });
    row.append(remove);
    return row;
  }

  return { forSource, writing: () => pending, close };
}
