# Analyze module dependencies

## Overview

Check package imports and dependency cycles against repository policy, then inspect and fix reported violations.

## Check repository dependency policy

With workspace dependencies prepared, run:

```sh
pnpm check:modules
pnpm check:modules --json
```

A pass has no unexcepted violations or stale exceptions. CI and the conformance
suite check the actual repository. The [policy](../../scripts/module-boundaries/policy.json)
scans controller and active package source files. It enforces public package
imports, selected domain and Driver boundaries, and runtime cycle rules. Type-only
edges count for dependency rules; cycles needing such an edge are reported.
The policy checks direct imports and does not prove runtime isolation or strict
layering across every module. Package manifests define public entrypoints.

### Maintain exact exceptions

[Exceptions](../../scripts/module-boundaries/exceptions.json) record exact
violations, their owners, reasons, and removal conditions. Prefer moving a
dependency to a supported contract or composition boundary. Do not broaden an
exception or accept a generated baseline without reviewing each entry. Remove or
narrow an exception when its import changes; stale exceptions fail the check.

### Verify a policy change

When changing policy, ownership, or exceptions, verify the real repository and
negative cases:

```sh
node --test tests/conformance/module-policy.test.mjs
```

Review the resulting scopes and cycles.

## Analyze another tree

Prepare workspace dependencies and provide a JSON policy:

```sh
pnpm analyze:modules --root tests/fixtures/module-boundaries --policy policy.json --json
```

Paths for policy and exceptions resolve relative to `--root`; without it the
repository is the root. The analyzer reads source with the TypeScript compiler
API; it does not execute imports or install dependencies.

## Policy

Use the [fixture policy](../../tests/fixtures/module-boundaries/policy.json) as an
example. A version-1 policy requires `sourceRoots` and `packages`. Each package
must have a named `package.json`; the analyzer discovers source files beneath the
roots. Boundary patterns accept exact paths, `**`, and prefixes ending in `/**`,
not arbitrary globs. `workspaceNamespaces` marks prefixes whose unregistered
packages must fail. Unknown fields are rejected.

`packageImports` can reject cross-package source paths or a package leaf's import
of its own root barrel. Cycle settings select `report` or `error`; cycles are
always reported. Type-only imports participate in boundary checks. Path and
dependency-anchor edges are not executable cycle edges.

## Read a report

`--json` includes resolved references, edges, cycles, violations, and accepted
exceptions. Exit status 0 means no unaccepted diagnostics; 1 means source,
resolution, or policy diagnostics; 2 means invalid arguments, configuration, or
an unreadable workspace. Run `pnpm analyze:modules --help` for options.

## Exact exceptions

Pass `--exceptions exceptions.json` to accept reviewed diagnostics. An exception
identifies the rule, source, target, specifier, kind, type status, and bindings;
uncertain dynamic loads can also require `loaderIdentity` from the JSON report.
Record its owner, reason, and removal condition. Duplicate entries are invalid;
unused entries fail as stale. Remove an exception when its violation is fixed.
See the [repository exceptions](../../scripts/module-boundaries/exceptions.json)
for examples.

## Resolution and analysis limits

The analyzer resolves supported static imports and selected Node loader and path
patterns. File URL schemes are case-insensitive, matching Node; local imports
and loader anchors keep their local edges and repository-relative diagnostic
identities across scheme casing. Query and fragment handling is unchanged.
Package export targets follow Node's case-insensitive refusal of
`node_modules` path segments, including percent-encoded spellings. A query or
fragment word alone is not a path segment; slash boundaries in the original
target are still checked without URL normalization. It fails closed on unknown loads and unsupported package import aliases (`#name`). It does not model arbitrary wrappers, computed execution, external
mutation, or control flow. A pass is a development check, not runtime security
enforcement. For a resolution failure, inspect the import, loader anchor,
package exports, and selected roots.
