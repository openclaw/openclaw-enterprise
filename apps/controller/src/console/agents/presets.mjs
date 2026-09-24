import { element, button } from "../dom.mjs";
import { renderPresetTemplate } from "../preset-variables.mjs";
import { message, namespacePath } from "./list.mjs";

export function createPresetFields(context, apply) {
  const selector = element(
    "select",
    { id: "agent-preset", disabled: true },
    element("option", { value: "" }, "Choose a Preset"),
  );
  const status = element("p", { className: "hint", role: "status" }, "Loading Presets…");
  const feedback = element("p", { className: "error", role: "alert" });
  const inputs = element("div");
  let selected;
  let fields = [];
  const applyButton = button("Use Preset", () => {
    if (!selected) {
      return;
    }
    try {
      const values = Object.create(null);
      for (const { name, definition, input } of fields) {
        if (!input.reportValidity()) {
          return;
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
              : input.value;
      }
      const rendered = renderPresetTemplate(selected.template, values);
      apply(rendered);
      for (const { definition, input } of fields) {
        if (definition.type === "password") {
          input.value = "";
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
    element("label", { for: selector.id }, "Preset template"),
    selector,
    status,
    inputs,
    applyButton,
    feedback,
  );
  applyButton.disabled = true;
  selector.addEventListener("change", async () => {
    const selectedId = selector.value;
    selected = undefined;
    fields = [];
    inputs.replaceChildren();
    feedback.textContent = "";
    applyButton.disabled = true;
    if (!selectedId) {
      status.textContent = "Choose a Preset or start without one.";
      return;
    }
    selector.disabled = true;
    status.textContent = "Loading Preset…";
    try {
      const preset = await context.request(
        `${namespacePath(context.namespaceId)}/presets/${encodeURIComponent(selectedId)}`,
      );
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      selected = preset;
      fields = Object.entries(preset.template.variables ?? {}).map(([name, definition]) => {
        const input =
          definition.type === "boolean"
            ? element(
                "select",
                { id: `preset-variable-${name}` },
                element("option", { value: "" }, "Choose a value"),
                element("option", { value: "true" }, "True"),
                element("option", { value: "false" }, "False"),
              )
            : element("input", {
                id: `preset-variable-${name}`,
                type: definition.type === "string" ? "text" : definition.type,
                ...(definition.type === "number" ? { step: "any" } : {}),
                autocomplete: "off",
                ...(definition.type === "password" ? { spellcheck: "false", required: true } : {}),
              });
        input.dataset.supplied = String(Object.hasOwn(definition, "default"));
        input.value = definition.default === undefined ? "" : String(definition.default);
        input.addEventListener("input", () => {
          input.dataset.supplied = "true";
          feedback.textContent = "";
        });
        input.addEventListener("change", () => {
          input.dataset.supplied = "true";
        });
        inputs.append(
          element(
            "div",
            { className: "form-field" },
            element("label", { for: input.id }, `Variable: ${name}`),
            input,
            definition.description
              ? element("p", { className: "hint" }, definition.description)
              : null,
          ),
        );
        return { name, definition, input };
      });
      status.textContent =
        "Fill in the variables, then use this Preset to create an editable draft.";
      applyButton.disabled = false;
    } catch (error) {
      if (!context.isCurrent() || !section.isConnected) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = message(error);
      }
    } finally {
      selector.disabled = false;
    }
  });
  context
    .request(`${namespacePath(context.namespaceId)}/presets`)
    .then((presets) => {
      if (!context.isCurrent()) {
        return;
      }
      selector.append(
        ...presets.map((preset) => element("option", { value: preset.id }, preset.name)),
      );
      selector.disabled = false;
      status.textContent = presets.length
        ? "Choose a Preset or start with the standard defaults."
        : "No Presets in this Namespace.";
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        status.textContent = `Presets unavailable. ${message(error)} You can continue without one.`;
      }
    });
  return section;
}
