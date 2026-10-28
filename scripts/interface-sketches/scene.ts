import { theme } from "./theme.ts";
import type { RegionRole, TextRole } from "./theme.ts";

export type Side = "left" | "right" | "top" | "bottom";
export type Point = [number, number] | { node: string; side: Side };
export type Rect = { id?: string; x: number; y: number; w: number; h: number };
export type Item =
  | (Rect & { kind: "box"; role?: RegionRole; color?: string; dashed?: boolean; radius?: number })
  | (Rect & {
      kind: "node";
      role?: RegionRole;
      lines: string[];
      titleLineCount?: number;
      size?: number;
      color?: string;
    })
  | {
      kind: "text";
      role?: TextRole;
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

function fail(message: string): never {
  throw new Error(`Invalid sketch: ${message}`);
}
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("expected object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`unsupported field ${key}`);
    }
  }
  return obj;
}
function number(value: unknown, name: string, min = -100_000, max = 100_000): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`invalid ${name}`);
  }
}
function label(value: unknown, name: string): void {
  if (
    typeof value !== "string" ||
    value.length > 10_000 ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      );
    })
  ) {
    fail(`invalid ${name}`);
  }
}
export function validateScene(input: unknown): Sketch {
  const root = record(input, ["title", "width", "height", "items"]);
  label(root.title, "title");
  number(root.width, "width", 1, 8192);
  number(root.height, "height", 1, 8192);
  if ((root.width as number) * (root.height as number) > 16_000_000) {
    fail("canvas exceeds 16 million pixels");
  }
  if (!Array.isArray(root.items) || root.items.length > 5000) {
    fail("invalid items");
  }
  let complexity = 0;
  const ids = new Set<string>();
  for (const value of root.items) {
    const obj = record(value, [
      "kind",
      "role",
      "id",
      "x",
      "y",
      "w",
      "h",
      "color",
      "dashed",
      "radius",
      "lines",
      "titleLineCount",
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
        keys = ["role", "id", "x", "y", "w", "h", "color", "dashed", "radius"];
        break;
      case "node":
        keys = ["role", "id", "x", "y", "w", "h", "lines", "titleLineCount", "size", "color"];
        break;
      case "text":
        keys = ["role", "x", "y", "text", "size", "center", "color", "halo"];
        break;
      case "line":
        keys = ["points", "color", "dashed", "arrow"];
        break;
      default:
        fail("unsupported kind");
    }
    record(obj, ["kind", ...keys]);
    if ("role" in obj) {
      const roles = obj.kind === "text" ? Object.keys(theme.text) : Object.keys(theme.regions);
      if (typeof obj.role !== "string" || !roles.includes(obj.role)) {
        fail("invalid role");
      }
    }
    for (const key of ["dashed", "center", "halo", "arrow"]) {
      if (key in obj && typeof obj[key] !== "boolean") {
        fail(`invalid ${key}`);
      }
    }
    if (
      "color" in obj &&
      (typeof obj.color !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(obj.color))
    ) {
      fail("invalid color (use #RGB or #RRGGBB)");
    }
    if ("size" in obj) {
      number(obj.size, "size", 1, 512);
    }
    if ("radius" in obj) {
      number(obj.radius, "radius", 0, 100_000);
    }
    if (obj.kind !== "line") {
      number(obj.x, "x");
      number(obj.y, "y");
    }
    if (obj.kind === "box" || obj.kind === "node") {
      number(obj.w, "w", 0.01);
      number(obj.h, "h", 0.01);
      if ("id" in obj) {
        if (typeof obj.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(obj.id)) {
          fail("invalid id");
        }
        if (ids.has(obj.id)) {
          fail(`duplicate id ${obj.id}`);
        }
        ids.add(obj.id);
      }
    }
    if (obj.kind === "text") {
      label(obj.text, "text");
      complexity += (obj.text as string).length;
    }
    if (obj.kind === "node") {
      if (!Array.isArray(obj.lines) || obj.lines.length > 100) {
        fail("invalid lines");
      }
      if ("titleLineCount" in obj) {
        number(obj.titleLineCount, "titleLineCount", 1, obj.lines.length);
        if (!Number.isInteger(obj.titleLineCount)) {
          fail("invalid titleLineCount");
        }
      }
      for (const line of obj.lines) {
        label(line, "node label");
        complexity += (line as string).length;
      }
    }
    if (obj.kind === "line") {
      if (!Array.isArray(obj.points) || obj.points.length < 2 || obj.points.length > 1000) {
        fail("invalid points");
      }
      complexity += obj.points.length;
      for (const point of obj.points) {
        if (Array.isArray(point)) {
          if (point.length !== 2) {
            fail("point requires two coordinates");
          }
          number(point[0], "point x");
          number(point[1], "point y");
        } else {
          const anchor = record(point, ["node", "side"]);
          if (typeof anchor.node !== "string") {
            fail("invalid anchor");
          }
          if (!["left", "right", "top", "bottom"].includes(anchor.side as string)) {
            fail("unknown anchor side");
          }
        }
      }
    }
    if (complexity > 200_000) {
      fail("content exceeds complexity limit");
    }
  }
  const sketch = input as Sketch;
  for (const item of sketch.items) {
    if (item.kind === "line") {
      for (const point of item.points) {
        if (!Array.isArray(point) && !ids.has(point.node)) {
          fail(`missing anchor ${point.node}`);
        }
      }
    }
  }
  return sketch;
}
