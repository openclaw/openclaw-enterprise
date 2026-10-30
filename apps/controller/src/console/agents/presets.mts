import type {
  Preset,
  PresetLaunchSettings,
  PresetSummary,
  PresetTemplate,
  PresetVariable,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import type { createDraftStore } from "../drafts.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import {
  element,
  button,
  field as formField,
  setUnavailable,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import {
  renderPresetTemplate,
  requiredPresetVariables,
  validatePresetTemplate,
} from "../preset-variables.mjs";
import { describeFailure, message, namespaceListNeed, namespacePath } from "./list.mjs";
import type { SecretsOperateDenied } from "./credential-access.mjs";
import {
  NEW_SECRET_OPERATE_DENIED,
  NEW_SECRET_OPERATE_REMEDY,
  SECRET_OPERATE_DENIED,
} from "./secret-picker.mjs";
import {
  askAdministratorTo,
  NO_SECRETS_CREATE_DENIED,
  SECRET_CREATE_DENIED,
} from "./access-reasons.mjs";

type PresetContext = Pick<NamespacePageContext, "request" | "isCurrent" | "onExpired"> & {
  namespaceId: string;
  drafts: ReturnType<ReturnType<typeof createDraftStore>["scope"]>;
  // The readable Secrets the caller may not operate; undefined when the answer is unknown.
  secretsOperateDenied?: SecretsOperateDenied | undefined;
  // The Namespace permission answer's secrets.create: undefined when it is unknown.
  secretsCreateAllowed?: (() => Promise<boolean | undefined>) | undefined;
};

interface VariableField {
  name: string;
  definition: PresetVariable;
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  readValue(): string;
}

interface SecretField extends VariableField {
  mode: HTMLSelectElement;
  secretSelect: HTMLSelectElement;
  secretStatus: HTMLElement;
  inputField: HTMLElement;
  secretField: HTMLElement;
  restoredSecret: string | undefined;
  secrets: SecretMetadata[];
  // Listed Secrets the caller may not operate: listed disabled, never used (finding 2469).
  operateDenied: ReadonlySet<string>;
  secretsState: "loading" | "ready" | "failed";
}

// Retain the password field's source choice, never the password.
type SavedField =
  | { type: "password"; mode?: string; secret?: string }
  | {
      type: Exclude<PresetVariable["type"], "password">;
      value: string;
      supplied: string | undefined;
    };

function saveField(field: VariableField | SecretField): SavedField {
  const { type } = field.definition;
  if (type !== "password") {
    return { type, value: field.readValue(), supplied: field.input.dataset.supplied };
  }
  return "mode" in field
    ? { type, mode: field.mode.value, secret: field.secretSelect.value }
    : { type };
}

interface PresetDraft {
  id: string;
  touched: boolean;
  fields: Record<string, SavedField> | undefined;
}

type ModelSecret = { kind: "new" } | { kind: "existing"; secret: SecretMetadata };

const NEW_SECRET = "new";
const EXISTING_SECRET = "existing";
const HARNESS_SECRET_TOKEN = /^\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

function harnessSecretVariable(template: PresetTemplate) {
  const value = responseFields(template.agent?.harnessAuth).secret;
  return typeof value === "string" ? HARNESS_SECRET_TOKEN.exec(value)?.[1] : undefined;
}

// Only the variable that names the Agent (the whole agent.name is its token) is a one-line
// input. Any other string may hold several lines (instructions, a workspace file), even when its
// default is one line, so it keeps a textarea (UX plan C3; #1989).
function singleLineVariable(template: PresetTemplate, name: string, value: string) {
  const agentName = template.agent?.name;
  return (
    !/[\r\n]/.test(value) &&
    typeof agentName === "string" &&
    HARNESS_SECRET_TOKEN.exec(agentName)?.[1] === name
  );
}

function variableLabel(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function sameNamespaceSecret(context: PresetContext, value: unknown): value is SecretMetadata {
  const secret = responseFields(value);
  const ref = responseFields(secret.ref);
  return (
    secret.namespaceId === context.namespaceId &&
    typeof secret.name === "string" &&
    ref.kind === "secret" &&
    ref.namespaceId === context.namespaceId &&
    typeof ref.id === "string" &&
    ref.id === secret.id
  );
}

// A Secret the caller may read but not operate is listed disabled with the shared reason: Agent
// create binds it as the Harness authentication Secret and would refuse it (finding 2469).
function renderSecretOptions(
  secrets: readonly SecretMetadata[],
  operateDenied: ReadonlySet<string>,
) {
  return [
    element("option", { value: "" }, "Choose an existing Secret"),
    ...secrets.map((secret) =>
      operateDenied.has(secret.id)
        ? element(
            "option",
            { value: secret.id, disabled: true },
            `${secret.name} (${SECRET_OPERATE_DENIED})`,
          )
        : element("option", { value: secret.id }, secret.name),
    ),
  ];
}

export function createPresetFields(
  context: PresetContext,
  apply: (
    settings: PresetLaunchSettings,
    options: { modelSecret: ModelSecret | undefined; presetName: string },
    draft: Pick<PresetDraft, "touched">,
  ) => void,
) {
  // This scoped draft is written only by the capture below.
  let retained = context.drafts.get("preset") as PresetDraft | undefined;
  const selector = element(
    "select",
    { id: "agent-preset", disabled: true },
    element("option", { value: "" }, "Choose a Preset"),
  );
  const status = element("p", { className: "hint", role: "status" }, "Loading Presets…");
  const feedback = statusBlock("danger", null, null);
  const inputs = element("div");
  let defaultId: string | undefined;
  // How the next selection change started: "shortcut" applies the default Preset at once.
  let origin: "shortcut" | undefined;
  // Whether the reader changed a variable. The form a Preset opens keeps it, so its Cancel asks
  // first; a reload or tab close warns either way (finding 1902).
  let touched = false;
  const markTouched = (event: Event) => {
    touched ||= event.isTrusted;
  };
  inputs.addEventListener("input", markTouched);
  inputs.addEventListener("change", markTouched);
  // Without default-codex, the hint under the shortcut already says it is not available, so the
  // status line does not repeat it (finding 2946).
  const chooseHint = () =>
    defaultId ? "Choose a Preset or start with the default Preset." : "Choose a Preset.";
  const startDefault = button(
    "Start with default Preset",
    () => {
      selector.value = defaultId ?? "";
      origin = "shortcut";
      selector.dispatchEvent(new Event("change"));
    },
    { tone: "primary", disabled: true },
  );
  // The chooser named no Preset beside its default shortcut (finding 2066).
  const defaultHint = element("p", {
    className: "hint",
    id: `${selector.id}-default-hint`,
    hidden: true,
  });
  // Once a Preset is chosen, Use Preset is the next step, so it takes the filled style from the
  // default shortcut; clearing the choice gives it back (finding 2066).
  function emphasize(chosen: boolean) {
    for (const [node, primary] of [
      [startDefault, !chosen],
      [applyButton, chosen],
    ] as const) {
      node.classList.toggle("button", primary);
      node.classList.toggle("button--primary", primary);
    }
  }
  let selected: Pick<Preset, "name" | "template"> | undefined;
  let fields: (VariableField | SecretField)[] = [];
  let loadVersion = 0;
  context.drafts.track("preset", (): PresetDraft | undefined =>
    selector.value
      ? {
          id: selector.value,
          touched,
          fields: fields.length
            ? Object.fromEntries(fields.map((field) => [field.name, saveField(field)]))
            : retained?.fields,
        }
      : retained,
  );
  context.drafts.unsavedWhen("preset", (draft) => responseFields(draft).touched === true);

  function updatePasswordField(field: SecretField) {
    const existing = field.mode.value === EXISTING_SECRET;
    field.input.required = !existing;
    field.input.disabled = existing;
    field.secretSelect.required = existing;
    field.secretSelect.disabled = !existing || field.secretsState !== "ready";
    field.inputField.hidden = existing;
    field.secretField.hidden = !existing;
    if (existing) {
      field.input.value = "";
      field.input.dataset.supplied = "false";
    } else {
      field.secretSelect.value = "";
    }
  }

  async function loadSecrets(version: number, passwordFields: SecretField[]) {
    if (!passwordFields.length) {
      return;
    }
    for (const field of passwordFields) {
      field.secretsState = "loading";
      field.secretStatus.textContent = "Loading existing Secrets…";
      updatePasswordField(field);
    }
    try {
      // The list shows once the operate answer is in, so no denied Secret is ever choosable.
      const [secrets, operateDenied, createAllowed] = await Promise.all([
        context.request(`${namespacePath(context.namespaceId)}/secrets`),
        (context.secretsOperateDenied?.() ?? Promise.resolve(undefined)).catch(() => undefined),
        (context.secretsCreateAllowed?.() ?? Promise.resolve(undefined)).catch(() => undefined),
      ]);
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      for (const field of passwordFields) {
        field.operateDenied = operateDenied ?? new Set();
        field.secrets = Array.isArray(secrets)
          ? secrets.filter((value: unknown): value is SecretMetadata =>
              sameNamespaceSecret(context, value),
            )
          : [];
        field.secretsState = "ready";
        field.secretSelect.replaceChildren(
          ...renderSecretOptions(field.secrets, field.operateDenied),
        );
        // A restored choice the answer now denies is not kept.
        const restored = field.restoredSecret ?? "";
        field.secretSelect.value = field.operateDenied.has(restored) ? "" : restored;
        field.restoredSecret = undefined;
        // Without Secret create, the create-new source is listed disabled with the reason and
        // the field binds an existing Secret, as the other Secret fields do (finding 2483). So it
        // is when operate is denied on any readable Secret: operate is then granted per Secret,
        // and a new Secret has none, so Agent create would refuse it once saved (finding 2492).
        const createDenied = createAllowed === false;
        const newSecretDenied = createDenied
          ? SECRET_CREATE_DENIED
          : field.operateDenied.size
            ? NEW_SECRET_OPERATE_DENIED
            : undefined;
        const createOption = field.mode.querySelector<HTMLOptionElement>(
          `option[value="${NEW_SECRET}"]`,
        );
        if (createOption) {
          createOption.disabled = newSecretDenied !== undefined;
          createOption.textContent = newSecretDenied
            ? `Create new Secret (${newSecretDenied})`
            : "Create new Secret";
        }
        // Per-Secret operate also names the grant that would let an Agent use a new Secret.
        const newSecretHint =
          newSecretDenied === NEW_SECRET_OPERATE_DENIED
            ? `${newSecretDenied} ${NEW_SECRET_OPERATE_REMEDY}`
            : newSecretDenied;
        if (newSecretDenied && field.mode.value === NEW_SECRET) {
          field.mode.value = EXISTING_SECRET;
          field.input.dataset.supplied = "false";
        }
        field.secretStatus.textContent =
          createDenied && !field.secrets.length
            ? NO_SECRETS_CREATE_DENIED
            : newSecretDenied
              ? `Choose an existing Secret. ${newSecretHint}`
              : field.secrets.length
                ? "Existing Secrets in this Namespace are available. Secret values are never shown."
                : "No existing Secrets are available in this Namespace. Create a new Secret instead.";
        updatePasswordField(field);
      }
    } catch (error) {
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
        return;
      }
      for (const field of passwordFields) {
        field.secrets = [];
        field.secretsState = "failed";
        field.secretSelect.replaceChildren(
          element("option", { value: "" }, "Existing Secrets unavailable"),
        );
        field.secretStatus.textContent = `Existing Secrets unavailable. ${message(error, false, namespaceListNeed("Secrets"))} Choose create-new mode to enter a new token.`;
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
      "mode" in field && field.mode.value === EXISTING_SECRET ? field.secretSelect : field.input,
    );
    if (!validateFields(controls)) {
      return;
    }
    try {
      const values: Record<string, string | number | boolean> = Object.create(null);
      let modelSecret: ModelSecret | undefined;
      for (const field of fields) {
        const { name, definition, input } = field;
        if ("mode" in field) {
          if (field.mode.value === EXISTING_SECRET) {
            const secret = field.secrets.find((item) => item.id === field.secretSelect.value);
            if (!sameNamespaceSecret(context, secret)) {
              feedback.textContent = "Choose an existing Secret from this Namespace.";
              return;
            }
            if (field.operateDenied.has(secret.id)) {
              feedback.textContent = `${secret.name} cannot be chosen. ${SECRET_OPERATE_DENIED}`;
              return;
            }
            modelSecret = { kind: "existing", secret };
            continue;
          }
          values[name] = input.value;
          modelSecret = { kind: "new" };
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
      const template = selected.template;
      const agent = template.agent;
      const settings =
        modelSecret?.kind === "existing"
          ? {
              ...template,
              agent: {
                ...agent,
                harnessAuth: {
                  method: responseFields(agent?.harnessAuth).method,
                  source: modelSecret.secret.ref,
                },
              },
            }
          : template;
      const applied = renderPresetTemplate(settings, values);
      // The form names the Preset it started from (UX plan A2, flows.md C8).
      apply(applied, { modelSecret, presetName: selected.name }, { touched });
      for (const field of fields) {
        if (field.definition.type === "password") {
          field.input.value = "";
          field.input.dataset.supplied = "false";
        }
      }
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : message(error);
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
  let applyUnavailable = true;
  // An unavailable Use Preset is described by the line that says why (finding D793): the
  // Preset's load failure, else the status line ("Choose a Preset or start with the default
  // Preset."), and stays in the Tab order while it shows (finding 2878). Called wherever either
  // line or the button changes.
  const describeApply = () =>
    setUnavailable(applyButton, applyUnavailable, feedback.textContent?.trim() ? feedback : status);
  describeApply();
  selector.addEventListener("change", async () => {
    const version = ++loadVersion;
    const selectedId = selector.value;
    emphasize(Boolean(selectedId));
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
    applyUnavailable = true;
    if (!selectedId) {
      status.textContent = chooseHint();
      describeApply();
      return;
    }
    status.textContent = "Loading Preset…";
    describeApply();
    try {
      const value = await context.request(
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
      const preset = responseFields(value);
      if (typeof preset.name !== "string") {
        throw new Error("Invalid Preset response.");
      }
      const template = validatePresetTemplate(preset.template);
      selected = { name: preset.name, template };
      const required = requiredPresetVariables(template);
      const variables = Object.entries<PresetVariable>(template.variables ?? {});
      fields = variables.map(([name, definition]) => {
        const label = variableLabel(name);
        // Password inputs stay required in every case; other types only when rendering needs them.
        const needed = definition.type === "password" || required.has(name);
        const saved = retained?.fields?.[name];
        let initialValue = "default" in definition ? String(definition.default) : "";
        if (saved && saved.type !== "password" && saved.type === definition.type) {
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
            : definition.type === "string" && !singleLineVariable(template, name, initialValue)
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
        if (saved && saved.type !== "password" && saved.type === definition.type) {
          input.dataset.supplied = saved.supplied;
        }
        input.value = initialValue;
        // Textarea displays CRLF as LF. Keep an untouched default or restored value exact;
        // an actual edit takes the browser's current string, including its line breaks.
        let stringValue = initialValue;
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
        if (definition.type !== "password" || name !== harnessSecretVariable(template)) {
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
        const fieldEntry: SecretField = {
          name,
          definition,
          input,
          readValue,
          mode,
          secretSelect,
          secretStatus,
          inputField,
          secretField,
          restoredSecret: saved?.type === "password" ? saved.secret : undefined,
          secrets: [],
          operateDenied: new Set(),
          secretsState: "loading",
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
      applyUnavailable = false;
      describeApply();
      if (applyDefault && fields.length === 0) {
        applyButton.click();
      }
      void loadSecrets(
        version,
        fields.filter((field): field is SecretField => "mode" in field),
      );
    } catch (error) {
      if (!context.isCurrent() || !section.isConnected || version !== loadVersion) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `This Preset could not be loaded. ${describeFailure(error)}`;
        describeApply();
        // Use Preset stays disabled, so the filled style goes back to the shortcut.
        emphasize(false);
      }
    } finally {
      if (version === loadVersion) {
        selector.disabled = false;
      }
    }
  });
  context
    .request(`${namespacePath(context.namespaceId)}/presets`)
    .then((value) => {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      if (!Array.isArray(value)) {
        throw new Error("Invalid Presets response.");
      }
      const presets = value.map((entry: unknown): Pick<PresetSummary, "id" | "name"> => {
        const { id, name } = responseFields(entry);
        if (typeof id !== "string" || typeof name !== "string") {
          throw new Error("Invalid Presets response.");
        }
        return { id, name };
      });
      selector.append(
        ...presets
          .sort((left, right) =>
            left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
          )
          .map((preset) => element("option", { value: preset.id }, preset.name)),
      );
      selector.disabled = false;
      defaultId = presets.find((preset) => preset.name === "default-codex")?.id;
      // The hint beside the shortcut names the default Preset, or says that it is not
      // available, and then describes the unavailable shortcut, which stays in the Tab order
      // (finding 2937).
      defaultHint.textContent = defaultId
        ? "The default Preset is default-codex."
        : "default-codex is not available to you in this Namespace.";
      defaultHint.hidden = false;
      setUnavailable(startDefault, !defaultId, defaultHint);
      if (defaultId) {
        startDefault.setAttribute("aria-describedby", defaultHint.id);
      }
      if (retained && presets.some((preset) => preset.id === retained?.id)) {
        selector.value = retained.id;
        selector.dispatchEvent(new Event("change"));
      }
      if (presets.length === 0) {
        status.textContent = `No Presets available to you in this Namespace. ${askAdministratorTo(
          "install default-codex or another Preset, or to give you Preset read on one",
        )}`;
      } else {
        status.textContent = chooseHint();
      }
      describeApply();
    })
    .catch((error) => {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        status.textContent = `Presets unavailable. ${message(error, false, namespaceListNeed("Presets"))}`;
        describeApply();
        // The chooser stays unavailable, so its status says why the shortcut is too.
        setUnavailable(startDefault, true, status);
      }
    });
  return { section, startDefault, defaultHint };
}
