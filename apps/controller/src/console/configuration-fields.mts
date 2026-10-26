import type { DriverConfigurationDescriptor, JSONSchema } from "@openclaw-enterprise/contracts";
import { type ConsoleApiError, responseFields } from "./api-client.mjs";
import { button, element } from "./dom.mjs";

// The controller admits the schema. These are the keywords this editor turns into controls;
// the owner still validates the draft, including when a schema needs the JSON editor.
type FieldSchema = JSONSchema & {
  title?: string;
  description?: string;
  type?: string | readonly string[];
  required?: readonly string[];
  properties?: Readonly<Record<string, FieldSchema | boolean>>;
  items?: FieldSchema | boolean | FieldSchema[];
  enum?: readonly unknown[];
  minimum?: number;
  minItems?: number;
  maxItems?: number;
};
type FieldErrors = Readonly<ConsoleApiError["details"]>;

const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

// The dotted setting path for a JSON pointer, as the API's own refusals name a setting
// ("Configuration setting network.allow[0].host"), so no copy shows a pointer (finding 2538).
function settingPath(path: string) {
  return path
    .split("/")
    .slice(1)
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (dotted, key) =>
        /^\d+$/.test(key) ? `${dotted}[${key}]` : dotted ? `${dotted}.${key}` : key,
      "",
    );
}

// A field error's text: the API's sentence, or one that names no internal code when it sent none.
const detailText = (detail: FieldErrors[number]) =>
  detail.message ?? "This value does not match the setting's schema.";

function initialValue(schema: FieldSchema | boolean): unknown {
  if (typeof schema === "boolean") {
    return "";
  }
  if (schema.type === "object") {
    return Object.fromEntries(
      (schema.required ?? []).map((key) => [key, initialValue(schema.properties?.[key] ?? {})]),
    );
  }
  if (schema.type === "array") {
    return [];
  }
  if (schema.enum) {
    return schema.enum[0];
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return schema.minimum ?? 0;
  }
  return "";
}

