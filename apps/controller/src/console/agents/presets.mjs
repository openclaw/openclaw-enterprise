import { element, button, field as formField, statusBlock, validateFields } from "../dom.mjs";
import {
  renderPresetTemplate,
  requiredPresetVariables,
  validatePresetTemplate,
} from "../preset-variables.mjs";
import { message, namespacePath } from "./list.mjs";

const NEW_SECRET = "new";
const EXISTING_SECRET = "existing";
const HARNESS_SECRET_TOKEN = /^\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

function harnessSecretVariable(template) {
  const value = template?.agent?.harnessAuth?.secret;
  return typeof value === "string" ? HARNESS_SECRET_TOKEN.exec(value)?.[1] : undefined;
}

// Only the variable that names the Agent (the whole agent.name is its token) is a one-line
// input. Any other string may hold several lines (instructions, a workspace file), even when its
// default is one line, so it keeps a textarea (UX plan C3; #1989).
function singleLineVariable(template, name, value) {
  const agentName = template?.agent?.name;
  return (
    !/[\r\n]/.test(value) &&
    typeof agentName === "string" &&
    HARNESS_SECRET_TOKEN.exec(agentName)?.[1] === name
  );
}

function variableLabel(name) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

function sameNamespaceSecret(context, secret) {
  return (
    secret?.namespaceId === context.namespaceId &&
    secret?.ref?.kind === "secret" &&
    secret.ref.namespaceId === context.namespaceId &&
    typeof secret.ref.id === "string" &&
    secret.ref.id === secret.id
  );
}

function renderSecretOptions(secrets) {
  return [
    element("option", { value: "" }, "Choose an existing Secret"),
    ...secrets.map((secret) => element("option", { value: secret.id }, secret.name ?? "Secret")),
  ];
}

