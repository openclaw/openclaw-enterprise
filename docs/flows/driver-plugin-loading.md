---
created: 2026-08-21
updated: 2026-10-20
last_updated_session: authoring-run/5095b5aa-1826-472c-a40d-c34550457c0e
---

# Installation Driver Package Loading Flow

## Overview

The API and worker independently load trusted Installation YAML and construct
their selected IAM, Compute, Configuration, Secret, and optional Sandbox
capabilities. Only the API constructs the optional Backend client and
ServiceAccount Driver. This trace follows package resolution through process
composition and stops at request serving or worker reconciliation. Development
without startup YAML uses the defaults traced in [platform startup](platform-startup.md).

## Entry Points

- Trigger: Start `apps/controller/src/server.mjs` or
  `apps/controller/src/worker.mjs` with trusted Installation configuration.
- Source:
  `apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`,
  `apps/controller/src/composition/driver-packages.ts:loadDriverPackage`,
  `apps/controller/src/composition/production.ts:composeProduction`.
- Assumptions: An operator has installed and selected the reviewed package;
  [Install Driver packages](../reference/drivers/selection.md) owns installation,
  package formats, configuration examples, private registries, and deployment.

## Flow

```mermaid
graph TD
  subgraph Startup["Independent API or worker startup"]
    A["Read trusted Installation selections"] --> B{"Bundled or packaged"}
    B -->|bundled| C["Resolve built-in implementation"]
    B -->|packaged| D["Resolve package identity and import code"]
    C --> E["Validate Driver configuration and capability"]
    D --> E
    E --> F["Construct Configuration, optional Sandbox, Compute, Secret, and IAM factory"]
  end

  subgraph OCC["Control-plane ownership"]
    F --> P{"API with ServiceAccount selection?"}
    P -->|yes| Q["Build Backend client and ServiceAccount Driver factory"]
    P -->|no| G["Construct IAM with platform state"]
    Q --> G
    G --> H["Select exact Drivers and attach lifecycle owners"]
    H --> I["Authorize requests and reconcile Namespace lifecycle"]
  end
```

## Execution Trace

### 1. Resolve and validate selected Driver implementations

`apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`,
`apps/controller/src/composition/driver-packages.ts:loadDriverPackage`

