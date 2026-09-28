/** Strongly connected import groups, independent of source ordering or line numbers. */
export function findCycles(files, edges) {
  const adjacent = new Map([...files].sort().map((file) => [file, new Set()]));
  for (const edge of edges) {
    if (adjacent.has(edge.from) && adjacent.has(edge.to)) {
      adjacent.get(edge.from).add(edge.to);
    }
  }
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const groups = [];
  let next = 0;
  function visit(file) {
    indices.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const target of adjacent.get(file)) {
      if (!indices.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (active.has(target)) {
        low.set(file, Math.min(low.get(file), indices.get(target)));
      }
    }
    if (low.get(file) !== indices.get(file)) {
      return;
    }
    const members = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      members.push(member);
    } while (member !== file);
    if (members.length > 1 || adjacent.get(file).has(file)) {
      groups.push(members.sort());
    }
  }
  for (const file of adjacent.keys()) {
    if (!indices.has(file)) {
      visit(file);
    }
  }
  return Object.freeze(groups.sort((a, b) => a.join().localeCompare(b.join())).map(Object.freeze));
}

export function classifyCycles(files, edges) {
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

export function cycleDiagnostic(members, edges, typeOnly) {
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
