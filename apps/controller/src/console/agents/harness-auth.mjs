import { element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

export function harnessAuthDescription(binding) {
  if (!binding) {
    return "None selected";
  }
  if (binding.method === "runtime") {
    return "Operator-managed credentials";
  }
  return binding.method === "api_key"
    ? "OpenAI API key · Secret configured"
    : `ChatGPT service account · ${binding.serviceAccountId}`;
}

export function createHarnessAuthFields(context, binding = null) {
  const method = element(
    "select",
    { id: "harness-auth-method" },
    element("option", { value: "" }, "None"),
    element("option", { value: "api_key" }, "OpenAI API key"),
    element("option", { value: "runtime" }, "Operator-managed credentials"),
    element("option", { value: "chatgpt_service_account" }, "ChatGPT service account"),
  );
  method.value = binding?.method ?? "";
  const secret = element("input", {
    id: "harness-auth-secret",
    type: "password",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "sec_…",
    value: binding?.method === "api_key" ? binding.source.id : "",
  });
  const account = element(
    "select",
    { id: "service-account-id", disabled: true },
    element("option", { value: "" }, "Select an issued account"),
  );
  if (binding?.method === "chatgpt_service_account") {
    account.append(
      element("option", { value: binding.serviceAccountId }, binding.serviceAccountId),
    );
    account.value = binding.serviceAccountId;
  }
  let accountsLoaded = false;
  let disabled = false;
  const feedback = element("p", { className: "hint", role: "status" });
  const secretField = element(
    "div",
    { className: "form-field" },
    element("label", { for: secret.id }, "OpenAI API key Secret ID"),
    secret,
    element(
      "p",
      { className: "hint" },
      "Select an existing OCC Secret in this Namespace by its ID. Secret values are never shown.",
    ),
  );
  const accountField = element(
    "div",
    { className: "form-field" },
    element("label", { for: account.id }, "Issued ChatGPT service account"),
    account,
  );
  const runtimeHint = element(
    "p",
    { className: "hint" },
    "Configured on the runtime host; not validated by OCC.",
  );
  const section = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Harness authentication"),
    element("label", { for: method.id }, "Authentication source"),
    method,
    secretField,
    accountField,
    runtimeHint,
    feedback,
    element(
      "p",
      { className: "hint" },
      "Managed sources are checked during deployment. Operator-managed credentials are not validated by OCC. Selection does not establish provider login or model readiness.",
    ),
  );
  function update() {
    runtimeHint.hidden = method.value !== "runtime";
    secretField.hidden = method.value !== "api_key";
    accountField.hidden = method.value !== "chatgpt_service_account";
    secret.required = method.value === "api_key";
    account.required = method.value === "chatgpt_service_account";
  }
  method.addEventListener("change", update);
  update();
  context
    .request(`${namespacePath(context.namespaceId)}/service-accounts`)
    .then((items) => {
      if (!context.isCurrent()) {
        return;
      }
      const issued = items.filter((item) => item.credential?.kind === "access_token");
      accountsLoaded = true;
      account.disabled = disabled;
      const selected = account.value;
      account.replaceChildren(
        element("option", { value: "" }, "Select an issued account"),
        ...issued.map((item) => element("option", { value: item.id }, `${item.name} · ${item.id}`)),
      );
      if (selected && !issued.some((item) => item.id === selected)) {
        account.append(element("option", { value: selected }, `${selected} · unavailable`));
      }
      account.value = selected;
      feedback.textContent = issued.length
        ? "Issued accounts in this Namespace are available."
        : "No issued ChatGPT accounts available in this Namespace.";
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `Service accounts unavailable. ${message(error)}`;
      }
    });
  return {
    section,
    setDisabled(value) {
      disabled = value;
      method.disabled = value;
      secret.disabled = value;
      account.disabled = value || !accountsLoaded;
    },
    async readBinding() {
      if (!method.value) {
        return null;
      }
      if (method.value === "runtime") {
        return { method: "runtime" };
      }
      if (method.value === "chatgpt_service_account") {
        if (!account.value) {
          throw new Error("Select an issued ChatGPT service account.");
        }
        return { method: "chatgpt_service_account", serviceAccountId: account.value };
      }
      const id = secret.value.trim();
      if (!id) {
        throw new Error("Enter an OCC Secret ID.");
      }
      return {
        method: "api_key",
        source: { kind: "secret", namespaceId: context.namespaceId, id },
      };
    },
  };
}
