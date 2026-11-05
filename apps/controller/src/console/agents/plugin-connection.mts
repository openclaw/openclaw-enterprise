import type { AgentPluginCredentialSlot, SecretReference } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, field, withRequestId } from "../dom.mjs";
import { namespacePath } from "./list.mjs";
import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";
import { createSecretReferenceField } from "./secret-picker.mjs";

type Source = { id: string; name: string };

/** Keep a registered source available for a separately authorized attachment or retry. */
export function importedConnectionEditor(
  context: PluginDiscoveryContext,
  agentPath: string,
  onAttached: () => void,
) {
  const pendingSources = new Map<string, Source>();
  return (slot: AgentPluginCredentialSlot, parent: HTMLDialogElement) => {
    const key = slot.releaseSha256 + "/" + slot.id;
    let source = pendingSources.get(key);
    let secret: SecretReference | undefined;
    let pending = false;
    const name = element("input", { type: "text", maxLength: 160, value: slot.label });
    const heading = element("h2", { id: "plugin-connection-title" }, "Create connection");
    const status = element("p", { className: "hint", role: "status" });
    const next = button("Create connection", () => void submit(), { tone: "primary" });
    const close = button("Close", () => dialog.close());
    const picker = createSecretReferenceField({
      context,
      id: "plugin-connection-token",
      label: "Token Secret",
      getCurrentSource: () => secret,
      onSecretSelected: (metadata) => {
        secret = metadata.ref;
      },
      noSecretLabel: "Choose an existing Secret",
      stagedHint: "This connection will use the selected Secret.",
      required: true,
    });
    const fields = element(
      "div",
      {},
      field({ label: "Connection name", control: name }),
      picker.field,
    );
    const dialog = element(
      "dialog",
      { className: "dialog", "aria-labelledby": heading.id },
      heading,
      element(
        "p",
        { className: "muted" },
        "Choose the OCE Secret that holds the bearer token for " +
          slot.id +
          ". The package declares how this server authenticates.",
      ),
      fields,
      status,
      element("div", { className: "dialog-actions" }, close, next),
    );
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.addEventListener("cancel", (event) => {
      if (pending) {
        event.preventDefault();
      }
    });
    function registered(value: Source) {
      fields.hidden = true;
      heading.textContent = "Attach connection";
      status.textContent =
        value.name +
        " (" +
        value.id +
        ") is registered in this Namespace. Attach it to this Agent to make it available in the account picker.";
      next.textContent = "Attach to Agent";
    }
    if (source) {
      registered(source);
    }
    parent.append(dialog);
    dialog.showModal();
    async function submit() {
      if (pending || !context.isCurrent()) {
        return;
      }
      if (!source && (!name.value.trim() || !secret)) {
        status.textContent = "Enter a connection name and choose a Token Secret.";
        return;
      }
      pending = true;
      close.disabled = true;
      next.disabled = true;
      name.disabled = true;
      picker.setDisabled(true);
      try {
        if (!source) {
          const saved = responseFields(
            await context.request(namespacePath(context.namespaceId) + "/credential-sources", {
              method: "POST",
              body: {
                name: name.value.trim(),
                type: "bearer-token",
                importedPluginTemplate: { releaseSha256: slot.releaseSha256, serverName: slot.id },
                secrets: { token: secret },
              },
            }),
          );
          if (
            typeof saved.id !== "string" ||
            typeof saved.name !== "string" ||
            saved.namespaceId !== context.namespaceId ||
            responseFields(saved.importedPluginTemplate).releaseSha256 !== slot.releaseSha256 ||
            responseFields(saved.importedPluginTemplate).serverName !== slot.id
          ) {
            throw new Error("Unconfirmed registration");
          }
          source = { id: saved.id, name: saved.name };
          pendingSources.set(key, source);
          if (context.isCurrent()) {
            registered(source);
          }
          return;
        }
        // Read the saved binding list, then compare it under the Namespace lock when appending.
        const current = responseFields(await context.request(agentPath));
        if (
          current.namespaceId !== context.namespaceId ||
          (current.credentialSources !== undefined && !Array.isArray(current.credentialSources))
        ) {
          throw new Error("Unconfirmed Agent");
        }
        const sourceId = source.id;
        const old = ((current.credentialSources as unknown[] | undefined) ?? []).map((binding) => {
          const { sourceId } = responseFields(binding);
          if (typeof sourceId !== "string") {
            throw new Error("Unconfirmed Agent binding");
          }
          return { sourceId };
        });
        const alreadyBound = old.some((binding) => responseFields(binding).sourceId === sourceId);
        if (!alreadyBound) {
          const changed = responseFields(
            await context.request(agentPath, {
              method: "PATCH",
              body: {
                expectedCredentialSources: old,
                credentialSources: [...old, { sourceId }],
              },
            }),
          );
          if (
            !Array.isArray(changed.credentialSources) ||
            !changed.credentialSources.some(
              (binding) => responseFields(binding).sourceId === sourceId,
            )
          ) {
            throw new Error("Unconfirmed binding");
          }
        }
        pendingSources.delete(key);
        if (context.isCurrent()) {
          next.hidden = true;
          status.textContent =
            "Connection attached. Close this dialog, choose the account, and load its tools. If the account is missing, grant the Agent service principal operate access to this connection.";
          onAttached();
        }
      } catch (cause) {
        const error = requestFailure(cause);
        if (error.status === 401) {
          context.onExpired();
        } else if (context.isCurrent()) {
          status.textContent = withRequestId(
            source && error.status === 409
              ? "The Agent’s bindings changed. The registered connection is available. Choose Attach to Agent to refresh the bindings and retry."
              : (error.serverMessage ??
                  (source
                    ? "Could not confirm the attachment. Retry to check this Agent’s bindings."
                    : "Could not confirm connection creation. Check Namespace connections before retrying.")),
            error.requestId,
          );
        }
      } finally {
        pending = false;
        close.disabled = false;
        next.disabled = false;
        name.disabled = false;
        picker.setDisabled(false);
      }
    }
  };
}
