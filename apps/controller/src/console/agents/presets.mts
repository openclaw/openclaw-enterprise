import type {
  Preset,
  PresetLaunchSettings,
  PresetSummary,
  PresetDraftTemplate,
  PresetVariable,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import type { NamespacePageContext } from "../namespaces.mjs";
import {
  element,
  button,
  field as formField,
  setFieldError,
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

// How Create Agent opens the chooser. `applied` is the Preset the form was filled from, and
// `appliedName` its name, shown before the list arrives. `pending` is a selection a restored
// draft kept, not yet applied. `autoDefault` chooses default-codex for a new form, and
// `onSettled` runs once the chooser has nothing more to apply by itself. `clear` asks to empty
// the form when No Preset is chosen.
export interface PresetLaunch {
  applied?: PresetDraft | undefined;
  appliedName?: string | undefined;
  pending?: PresetDraft | undefined;
  autoDefault?: boolean;
  onSettled?: () => void;
  clear?: () => boolean;
}

export interface PresetDraft {
  id: string;
  touched: boolean;
  fields: Record<string, SavedField> | undefined;
}

// Each Configuration setting a Preset variable filled, by its path segments (keys and array
// indexes), with the variables that filled it. Create Agent maps a refusal that names a setting
// back to these (finding 3122).
export type PresetSettingVariables = { setting: readonly string[]; variables: string[] }[];

// The Preset step reopened after Create Agent refused a setting its variables filled: the chooser
// state to restore, and the variables to mark with the refusal.
export interface PresetReturn {
  draft: PresetDraft;
  variables: readonly string[];
  refusal: string;
}

const VARIABLE_REFERENCE = /(?<!\\)\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const referencedVariables = (text: string) =>
  [...text.matchAll(VARIABLE_REFERENCE)].map((match) => match[1] ?? "");

// A key as the API shows it in a setting path: control, format, line and paragraph separator
// characters show as ? (OCC's shownSettingKey).
const shownSettingKey = (key: string) => key.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Cs}/gu, "?");

