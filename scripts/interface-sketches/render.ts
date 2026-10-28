import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Side = "left" | "right" | "top" | "bottom";
type Point = [number, number] | { node: string; side: Side };
type Rect = { id?: string; x: number; y: number; w: number; h: number };
export type Item =
  | (Rect & { kind: "box"; color?: string; dashed?: boolean; radius?: number })
  | (Rect & { kind: "node"; lines: string[]; size?: number; color?: string })
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size?: number;
      center?: boolean;
      color?: string;
      halo?: boolean;
    }
  | { kind: "line"; points: Point[]; color?: string; dashed?: boolean; arrow?: boolean };
export type Sketch = { title: string; width: number; height: number; items: Item[] };

const BLACK = "#262626";
const MAX_INPUT = 2_000_000;
const fontUrl = new URL("./fonts/Kalam-Regular.ttf", import.meta.url);
const escapeXml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

function fail(message: string): never {
  throw new Error(`Invalid sketch: ${message}`);
}
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected object");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(`unsupported field ${key}`);
  return obj;
}
function number(value: unknown, name: string, min = -100_000, max = 100_000): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(`invalid ${name}`);
}
function label(value: unknown, name: string): void {
  if (
    typeof value !== "string" ||
    value.length > 10_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value)
  )
    fail(`invalid ${name}`);
}
function validate(input: unknown): Sketch {
  const root = record(input, ["title", "width", "height", "items"]);
  label(root.title, "title");
  number(root.width, "width", 1, 8192);
  number(root.height, "height", 1, 8192);
  if ((root.width as number) * (root.height as number) > 16_000_000)
    fail("canvas exceeds 16 million pixels");
  if (!Array.isArray(root.items) || root.items.length > 5000) fail("invalid items");
  let complexity = 0;
  const ids = new Set<string>();
  for (const value of root.items) {
    const obj = record(value, [
      "kind",
      "id",
      "x",
      "y",
      "w",
      "h",
      "color",
      "dashed",
      "radius",
      "lines",
      "size",
      "text",
      "center",
      "halo",
      "points",
      "arrow",
    ]);
    let keys: string[];
    switch (obj.kind) {
      case "box":
        keys = ["id", "x", "y", "w", "h", "color", "dashed", "radius"];
        break;
      case "node":
        keys = ["id", "x", "y", "w", "h", "lines", "size", "color"];
        break;
      case "text":
        keys = ["x", "y", "text", "size", "center", "color", "halo"];
        break;
      case "line":
        keys = ["points", "color", "dashed", "arrow"];
        break;
      default:
        fail("unsupported kind");
    }
    record(obj, ["kind", ...keys]);
    for (const key of ["dashed", "center", "halo", "arrow"]) {
      if (key in obj && typeof obj[key] !== "boolean") fail(`invalid ${key}`);
    }
    if (
      "color" in obj &&
      (typeof obj.color !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(obj.color))
    )
      fail("invalid color (use #RGB or #RRGGBB)");
    if ("size" in obj) number(obj.size, "size", 1, 512);
    if ("radius" in obj) number(obj.radius, "radius", 0, 100_000);
    if (obj.kind !== "line") {
      number(obj.x, "x");
      number(obj.y, "y");
    }
    if (obj.kind === "box" || obj.kind === "node") {
      number(obj.w, "w", 0.01);
      number(obj.h, "h", 0.01);
      if ("id" in obj) {
        if (typeof obj.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(obj.id))
          fail("invalid id");
        if (ids.has(obj.id)) fail(`duplicate id ${obj.id}`);
        ids.add(obj.id);
      }
    }
    if (obj.kind === "text") {
      label(obj.text, "text");
      complexity += (obj.text as string).length;
    }
    if (obj.kind === "node") {
      if (!Array.isArray(obj.lines) || obj.lines.length > 100) fail("invalid lines");
      for (const line of obj.lines) {
        label(line, "node label");
        complexity += (line as string).length;
      }
    }
    if (obj.kind === "line") {
      if (!Array.isArray(obj.points) || obj.points.length < 2 || obj.points.length > 1000)
        fail("invalid points");
      complexity += obj.points.length;
      for (const point of obj.points) {
        if (Array.isArray(point)) {
          if (point.length !== 2) fail("point requires two coordinates");
          number(point[0], "point x");
          number(point[1], "point y");
        } else {
          const anchor = record(point, ["node", "side"]);
          if (typeof anchor.node !== "string") fail("invalid anchor");
          if (!["left", "right", "top", "bottom"].includes(anchor.side as string))
            fail("unknown anchor side");
        }
      }
    }
    if (complexity > 200_000) fail("content exceeds complexity limit");
  }
  const sketch = input as Sketch;
  for (const item of sketch.items)
    if (item.kind === "line") {
      for (const point of item.points)
        if (!Array.isArray(point) && !ids.has(point.node)) fail(`missing anchor ${point.node}`);
    }
  return sketch;
}

