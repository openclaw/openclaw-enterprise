import type {
  AgentNetworkProxy,
  SecretMetadata,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { button, element, field } from "../dom.mjs";
import { createSecretReferenceField } from "./secret-picker.mjs";

type PickerContext = Parameters<typeof createSecretReferenceField>[0]["context"];

export interface NetworkProxyDraft {
  readonly url: string;
  readonly credentialSecretId?: string;
}

function endpoint(value: string): string {
  if (
    !/^https?:\/\//iu.test(value) ||
    /^https?:\/\/[^/]*@/iu.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error("Use an HTTP or HTTPS proxy endpoint without credentials.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Use an HTTP or HTTPS proxy endpoint without credentials.");
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Use an HTTP or HTTPS proxy endpoint without credentials or a path.");
  }
  return parsed.origin;
}

export function createNetworkProxyFields({
  context,
  namespaceId,
  id,
  initial,
  agentName,
  onChange,
}: {
  context: PickerContext;
  namespaceId: string;
  id: string;
  initial?: NetworkProxyDraft;
  agentName(): string;
  onChange(): void;
}) {
  let source: SecretReference | null = initial?.credentialSecretId
    ? { kind: "secret", namespaceId, id: initial.credentialSecretId }
    : null;
  const input = element("input", {
    id: `${id}-url`,
    type: "url",
    autocomplete: "off",
    spellcheck: false,
    value: initial?.url ?? "",
    placeholder: "https://proxy.example:8443",
  });
  const validation = element("p", { className: "hint", role: "status" });
  const picker = createSecretReferenceField({
    context,
    id: `${id}-credential`,
    label: "Proxy credential Secret (optional)",
    getCurrentSource: () => source,
    onSecretSelected(secret: SecretMetadata) {
      source = secret.ref;
      changed();
    },
    createSecretName: () => `${agentName() || "Agent"} proxy credential`,
    createDialogTitle: "Create proxy credential Secret",
    metadataLabel: "View proxy credential Secret metadata",
    noSecretLabel: "No proxy credential",
    stagedHint:
      "Proxy credential staged. Save the Agent setting to apply it on the next deployment.",
  });
  const remove = button("Remove proxy credential", () => {
    source = null;
    picker.refresh();
    changed();
  });
  const node = element(
    "div",
    { className: "network-proxy-fields" },
    field({
      label: "Network proxy URL",
      control: input,
      help: "Applies to Gateway channel traffic only. Deploy a new version to apply changes.",
    }),
    picker.field,
    element(
      "p",
      { className: "hint" },
      "For Basic authentication, select a Secret containing Basic <base64(username:password)>. Proxy credentials are separate from channel credentials.",
    ),
    remove,
    validation,
  );
  function changed() {
    validation.textContent = "";
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
    remove.hidden = source === null;
    onChange();
  }
  input.addEventListener("input", changed);
  remove.hidden = source === null;

  return {
    node,
    input,
    read(): AgentNetworkProxy | undefined {
      const raw = input.value.trim();
      if (!raw) {
        if (source) {
          throw new Error("Enter a Network proxy URL or remove the proxy credential Secret.");
        }
        return undefined;
      }
      return {
        url: endpoint(raw),
        ...(source === null ? {} : { credentialSecretId: source.id }),
      };
    },
    showValidation(message: string) {
      validation.textContent = message;
      input.setCustomValidity(message);
      input.setAttribute("aria-invalid", "true");
      input.focus();
    },
    draft(): NetworkProxyDraft {
      const raw = input.value;
      // Never retain user information from a credential-bearing URL in Console draft state.
      const url = raw.includes("@") ? "" : raw;
      return { url, ...(source === null ? {} : { credentialSecretId: source.id }) };
    },
    reset(value: AgentNetworkProxy | undefined) {
      input.value = value?.url ?? "";
      source = value?.credentialSecretId
        ? { kind: "secret", namespaceId, id: value.credentialSecretId }
        : null;
      picker.refresh();
      changed();
    },
    setDisabled(disabled: boolean) {
      input.disabled = disabled;
      picker.setDisabled(disabled);
      remove.disabled = disabled;
    },
  };
}
