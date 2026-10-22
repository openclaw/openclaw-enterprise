type DirectedEdge = Readonly<{ from: string; to: string }>;
type ImportEdge = DirectedEdge &
  Readonly<{
    kind: string;
    typeOnly: boolean;
    specifier: string;
    bindings: readonly string[];
  }>;

type GraphNode = {
  file: string;
  targets: Set<GraphNode>;
  index: number | undefined;
  low: number;
  active: boolean;
};

/** Strongly connected import groups, independent of source ordering or line numbers. */
export function findCycles(files: Iterable<string>, edges: Iterable<DirectedEdge>) {
  const nodes = new Map<string, GraphNode>(
    [...files]
      .sort()
      .map((file) => [file, { file, targets: new Set(), index: undefined, low: 0, active: false }]),
  );
  for (const edge of edges) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (source && target) {
      source.targets.add(target);
    }
  }
  const stack: GraphNode[] = [];
  const groups: string[][] = [];
  let next = 0;
  function visit(node: GraphNode): void {
    node.index = next;
    node.low = next++;
    stack.push(node);
    node.active = true;
    for (const target of node.targets) {
      if (target.index === undefined) {
        visit(target);
        node.low = Math.min(node.low, target.low);
      } else if (target.active) {
        node.low = Math.min(node.low, target.index);
      }
    }
    if (node.low !== node.index) {
      return;
    }
    const members: string[] = [];
    while (true) {
      const member = stack.pop();
      if (!member) {
        throw new Error("Cycle traversal stack is empty.");
      }
      member.active = false;
      members.push(member.file);
      if (member === node) {
        break;
      }
    }
    if (members.length > 1 || node.targets.has(node)) {
      groups.push(members.sort());
    }
  }
  for (const node of nodes.values()) {
    if (node.index === undefined) {
      visit(node);
    }
  }
  return Object.freeze(
    groups
      .sort((a, b) => a.join().localeCompare(b.join()))
      .map((members) => Object.freeze(members)),
  );
}

export function classifyCycles(files: readonly string[], edges: readonly ImportEdge[]) {
  // Anchors and path expressions locate dependencies without importing them.
  const imports = edges.filter((edge) => !["path", "dependency-anchor"].includes(edge.kind));
  const runtimeCycles = findCycles(
    files,
    imports.filter((edge) => !edge.typeOnly),
  );
  const typeInvolvingCycles = Object.freeze(
    findCycles(files, imports).filter((members) =>
      imports.some(
        (edge) => edge.typeOnly && members.includes(edge.from) && members.includes(edge.to),
      ),
    ),
  );
  const typeOnlyCycles = Object.freeze(
    typeInvolvingCycles.filter(
      (members) =>
        !runtimeCycles.some((runtime) => runtime.every((file) => members.includes(file))),
    ),
  );
  return Object.freeze({ runtimeCycles, typeOnlyCycles, typeInvolvingCycles });
}

export function cycleDiagnostic(
  members: readonly string[],
  edges: readonly ImportEdge[],
  typeOnly: boolean,
) {
  // Cycle exceptions use these exact JSON bytes. Reuse each serialized edge for
  // locale-aware sorting and the final array instead of serializing per comparison.
  const cycleEdges = edges
    .filter(
      (edge) =>
        !["path", "dependency-anchor"].includes(edge.kind) &&
        (typeOnly || !edge.typeOnly) &&
        members.includes(edge.from) &&
        members.includes(edge.to),
    )
    .map(({ from, to, kind, specifier, bindings, typeOnly: edgeTypeOnly }) =>
      JSON.stringify(
        typeOnly
          ? [from, to, kind, specifier, bindings, edgeTypeOnly]
          : [from, to, kind, specifier, bindings],
      ),
    )
    .sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    category: "policy",
    rule: typeOnly ? "type-only-cycle" : "runtime-cycle",
    from: members[0],
    to: members.join(" -> "),
    specifier: `[${cycleEdges.join(",")}]`,
    kind: "cycle",
    typeOnly,
    bindings: Object.freeze([]),
    line: 1,
    message: `${typeOnly ? "Type-only" : "Runtime"} import cycle; members are reported in sorted order, not execution order.`,
  });
}
