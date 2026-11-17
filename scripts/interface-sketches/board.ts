import { validateDiagram, type Diagram, type Pin } from "./diagram.ts";
import { widestLine, wrap } from "./measure.ts";
import { textBlock, validateScene, type Item, type Rect, type Side, type Sketch } from "./scene.ts";
import { theme, type TextRole } from "./theme.ts";

function fail(message: string): never {
  throw new Error(`Invalid board: ${message}`);
}

function tuple(value: readonly number[] | undefined, length: number, owner: string): void {
  if (!Array.isArray(value) || value.length !== length || value.some((n) => !Number.isFinite(n))) {
    fail(`${owner} requires ${length} finite pin coordinates`);
  }
}

function rectangle(pin: Pin | undefined, parent: Rect, owner: string): Rect {
  tuple(pin, 4, owner);
  const [x, y, w, h] = pin!;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > parent.w || y + h > parent.h) {
    fail(
      `${owner} pin [${pin}] exceeds parent ${parent.id ?? "board"} available ${parent.w}x${parent.h}`,
    );
  }
  return { id: owner, x: parent.x + x, y: parent.y + y, w, h };
}

function center(rect: Rect, side: Side): [number, number] {
  switch (side) {
    case "left":
      return [rect.x, rect.y + rect.h / 2];
    case "right":
      return [rect.x + rect.w, rect.y + rect.h / 2];
    case "top":
      return [rect.x + rect.w / 2, rect.y];
    case "bottom":
      return [rect.x + rect.w / 2, rect.y + rect.h];
  }
}

function facing(from: Rect, to: Rect): [Side, Side] {
  const pairs: [Side, Side][] = [
    ["right", "left"],
    ["left", "right"],
    ["bottom", "top"],
    ["top", "bottom"],
  ];
  return pairs.reduce((best, pair) => {
    const distance = ([a, b]: [Side, Side]) => {
      const start = center(from, a);
      const end = center(to, b);
      return Math.hypot(start[0] - end[0], start[1] - end[1]);
    };
    return distance(pair) < distance(best) ? pair : best;
  });
}

/** Compile explicit parent-relative geometry without layout or text scaling. */
export function compileBoard(diagram: Diagram): Sketch {
  validateDiagram(diagram);
  const size = diagram.layout?.board;
  tuple(size, 2, "board");
  const [width, height] = size!;
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 16_000_000) {
    fail("board size exceeds canvas limits");
  }
  const board: Rect = { x: 0, y: 0, w: width, h: height };
  const items: Item[] = [];
  const positions = new Map<string, Rect>();
  const groups = new Map(diagram.groups.map((group) => [group.id, group]));
  function point(value: readonly [number, number], owner: string): void {
    tuple(value, 2, owner);
    if (value[0] < 0 || value[1] < 0 || value[0] > width || value[1] > height) {
      fail(`${owner} coordinates exceed board ${width}x${height}`);
    }
  }
  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    role: TextRole,
    owner: string,
    available = width - x,
  ): void {
    point([x, y], owner);
    const item: Extract<Item, { kind: "text" }> = {
      kind: "text",
      text: value,
      x,
      y,
      size,
      role,
      ...(role === "label" ? { backdrop: true, lineHeight: 16 } : {}),
    };
    const bounds = textBlock(item);
    if (
      (role !== "label" && value.includes("\n")) ||
      bounds.x < 0 ||
      bounds.x + bounds.w > x + available ||
      bounds.y < 0 ||
      bounds.y + bounds.h > height
    ) {
      fail(
        `${owner} text needs ${Math.ceil(bounds.w)}px width and ${size}px above baseline; available ${available}px at [${x},${y}]`,
      );
    }
    items.push(item);
  }
  function groupPosition(id: string): Rect {
    const existing = positions.get(id);
    if (existing) {
      return existing;
    }
    const group = groups.get(id)!;
    const parent = group.parent ? groupPosition(group.parent) : board;
    const rect = rectangle(group.pin, parent, id);
    positions.set(id, rect);
    items.push({ kind: "box", ...rect, role: group.role ?? "boundary" });
    text(group.title, rect.x + 12, rect.y + 18, 16, "group", id, rect.w - 24);
    if (rect.h < 22) {
      fail(`${id} frame needs at least 22px height for its heading`);
    }
    return rect;
  }
  text(diagram.title, 20, 33, 28, "title", "title", width - 40);
  if (diagram.subtitle) {
    text(diagram.subtitle, 20, 55, 16, "subtitle", "subtitle", width - 40);
  }
  for (const group of diagram.groups) {
    groupPosition(group.id);
  }
  for (const node of diagram.nodes) {
    const rect = rectangle(node.pin, node.group ? groupPosition(node.group) : board, node.id);
    positions.set(node.id, rect);
    const { titleSize, detailSize, stride, padding } = theme.compactNode;
    const available = rect.w - padding * 2;
    if (available <= 0) {
      fail(
        `${node.id} text available width ${available}px; needs more than ${padding * 2}px card width`,
      );
    }
    const title = wrap(node.title, titleSize, "Bold", available);
    const detail = node.detail ? wrap(node.detail, detailSize, "Italic", available) : [];
    const lines = [...title, ...detail];
    const neededHeight = lines.length === 1 ? 40 : 15 + lines.length * stride;
    const neededWidth = Math.max(
      widestLine(title, titleSize, "Bold"),
      widestLine(detail, detailSize, "Italic"),
    );
    if (neededHeight > rect.h || neededWidth > available) {
      fail(
        `${node.id} text available ${available}x${rect.h}px; needs ${Math.ceil(neededWidth)}x${neededHeight}px (${lines.length} lines)`,
      );
    }
    items.push({
      kind: "node",
      ...rect,
      lines,
      titleLineCount: title.length,
      density: "compact",
      role: groups.get(node.group ?? "")?.role ?? "runtime",
    });
  }
  for (const edge of diagram.edges) {
    const owner = `edge ${edge.from} → ${edge.to}`;
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
    const defaults = facing(from, to);
    const startSide = edge.pin?.from ?? defaults[0];
    const endSide = edge.pin?.to ?? defaults[1];
    for (const side of [startSide, endSide]) {
      if (!["left", "right", "top", "bottom"].includes(side)) {
        fail(`${owner} has invalid side ${side}`);
      }
    }
    const via = edge.pin?.via ?? [];
    for (const p of via) {
      point(p, owner);
    }
    items.push({
      kind: "line",
      points: [
        { node: edge.from, side: startSide },
        ...via.map(([x, y]): [number, number] => [x, y]),
        { node: edge.to, side: endSide },
      ],
      dashed: edge.kind !== undefined,
      arrow: true,
    });
    const start = center(from, startSide);
    const end = center(to, endSide);
    const label = edge.pin?.label ?? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    tuple(label, 2, `${owner} label`);
    text(edge.label, label[0], label[1], 14, "label", owner);
  }
  let bottom = Math.max(64, ...[...positions.values()].map((rect) => rect.y + rect.h));
  for (const note of diagram.notes ?? []) {
    bottom += 22;
    for (const line of wrap(note, 14, "Italic", width - 40)) {
      text(line, 20, bottom, 14, "note", "footer note", width - 40);
      bottom += 18;
    }
    bottom -= 18;
  }
  return validateScene({ title: diagram.title, width, height, items });
}
