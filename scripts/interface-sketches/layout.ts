import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkExtendedEdge, ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import { widestLine, wrap } from "./measure.ts";
import { theme, type TextRole } from "./theme.ts";
import { validateDiagram, type Diagram } from "./diagram.ts";
import type { Item, Sketch } from "./scene.ts";

const MARGIN = 24;
const ROOT = "$root";

function prepareGraph(diagram: Diagram, direction: "RIGHT" | "DOWN") {
  const nodeLines = new Map<
    string,
    Pick<Extract<Item, { kind: "node" }>, "lines" | "titleLineCount">
  >();
  const groupLines = new Map<string, string[]>();
  const elements = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: ROOT,
    children: [],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.randomSeed": "1",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
      "elk.spacing.nodeNode": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "28",
      "elk.spacing.edgeLabel": "6",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
  };
  elements.set(ROOT, root);
  for (const group of diagram.groups) {
    const lines = wrap(
      group.title,
      theme.text.group.size,
      "Bold",
      direction === "DOWN" ? 200 : 320,
    );
    groupLines.set(group.id, lines);
    const minWidth = Math.ceil(Math.max(56, widestLine(lines, theme.text.group.size, "Bold")) + 32);
    elements.set(group.id, {
      id: group.id,
      children: [],
      width: minWidth,
      height: 32 + lines.length * 22,
      layoutOptions: {
        "elk.direction": direction,
        "elk.padding": `[top=${16 + lines.length * 22},left=16,bottom=16,right=16]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${minWidth},${32 + lines.length * 22})`,
      },
    });
  }
  for (const group of diagram.groups) {
    elements.get(group.parent ?? ROOT)!.children!.push(elements.get(group.id)!);
  }
  for (const node of diagram.nodes) {
    const { titleSize, detailSize, padding, stride } = theme.node;
    const title = wrap(node.title, titleSize, "Bold", 360);
    const detail = node.detail ? wrap(node.detail, detailSize, "Italic", 210) : [];
    const lines = [...title, ...detail];
    nodeLines.set(node.id, {
      lines,
      ...(title.length > 1 ? { titleLineCount: title.length } : {}),
    });
    const textWidth = Math.max(
      56,
      widestLine(title, titleSize, "Bold"),
      widestLine(detail, detailSize, "Italic"),
    );
    const element: ElkNode = {
      id: node.id,
      width: Math.ceil(textWidth + 2 * padding),
      height: 22 + lines.length * stride,
    };
    elements.get(node.group ?? ROOT)!.children!.push(element);
  }
  const edgeLines = diagram.edges.map((edge) =>
    wrap(
      `${edge.kind ? `${edge.kind === "setup" ? "Setup" : "Conditional"}: ` : ""}${edge.label}`,
      theme.text.label.size,
      "Regular",
      160,
    ),
  );
  // Route both directions between a pair of regions through the same corridor.
  // The first connection sets the layout direction; the scene restores each
  // arrow to the source and target the author specified.
  const parents = new Map(diagram.groups.map((group) => [group.id, group.parent]));
  const region = new Map(
    diagram.nodes.map((node) => {
      let id = node.group ?? node.id;
      while (parents.get(id)) {
        id = parents.get(id)!;
      }
      return [node.id, id];
    }),
  );
  const outbound = new Set<string>();
  root.edges = diagram.edges.map((edge, index): ElkExtendedEdge => {
    let from = region.get(edge.from)!;
    let to = region.get(edge.to)!;
    if (from === to) {
      from = edge.from;
      to = edge.to;
    }
    const reply = from !== to && outbound.has(`${to}>${from}`);
    if (!reply) {
      outbound.add(`${from}>${to}`);
    }
    const lines = edgeLines[index];
    return {
      id: `$edge-${index}`,
      sources: [reply ? edge.to : edge.from],
      targets: [reply ? edge.from : edge.to],
      labels: [
        {
          text: lines.join("\n"),
          width: Math.ceil(widestLine(lines, theme.text.label.size, "Regular") + 8),
          height: lines.length * 19 + 4,
          ...(direction === "DOWN"
            ? { layoutOptions: { "elk.edgeLabels.placement": "HEAD" } }
            : {}),
        },
      ],
    };
  });
  return { root, nodeLines, groupLines, edgeLines };
}

function absolutePositions(graph: ElkNode, left: number, top: number) {
  const positions = new Map<string, { x: number; y: number; node: ElkNode }>();
  function collect(node: ElkNode, x: number, y: number): void {
    const position = { x: x + (node.x ?? 0), y: y + (node.y ?? 0), node };
    positions.set(node.id, position);
    for (const child of node.children ?? []) {
      collect(child, position.x, position.y);
    }
  }
  collect(graph, left, top);
  return positions;
}

function routedEdges(
  diagram: Diagram,
  positions: ReturnType<typeof absolutePositions>,
  edgeLines: string[][],
) {
  const lines: Item[] = [];
  const labels: { lines: string[]; x: number; y: number }[] = [];
  const segments: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const { node: owner } of positions.values()) {
    for (const edge of owner.edges ?? []) {
      const index = Number(edge.id.slice("$edge-".length));
      const origin = positions.get(edge.container ?? owner.id)!;
      if (!origin || !edge.sections?.length) {
        throw new Error(`Layout did not route edge ${index}`);
      }
      for (const section of edge.sections) {
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
          (point): [number, number] => [origin.x + point.x, origin.y + point.y],
        );
        for (let i = 1; i < points.length; i++) {
          const [x1, y1] = points[i - 1];
          const [x2, y2] = points[i];
          segments.push({
            left: Math.min(x1, x2),
            right: Math.max(x1, x2),
            top: Math.min(y1, y2),
            bottom: Math.max(y1, y2),
          });
        }
        const reply = edge.sources[0] !== diagram.edges[index].from;
        lines.push({
          kind: "line",
          points: reply ? points.reverse() : points,
          dashed: diagram.edges[index].kind !== undefined,
          arrow: reply ? !section.incomingSections?.length : !section.outgoingSections?.length,
        });
      }
      for (const label of edge.labels ?? []) {
        labels.push({
          lines: edgeLines[index],
          x: origin.x + (label.x ?? 0) + 4,
          y: origin.y + (label.y ?? 0) + 16,
        });
      }
    }
  }
  return { lines, labels, segments };
}

