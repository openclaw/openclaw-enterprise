# Check repository dependency policy

With workspace dependencies prepared, run:

```sh
pnpm check:modules
pnpm check:modules --json
```

A successful check reports no unexcepted violations and no stale exceptions.
The conformance suite and `checks-baseline` CI lane run the policy test against
the actual repository. Its second case verifies an allowed public-root import
and a forbidden HTTP-to-Driver import in a temporary copy of that source.

## Ownership and allowed dependencies

The [platform architecture](../design.md) describes implemented components and
identifies remaining design requirements.
[Repository policy](../../scripts/module-boundaries/policy.json) makes the
following source-level checks explicit. It scans all source files under the
controller and the five active packages, including newly added files.

| Source                                                      | Dependency rule                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src`                                    | May consume its own declarations and neutral `utils`; must not import another workspace implementation or the listed database, HTTP or provider libraries.                                                              |
| `packages/occ/src` outside `state` and `auth-persistence`   | Must not import storage adapters, controller implementations or the listed database, HTTP or provider libraries. The root may re-export adapters through the supported package API; its service imports remain checked. |
| Controller HTTP entrypoint, `http`, `routes` and `channels` | Must not import Driver implementations. Use domain services and neutral contracts.                                                                                                                                      |
| Docker, Kubernetes and SSH Compute implementations          | Must not import each other's implementation files. Shared code belongs outside those provider directories.                                                                                                              |
| All scanned sources                                         | Use supported package exports across package boundaries. Private source paths and dependency anchors into another package require an exact exception. Runtime cycles fail.                                              |

Package manifests remain the authority for public entrypoints. The existing root
API, including `@openclaw-enterprise/contracts`, is supported; this policy does
not require public subpaths or prohibit imports through a package's own root.
Type-only edges participate in dependency rules, while cycles requiring a
type-only edge are reported without failing the check. Dependency anchors are
checked for ownership but do not create executable cycle edges.

The controller worker and startup files currently combine composition with
runtime coordination. They are scanned for package access and cycles, but are
not classified as OCC domain sources. Provider-specific coupling checks cover
the three Compute implementations listed above. This gate does not establish
strict layering for every application module or classify other dependencies by
inference. It checks direct imports; a permitted root export does not certify that
every exported symbol is infrastructure-neutral. Changing these scopes is an architecture decision to review with the
code it affects.

## Maintain exact exceptions

[Exceptions](../../scripts/module-boundaries/exceptions.json) record existing
violations by rule, source, target, import form, type-only status and bindings.
Each records a capability owner, why the edge exists and its removal condition.
The baseline reflects the source currently checked: authentication schema
binding, runtime Driver loading, Configuration errors, shared Compute scripts,
repository composition, the type-only aggregate contracts used by repository lifetime
projections, Work status and claim handling, provisioning record types, repository
snapshot validation, and transaction errors each retain their own entries until
their actual imports change. Console browser URLs are resolved by the explicit
asset map rather than adjacent source files; the credential-service launcher
imports a generated entrypoint outside the authored-source graph. Those exact
resolution and asset-path allowances do not exempt other imports in those files.

Policy adoption is reviewed independently of product changes. Before merging an
adoption change, refresh and review the baseline against the resulting main
branch, then rerun the real-repository and negative checks. Product repository
or authentication work does not need this gate as a prerequisite. A baseline
that passed an earlier source tree is not approval to retain those entries.

Move a dependency to its supported contract or composition boundary when possible.
When an intentional import cannot be analyzed statically, explain its runtime
contract and bound the exception to that exact diagnostic. Do not broaden an
exception to cover unrelated imports. Remove or narrow its entry in the same
change that resolves the dependency; a stale entry fails the command and CI.
`--json` includes the resolved graph, accepted exceptions and cycle groups for
review. Do not generate or accept a new baseline without reviewing every entry.

## Verify a policy change

After changing rules, package ownership or exception bindings, run:

```sh
node --test tests/conformance/module-policy.test.mjs
```

The real-repository case must remain green, the supported public-root import
must remain allowed, and the new forbidden import must fail with the checked-in
exceptions. Review reported cycles and intended scopes with the policy change.

For analyzer syntax, resolution behavior, explicit configuration and diagnostic
categories, see [the import analyzer](module-boundaries.md). The analyzer is a
bounded development check: it does not execute target modules or prove runtime
isolation. Malformed configuration or missing analyzer dependencies require
repair or explicit dependency preparation; they are not architecture exceptions.
