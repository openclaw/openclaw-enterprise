import { posix } from "node:path";
import { classifyCycles, cycleDiagnostic } from "./cycles.mjs";
import { diagnosticIdentity } from "./exceptions.mjs";

const inside = (path, root) => path === root || path.startsWith(`${root}/`);
const matches = (path, patterns = []) =>
  patterns.some(
    (pattern) =>
      pattern === "**" ||
      (pattern.endsWith("/**") ? inside(path, pattern.slice(0, -3)) : path === pattern),
  );
const pathValid = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.includes(":") &&
  !value.includes("*") &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const patternValid = (value) =>
  value === "**" ||
  pathValid(typeof value === "string" && value.endsWith("/**") ? value.slice(0, -3) : value);
const kinds = new Set([
  "import",
  "export",
  "import-type",
  "require",
  "dynamic-import",
  "dependency-anchor",
  "path",
]);

export function validatePolicy(policy) {
  if (!policy || policy.version !== 1) {
    throw new Error("Unsupported module-boundary policy version.");
  }
  const policyFields = new Set([
    "version",
    "sourceRoots",
    "packages",
    "rootBarrels",
    "workspaceNamespaces",
    "diagnosticLimit",
    "boundaries",
    "packageImports",
    "cycles",
  ]);
  if (Object.keys(policy).some((key) => !policyFields.has(key))) {
    throw new Error("Unknown policy field.");
  }
  for (const field of ["sourceRoots", "packages"]) {
    if (!Array.isArray(policy[field]) || policy[field].some((entry) => !pathValid(entry))) {
      throw new Error(`Invalid policy field: ${field}`);
    }
  }
  if (
    policy.rootBarrels !== undefined &&
    (!Array.isArray(policy.rootBarrels) || policy.rootBarrels.some((entry) => !pathValid(entry)))
  ) {
    throw new Error("Invalid policy field: rootBarrels");
  }
  if (
    policy.workspaceNamespaces !== undefined &&
    (!Array.isArray(policy.workspaceNamespaces) ||
      policy.workspaceNamespaces.some(
        (entry) => typeof entry !== "string" || !/^@[^/\\\s]+\/$/.test(entry),
      ))
  ) {
    throw new Error("Invalid policy field: workspaceNamespaces");
  }
  if (
    policy.diagnosticLimit !== undefined &&
    (!Number.isSafeInteger(policy.diagnosticLimit) || policy.diagnosticLimit < 1)
  ) {
    throw new Error("Invalid policy diagnostic limit.");
  }
  if (policy.boundaries !== undefined && !Array.isArray(policy.boundaries)) {
    throw new Error("Invalid policy field: boundaries");
  }
  for (const boundary of policy.boundaries ?? []) {
    if (
      !boundary ||
      typeof boundary.rule !== "string" ||
      !boundary.rule.trim() ||
      typeof boundary.message !== "string" ||
      !boundary.message.trim()
    ) {
      throw new Error("Boundaries require a rule and message.");
    }
    const boundaryFields = new Set([
      "rule",
      "message",
      "from",
      "to",
      "exceptFrom",
      "exceptTo",
      "specifiers",
      "kinds",
    ]);
    if (Object.keys(boundary).some((key) => !boundaryFields.has(key))) {
      throw new Error("Unknown boundary field.");
    }
    for (const field of ["from", "to", "exceptFrom", "exceptTo"]) {
      if (field !== "from" && boundary[field] === undefined) {
        continue;
      }
      if (
        !Array.isArray(boundary[field]) ||
        boundary[field].some((entry) => !patternValid(entry))
      ) {
        throw new Error(`Invalid boundary field: ${field}`);
      }
    }
    if (
      boundary.specifiers !== undefined &&
      (!Array.isArray(boundary.specifiers) ||
        boundary.specifiers.some(
          (entry) =>
            typeof entry !== "string" ||
            !entry.trim() ||
            (entry.includes("*") &&
              entry !== "**" &&
              (!entry.endsWith("/**") || entry.slice(0, -3).includes("*"))),
        ))
    ) {
      throw new Error("Invalid boundary field: specifiers");
    }
    if (!boundary.from.length || !(boundary.to?.length || boundary.specifiers?.length)) {
      throw new Error("Boundaries require source patterns and target paths or specifiers.");
    }
    if (
      boundary.kinds !== undefined &&
      (!Array.isArray(boundary.kinds) || boundary.kinds.some((kind) => !kinds.has(kind)))
    ) {
      throw new Error("Invalid boundary field: kinds");
    }
  }
  for (const [field, entries] of [
    ["packageImports", ["sourcePaths", "internalRoot"]],
    ["cycles", ["runtime", "typeOnly"]],
  ]) {
    if (policy[field] === undefined) {
      continue;
    }
    if (!policy[field] || typeof policy[field] !== "object" || Array.isArray(policy[field])) {
      throw new Error(`Invalid policy field: ${field}`);
    }
    const allowed = field === "cycles" ? ["error", "report"] : ["allow", "error"];
    for (const key of Object.keys(policy[field])) {
      if (!entries.includes(key) || !allowed.includes(policy[field][key])) {
        throw new Error(`Invalid policy field: ${field}.${key}`);
      }
    }
  }
}

