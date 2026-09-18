// Every value received from the API is inserted as text, never as HTML.
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") {
      node.className = value;
    } else if (
      typeof value === "boolean" &&
      ["disabled", "checked", "selected", "hidden", "required", "readonly"].includes(key)
    ) {
      node.toggleAttribute(key, value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

export function button(label, action, attributes = {}) {
  const node = element("button", { type: "button", ...attributes }, label);
  node.addEventListener("click", action);
  return node;
}
