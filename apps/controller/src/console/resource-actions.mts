const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Stroke icons on a 24-unit grid: a square for Stop and a trash can for Delete.
const ACTION_ICONS = {
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
  delete: [
    ["path", { d: "M4 7h16" }],
    ["path", { d: "M10 11v6M14 11v6" }],
    ["path", { d: "M6 7l1 13h10l1-13" }],
    ["path", { d: "M9 7V4h6v3" }],
  ],
} as const;

export function resourceActionIcon(name: "stop" | "delete") {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const attributes = {
    class: "action-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [key, value] of Object.entries(attributes)) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, shapeAttributes] of ACTION_ICONS[name]) {
    const shape = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(shapeAttributes)) {
      shape.setAttribute(key, String(value));
    }
    svg.append(shape);
  }
  return svg;
}