Each process reads the same trusted startup YAML. Configuration, IAM, Compute,
and optional Sandbox selections may name an operator-installed package;
implementation identity comes from its installed metadata. The installed root
`package.json` accepts one leading UTF-8 byte order mark, as Node does; remaining
text must still be a JSON object with the selected name and exact version. Secret selection is
required in this YAML path and accepts only bundled Kubernetes Secrets.
Optional `service_account` selection identifies the bundled Backend member;
it has no package-loading path. The
[operator installation guide](../reference/drivers/selection.md) defines the package,
pinning, registry, and configuration contract. TypeBox checks each selected
Driver's closed schema once per admission call before implementation-owned
semantic validation. `requireConfiguration` gives the callback an isolated frozen
copy, checks its field-error list, and returns the original input. Driver callbacks
cannot supply replacement data; malformed results and throws fail closed. Composition retains each definition with its selection, registers startup
and named contributions in `packages/occ/src/configuration-registry.ts`, and
rejects missing owner bindings, duplicate identities, or unsupported schemas before
construction. Invalid package exports, identity, capability, or lifecycle wiring reject
startup without fallback. The package root export resolver follows Node's
`import()` resolution: `"."` selects a subpath only at the top level (nested, it
is an unmatched condition name), conditions are Node's defaults (`node`,
`import`, `module-sync`, `node-addons`, `default`) in key order, and mixed
subpath and condition keys or numeric keys are invalid. Invalid targets and
unmatched conditions can select a later array entry; a matched null condition
ends that condition branch. The selected target is resolved as a URL inside the
package and percent-decoded; it must name an existing file exactly, with no
extension, directory index or `main` lookup, and an encoded separator or
directory is refused. Package containment, the compiled ESM check, and import
must then succeed before Driver construction. Import uses the checked realpath
with the selected URL's query and fragment preserved, so URL-qualified package
profiles retain Node's module identity. Containment rejects only a parent
directory path; an in-package filename that begins with two dots remains valid,
matching Node's export resolution. The entry must be `.mjs`, or `.js`
whose nearest `package.json` (searched from the entry's directory up to the
package root, stopping at a `node_modules` directory, as Node's import does)
declares `"type": "module"`. The refusal names that `package.json`, or says the
entry is neither `.mjs` nor `.js`. Unlike Node, the check never detects ESM
syntax in a `.js` file outside a module scope. Missing files and import failures
do not select another target.

For packageless Compute, the exact id `compute-ssh` selects `SshComputeDriver`
with implementation `occ/ssh`. Every other packageless id retains Kubernetes
selection. The [SSH reference](../reference/drivers/ssh-compute.md) owns the host
contract. Its helper is read at module import and sent through SSH
operations with a 180-second timeout; `bindAgent` supplies authoritative Namespace and ServicePrincipal
identity before version operations.

Installed packages run arbitrary, unsandboxed code with controller database,
credential, Kubernetes, tenant, and authorization authority. An untrusted or
malicious package can violate authorization and tenant isolation; package
validation and lockfile integrity do not establish publisher trust.

Local Setup also calls the shared admission path before provisioning:
`internal/occdev/sandbox_network_policy.go:loadSandboxNetworkPolicies` invokes
`scripts/validate-sandbox-network-policy.mjs`, which uses `requireConfiguration`
for platform structural validation and Driver semantic checks. A failure stops before creating development state
or invoking a container engine. API and worker startup log
`DRIVER_CONFIGURATION_INVALID` with bounded field diagnostics; semantic messages
identify the setting without echoing submitted values.

### 2. Construct the single authoritative runtime bundle

`apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`,
`apps/controller/src/composition/driver-packages.ts:createExternalDriver`

The loader constructs Configuration, optional Sandbox, Compute, and Secret
Drivers and returns them with the validated Installation and required
`createIAMDriver(state)` function. A selected Sandbox Driver is passed to bundled
Kubernetes Compute; selecting it with SSH or packaged Compute rejects startup. Bundled and
packaged IAM receive the same controller-owned platform state. The bundled IAM
Driver loads current policy for each identity lookup and authorization decision;
packaged Drivers must do the same, which operator review verifies because the
runtime cannot enforce package internals. Packaged factories must return their exact server-owned capability
and identity. The Helm upgrade hook's `installation-check` also runs this loader
with only `NODE_ENV`, `OCC_CONFIG_PATH` and the Installation and repository
mounts, so factories must defer other environment and file reads past construction.

Kubernetes-specific image and projected-credential requirements apply only to
bundled Kubernetes Compute. SSH preflight verifies local SSH files and probes
each configured host. Startup enforces the
[production version-stage contract](../reference/drivers/compute.md#production-revision-stages)
before returning any production runtime; development can use a four-operation
Driver, and the worker still fails closed if a required stage becomes unavailable.

### 3. Construct the API-only Backend branch

[`api-startup.mjs:startApi`](../../apps/controller/src/api-startup.mjs) handles a selected
ServiceAccount Driver after loading the common bundle. It requires PostgreSQL,
Compute credential-storage methods, and an owning Backend definition. It reads
that Backend's `apiKeyPath`, constructs `ChatGPTClient`, and supplies the
ServiceAccount Driver factory to controller composition. The worker keeps only
nonsecret Backend metadata; it constructs neither the client nor this Driver.
The [managed credential flow](service-account-driver-credential-delivery.md)
continues through account creation, issuance, and deployment checks.

### 4. Load current policy and hand off lifecycle ownership

`apps/controller/src/worker.ts:ControllerWorker.start`

API and worker construct separate process-local Driver instances. Production
composition validates persisted policy, creates the selected IAM Driver with
platform state, and selects the exact common Driver identities with OCC. The API
also registers its selected ServiceAccount Driver after composition. Worker
startup checks persisted identities, including Secret and optional Sandbox,
and attaches selected lifecycle owners once. Both processes pass the retained
definitions into OCC; the worker also resolves the current policy contribution
before live application. `discoverConfigurations` exposes only authorized schemas
and resource-owned action URLs, never startup values or executable validators.
The bundled IAM Driver loads current policy for identity lookup and
authorization; installed IAM Drivers must honor the same contract. Neither is
rebuilt or replaced after account or policy changes.

OCC owns exact-resource authorization and invokes Compute only during Namespace
or Agent revision reconciliation. Embedded OpenClaw and dedicated Codex retain
their existing Harness-owned runtime topology.

## Debugging and Verification

- Run `node --test tests/integration/driver-plugin-installation.test.mjs` for
  real installed IAM, Compute, and Configuration packages; production admission;
  IAM allow/deny evidence; Configuration CRUD; and OCC provisioning of an
  evidence file in a per-run temporary directory.
- Startup failures emit `startup-error` or `worker.startup-error`; inspect
  Driver identity, persisted policy, capability contracts, and lifecycle stages.
- The integration uses `InMemoryPlatformState`; it does not prove a running
  PostgreSQL worker, live Kubernetes, private registry, gateway, or model turn.

## Related docs

- [Install Driver packages](../reference/drivers/selection.md)
- [Platform startup flow](platform-startup.md)
- [Configuration Driver and Agent Revision flow](configuration-driver.md)
- [Compute Driver lifecycle-hook flow](compute-driver-lifecycle-hooks.md)
- [ComputeDriver contract](../reference/drivers/compute.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-22: The installed Compute fixture provisions into a per-run temporary directory instead of a fixed `/tmp/local-test`. (harden-1022c)

- 2026-10-20 05:56: Assign structural validation and accepted input ownership to the platform; Driver semantic callbacks return only field errors. (authoring-run/5095b5aa-1826-472c-a40d-c34550457c0e - 01ee10b27e1de60faccccf2f386cff394c1afedc)

- 2026-10-19 20:34: Trace shared definitions, contextual discovery, and preview admission in the accompanying implementation. (authoring-run/9b1f7ddf-52fe-46c8-9fa9-fa7a1acfa64a - 7fa0a561df615296a612126d430a4bbfa1124d9c)

- 2026-10-18: Note the upgrade hook's Installation check runs this loader.
- 2026-10-16 13:47: Preserve selected export URL query and fragment after realpath validation. (authoring-run/6e734247-4639-4e34-8432-e2d0f546353f - 591feb34bdbaaf7f316607347a02f7335ee816c0)

- 2026-10-13 21:02: Keep valid in-package Driver entry filenames that begin with two dots while still refusing parent-directory escapes. (issue-2323 - 5fad4d023a8896ac6bc05a201e6733ee256845b9)

- 2026-10-10 11:34: Read installed Driver root manifests with Node-compatible leading UTF-8 byte order marks. (authoring-run/cda14eba-9150-4d7e-9956-e276bfed4c64 - f8a837e33b5c03bc0c92065e979485ee06960150)

- 2026-10-09 17:39: Name the deciding `package.json` in the compiled ESM refusal. (fix-962-964)

- 2026-10-09 16:21: Decide a `.js` Driver entry is ESM from its nearest `package.json` scope, as Node's import does, instead of the package root manifest. (fix-956)

- 2026-10-09 15:42: Resolve the Driver package root export as Node's `import()` does (top-level `"."` only, default conditions, exact existing file) and restore the worker entry in Source. (fix-949-950)

- 2026-10-09 22:04: Admit compiled Driver export target arrays through startup and preserve selected-file failure boundaries. (authoring-run/480d2d81-8f6a-43f5-854d-6ce9ee130ea5 - dc95c2261d4b46cff8aca703e13e43cdd71d153e)

- 2026-09-01 19:09: Include Secret and Sandbox construction and the API-only Provider/ServiceAccount branch in the current loading trace. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-24 19:46: Pass controller-owned platform state directly to bundled and installed IAM Drivers. (01a036c0-9a0e-7ee0-8428-17824f5172a0 - 786b7ce)
- 2026-08-24 17:12: Documented the controller-owned current-policy loader supplied to bundled and installed IAM Drivers. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e)
- 2026-08-24 17:12: Removed IAM policy snapshots and Driver rebuilding; bundled and installed IAM Drivers load current policy for every authorization decision. (01a0352c-debe-73b1-baa6-379855af874f - 4502d7e) (NOT_IN_SPEC)
- 2026-08-21 20:53: Consolidated startup phases, linked canonical package and Compute contracts, and clarified unsandboxed authorization and tenant-isolation risk. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - f6491502262d6190c95d2a910ee46283c30244f9)
- 2026-08-21 20:12: Required both typed Compute version stages before production startup while preserving four-method development Drivers. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - b651c4ae38310032f8cda47c868a9b282fb12ff3)
- 2026-08-21 20:05: Consolidated the package flow into runtime order and linked canonical operator guidance; clarified metadata identity, TypeBox, required IAM factory, and unsandboxed authority. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - b651c4ae38310032f8cda47c868a9b282fb12ff3)
- 2026-08-21 19:28: Enabled all reviewed Driver capabilities in both modes and documented state-aware IAM, structural production Compute, and honestly scoped production-admission proof. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - a45b01d258c6a6b10db2301cad3303e2fa520f09)
- 2026-08-21 17:28: Consolidated startup into one async Driver bundle, removed hidden module-cache state, and preserved fail-closed factory and integration proof. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - d17a87541cbebc8e333bd00bd90c42e734d91a80)
- 2026-08-21 16:27: Recorded exact dependency pins, conditional ESM exports, isolated tarball exception, simplified factories, and frozen production installation proof. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 4fe8091c5f7faa1a56445beb022e075b59787bee)
- 2026-08-21 16:19: Documented trusted Driver package startup, capability restrictions, isolated installation, and real development Namespace provisioning. (01a0269c-0551-7f01-9dfc-ffb2a0896c94 - 9e356f7228c51fe68d85327cf7b47dbd04e420a4)