function compileScene(
  diagram: Diagram,
  graph: ElkNode,
  { nodeLines, groupLines, edgeLines }: ReturnType<typeof prepareGraph>,
): Sketch {
  const groups = new Map(diagram.groups.map((group) => [group.id, group]));
  const contentWidth = Math.max(520, graph.width ?? 0);
  const headingWidth = Math.min(1000, contentWidth);
  const titleLines = wrap(diagram.title, theme.text.title.size, "Bold", headingWidth);
  const subtitleLines = diagram.subtitle
    ? wrap(diagram.subtitle, theme.text.subtitle.size, "Regular", headingWidth)
    : [];
  const graphTop = MARGIN + titleLines.length * 44 + subtitleLines.length * 26 + 20;
  const items: Item[] = [];
  function textLines(lines: string[], x: number, y: number, stride: number, role: TextRole): void {
    lines.forEach((text, index) =>
      items.push({
        kind: "text",
        x,
        y: y + index * stride,
        text,
        size: theme.text[role].size,
        role,
        ...(role === "label" ? { halo: true } : {}),
      }),
    );
  }
  textLines(titleLines, MARGIN, MARGIN + theme.text.title.size, 44, "title");
  textLines(
    subtitleLines,
    MARGIN,
    MARGIN + titleLines.length * 44 + theme.text.subtitle.size,
    26,
    "subtitle",
  );
  const positions = absolutePositions(graph, MARGIN, graphTop);
  const headings: { lines: string[]; x: number; y: number; width: number }[] = [];
  for (const { node, x, y } of positions.values()) {
    const group = groups.get(node.id);
    if (group) {
      items.push({
        kind: "box",
        id: node.id,
        x,
        y,
        w: node.width!,
        h: node.height!,
        role: group.role ?? "boundary",
      });
      headings.push({
        lines: groupLines.get(node.id)!,
        x: x + 16,
        y: y + 23,
        width: node.width! - 32,
      });
    }
  }
  for (const node of diagram.nodes) {
    const { x, y, node: element } = positions.get(node.id)!;
    items.push({
      kind: "node",
      id: node.id,
      x,
      y,
      w: element.width!,
      h: element.height!,
      ...nodeLines.get(node.id)!,
      role: groups.get(node.group ?? "")?.role ?? "runtime",
    });
  }
  const routes = routedEdges(diagram, positions, edgeLines);
  items.push(...routes.lines);
  // Boundary-crossing routes may enter the header from above. Place the
  // heading in the first clear horizontal interval within its reserved band.
  for (const heading of headings) {
    const size = theme.text.group.size;
    const occupied = routes.segments.filter(
      (s) =>
        s.top <= heading.y + (heading.lines.length - 1) * 22 + 4 && s.bottom >= heading.y - size,
    );
    const textWidth = widestLine(heading.lines, size, "Bold");
    let x = heading.x;
    for (const span of occupied.sort((a, b) => a.left - b.left)) {
      if (span.left >= x + textWidth + 5) {
        break;
      }
      if (span.right >= x - 5) {
        x = span.right + 5;
      }
    }
    textLines(
      heading.lines,
      x + textWidth <= heading.x + heading.width ? x : heading.x,
      heading.y,
      22,
      "group",
    );
  }
  for (const label of routes.labels) {
    textLines(label.lines, label.x, label.y, 19, "label");
  }
  let bottom = graphTop + (graph.height ?? 0);
  for (const note of diagram.notes ?? []) {
    const lines = wrap(note, theme.text.note.size, "Italic", Math.min(1000, contentWidth));
    bottom += 10;
    textLines(lines, MARGIN, bottom + theme.text.note.size, 20, "note");
    bottom += lines.length * 20;
  }
  return {
    title: diagram.title,
    width: Math.ceil(contentWidth + MARGIN * 2),
    height: Math.ceil(bottom + MARGIN),
    items,
  };
}

/** Choose the orientation that fits most legibly into a landscape review window. */
export async function compileDiagram(diagram: Diagram): Promise<Sketch> {
  validateDiagram(diagram);
  // The bundled CommonJS export is the constructor, despite its ESM declaration.
  const Elk = ELK as unknown as { new (): ElkEngine };
  const elk = new Elk();
  const directions = diagram.layout?.direction
    ? [diagram.layout.direction]
    : (["RIGHT", "DOWN"] as const);
  let best: Sketch | undefined;
  let bestScore = Infinity;
  for (const direction of directions) {
    const prepared = prepareGraph(diagram, direction);
    const graph = await elk.layout(prepared.root);
    const scene = compileScene(diagram, graph, prepared);
    if (scene.width > 8192 || scene.height > 8192 || scene.width * scene.height > 16_000_000) {
      continue;
    }
    const score = Math.max(scene.width / 1.65, scene.height) + Math.max(0, scene.width - 1600);
    if (score < bestScore) {
      best = scene;
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error("Diagram exceeds scene size limits; split it into smaller diagrams");
  }
  return best;
}
