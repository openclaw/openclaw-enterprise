/** Semantic authoring model. Use raw scenes when exact placement is required. */
import type { RegionRole } from "./theme.ts";

export type GroupRole = RegionRole;

export type Diagram = {
  title: string;
  subtitle?: string;
  groups: readonly {
    id: string;
    title: string;
    role?: GroupRole;
    parent?: string;
  }[];
  nodes: readonly {
    id: string;
    title: string;
    detail?: string;
    group?: string;
  }[];
  edges: readonly {
    from: string;
    to: string;
    label: string;
    kind?: "conditional" | "setup";
  }[];
  notes?: readonly string[];
  layout?: { direction?: "RIGHT" | "DOWN" };
};

export function validateDiagram(diagram: Diagram): void {
  const ids = new Set<string>();
  for (const entry of [...diagram.groups, ...diagram.nodes]) {
    if (!/^[a-z][a-z0-9_-]{0,127}$/.test(entry.id)) {
      throw new Error(`Invalid diagram: invalid id ${entry.id}`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`Invalid diagram: duplicate id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  const groups = new Map(diagram.groups.map((group) => [group.id, group]));
  for (const group of diagram.groups) {
    const seen = new Set([group.id]);
    let parent = group.parent;
    while (parent !== undefined) {
      if (!groups.has(parent)) {
        throw new Error(`Invalid diagram: missing group ${parent}`);
      }
      if (seen.has(parent)) {
        throw new Error(`Invalid diagram: group cycle at ${parent}`);
      }
      seen.add(parent);
      parent = groups.get(parent)!.parent;
    }
  }
  for (const node of diagram.nodes) {
    if (node.group !== undefined && !groups.has(node.group)) {
      throw new Error(`Invalid diagram: missing group ${node.group} for ${node.id}`);
    }
  }
  const nodes = new Set(diagram.nodes.map((node) => node.id));
  for (const edge of diagram.edges) {
    for (const id of [edge.from, edge.to]) {
      if (!nodes.has(id)) {
        throw new Error(`Invalid diagram: missing node endpoint ${id}`);
      }
    }
  }
  if (diagram.layout?.direction && !["RIGHT", "DOWN"].includes(diagram.layout.direction)) {
    throw new Error("Invalid diagram: unsupported direction");
  }
}