// A refusal's setting path as segments. The API writes an array index as `allow[0]` or
// `allow.0`, and a key that is not a plain ID quoted, as `entries["my agent"].model` (OCC's
// keyedSettingPath). A path it shortened with … names no exact setting.
const SETTING_SEGMENT = /\.?([^.[\]"\s]+)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/uy;

function settingSegments(path: string): string[] | undefined {
  if (path.endsWith("…")) {
    return undefined;
  }
  const segments: string[] = [];
  SETTING_SEGMENT.lastIndex = 0;
  while (SETTING_SEGMENT.lastIndex < path.length) {
    const match = SETTING_SEGMENT.exec(path);
    const [, plain, index, quoted] = match ?? [];
    const segment = quoted === undefined ? (plain ?? index) : parseQuotedKey(quoted);
    if (segment === undefined) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments.length ? segments : undefined;
}

function parseQuotedKey(quoted: string): string | undefined {
  try {
    const key: unknown = JSON.parse(quoted);
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

// The setting a refusal names: plain, indexed and quoted segments, up to the colon, comma or
// space after it.
const REFUSED_SETTING =
  /^Configuration setting ((?:[^\s"[]|\[\d+\]|\["(?:[^"\\]|\\.)*"\])+?)[:,]?\s/u;

// Where each variable went in configuration.values. A key that holds a variable is named by its
// rendered text, as the API names it.
function presetSettingVariables(
  template: PresetDraftTemplate,
  inputs: Record<string, string | number | boolean>,
): PresetSettingVariables {
  const found: PresetSettingVariables = [];
  const visit = (value: unknown, setting: readonly string[]) => {
    if (typeof value === "string") {
      const variables = referencedVariables(value);
      if (variables.length) {
        found.push({ setting, variables });
      }
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...setting, String(index)]));
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const keyVariables = referencedVariables(key);
        const rendered = keyVariables.length
          ? (Object.keys(
              renderPresetTemplate(
                { variables: template.variables ?? {}, configuration: { values: { [key]: null } } },
                inputs,
              ).configuration?.values ?? {},
            )[0] ?? key)
          : key;
        const path = [...setting, shownSettingKey(rendered)];
        if (keyVariables.length) {
          found.push({ setting: path, variables: keyVariables });
        }
        visit(child, path);
      }
    }
  };
  visit(template.configuration?.values, []);
  return found;
}

// The value at `segments` in Configuration values, or undefined.
function settingValue(values: unknown, segments: readonly string[]): unknown {
  let value = values;
  for (const segment of segments) {
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, segment)
        ? (value as Record<string, unknown>)[segment]
        : undefined;
  }
  return value;
}

/** The Preset variables that filled the Configuration setting `refusal` names, or none: the setting
 * itself or a value inside it. Never a value, only the setting's name (finding 3122). A setting
 * the submitted values no longer hold as the Preset rendered it names none: the reader changed
 * it after the Preset (finding 3125). */
export function refusedPresetVariables(
  refusal: string | undefined,
  settings: PresetSettingVariables | undefined,
  values: { submitted: unknown; rendered: unknown },
): string[] {
  const named = REFUSED_SETTING.exec(refusal ?? "")?.[1];
  const refused = named === undefined ? undefined : settingSegments(named);
  if (
    !refused ||
    !settings ||
    !sameValue(settingValue(values.submitted, refused), settingValue(values.rendered, refused))
  ) {
    return [];
  }
  const variables = new Set<string>();
  for (const { setting, variables: names } of settings) {
    if (refused.every((segment, index) => setting[index] === segment)) {
      names.forEach((name) => variables.add(name));
    }
  }
  return [...variables];
}

/** The variables' field labels as one phrase: "Human", "Human and Team". */
export function presetVariableLabels(names: readonly string[]) {
  const labels = names.map(variableLabel);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : (labels[0] ?? "");
}

type ModelSecret = { kind: "new" } | { kind: "existing"; secret: SecretMetadata };

const NEW_SECRET = "new";
const EXISTING_SECRET = "existing";
const HARNESS_SECRET_TOKEN = /^\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

function harnessSecretVariable(template: PresetDraftTemplate) {
  const value = responseFields(template.agent?.harnessAuth).secret;
  return typeof value === "string" ? HARNESS_SECRET_TOKEN.exec(value)?.[1] : undefined;
}

// Only the variable that names the Agent (the whole agent.name is its token) is a one-line
// input. Any other string may hold several lines (instructions, a workspace file), even when its
// default is one line, so it keeps a textarea (UX plan C3; #1989).
function singleLineVariable(template: PresetDraftTemplate, name: string, value: string) {
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
    options: {
      modelSecret: ModelSecret | undefined;
      presetName: string;
      presetDraft: PresetDraft;
      settingVariables: PresetSettingVariables;
    },
    draft: Pick<PresetDraft, "touched">,
  ) => boolean,
  returning?: PresetReturn,
  launch: PresetLaunch = {},
) {
  // The chooser shows the Preset the form around it was filled from, or the selection a draft
  // kept. Create Agent sent the reader back to change the variables it refused when `returning`
  // is set.
  let retained = returning?.draft ?? launch.pending ?? launch.applied;
  const appliedId = launch.applied?.id ?? "";
  // Marked once, when the returned Preset's fields are built.
  let refused = returning;
  // Disabled until the list arrives, and while the form holds saved resources: a new Preset
  // would replace them, as Start over does.
  let listed = false;
  let locked = false;
  const updateSelector = () => {
    selector.disabled = locked || !listed;
  };
  // The Preset a filled form shows stays named while the list loads.
  const selector = element(
    "select",
    { id: "agent-preset", disabled: true },
    element("option", { value: "" }, "No Preset"),
    ...(launch.applied ? [element("option", { value: appliedId }, launch.appliedName ?? "")] : []),
  );
  selector.value = appliedId;
  const status = element("p", { className: "hint", role: "status" }, "Loading Presets…");
  const feedback = statusBlock("danger", null, null);
  const inputs = element("div");
  // How the next selection change started: "shortcut" is the default Preset a new form chose.
  let origin: "shortcut" | undefined;
  // Whether the reader changed a variable. The form a Preset opens keeps it, so its Cancel asks
  // first; a reload or tab close warns either way (finding 1902).
  let touched = false;
  const markTouched = (event: Event) => {
    touched ||= event.isTrusted;
  };
  inputs.addEventListener("input", markTouched);
  inputs.addEventListener("change", markTouched);
  let selected: (Pick<Preset, "name"> & { template: PresetDraftTemplate }) | undefined;
  let fields: (VariableField | SecretField)[] = [];
  let loadVersion = 0;
  // The chooser's selection and variables, kept with Create Agent's draft.
  const capture = (): PresetDraft | undefined =>
    selector.value
      ? {
          id: selector.value,
          touched,
          fields: fields.length
            ? Object.fromEntries(fields.map((field) => [field.name, saveField(field)]))
            : retained?.fields,
        }
      : retained;

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
      const presetDraft: PresetDraft = {
        id: selector.value,
        touched,
        fields: Object.fromEntries(fields.map((field) => [field.name, saveField(field)])),
      };
      // The form names the Preset it started from (UX plan A2, flows.md C8), and keeps where
      // each variable went, so a refused setting names the field that filled it (finding 3122).
      const used = apply(
        applied,
        {
          modelSecret,
          presetName: selected.name,
          presetDraft,
          settingVariables: presetSettingVariables(template, values),
        },
        { touched },
      );
      // The reader kept the form: the chooser keeps this choice and its variables.
      if (!used) {
        return;
      }
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
  // Use Preset shows once a Preset the form does not use yet has loaded.
  applyButton.hidden = true;
  const section = element(
    "fieldset",
    { className: "create-preset" },
    element("legend", {}, "Preset"),
    formField({ label: "Preset", control: selector }),
    status,
    inputs,
    applyButton,
    feedback,
  );
  // Enter in a variable uses the Preset; it never submits the form around the chooser.
  section.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (!applyButton.hidden) {
        applyButton.click();
      }
    }
  });
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
    status.textContent = "";
    applyButton.hidden = true;
    // The form already holds the applied Preset's values: there is nothing to fill in or use.
    if (selectedId === appliedId) {
      return;
    }
    if (!selectedId) {
      // No Preset empties the form the applied Preset filled, unless the reader keeps it.
      if (!launch.clear?.()) {
        selector.value = appliedId;
      }
      return;
    }
    status.textContent = "Loading Preset…";
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
          setFieldError(input, "");
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
      applyButton.hidden = false;
      // Create Agent refused the setting these variables filled: its refusal shows under each,
      // and focus moves to the first to change (finding 3122). Focus scrolls only the field into
      // view, so at phone width the refusal under it can start below the fold: it scrolls in too.
      const returned = refused?.draft.id === selectedId ? refused : undefined;
      refused = undefined;
      const marked = fields.filter(
        (field) => returned?.variables.includes(field.name) && !("mode" in field),
      );
      for (const field of marked) {
        setFieldError(field.input, returned?.refusal);
      }
      const first = marked[0]?.input;
      if (first) {
        first.focus();
        document.getElementById(`${first.id}-error`)?.scrollIntoView({ block: "nearest" });
      }
      // A new form starts from default-codex at once when it has no variables to fill.
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
        status.textContent = "";
        feedback.textContent = `This Preset could not be loaded. ${describeFailure(error)}`;
        // Create Agent sent the reader back here and removed the button they pressed. With no
        // field to mark, focus goes to the chooser, not the document (findings 1446, 3122).
        if (refused) {
          refused = undefined;
          selector.focus();
        }
      }
    } finally {
      if (version === loadVersion && applyDefault) {
        launch.onSettled?.();
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
      selector.replaceChildren(
        element("option", { value: "" }, "No Preset"),
        ...presets
          .sort((left, right) =>
            left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
          )
          .map((preset) => element("option", { value: preset.id }, preset.name)),
      );
      listed = true;
      updateSelector();
      status.textContent = presets.length
        ? ""
        : `No Presets available to you in this Namespace. ${askAdministratorTo(
            "install default-codex or another Preset, or to give you Preset read on one",
          )}`;
      const defaultId = presets.find((preset) => preset.name === "default-codex")?.id;
      // An applied Preset the list no longer holds leaves No Preset selected.
      selector.value = appliedId;
      if (retained?.id !== appliedId && presets.some((preset) => preset.id === retained?.id)) {
        // A selection the form does not use yet shows its variables again.
        selector.value = retained?.id ?? "";
        selector.dispatchEvent(new Event("change"));
      } else if (launch.autoDefault && defaultId) {
        // A new form starts from default-codex when it is available.
        selector.value = defaultId;
        origin = "shortcut";
        selector.dispatchEvent(new Event("change"));
      } else {
        launch.onSettled?.();
      }
    })
    .catch((error) => {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      if (requestFailure(error).status === 401) {
        context.onExpired();
      } else {
        status.textContent = `Presets unavailable. ${message(error, false, namespaceListNeed("Presets"))}`;
      }
      launch.onSettled?.();
    });
  return {
    section,
    capture,
    // While the form holds saved resources, the chooser cannot replace it.
    setLocked(value: boolean) {
      locked = value;
      updateSelector();
    },
  };
}