export function createPresetFields(context, apply) {
  let retained = context.drafts.get("preset");
  const selector = element(
    "select",
    { id: "agent-preset", disabled: true },
    element("option", { value: "" }, "Choose a Preset"),
  );
  const status = element("p", { className: "hint", role: "status" }, "Loading Presets…");
  const feedback = statusBlock("danger", null, null);
  const inputs = element("div");
  let defaultId;
  // How the next selection change started: "shortcut" applies the default Preset at once.
  let origin;
  // Whether the reader changed a variable. The form a Preset opens keeps it, so its Cancel asks
  // first; a reload or tab close warns either way (finding 1902).
  let touched = false;
  const markTouched = (event) => {
    touched ||= event.isTrusted;
  };
  inputs.addEventListener("input", markTouched);
  inputs.addEventListener("change", markTouched);
  const chooseHint = () =>
    defaultId
      ? "Choose a Preset or start with the default Preset."
      : "Choose a Preset. default-codex is not available to you in this Namespace.";
  const startDefault = button(
    "Start with default Preset",
    () => {
      selector.value = defaultId;
      origin = "shortcut";
      selector.dispatchEvent(new Event("change"));
    },
    { tone: "primary", disabled: true },
  );
  let selected;
  let fields = [];
  let loadVersion = 0;
  context.drafts.track("preset", () =>
    selector.value
      ? {
          id: selector.value,
          touched,
          fields: fields.length
            ? Object.fromEntries(
                fields.map((field) => [
                  field.name,
                  {
                    type: field.definition.type,
                    ...(field.definition.type === "password"
                      ? {}
                      : {
                          value:
                            field.definition.type === "string"
                              ? field.readValue()
                              : field.input.value,
                          supplied: field.input.dataset.supplied,
                        }),
                    mode: field.mode?.value,
                    secret: field.secretSelect?.value,
                  },
                ]),
              )
            : retained?.fields,
        }
      : retained,
  );
  context.drafts.unsavedWhen("preset", (draft) => Boolean(draft?.touched));

  function currentSecrets(field) {
    return field.secrets.filter((secret) => sameNamespaceSecret(context, secret));
  }

  function updatePasswordField(field) {
    const existing = field.mode?.value === EXISTING_SECRET;
    field.input.required = !existing;
    field.input.disabled = existing;
    field.secretSelect.required = existing;
    field.secretSelect.disabled = !existing || field.secretsLoading || field.secretsError !== null;
    field.inputField.hidden = existing;
    field.secretField.hidden = !existing;
    if (existing) {
      field.input.value = "";
      field.input.dataset.supplied = "false";
    } else {
      field.secretSelect.value = "";
    }
  }

  async function loadSecrets(version, passwordFields) {
    if (!passwordFields.length) {
      return;
    }
    for (const field of passwordFields) {
      field.secretsLoading = true;
      field.secretsError = null;
      field.secretStatus.textContent = "Loading existing Secrets…";
      updatePasswordField(field);
    }
    try {
      const secrets = await context.request(`${namespacePath(context.namespaceId)}/secrets`);
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      for (const field of passwordFields) {
        field.secrets = Array.isArray(secrets)
          ? secrets.filter((secret) => sameNamespaceSecret(context, secret))
          : [];
        field.secretsLoading = false;
        field.secretSelect.replaceChildren(...renderSecretOptions(field.secrets));
        field.secretSelect.value = field.restoredSecret ?? "";
        delete field.restoredSecret;
        field.secretStatus.textContent = field.secrets.length
          ? "Existing Secrets in this Namespace are available. Secret values are never shown."
          : "No existing Secrets are available in this Namespace. Create a new Secret instead.";
        updatePasswordField(field);
      }
    } catch (error) {
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      for (const field of passwordFields) {
        field.secrets = [];
        field.secretsLoading = false;
        field.secretsError = error;
        field.secretSelect.replaceChildren(
          element("option", { value: "" }, "Existing Secrets unavailable"),
        );
        field.secretStatus.textContent = `Existing Secrets unavailable. ${message(error)} Choose create-new mode to enter a new token.`;
        updatePasswordField(field);
      }
    }
  }

  const applyButton = button("Use Preset", () => {
    if (!selected) {
      return;
    }
    // The console checks every variable at once, under each field, with no browser bubble, and
    // focuses the first to fix (UX plan C3).
    const controls = fields.map((field) =>
      field.mode?.value === EXISTING_SECRET ? field.secretSelect : field.input,
    );
    if (!validateFields(controls)) {
      return;
    }
    try {
      const values = Object.create(null);
      const secretSelections = new Map();
      for (const field of fields) {
        const { name, definition, input } = field;
        if (definition.type === "password" && field.mode) {
          if (field.mode.value === EXISTING_SECRET) {
            const secret = currentSecrets(field).find(
              (item) => item.id === field.secretSelect.value,
            );
            if (!sameNamespaceSecret(context, secret)) {
              feedback.textContent = "Choose an existing Secret from this Namespace.";
              return;
            }
            secretSelections.set(name, { kind: "existing", secret });
            continue;
          }
          values[name] = input.value;
          secretSelections.set(name, { kind: "new" });
          continue;
        }
        if (input.dataset.supplied !== "true") {
          continue;
        }
        if (input.value === "" && !["string", "password"].includes(definition.type)) {
          continue;
        }
        values[name] =
          definition.type === "number"
            ? Number(input.value)
            : definition.type === "boolean"
              ? input.value === "true"
              : definition.type === "string"
                ? field.readValue()
                : input.value;
      }
      const passwordVariable = harnessSecretVariable(selected.template);
      const secretSelection = passwordVariable ? secretSelections.get(passwordVariable) : undefined;
      validatePresetTemplate(selected.template);
      const renderTemplate = structuredClone(selected.template);
      if (secretSelection?.kind === "existing") {
        renderTemplate.agent = { ...(renderTemplate.agent ?? {}) };
        renderTemplate.agent.harnessAuth = {
          method: renderTemplate.agent.harnessAuth.method,
          source: secretSelection.secret.ref,
        };
      }
      const applied = renderPresetTemplate(renderTemplate, values);
      apply(applied, { modelSecret: secretSelection }, { touched });
      for (const field of fields) {
        if (field.definition.type === "password") {
          field.input.value = "";
          field.input.dataset.supplied = "false";
        }
      }
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
  const section = element(
    "fieldset",
    {},
    element("legend", {}, "Preset"),
    formField({ label: "Preset template", control: selector }),
    status,
    inputs,
    applyButton,
    feedback,
  );
  applyButton.disabled = true;
  selector.addEventListener("change", async () => {
    const version = ++loadVersion;
    const selectedId = selector.value;
    const applyDefault = origin === "shortcut";
    origin = undefined;
    if (retained?.id !== selectedId) {
      retained = undefined;
    }
    touched = Boolean(retained?.touched);
    selected = undefined;
    fields = [];
    inputs.replaceChildren();
    feedback.textContent = "";
    applyButton.disabled = true;
    if (!selectedId) {
      status.textContent = chooseHint();
      return;
    }
    status.textContent = "Loading Preset…";
    try {
      const preset = await context.request(
        `${namespacePath(context.namespaceId)}/presets/${encodeURIComponent(selectedId)}`,
      );
      if (
        !context.isCurrent() ||
        !section.isConnected ||
        version !== loadVersion ||
        selector.value !== selectedId
      ) {
        return;
      }
      selected = preset;
      const required = requiredPresetVariables(preset.template);
      fields = Object.entries(preset.template.variables ?? {}).map(([name, definition]) => {
        const label = variableLabel(name);
        // Password inputs stay required in every case; other types only when rendering needs them.
        const needed = definition.type === "password" || required.has(name);
        const saved = retained?.fields?.[name];
        let initialValue = definition.default === undefined ? "" : String(definition.default);
        if (saved?.type === definition.type && definition.type !== "password") {
          initialValue = saved.value;
        }
        const input =
          definition.type === "boolean"
            ? element(
                "select",
                { id: `preset-variable-${name}`, required: needed },
                element("option", { value: "" }, "Choose a value"),
                element("option", { value: "true" }, "True"),
                element("option", { value: "false" }, "False"),
              )
            : definition.type === "string" &&
                !singleLineVariable(preset.template, name, initialValue)
              ? element("textarea", {
                  id: `preset-variable-${name}`,
                  rows: 2,
                  autocomplete: "off",
                  required: needed,
                })
              : element("input", {
                  id: `preset-variable-${name}`,
                  type: definition.type === "string" ? "text" : definition.type,
                  ...(definition.type === "number" ? { step: "any" } : {}),
                  autocomplete: "off",
                  required: needed,
                  ...(definition.type === "password" ? { spellcheck: "false" } : {}),
                });
        input.dataset.supplied = String(Object.hasOwn(definition, "default"));
        if (saved?.type === definition.type && definition.type !== "password") {
          input.dataset.supplied = saved.supplied;
        }
        input.value = initialValue;
        // Textarea displays CRLF as LF. Keep an untouched default or restored value exact;
        // an actual edit takes the browser's current string, including its line breaks.
        let stringValue = definition.type === "string" ? initialValue : undefined;
        const readValue = () => (definition.type === "string" ? stringValue : input.value);
        input.addEventListener("input", () => {
          if (definition.type === "string") {
            stringValue = input.value;
          }
          input.dataset.supplied = "true";
          feedback.textContent = "";
        });
        input.addEventListener("change", () => {
          if (definition.type === "string") {
            stringValue = input.value;
          }
          input.dataset.supplied = "true";
        });
        if (definition.type !== "password" || name !== harnessSecretVariable(preset.template)) {
          inputs.append(formField({ label, control: input, help: definition.description }));
          return { name, definition, input, readValue };
        }
        const mode = element(
          "select",
          { id: `preset-variable-${name}-secret-source` },
          element("option", { value: NEW_SECRET }, "Create new Secret"),
          element("option", { value: EXISTING_SECRET }, "Use existing Secret"),
        );
        if (saved?.type === "password" && saved.mode) {
          mode.value = saved.mode;
        }
        const secretSelect = element(
          "select",
          { id: `preset-variable-${name}-existing-secret`, required: true, disabled: true },
          element("option", { value: "" }, "Loading existing Secrets…"),
        );
        const secretStatus = element(
          "p",
          { className: "hint field-help", role: "status", id: `${secretSelect.id}-hint` },
          "Loading existing Secrets…",
        );
        const inputField = formField({ label, control: input, help: definition.description });
        const secretField = formField({
          label: `Existing Secret for ${label}`,
          control: secretSelect,
        });
        secretField.hidden = true;
        secretField.append(secretStatus);
        secretSelect.setAttribute("aria-describedby", secretStatus.id);
        const fieldEntry = {
          name,
          definition,
          input,
          mode,
          secretSelect,
          secretStatus,
          inputField,
          secretField,
          restoredSecret: saved?.secret,
          secrets: [],
          secretsLoading: true,
          secretsError: null,
        };
        mode.addEventListener("change", () => {
          input.dataset.supplied = String(mode.value === NEW_SECRET);
          feedback.textContent = "";
          updatePasswordField(fieldEntry);
        });
        secretSelect.addEventListener("change", () => {
          feedback.textContent = "";
        });
        inputs.append(
          formField({
            label: `Secret source for ${label}`,
            control: mode,
            help: "Create a new masked Secret at final Create, or bind an existing Secret from this Namespace.",
          }),
          inputField,
          secretField,
        );
        updatePasswordField(fieldEntry);
        return fieldEntry;
      });
      status.textContent =
        "Fill in the variables, then use this Preset to create an editable draft.";
      applyButton.disabled = false;
      if (applyDefault && fields.length === 0) {
        applyButton.click();
      }
      void loadSecrets(
        version,
        fields.filter((field) => field.definition.type === "password" && field.mode),
      );
    } catch (error) {
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = message(error);
      }
    } finally {
      if (version === loadVersion) {
        selector.disabled = false;
      }
    }
  });
  context
    .request(`${namespacePath(context.namespaceId)}/presets`)
    .then((presets) => {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      selector.append(
        ...presets
          .toSorted((left, right) =>
            left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
          )
          .map((preset) => element("option", { value: preset.id }, preset.name)),
      );
      selector.disabled = false;
      defaultId = presets.find((preset) => preset.name === "default-codex")?.id;
      startDefault.disabled = !defaultId;
      if (retained && presets.some((preset) => preset.id === retained.id)) {
        selector.value = retained.id;
        selector.dispatchEvent(new Event("change"));
      }
      if (presets.length === 0) {
        status.textContent =
          "No Presets available to you in this Namespace. Ask an administrator to install default-codex or another Preset, or to give you read access to a Preset.";
      } else {
        status.textContent = chooseHint();
      }
    })
    .catch((error) => {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        status.textContent = `Presets unavailable. ${message(error)} Try again or ask an administrator to check Preset access.`;
      }
    });
  return { section, startDefault };
}
