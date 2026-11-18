import { element } from "../dom.mjs";

export function additionalModelChoices(change: (id: string, selected: boolean) => void) {
  const fields = element("fieldset", { "aria-label": "Additional models" });
  const section = element(
    "details",
    { className: "additional-models", hidden: true },
    element("summary", {}, "Additional models"),
    element(
      "p",
      { className: "hint" },
      "Allow these models for session switching. The model chosen above stays the default.",
    ),
    fields,
  );
  let lastOptions: string[] = [];
  return {
    section,
    fields,
    update(primary: string, choices: readonly string[], selected: readonly string[]) {
      const options = [...new Set([...choices, ...selected])].filter((id) => id !== primary);
      section.hidden = !primary || !options.length;
      if (lastOptions.length !== options.length || options.some((id, i) => lastOptions[i] !== id)) {
        fields.replaceChildren(
          ...options.map((id) => {
            const box = element("input", { type: "checkbox", value: id });
            box.addEventListener("change", () => change(id, box.checked));
            return element("label", {}, box, id);
          }),
        );
        lastOptions = options;
      }
      const allowed = new Set(selected);
      for (const box of fields.querySelectorAll("input")) {
        box.checked = allowed.has(box.value);
      }
    },
  };
}
