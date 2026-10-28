export type RegionRole = "control" | "runtime" | "boundary" | "external";
export type TextRole = "title" | "subtitle" | "group" | "label" | "note";

export const theme = {
  ink: "#243247",
  detail: "#4b5563",
  line: "#64748b",
  regions: {
    control: { stroke: "#53799d", fill: "#f0f5fb" },
    runtime: { stroke: "#427b76", fill: "#eef7f5" },
    boundary: { stroke: "#967234", fill: "#fcf7ec" },
    external: { stroke: "#737b87", fill: "#f5f6f8" },
  },
  text: {
    title: { size: 34, weight: 700, style: "normal", color: "#243247" },
    subtitle: { size: 17, weight: 400, style: "normal", color: "#4b5563" },
    group: { size: 16, weight: 700, style: "normal", color: "#405875" },
    label: { size: 15, weight: 400, style: "normal", color: "#243247" },
    note: { size: 14, weight: 400, style: "italic", color: "#4b5563" },
  },
  node: { titleSize: 18, detailSize: 15, stride: 24, fill: "#ffffff", padding: 20 },
} as const;
