type Edge = {
  from: string;
  to: string;
  kind: string;
  specifier: string;
  bindings: readonly string[];
  typeOnly: boolean;
};

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error("Missing cycle graph entry.");
  }
  return value;
}

/** Strongly connected import groups, independent of source ordering or line numbers. */
export function findCycles(files: readonly string[], edges: readonly Edge[]) {
  const adjacent = new Map([...files].sort().map((file) => [file, new Set<string>()]));
  for (const edge of edges) {
    if (adjacent.has(edge.from) && adjacent.has(edge.to)) {
      required(adjacent, edge.from).add(edge.to);
    }
  }
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const groups: string[][] = [];
  let next = 0;
  function visit(file: string) {
    indices.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const target of required(adjacent, file)) {
      if (!indices.has(target)) {
        visit(target);
        low.set(file, Math.min(required(low, file), required(low, target)));
      } else if (active.has(target)) {
        low.set(file, Math.min(required(low, file), required(indices, target)));
      }
    }
    if (low.get(file) !== indices.get(file)) {
      return;
    }
    const members: string[] = [];
    let member: string;
    do {
      const popped = stack.pop();
      if (popped === undefined) {
        throw new Error("Missing cycle stack entry.");
      }
      member = popped;
      active.delete(member);
      members.push(member);
    } while (member !== file);
    if (members.length > 1 || required(adjacent, file).has(file)) {
      groups.push(members.sort());
    }
  }
  for (const file of adjacent.keys()) {
    if (!indices.has(file)) {
      visit(file);
    }
  }
  return Object.freeze(
    groups.sort((a, b) => a.join().localeCompare(b.join())).map((group) => Object.freeze(group)),
  );
}

export function classifyCycles(files: readonly string[], edges: readonly Edge[]) {
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
  edges: readonly Edge[],
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