/** Validate all items and references before accessing fonts or generating output. */
export function renderSvg(input: unknown): string {
  const sketch = validate(input);
  const font = readFileSync(fontUrl).toString("base64");
  const nodes = new Map<string, Rect>();
  for (const item of sketch.items)
    if ((item.kind === "node" || item.kind === "box") && item.id) nodes.set(item.id, item);
  const point = (p: Point): string => {
    if (Array.isArray(p)) return p.join(",");
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
    size = 20,
    center = false,
    color = BLACK,
    halo = false,
  ): string =>
    `<text x="${x}" y="${y}" text-anchor="${center ? "middle" : "start"}" font-family="Kalam" font-size="${size}" fill="${color}"${halo ? ' paint-order="stroke" stroke="white" stroke-width="7" stroke-linejoin="round"' : ""}>${escapeXml(s)}</text>`;
  const box = (r: Rect, color = BLACK, dashed = false, radius = 16): string =>
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${Math.min(radius, r.w / 2, r.h / 2)}" fill="white" stroke="${color}" stroke-width="1.9"${dashed ? ' stroke-dasharray="7 6"' : ""}/>`;
  const markers: string[] = [];
  const chunks = sketch.items.map((item, index) => {
    switch (item.kind) {
      case "box":
        return box(item, item.color, item.dashed, item.radius);
      case "node":
        return (
          box(item, item.color) +
          item.lines
            .map((s, i) =>
              text(
                item.x + item.w / 2,
                item.y + item.h / 2 + 7 + (i - (item.lines.length - 1) / 2) * 26,
                s,
                item.size ?? 22,
                true,
              ),
            )
            .join("")
        );
      case "text":
        return text(item.x, item.y, item.text, item.size, item.center, item.color, item.halo);
      case "line": {
        const color = item.color ?? BLACK;
        if (item.arrow !== false)
          markers.push(
            `<marker id="arrow-${index}" markerUnits="userSpaceOnUse" markerWidth="15" markerHeight="14" refX="11" refY="7" orient="auto"><path d="M1 2 L11 7 L1 12" stroke="${color}" stroke-width="2" fill="none"/></marker>`,
          );
        return `<polyline fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round"${item.dashed ? ' stroke-dasharray="8 7"' : ""}${item.arrow !== false ? ` marker-end="url(#arrow-${index})"` : ""} points="${item.points.map(point).join(" ")}"/>`;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sketch.width}" height="${sketch.height}" viewBox="0 0 ${sketch.width} ${sketch.height}"><title>${escapeXml(sketch.title)}</title><defs><style>@font-face{font-family:Kalam;src:url(data:font/ttf;base64,${font}) format("truetype")}</style>${markers.join("")}</defs><rect width="100%" height="100%" fill="white"/>${chunks.join("\n")}</svg>`;
}

/** Pure output API: no files are written. Font discovery and network are disabled. */
export async function render(input: unknown): Promise<{ svg: string; png: Buffer }> {
  const svg = renderSvg(input);
  const { Resvg } = await import("@resvg/resvg-js");
  const font = {
    fontFiles: [fileURLToPath(fontUrl)],
    loadSystemFonts: false,
    defaultFontFamily: "Kalam",
  };
  const png = new Resvg(svg, { font }).render().asPng();
  return { svg, png };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2)
    throw new Error("Usage: node scripts/interface-sketches/render.ts INPUT.json OUTPUT_PREFIX");
  const [input, prefix] = args as [string, string];
  if (statSync(input).size > MAX_INPUT) fail("input exceeds 2 MB");
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