/** The schema supplies fields; the resource owner retains submission and lifecycle controls. */
export function configurationFields(
  schema: JSONSchema,
  value: unknown,
  onChange: (draft: unknown) => void,
  {
    disabled = false,
    details = [],
    onEdit = () => {},
  }: { disabled?: boolean; details?: FieldErrors; onEdit?: () => void } = {},
) {
  const root = element("fieldset", { disabled, className: "configuration-fields" });
  let draft = structuredClone(value);
  const changed = () => {
    onEdit();
    onChange(structuredClone(draft));
  };

  function field(
    schema: FieldSchema | boolean,
    current: unknown,
    set: (value: unknown) => void,
    path: string,
    name: string,
  ): HTMLElement {
    const definition = typeof schema === "boolean" ? {} : schema;
    const label = definition.title ?? name;
    const box = element("div", { className: "form-field", "data-configuration-path": path });
    if (definition.description) {
      box.append(element("p", { className: "hint" }, definition.description));
    }
    const complex =
      definition.anyOf ||
      definition.oneOf ||
      definition.allOf ||
      definition.$ref ||
      definition.patternProperties ||
      definition.prefixItems ||
      definition.if ||
      definition.dependentSchemas ||
      definition.enum?.some((item) => item !== null && typeof item === "object");
    const { items, type } = definition;
    if (
      !complex &&
      definition.type === "object" &&
      definition.properties &&
      definition.additionalProperties === false
    ) {
      box.append(element("h4", {}, label));
      let values = responseFields(current);
      for (const [key, child] of Object.entries(definition.properties)) {
        const childLabel = typeof child === "boolean" ? key : (child.title ?? key);
        const required = definition.required?.includes(key);
        const present = Object.hasOwn(values, key);
        if (!required) {
          const include = element("input", {
            type: "checkbox",
            checked: present,
            "aria-label": `Include ${childLabel}`,
          });
          include.addEventListener("change", () => {
            const next = { ...values, [key]: initialValue(child) };
            if (!include.checked) {
              delete next[key];
            }
            set(next);
            changed();
            render();
          });
          box.append(element("label", {}, include, `Include ${childLabel}`));
        }
        if (required || present) {
          box.append(
            field(
              child,
              values[key],
              (next) => {
                values = { ...values, [key]: next };
                set(values);
              },
              `${path}/${pointer(key)}`,
              key,
            ),
          );
        }
      }
    } else if (!complex && type === "array" && items && !Array.isArray(items)) {
      box.append(element("h4", {}, label));
      const values: unknown[] = Array.isArray(current) ? current : [];
      values.forEach((item, index) => {
        const row = field(
          items,
          item,
          (next) => {
            values[index] = next;
            set(values);
          },
          `${path}/${index}`,
          `${label} ${index + 1}`,
        );
        row.append(
          button(
            `Remove ${label} ${index + 1}`,
            () => {
              values.splice(index, 1);
              set(values);
              changed();
              render();
            },
            { disabled: values.length <= (definition.minItems ?? 0) },
          ),
        );
        box.append(row);
      });
      box.append(
        button(
          `Add ${label}`,
          () => {
            values.push(initialValue(items));
            set(values);
            changed();
            render();
          },
          { disabled: values.length >= (definition.maxItems ?? Infinity) },
        ),
      );
    } else if (
      !complex &&
      (definition.enum ||
        type === "string" ||
        type === "number" ||
        type === "integer" ||
        type === "boolean")
    ) {
      let input: HTMLInputElement | HTMLSelectElement;
      let read: () => unknown;
      if (definition.enum) {
        input = element(
          "select",
          { "aria-label": label },
          ...definition.enum.map((item, index) =>
            element("option", { value: index, selected: Object.is(item, current) }, String(item)),
          ),
        );
        const choices = definition.enum;
        read = () => choices[Number(input.value)];
      } else {
        let inputType = "text";
        if (type === "boolean") {
          inputType = "checkbox";
        } else if (type === "number" || type === "integer") {
          inputType = "number";
        }
        const control = element("input", {
          type: inputType,
          "aria-label": label,
        });
        input = control;
        if (inputType === "checkbox") {
          control.checked = current === true;
          read = () => control.checked;
        } else {
          control.value = String(current ?? "");
          read =
            inputType === "number"
              ? () => (control.value === "" ? null : Number(control.value))
              : () => control.value;
        }
        // JSON Schema counts code points; native input lengths count UTF-16 units.
        // Leave string length validation to the resource owner to avoid truncating input.
        for (const [source, target] of [
          ["minimum", "min"],
          ["maximum", "max"],
          ["pattern", "pattern"],
        ] as const) {
          if (definition[source] !== undefined) {
            input.setAttribute(target, String(definition[source]));
          }
        }
        if (type === "integer") {
          control.step = "1";
        }
      }
      input.addEventListener("input", () => {
        set(read());
        changed();
      });
      box.append(element("label", {}, label, input));
    } else {
      const input = element(
        "textarea",
        { "aria-label": `${label} JSON`, rows: "8" },
        JSON.stringify(current, null, 2),
      );
      const status = element("p", { role: "status" });
      input.addEventListener("input", () => {
        try {
          const next = JSON.parse(input.value);
          input.setCustomValidity("");
          status.textContent = "";
          set(next);
          changed();
        } catch {
          onEdit();
          input.setCustomValidity("Enter valid JSON.");
          status.textContent = "Enter valid JSON. Your text is retained.";
        }
      });
      box.append(
        element("label", {}, `${label} (JSON)`, input),
        status,
        element(
          "details",
          {},
          element("summary", {}, "Schema"),
          element("pre", {}, JSON.stringify(schema, null, 2)),
        ),
      );
    }
    for (const detail of details.filter((item) => item.path === path)) {
      box.append(element("p", { role: "alert", className: "error" }, detailText(detail)));
    }
    return box;
  }
  function render() {
    root.replaceChildren(
      field(
        schema,
        draft,
        (next) => {
          draft = next;
        },
        "",
        "Configuration",
      ),
    );
  }
  render();
  return root;
}

export function configurationErrors(details: FieldErrors) {
  return element(
    "ul",
    { role: "alert", className: "error" },
    ...details.map((detail) =>
      element(
        "li",
        {},
        detail.path
          ? `Configuration setting ${settingPath(detail.path)}: ${detailText(detail)}`
          : detailText(detail),
      ),
    ),
  );
}

// Only resource-owned, same-origin actions may be used. A Driver supplies no executable UI.
export function configurationAction(
  descriptor: Pick<DriverConfigurationDescriptor, "actions">,
  name: keyof DriverConfigurationDescriptor["actions"],
) {
  const action = descriptor.actions?.[name];
  if (
    !action ||
    !["GET", "POST", "PUT"].includes(action.method) ||
    !/^\/[^/\\]/.test(action.href) ||
    action.href.includes("\\") ||
    new URL(action.href, location.origin).origin !== location.origin
  ) {
    throw new Error("The configuration action is unavailable.");
  }
  return action;
}
