import { element } from "./dom.mjs";

const displayName =
  document.querySelector('meta[name="occ-console-display-name"]')?.content ?? "OpenClaw Enterprise";
const logoUrl =
  document.querySelector('meta[name="occ-console-logo"]')?.content ?? "/console/oce-mascot.png";

export function brandContents(size) {
  return [
    element("img", { src: logoUrl, alt: "", width: String(size), height: String(size) }),
    element("span", { className: "brand-name", title: displayName }, displayName),
  ];
}
