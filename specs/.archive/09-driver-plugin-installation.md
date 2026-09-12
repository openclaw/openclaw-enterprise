# Feature Spec: Installation-scoped Driver package extensions

**Date:** 2026-08-21
**Status:** Complete
**Owner:** OCC controller / trusted Installation operator
**Source baseline:** `origin/main@f0020932b28f`.

## Problem and Decision

A trusted Installation operator can select an installed, lockfile-pinned npm
Driver for any supported capability: IAM, Compute, or Configuration. The same
package mechanism works in development and production. Existing first-party
Drivers remain bundled defaults. Trust comes from exact operator-selected
dependencies, immutable deployment, and existing authorization boundaries, not
the runtime environment or a particular Driver class.

The selected contracts are `DriverImplementation`, `IAMDriver`, `ComputeDriver`,
and `ConfigurationDriver` in `packages/contracts/src/index.ts:277`,
`packages/contracts/src/index.ts:282`, `packages/contracts/src/index.ts:309`, and
`packages/contracts/src/index.ts:318`. Existing integration points include
production composition in `apps/controller/src/composition/production.ts:27`,
production admission in `apps/controller/src/admission/internal-bearer.ts:46`,
Fastify in `apps/controller/src/index.ts:440`, and worker policy refresh in
`apps/controller/src/worker.ts:240`.

## Scope

**Changes**

- Allow one explicitly selected, installed npm package for each supported IAM,
  Compute, and Configuration Driver in every environment.
- Load package-owned schemas and implementations through one trusted startup
  path; validate capability, identity, configuration, and structural contracts.
- Construct selected IAM Drivers against fresh persisted authorization state in
  both the API and worker.

**Does not change**

- Installation ownership, Namespace isolation, exact-resource authorization,
  admission, actor revocation, attributed audit, or admitted revisions.
- One immutable controller image shared by API and worker; existing nonroot,
  read-only container restrictions and Installation Secret ownership.
- No marketplace, installation API, tenant installation, automatic discovery,
  new resource or database table, hot reload, public plugin SDK, OAuth, runtime
  compiler, custom package manifest, rollout coordinator, or defaults engine.
- Existing bundled local-test Compute coverage is unrelated and remains intact.

## Contract

See [Contract](09-driver-plugin-installation/contract.md#contract).

## Implementation

1. In `apps/controller/src/composition/installation-config.ts`, allow optional
   packages for all three capabilities in every mode, load only exact direct
   selected dependencies, validate package-owned schemas and structural
   contracts, and return a package-bound state-aware `createIAMDriver` beside
   the selected Compute and Configuration Drivers. Preserve bundled
   Kubernetes-specific immutable-image and projected-token checks without
   applying them to external Compute schemas.
2. In `apps/controller/src/composition/production.ts`, construct the selected
   IAM Driver from persisted policy, retain real
   `InternalBearerAdmissionVerifier`, principal lookup, exact selection,
   authorization, audit, and registration, and accept structural Compute and
   Configuration Drivers. Run optional behavioral Compute preflight; preserve
   existing bundled Kubernetes preflight. Never gate selection on `instanceof`
   or environment.
3. In `apps/controller/src/worker.ts` and its startup wiring, accept the selected
   structural Compute Driver and invoke the same selected
   `createIAMDriver(currentPersistedState)` for fresh policy checks. Preserve
   selected Configuration and startup IAM lifecycle owners through the Compute
   lifecycle-owner contract, failing closed when Compute cannot accept one.
   Preserve
   actor revocation, exact-resource restrictions, authorization denial,
   attributable audit, and worker failure behavior.
4. Preserve existing immutable-image packaging, disabled lifecycle scripts,
   ephemeral npmrc secret handling, npmrc build-context exclusion, and shared
   API/worker image. Document installation, trust, restart, and rollback in
   `docs/drivers/`; update directly relevant guides.
5. Add separately authored IAM, Compute, and Configuration integration fixtures
   under `tests/fixtures/`, pack and actually install them only into an isolated
   temporary dependency root, and exercise them through
   `tests/integration/`. Never change checkout `package.json`, `pnpm-lock.yaml`,
   or `node_modules`. Preserve the unrelated existing bundled
   `apps/controller/src/drivers/compute/local-test/index.ts` and its direct-import
   tests unchanged.

## Verification

| Required outcome                                                    | Automated acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Three externally installed capabilities load in production mode.    | Pack three separately authored scoped IAM, Compute, and Configuration fixture packages; install their compiled tarballs using real pnpm in an isolated temporary controller dependency root; execute `pnpm install --offline --frozen-lockfile --prod --ignore-scripts`; and load all three through the actual selected package mechanism in production mode. Exercise one bundled default as a separate control.                                                                                                                                                                          |
| Production admission, packaged IAM, and Compute operate end to end. | Compose the real `InternalBearerAdmissionVerifier`, Fastify app, OCC, and selected packaged IAM/Compute/Configuration Drivers using honest in-memory platform state. Submit authenticated allowed and denied real API requests with `app.inject`; assert packaged IAM principal lookup, exact authorization, denial, and audit. Create a Namespace with `POST /namespaces`, invoke real `OCC.handleNamespaceLifecycle`, and assert the installed Compute package itself creates `/tmp/local-test`. No direct fixture imports, injected fake Driver objects, or monkeypatched provisioning. |
| Worker honors installed Driver contracts and current policy.        | Exercise production-mode worker structural acceptance of the selected packaged Compute Driver and package-bound IAM factory; verify state-aware IAM construction preserves fresh-policy identity and actor-revocation/authorization behavior at the supported integration boundary. Do not claim PostgreSQL-backed worker execution without a real database.                                                                                                                                                                                                                               |
| Invalid package selections fail closed.                             | Reject missing packages, non-direct or non-exact dependencies, identity/version mismatches, invalid schema/configuration, missing capability methods, mismatched returned Driver identity, unresolvable principals, and invalid persisted IAM policy without falling back to bundled Drivers.                                                                                                                                                                                                                                                                                              |
| Packaging and authority remain intact.                              | Execute the isolated offline frozen production install with lifecycle scripts disabled; verify directly from source the Dockerfile ephemeral npmrc secret mount, `.dockerignore` npmrc exclusion, and same Helm image for API and worker. Preserve unauthorized/cross-Namespace denial. No container image is built or inspected.                                                                                                                                                                                                                                                          |

The production-mode in-memory composition proves real production admission,
Fastify routing, OCC authorization, selected package execution, and Driver
effects. It does not prove PostgreSQL persistence, a live production worker,
a Kubernetes cluster, private-registry authentication, provider credentials,
container-image construction, or an Agent turn without those real dependencies.

## Open Decisions

- Whether Enterprise should later publish a stable typed SDK; structural
  package modules suffice for this feature.
- Whether specific operators want stronger package provenance or sandboxing;
  those are separate supply-chain capabilities and are not provided here.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-21 13:51]: Defined source-backed bundled and external Installation Driver package contracts, immutable packaging, private registry isolation, and real integration acceptance. (01a02610-d4a9-7d02-ad7a-462ff1970399 - a11911c)
