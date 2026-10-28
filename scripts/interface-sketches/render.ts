import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as scene from "./scene.ts";
import type { Point, Rect, Side } from "./scene.ts";
import { theme } from "./theme.ts";

export type { Item, Sketch } from "./scene.ts";

const MAX_INPUT = 2_000_000;
const fontFaces = [
  { file: "LiberationSans-Regular.ttf", weight: 400, style: "normal" },
  { file: "LiberationSans-Bold.ttf", weight: 700, style: "normal" },
  { file: "LiberationSans-Italic.ttf", weight: 400, style: "italic" },
] as const;
const fontUrl = (file: string): URL => new URL(`./fonts/${file}`, import.meta.url);
const escapeXml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

/** Validate all items and references before accessing fonts or generating output. */
export function renderSvg(input: unknown): string {
  const sketch = scene.validateScene(input);
  const fonts = fontFaces
    .map(
      (face) =>
        `@font-face{font-family:"Liberation Sans";font-weight:${face.weight};font-style:${face.style};src:url(data:font/ttf;base64,${readFileSync(fontUrl(face.file)).toString("base64")}) format("truetype")}`,
    )
    .join("");
  const fontLicense = readFileSync(fontUrl("OFL.txt"), "utf8");
  const nodes = new Map<string, Rect>();
  for (const item of sketch.items) {
    if ((item.kind === "node" || item.kind === "box") && item.id) {
      nodes.set(item.id, item);
    }
  }
  const point = (p: Point): string => {
    if (Array.isArray(p)) {
      return p.join(",");
    }
    const n = nodes.get(p.node)!;
    const positions: Record<Side, [number, number]> = {
      left: [n.x, n.y + n.h / 2],
      right: [n.x + n.w, n.y + n.h / 2],
      top: [n.x + n.w / 2, n.y],
      bottom: [n.x + n.w / 2, n.y + n.h],
    };
    return positions[p.side].join(",");
  };
  const text = (
    x: number,
    y: number,
    s: string,
    size: number = theme.text.label.size,
    center = false,
    color: string = theme.ink,
    halo = false,
    weight: number = 400,
    style: string = "normal",
  ): string =>
    `<text x="${x}" y="${y}" text-anchor="${center ? "middle" : "start"}" font-family="Liberation Sans" font-size="${size}" font-weight="${weight}" font-style="${style}" fill="${color}"${halo ? ' paint-order="stroke" stroke="white" stroke-width="7" stroke-linejoin="round"' : ""}>${escapeXml(s)}</text>`;
  const box = (
    r: Rect,
    color: string = theme.line,
    dashed = false,
    radius = 10,
    fill = "white",
  ): string =>
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${Math.min(radius, r.w / 2, r.h / 2)}" fill="${fill}" stroke="${color}" stroke-width="1.9"${dashed ? ' stroke-dasharray="7 6"' : ""}/>`;
  const markers: string[] = [];
  const chunks = sketch.items.map((item, index) => {
    switch (item.kind) {
      case "box": {
        const region = theme.regions[item.role ?? "external"];
        return box(item, item.color ?? region.stroke, item.dashed, item.radius, region.fill);
      }
      case "node": {
        const region = theme.regions[item.role ?? "external"];
        const color = item.color ?? region.stroke;
        const titleLineCount = item.titleLineCount ?? 1;
        const inset = Math.min(8, item.w / 8, item.h / 4);
        const accentWidth = Math.min(4, item.w / 10);
        const accent = item.role
          ? `<rect x="${item.x + inset}" y="${item.y + inset}" width="${accentWidth}" height="${item.h - 2 * inset}" rx="${accentWidth / 2}" fill="${color}"/>`
          : "";
        return (
          box(item, color, false, 10, theme.node.fill) +
          accent +
          item.lines
            .map((s, i) =>
              text(
                item.x + (item.role ? Math.min(theme.node.padding, item.w / 2) : item.w / 2),
                item.y + item.h / 2 + 6 + (i - (item.lines.length - 1) / 2) * theme.node.stride,
                s,
                item.size ?? (i < titleLineCount ? theme.node.titleSize : theme.node.detailSize),
                !item.role,
                i < titleLineCount ? theme.ink : theme.detail,
                false,
                i < titleLineCount ? 700 : 400,
                i < titleLineCount ? "normal" : "italic",
              ),
            )
            .join("")
        );
      }
      case "text": {
        const style = theme.text[item.role ?? "label"];
        return text(
          item.x,
          item.y,
          item.text,
          item.size ?? style.size,
          item.center,
          item.color ?? style.color,
          item.halo,
          style.weight,
          style.style,
        );
      }
      case "line": {
        const color = item.color ?? theme.line;
        if (item.arrow !== false) {
          markers.push(
            `<marker id="arrow-${index}" markerUnits="userSpaceOnUse" markerWidth="15" markerHeight="14" refX="11" refY="7" orient="auto"><path d="M1 2 L11 7 L1 12" stroke="${color}" stroke-width="2" fill="none"/></marker>`,
          );
        }
        return `<polyline fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round"${item.dashed ? ' stroke-dasharray="8 7"' : ""}${item.arrow !== false ? ` marker-end="url(#arrow-${index})"` : ""} points="${item.points.map(point).join(" ")}"/>`;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sketch.width}" height="${sketch.height}" viewBox="0 0 ${sketch.width} ${sketch.height}"><title>${escapeXml(sketch.title)}</title><metadata>${escapeXml(fontLicense)}</metadata><defs><style>${fonts}</style>${markers.join("")}</defs><rect width="100%" height="100%" fill="white"/>${chunks.join("\n")}</svg>`;
}

/** Pure output API: no files are written. Font discovery and network are disabled. */
export async function render(input: unknown): Promise<{ svg: string; png: Buffer }> {
  const svg = renderSvg(input);
  const { Resvg } = await import("@resvg/resvg-js");
  const font = {
    fontFiles: fontFaces.map((face) => fileURLToPath(fontUrl(face.file))),
    loadSystemFonts: false,
    defaultFontFamily: "Liberation Sans",
  };
  const png = new Resvg(svg, { font }).render().asPng();
  return { svg, png };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("Usage: node scripts/interface-sketches/render.ts INPUT.json OUTPUT_PREFIX");
  }
  const [input, prefix] = args as [string, string];
  if (statSync(input).size > MAX_INPUT) {
    throw new Error("Invalid sketch: input exceeds 2 MB");
  }
  const data: unknown = JSON.parse(readFileSync(input, "utf8"));
  const { svg, png } = await render(data);
  writeFileSync(`${prefix}.svg`, svg);
  writeFileSync(`${prefix}.png`, png);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Rendering failed");
    process.exitCode = 1;
  });
}
