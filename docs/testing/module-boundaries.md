# Analyze module dependencies

Run the source analyzer with an explicit JSON policy to inspect imports, detect
cycles, and check caller-selected boundaries:

```sh
pnpm analyze:modules --root tests/fixtures/module-boundaries --policy policy.json --json
```

The checked-in fixture policy demonstrates the command. To analyze another tree,
provide its root and a policy using the schema below. Policy and exception file
paths resolve relative to `--root`; absolute paths also work. Without `--root`,
the command uses this repository. The analyzer requires an explicit policy;
[repository dependency checks](repository-boundaries.md) select this repository's
policy and explain its CI adoption.

Prepare the [pinned workspace dependencies](README.md#requirements-and-credentials)
first. The analyzer uses the JavaScript TypeScript compiler API through the
`typescript-compiler-api` development dependency. The workspace compiler remains
separately pinned. Running the analyzer never installs dependencies or executes
imported application code.

## Policy

```json
{
  "version": 1,
  "sourceRoots": ["apps/app/src", "packages/library/src"],
  "packages": ["apps/app", "packages/library"],
  "workspaceNamespaces": ["@fixture/"],
  "boundaries": [
    {
      "rule": "consumer-to-private",
      "from": ["apps/app/src/consumers/**"],
      "to": ["apps/app/src/private/**"],
      "specifiers": ["external-driver/**"],
      "exceptFrom": ["apps/app/src/consumers/adapter.ts"],
      "exceptTo": ["apps/app/src/private/public.ts"],
      "message": "Use the public leaf."
    }
  ],
  "packageImports": { "sourcePaths": "error", "internalRoot": "allow" },
  "cycles": { "runtime": "error", "typeOnly": "report" },
  "diagnosticLimit": 50
}
```

`version`, `sourceRoots`, and `packages` are required. Roots are normalized,
nonempty paths relative to the analyzed tree. Each package directory must have a
named `package.json`. New source files under the selected roots are discovered
automatically. The walker excludes `node_modules`, `dist`, `.git`, and symlinked
directories. Configured source roots may not contain symlink components. It includes JS/TS, JSX/TSX, CommonJS/ESM extensions, and declarations.
If the roots select no source files, analysis fails with a configuration error
and the CLI exits with status 2.
The root and existing resolver targets use canonical filesystem identities, so a
root symlink does not change graph membership. Sources excluded from discovery
remain outside the graph even when an import resolves through a symlink.

Boundary patterns support an exact path, a prefix ending in `/**`, or `**` for
everything. They do not support arbitrary globs. A boundary matches its source
and either its target path or its original specifier, after exclusions. External
package specifiers can therefore be checked without installing those packages.
Optional `kinds` limits it to `import`, `export`, `import-type`, `require`,
`dynamic-import`, `dependency-anchor`, or `path`. Multiple boundaries can share
one `rule`; duplicate diagnostic identities are collapsed.

`packageImports.sourcePaths` rejects direct cross-package paths, including loader
anchors, when set to `error`. `internalRoot` rejects a package leaf's import of
its own root barrel. Root barrels come from simple string package root exports;
optional `rootBarrels` supplies explicit source paths for conditional exports or
other layouts. Both settings default to `allow`.

Cycles are always reported; each cycle setting defaults to `report` and can be
`error`. `runtimeCycles` uses executable edges. `typeInvolvingCycles` contains
groups with at least one erased edge; `typeOnlyCycles` is the subset without a
contained runtime cycle. Such a group can include runtime edges but requires an
erased edge to complete its cycle. `path` and `dependency-anchor` edges locate
dependencies and never enter cycle analysis. Inline `import { type T }` and
`export { type T }` retain an empty runtime declaration under Node's native type
stripping. They also create a separate erased edge to the selected declaration,
including in mixed value/type declarations; an excluded declaration fails closed.
Statement-level `import type` and `export type` are erased.

`workspaceNamespaces` marks scoped prefixes whose unregistered packages must
fail. It defaults to an empty array. Other bare package literals are external
identities, not proof that a package exists or can execute. Node built-ins take
precedence over same-named workspace packages and remain subject to specifier rules.

Unknown policy and boundary fields are rejected so misspelled rules cannot be silently ignored.

## Read a report

Text output prints up to `diagnosticLimit` violations (default 50), then a summary.
`--json` prints the complete deterministic report with sorted source paths,
resolved references, local edges, cycle groups, violations, and accepted
exceptions. Paths in reports are relative to the analyzed root. Resolutions
distinguish `local`, `external`, and `unresolved`; local results expose separate
`runtimeTarget` and `typeTarget` source paths where available. A declaration file
cannot stand in for executable code.

Exit status `0` means no unaccepted diagnostics, `1` means source, resolution,
or policy diagnostics, and `2` means invalid arguments, malformed configuration,
or an unreadable workspace. Diagnostics carry `syntax`, `resolution`, or `policy`
categories. An unknown recognized load fails resolution; it never silently
becomes a valid external dependency. Unknown expressions use a deterministic
SHA-256 identity rather than raw source text, preserving exact exception matching.
Use `--help` for the complete command line.

To call the same analyzer from development tooling, import
`verifyModuleBoundaries` from `scripts/verify-module-boundaries.mjs` and pass
`{ root, policy, exceptions }`. Policy is required; exceptions default to an
empty version-1 list. The returned report is immutable.

## Exact exceptions

Pass `--exceptions exceptions.json` to accept reviewed diagnostic identities:

```json
{
  "version": 1,
  "exceptions": [
    {
      "rule": "consumer-to-private",
      "from": "apps/app/src/consumers/read.ts",
      "to": "apps/app/src/private/store.ts",
      "specifier": "../private/store.ts",
      "kind": "import",
      "typeOnly": true,
      "bindings": ["type:Store"],
      "owner": "Example capability",
      "reason": "The public port is awaiting extraction.",
      "removeWhen": "The consumer uses the public port."
    }
  ]
}
```

Identity includes rule, source, target, specifier, kind, erasure, and sorted
bindings. A dynamic load with an uncertain loader or path also includes an
opaque `loaderIdentity` based on its call, lexical provenance, and occurrence.
Destructured bindings include their enclosing initializer and local dependencies.
For destructured or parameter bindings, untracked identifiers, local or untracked
property receivers, or provenance that exceeds the analysis bound, the identity
also covers the normalized source file. A source edit can therefore require
another review even if the load itself is unchanged. Copy this field from the
JSON diagnostic when reviewing an exception. An old exception without that field
becomes stale and must be reviewed again. A known specifier remains subject to
specifier boundaries even when its loader is unresolved.
Line numbers and wording do not affect identity. Runtime-cycle identities
include the full existing edge set. Duplicate entries are configuration errors;
unused entries produce `stale-exception` failures. After fixing a dependency,
remove its exception in the same change.

## Resolution and analysis limits

CommonJS resolution delegates to `createRequire(...).resolve(...)`, preserving
native extensionless, directory-index, package-main, export-condition, and loader
anchor selection without executing targets. Registered CommonJS packages without
`exports` resolve from their registered directory, including `main` and subpaths,
without requiring a `node_modules` link. Workspace ESM packages still require
explicit `exports`; legacy ESM package-main resolution is unsupported.
When an installed or self-referenced package with a registered name is visible
from the loader, it must be the registered package; a different package produces
`workspace-package-mismatch`. A dynamic loader with an unknown anchor cannot
resolve relative or bare package paths, although builtins and absolute paths do
not depend on the anchor. ESM lookup ignores CommonJS global package paths. A
type-only reference fails when its selected declaration is outside the source
graph; it never substitutes a different runtime export.
The source URL is unknown when `import.meta` is assigned, exposed through an
alias, or used through another property, because Node permits it to change.
The compiler's public
`resolveModuleName` API handles declaration and absent emitted-file source
mapping. An existing runtime JS file takes precedence over its declaration or
TypeScript sibling. Workspace ESM export selection is isolated in a bounded
compatibility module; it supports ordered conditions, wildcard targets, arrays,
and explicit blocking. Runtime selection uses the default Node conditions
`node`, `node-addons`, `module-sync`, `default`, and either `import` or `require`.
Type resolution follows the compiler's `types` condition selection.
Custom `--conditions` and Node flags that change the default condition set are
outside this analysis. Package import aliases (`#name`) are unsupported and
produce diagnostics.

Relative ESM specifiers follow URL semantics: percent escapes are decoded, and
queries/fragments do not change the target's source-file ownership. CommonJS
paths retain native literal filename semantics.

Lexical analysis follows conventional loader imports, local aliases, object
destructuring, literal paths, local `const` strings, concatenations, templates,
and selected Node URL/path helpers. File-local bindings stay isolated across
Node ESM and CommonJS sources even without static import/export syntax.
`module`, `__filename`, and `__dirname` follow the nearest `package.json`
scope, including unnamed nested packages. `.cjs`/`.cts` and `.mjs`/`.mts` override the package type.
It follows initialized `let`/`var` loader
bindings only when they are not assigned elsewhere in the same source. Assigned
loader bindings become unknown. Writes to implicit CommonJS `require`, `module`,
its loader, `__filename`, or `__dirname` make the affected loader or path unknown.
The analyzer also stops evaluating modeled helpers when it sees a same-source
write or exposure of their Node module object, `require.resolve`, or the global
`URL` constructor. Shadowed parameters and local functions do not inherit
unrelated loader identities. Analysis is bounded to 64 nested nodes; arbitrary
wrappers, external or untracked mutation, computed execution, and control flow are
outside its scope. Such behavior can make a passing result select the wrong
target. Operations around an unresolved `require.resolve` value produce an
unknown path instead of guessing a target. This development tool is not runtime
security enforcement.

## Verify or troubleshoot the tool

```sh
node --test tests/conformance/module-boundaries.test.mjs
```

The existing CI baseline lane runs these fixture and CLI tests. They include
independent Node resolution oracles and targets that throw if executed. For a
resolution failure, inspect the original import, loader anchor, package export,
and selected source roots. For a configuration failure, verify normalized paths,
policy version, and exception fields before changing source boundaries.

The implementation passes immutable records through workspace discovery,
source parsing, loader provenance, resolution, pure policy/cycle evaluation, and
exception matching. ASTs stay in source analysis; architectural decisions stay
in policy evaluation. The CLI only orchestrates these stages and formats results.