- [2026-08-21 15:54]: Simplified selection to standard npm metadata and existing Driver exports, removed custom manifests/defaults and rollout coordination, and reduced acceptance to real operational outcomes. (01a02688-4734-7472-b9b4-f35e74be7908 - f002093)
- [2026-08-21 15:59]: Clarified selected-package scope and made private npmrc build-context exclusion an implementation requirement. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 15:59]: Removed metadata trailing whitespace flagged by Markdown diff checks. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 16:03]: Applied approved simplification pass, tightened exact source references, and preserved the single selected package plus existing Driver validation design. (01a02610-d4a9-7d02-ad7a-462ff1970399 - f002093)
- [2026-08-21 16:09]: Approved development-only external Compute selection and required an actually installed TestComputeDriver to provision `/tmp/local-test` through the real OCC lifecycle while preserving Kubernetes-only production Compute and native IAM. (01a02696-5ae9-7d63-94a9-7ff990fba97b - b3324a3)
- [2026-08-21 16:13]: Required trusted isolated integration package roots, preserved existing bundled local-test coverage, and prohibited checkout dependency mutations or bundled fixture substitutes. (01a02696-5ae9-7d63-94a9-7ff990fba97b - b3324a3)
- [2026-08-21 16:26]: Required exact production dependency pins, limited local tarballs to trusted isolated test roots, and aligned npmrc and offline-install verification claims with implemented source rather than unperformed container inspection. (01a02696-5ae9-7d63-94a9-7ff990fba97b - 4fe8091)
- [2026-08-21 17:28]: Consolidated selected Driver loading and construction into one asynchronous startup boundary with explicitly passed validated modules, preserving fail-closed factory checks and real installation proof. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- [2026-08-21 17:57]: Applied explicit product correction enabling operator-selected IAM, Compute, and Configuration Driver packages in every environment, including production; specified state-aware selected IAM, structural Compute, and honest three-package production-mode integration proof. (01a02696-5ae9-7d63-94a9-7ff990fba97b - a45b01d)
- [2026-08-21 20:12]: Completed the implementation, exact IAM identity and worker lifecycle-owner fixes, installed three-package production-mode proof, verification, and PR handoff. (01a02696-5ae9-7d63-94a9-7ff990fba97b)
