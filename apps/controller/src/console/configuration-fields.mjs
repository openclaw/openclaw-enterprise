import { button, element } from "./dom.mjs";

const pointer = (key) => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

function initialValue(schema) {
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
  schema,
  value,
  onChange,
  { disabled = false, details = [], onEdit = () => {} } = {},
) {
  const root = element("fieldset", { disabled, className: "configuration-fields" });
  let draft = structuredClone(value);
  const changed = () => {
    onEdit();
    onChange(structuredClone(draft));
  };

  function field(definition, current, set, path, name) {
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
    if (
      !complex &&
      definition.type === "object" &&
      definition.properties &&
      definition.additionalProperties === false
    ) {
      box.append(element("h4", {}, label));
      for (const [key, child] of Object.entries(definition.properties)) {
        const required = definition.required?.includes(key);
        const present = Object.hasOwn(current ?? {}, key);
        if (!required) {
          const include = element("input", {
            type: "checkbox",
            checked: present,
            "aria-label": `Include ${child.title ?? key}`,
          });
          include.addEventListener("change", () => {
            const next = { ...current };
            if (include.checked) {
              next[key] = initialValue(child);
            } else {
              delete next[key];
            }
            set(next);
            changed();
            render();
          });
          box.append(element("label", {}, include, `Include ${child.title ?? key}`));
        }
        if (required || present) {
          box.append(
            field(
              child,
              current?.[key],
              (next) => {
                current = { ...current, [key]: next };
                set(current);
              },
              `${path}/${pointer(key)}`,
              key,
            ),
          );
        }
      }
    } else if (
      !complex &&
      definition.type === "array" &&
      definition.items &&
      !Array.isArray(definition.items)
    ) {
      box.append(element("h4", {}, label));
      const values = Array.isArray(current) ? current : [];
      values.forEach((item, index) => {
        const row = field(
          definition.items,
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
            values.push(initialValue(definition.items));
            set(values);
            changed();
            render();
          },
          { disabled: values.length >= (definition.maxItems ?? Infinity) },
        ),
      );
    } else if (
      !complex &&
      (definition.enum || ["string", "number", "integer", "boolean"].includes(definition.type))
    ) {
      let input;
      if (definition.enum) {
        input = element(
          "select",
          { "aria-label": label },
          ...definition.enum.map((item, index) =>
            element("option", { value: index, selected: Object.is(item, current) }, String(item)),
          ),
        );
      } else {
        let type = "text";
        if (definition.type === "boolean") {
          type = "checkbox";
        } else if (["number", "integer"].includes(definition.type)) {
          type = "number";
        }
        input = element("input", {
          type,
          "aria-label": label,
        });
        if (definition.type === "boolean") {
          input.checked = current === true;
        } else {
          input.value = current ?? "";
        }
        for (const [source, target] of [
          ["minimum", "min"],
          ["maximum", "max"],
          ["minLength", "minlength"],
          ["maxLength", "maxlength"],
          ["pattern", "pattern"],
        ]) {
          if (definition[source] !== undefined) {
            input.setAttribute(target, definition[source]);
          }
        }
        if (definition.type === "integer") {
          input.step = "1";
        }
      }
      input.addEventListener("input", () => {
        let next = input.value;
        if (definition.enum) {
          next = definition.enum[Number(input.value)];
        } else if (definition.type === "boolean") {
          next = input.checked;
        } else if (["number", "integer"].includes(definition.type)) {
          next = input.value === "" ? null : Number(input.value);
        }
        set(next);
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
          element("pre", {}, JSON.stringify(definition, null, 2)),
        ),
      );
    }
    for (const detail of details.filter((item) => item.path === path)) {
      box.append(
        element("p", { role: "alert", className: "error" }, detail.message ?? detail.code),
      );
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
        schema.title ?? "Configuration",
      ),
    );
  }
  render();
  return root;
}

export function configurationErrors(details) {
  return element(
    "ul",
    { role: "alert", className: "error" },
    ...details.map((detail) =>
      element("li", {}, `${detail.path || "Configuration"}: ${detail.message ?? detail.code}`),
    ),
  );
}

// Only resource-owned, same-origin actions may be used. A Driver supplies no executable UI.
export function configurationAction(descriptor, name) {
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
