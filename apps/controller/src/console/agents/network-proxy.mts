import type { AgentNetworkProxy, CredentialSourceReference } from "@openclaw-enterprise/contracts";
import { button, element, field } from "../dom.mjs";
import { createInlineStaticCredentialSourcePicker } from "../credential-source-picker.mjs";

type PickerContext = Parameters<typeof createInlineStaticCredentialSourcePicker>[0];

export interface NetworkProxyDraft {
  readonly url: string;
  readonly credentialSourceId?: string;
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
  id,
  initial,
  onChange,
}: {
  context: PickerContext;
  id: string;
  initial?: NetworkProxyDraft;
  onChange(): void;
}) {
  const reference = (sourceId: string | undefined): CredentialSourceReference | null =>
    sourceId === undefined
      ? null
      : { kind: "credential_source", namespaceId: context.namespaceId, id: sourceId };
  let source = reference(initial?.credentialSourceId);
  let enrolling = false;
  const input = element("input", {
    id: `${id}-url`,
    type: "url",
    autocomplete: "off",
    spellcheck: false,
    value: initial?.url ?? "",
    placeholder: "https://proxy.example:8443",
  });
  const validation = element("p", { className: "hint", role: "status" });
  const node = element("div", { className: "network-proxy-fields" });
  const picker = createInlineStaticCredentialSourcePicker(context, node, {
    id: `${id}-credential`,
    label: "Proxy credential",
    initial: source,
    inputClassName: "form-field",
    deliveryHint: "The credential takes effect after you save the draft and deploy a new version.",
    onChange(selected) {
      source = selected;
      changed();
    },
    onPending(pending) {
      enrolling = pending;
      changed();
    },
  });
  const remove = button("Remove proxy credential", () => {
    source = null;
    picker.reset();
    changed();
  });
  node.append(
    field({
      label: "Network proxy URL",
      control: input,
      help: "Applies to Gateway channel traffic only. Deploy a new version to apply changes.",
    }),
    picker.field,
    element(
      "p",
      { className: "hint" },
      "For Basic authentication, select a Credential Source containing Basic <base64(username:",
      element("wbr"),
      "password)>. Proxy credentials are separate from channel credentials.",
    ),
    remove,
    validation,
  );
  picker.setRequired(false);
  picker.setActive(true);
  function changed() {
    validation.textContent = "";
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
    remove.hidden = source === null || picker.creating;
    onChange();
  }
  input.addEventListener("input", changed);
  remove.hidden = source === null;

  return {
    node,
    input,
    get selectingCredential() {
      return picker.creating || enrolling;
    },
    get enrollmentPending() {
      return enrolling;
    },
    read(): AgentNetworkProxy | undefined {
      if (picker.creating || enrolling) {
        throw new Error("Finish or cancel creating the proxy credential first.");
      }
      const raw = input.value.trim();
      if (!raw) {
        if (source) {
          throw new Error("Enter a Network proxy URL or remove the proxy credential.");
        }
        return undefined;
      }
      return {
        url: endpoint(raw),
        ...(source === null ? {} : { credentialSourceId: source.id }),
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
      return { url, ...(source === null ? {} : { credentialSourceId: source.id }) };
    },
    reset(value: AgentNetworkProxy | undefined) {
      input.value = value?.url ?? "";
      picker.setCurrent(reference(value?.credentialSourceId));
    },
    setDisabled(disabled: boolean) {
      input.disabled = disabled;
      picker.setDisabled(disabled);
      remove.disabled = disabled;
      node.toggleAttribute("inert", disabled);
    },
  };
}