function rootBarrels(snapshot, policy) {
  if (policy.rootBarrels !== undefined) {
    return new Set(policy.rootBarrels);
  }
  const files = new Set(snapshot.files.map((file) => file.path));
  const barrels = new Set();
  for (const pkg of snapshot.packages) {
    const exports = pkg.manifest.exports;
    const target = typeof exports === "string" ? exports : exports?.["."];
    if (typeof target !== "string" || !target.startsWith("./")) {
      continue;
    }
    const path = posix.join(pkg.path, target);
    if (!inside(path, pkg.path)) {
      continue;
    }
    if (files.has(path)) {
      barrels.add(path);
    }
    for (const extension of { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[
      posix.extname(path)
    ] ?? []) {
      const source = path.slice(0, -posix.extname(path).length) + extension;
      if (files.has(source)) {
        barrels.add(source);
      }
    }
  }
  return barrels;
}

/** Evaluate immutable resolved references without touching the filesystem or compiler. */
export function evaluatePolicy(snapshot, resolutions, policy) {
  validatePolicy(policy);
  const packages = [...snapshot.packages].sort((a, b) => b.path.length - a.path.length);
  const owner = (file) => packages.find((pkg) => inside(file, pkg.path));
  const barrels = rootBarrels(snapshot, policy);
  const edges = [];
  const diagnostics = [];
  const seenEdges = new Set();
  const seenDiagnostics = new Set();
  const add = (rule, edge, message) => {
    const diagnostic = Object.freeze({ category: "policy", rule, ...edge, message });
    const identity = diagnosticIdentity(diagnostic);
    if (!seenDiagnostics.has(identity)) {
      seenDiagnostics.add(identity);
      diagnostics.push(diagnostic);
    }
  };
  for (const resolution of resolutions) {
    const { reference, status } = resolution;
    const edge = Object.freeze({
      from: reference.from,
      to: status === "local" ? resolution.to : "",
      specifier: reference.specifier,
      kind: reference.kind,
      typeOnly: reference.typeOnly,
      bindings: Object.freeze([...(reference.bindings ?? [])]),
      line: reference.line,
      ...(reference.loaderIdentity ? { loaderIdentity: reference.loaderIdentity } : {}),
    });
    if (status === "local") {
      const identity = diagnosticIdentity(edge);
      if (!seenEdges.has(identity)) {
        seenEdges.add(identity);
        edges.push(edge);
      }
      const sourceOwner = owner(edge.from);
      const targetOwner = owner(edge.to);
      if (
        policy.packageImports?.sourcePaths === "error" &&
        !resolution.named &&
        sourceOwner &&
        targetOwner &&
        sourceOwner !== targetOwner
      ) {
        add(
          "cross-package-source",
          edge,
          "Use a supported package export instead of another package's source path.",
        );
      }
      if (
        policy.packageImports?.internalRoot === "error" &&
        sourceOwner &&
        sourceOwner === targetOwner &&
        edge.from !== edge.to &&
        barrels.has(edge.to)
      ) {
        add(
          "internal-root-barrel",
          edge,
          "Package leaves must import their owning leaf contracts instead of their root barrel.",
        );
      }
    }
    for (const boundary of policy.boundaries ?? []) {
      if (
        !matches(edge.from, boundary.from) ||
        matches(edge.from, boundary.exceptFrom) ||
        (edge.to && matches(edge.to, boundary.exceptTo)) ||
        (boundary.kinds && !boundary.kinds.includes(edge.kind))
      ) {
        continue;
      }
      if (
        (status === "local" && matches(edge.to, boundary.to)) ||
        matches(edge.specifier, boundary.specifiers)
      ) {
        add(boundary.rule, edge, boundary.message);
      }
    }
  }
  const cycles = classifyCycles(
    snapshot.files.map((file) => file.path),
    edges,
  );
  if (policy.cycles?.runtime === "error") {
    diagnostics.push(
      ...cycles.runtimeCycles.map((members) => cycleDiagnostic(members, edges, false)),
    );
  }
  if (policy.cycles?.typeOnly === "error") {
    diagnostics.push(
      ...cycles.typeOnlyCycles.map((members) => cycleDiagnostic(members, edges, true)),
    );
  }
  return Object.freeze({
    edges: Object.freeze(edges),
    ...cycles,
    diagnostics: Object.freeze(diagnostics),
  });
}
