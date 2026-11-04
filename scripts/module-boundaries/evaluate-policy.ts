import { posix } from "node:path";
import { classifyCycles, cycleDiagnostic } from "./cycles.ts";
import { diagnosticIdentity } from "./exceptions.mjs";
import type { SourceReference } from "./source-imports.ts";
import type { Resolution } from "./resolve-import.ts";

type Snapshot = Awaited<ReturnType<typeof import("./workspace.ts").readWorkspace>>;
type Boundary = {
  rule: string;
  message: string;
  from: string[];
  to?: string[];
  exceptFrom?: string[];
  exceptTo?: string[];
  specifiers?: string[];
  kinds?: string[];
};
export type Policy = {
  version: 1;
  sourceRoots: string[];
  packages: string[];
  rootBarrels?: string[];
  workspaceNamespaces?: string[];
  diagnosticLimit?: number;
  boundaries?: Boundary[];
  packageImports?: { sourcePaths?: "allow" | "error"; internalRoot?: "allow" | "error" };
  cycles?: { runtime?: "error" | "report"; typeOnly?: "error" | "report" };
};
type Edge = {
  from: string;
  to: string;
  specifier: string;
  kind: SourceReference["kind"];
  typeOnly: boolean;
  bindings: readonly string[];
  line: number;
  loaderIdentity?: string;
};
type PolicyDiagnostic =
  | (Edge & { category: "policy"; rule: string; message: string })
  | ReturnType<typeof cycleDiagnostic>;
function field(value: unknown, key: string): unknown {
  return value == null ? undefined : Reflect.get(Object(value), key);
}
function stringArray(value: unknown, valid: (value: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.every(valid);
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const matches = (path: string, patterns: readonly string[] = []) =>
  patterns.some(
    (pattern) =>
      pattern === "**" ||
      (pattern.endsWith("/**") ? inside(path, pattern.slice(0, -3)) : path === pattern),
  );
const pathValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.includes(":") &&
  !value.includes("*") &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const patternValid = (value: unknown): value is string =>
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

export function validatePolicy(policy: unknown): asserts policy is Policy {
  if (!policy || field(policy, "version") !== 1) {
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
  if (Object.keys(Object(policy)).some((key) => !policyFields.has(key))) {
    throw new Error("Unknown policy field.");
  }
  for (const name of ["sourceRoots", "packages"]) {
    const value = field(policy, name);
    if (!stringArray(value, pathValid)) {
      throw new Error(`Invalid policy field: ${name}`);
    }
  }
  const rootBarrels = field(policy, "rootBarrels");
  if (rootBarrels !== undefined && !stringArray(rootBarrels, pathValid))
    throw new Error("Invalid policy field: rootBarrels");
  const namespaces = field(policy, "workspaceNamespaces");
  if (
    namespaces !== undefined &&
    !stringArray(namespaces, (entry) => typeof entry === "string" && /^@[^/\\\s]+\/$/.test(entry))
  )
    throw new Error("Invalid policy field: workspaceNamespaces");
  const limit = field(policy, "diagnosticLimit");
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
  )
    throw new Error("Invalid policy diagnostic limit.");
  const boundaries: unknown = field(policy, "boundaries");
  if (boundaries !== undefined && !Array.isArray(boundaries))
    throw new Error("Invalid policy field: boundaries");
  for (const boundary of boundaries ?? []) {
    const rule = field(boundary, "rule");
    const message = field(boundary, "message");
    if (
      !boundary ||
      typeof rule !== "string" ||
      !rule.trim() ||
      typeof message !== "string" ||
      !message.trim()
    )
      throw new Error("Boundaries require a rule and message.");
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
    if (Object.keys(Object(boundary)).some((key) => !boundaryFields.has(key)))
      throw new Error("Unknown boundary field.");
    for (const name of ["from", "to", "exceptFrom", "exceptTo"]) {
      const value = field(boundary, name);
      if (name !== "from" && value === undefined) continue;
      if (!stringArray(value, patternValid)) throw new Error(`Invalid boundary field: ${name}`);
    }
    const specifiers = field(boundary, "specifiers");
    if (
      specifiers !== undefined &&
      !stringArray(
        specifiers,
        (entry) =>
          typeof entry === "string" &&
          Boolean(entry.trim()) &&
          !(
            entry.includes("*") &&
            entry !== "**" &&
            (!entry.endsWith("/**") || entry.slice(0, -3).includes("*"))
          ),
      )
    )
      throw new Error("Invalid boundary field: specifiers");
    const from = field(boundary, "from");
    const to = field(boundary, "to");
    if (
      !Array.isArray(from) ||
      !from.length ||
      !((Array.isArray(to) && to.length) || (Array.isArray(specifiers) && specifiers.length))
    )
      throw new Error("Boundaries require source patterns and target paths or specifiers.");
    const boundaryKinds = field(boundary, "kinds");
    if (
      boundaryKinds !== undefined &&
      !stringArray(boundaryKinds, (kind) => typeof kind === "string" && kinds.has(kind))
    )
      throw new Error("Invalid boundary field: kinds");
  }
  for (const [name, entries] of [
    ["packageImports", ["sourcePaths", "internalRoot"]],
    ["cycles", ["runtime", "typeOnly"]],
  ] as const) {
    const value = field(policy, name);
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid policy field: ${name}`);
    const allowed: readonly string[] = name === "cycles" ? ["error", "report"] : ["allow", "error"];
    for (const key of Object.keys(value)) {
      const item = field(value, key);
      if (
        !entries.some((entry) => entry === key) ||
        typeof item !== "string" ||
        !allowed.includes(item)
      )
        throw new Error(`Invalid policy field: ${name}.${key}`);
    }
  }
}

function rootBarrels(snapshot: Snapshot, policy: Policy) {
  if (policy.rootBarrels !== undefined) {
    return new Set(policy.rootBarrels);
  }
  const files = new Set(snapshot.files.map((file) => file.path));
  const barrels = new Set();
  for (const pkg of snapshot.packages) {
    const exports: unknown = field(pkg.manifest, "exports");
    const target = typeof exports === "string" ? exports : field(exports, ".");
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
export function evaluatePolicy(
  snapshot: Snapshot,
  resolutions: readonly Resolution[],
  policy: unknown,
) {
  validatePolicy(policy);
  const packages = [...snapshot.packages].sort((a, b) => b.path.length - a.path.length);
  const owners = new Map<string, Snapshot["packages"][number] | undefined>();
  const owner = (file: string) => {
    if (!owners.has(file)) {
      owners.set(
        file,
        packages.find((pkg) => inside(file, pkg.path)),
      );
    }
    return owners.get(file);
  };
  const barrels = rootBarrels(snapshot, policy);
  const edges: Edge[] = [];
  const diagnostics: PolicyDiagnostic[] = [];
  const seenEdges = new Set();
  const seenDiagnostics = new Set();
  const add = (rule: string, edge: Edge, message: string) => {
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
