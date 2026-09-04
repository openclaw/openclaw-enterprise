# Driver selection and package contracts

Trusted Installation configuration selects one Driver for each required
capability and can select optional Sandbox and ServiceAccount Drivers. Trusted
Kubernetes startup configuration must also select the bundled Secret Driver.
Only the Installation operator can add dependencies, publish controller images,
or select Drivers. Tenants cannot install or activate packages. Startup
procedures belong in the [deployment guide](../../guides/deploy.md).

## Supported selections

Trusted Installation YAML uses bundled Kubernetes Configuration and native IAM
when their `package` fields are omitted. Packageless Compute selects
[SSH Compute](ssh-compute.md) for the exact reserved id `compute-ssh`;
`compute-kubernetes` is the default bundled Kubernetes id, and every other
packageless Compute id continues to select Kubernetes.
Default Compose development instead selects filesystem Configuration, native
IAM, and Docker Compute without Installation YAML and does not select a
SecretDriver. An operator can select installed IAM, Compute, Configuration, or
Sandbox packages in trusted YAML in either mode.

| Capability        | Shared contract                            | Selection boundary                                                                                   |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `configuration`   | [ConfigurationDriver](configuration.md)    | Required in Installation YAML; bundled Kubernetes or installed package.                              |
| `iam`             | [IAMDriver](iam.md)                        | Required in Installation YAML; bundled native IAM or installed package.                              |
| `compute`         | [ComputeDriver](compute.md)                | Required in Installation YAML; bundled Kubernetes, bundled SSH, or installed package.                |
| `secret`          | [SecretDriver](kubernetes-secret.md)       | Required in trusted Installation YAML, including SSH; bundled Kubernetes only.                       |
| `sandbox`         | [SandboxDriver](sandbox.md)                | Optional; bundled OpenShell or installed package, and currently requires bundled Kubernetes Compute. |
| `service_account` | [ServiceAccountDriver](service-account.md) | Optional bundled ChatGPT Provider member; no installed-package selector.                             |

Installed packages run unsandboxed with control-plane authority and
access to controller credentials, database state, and Kubernetes identity.
OCC asks selected IAM to authorize operations, but malicious IAM can disregard
persisted policy and malicious Compute can violate workload isolation. Operator
review of installed code is the security boundary; lockfile integrity does not
establish publisher trust.

SSH supports embedded OpenClaw on preprovisioned Linux hosts. Kubernetes-only
production image, Codex runtime, and projected-credential checks apply only to
bundled Kubernetes Compute. `drivers.sandbox` with `compute-ssh` fails startup;
OCC Secret delivery to SSH hosts is unsupported even though the Installation
contract still requires the Secret selection.

## Provider membership

An Installation-scoped [Provider](../providers.md) groups an authenticated
client with exact related Driver selections. `provider[].drivers` owns
membership, and composition injects the Provider into the concrete member.
The generic Driver contract has no Provider identity field. All declared members
are required and must match the selected registry `(capability, id)`. The bundled ChatGPT Provider requires its selected
ServiceAccount Driver. There is no per-Agent Driver selection.

Runtime Provider injection is limited to that bundled Driver. Installed factory
arguments remain the contract below; Provider loading or injection into
installed packages is deferred.

## Package identity and factory exports

The reviewed package is a direct dependency of
`apps/controller/package.json`, recorded at the same exact version in
`pnpm-lock.yaml`. For example:

```json
{
  "dependencies": {
    "@acme/enterprise-configuration-driver": "1.2.3"
  }
}
```

The package must be a direct production dependency pinned to its exact installed version.
Version ranges, tags, Git references, transitive dependencies, workspace-only
packages, and development dependencies are unsupported. Installation and image
builds disable npm lifecycle scripts, so packages must contain precompiled
JavaScript.

A standard npm package manifest provides identity and an ESM entry point:

```json
{
  "name": "@acme/enterprise-configuration-driver",
  "version": "1.2.3",
  "type": "module",
  "exports": { ".": "./dist/index.js" }
}
```

The entry point exports the existing Driver contract, not a separate plugin
manifest or public plugin SDK. The controller validates its closed JSON Schema
with TypeBox, then applies the Driver's own semantic validation:

```js
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint"],
  properties: { endpoint: { type: "string" } },
};

export function validateConfiguration(configuration) {
  // Reject options that violate this Driver's semantic requirements.
}

export function createDriver({
  id,
  implementation,
  configuration,
  platformState,
  getOperationAbortSignal,
}) {
  // IAM receives platform state; Compute receives the current-operation getter.
}
```

Only IAM factories receive `platformState`, the controller-owned state object.
The bundled IAM Driver calls `platformState.loadNativeIAMState()` for each
identity lookup and authorization decision; installed Drivers must do the same.
The runtime cannot enforce installed package internals, so operators must
review that behavior. Tenants and operator YAML cannot supply platform state.

Only Compute factories receive `getOperationAbortSignal`, a controller-owned
function returning the current reconciliation operation's `AbortSignal`, or
`undefined` outside an operation. Drivers can use it to stop in-flight provider
work when an operation loses its lease or is cancelled. Tenants and operator
YAML cannot supply or replace the function.

Production startup rejects bundled or installed Compute Drivers missing either
`activateRevision` or `deactivateRevision`; development permits four-method
Drivers. See the [ComputeDriver contract](compute.md) for
core operations, staged activation, and preflight. Startup checks structure,
not whether installed code actually preserves workload isolation.

Provide any defaults explicitly in Installation YAML or document them in the
Driver package. OCC does not merge package-provided defaults.

## Select the installed Driver

IAM, Compute, Configuration, and Sandbox selections accept only `id`, optional
`package`, and `configuration`. Omit `package` for a bundled Driver. The
Secret selection accepts only the bundled Kubernetes implementation and does
not accept an installed package. Installed implementation identity is
`<package-name>@<installed-version>`; bundled identity is intrinsic. Operators
cannot supply `implementation` or `version`; factory identity and capability
must match the selection:

```yaml
drivers:
  configuration:
    id: acme-configuration
    package: "@acme/enterprise-configuration-driver"
    configuration:
      endpoint: "https://config.acme.example"
  iam:
    id: acme-iam
    package: "@acme/enterprise-iam-driver"
    configuration: {}
  compute:
    id: acme-compute
    package: "@acme/enterprise-compute-driver"
    configuration:
      endpoint: "https://compute.acme.example"
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: inCluster
```

Include the existing required `occ` settings and use the
[complete production Installation example](../../guides/deploy.md#configure-the-installation)
as the baseline for the selected Drivers. Each Driver owns its closed
configuration schema; bundled Kubernetes settings apply only when that bundled
Driver is selected. Startup YAML can select Secret storage but must not contain
Agent Secret values. Registry credentials, persisted IAM policy, and unsupported
settings do not belong in Installation YAML.

Set `NODE_ENV=production` or `NODE_ENV=development` explicitly and set
`OCC_CONFIG_PATH` to the absolute path of the complete operator-owned YAML. The
selected package interface is the same in both modes; production adds Compute
staged-activation requirements.

## Private package credentials

Private-registry credentials belong in an operator-owned npmrc outside the
checkout, readable only by its owner. Local dependency installation can select
it through `NPM_CONFIG_USERCONFIG`; image builds accept it as the ephemeral
BuildKit secret `id=npmrc`, not as a build argument or copied source file.

The Dockerfile runs `pnpm install --frozen-lockfile --prod --ignore-scripts` and
mounts the npmrc only for that installation. `.dockerignore` excludes npmrc
files. Registry tokens must not enter source, image layers, lockfiles, Helm
values, startup YAML, logs, or runtime Pods.

## Loading, updates, and startup failures

Publish the reviewed immutable controller image and configure the same digest
for the API and worker. Both processes load only explicitly selected packages
at startup from the same operator-owned Installation configuration. Restart
both after configuration changes; packages are never installed or hot-reloaded
inside running Pods.

Update or remove a package by reviewing the direct dependency and lockfile,
rebuilding the image, and updating Driver selection together. To recover,
restore the previous image and its matching Installation configuration.

Startup fails on unavailable or indirect packages, mismatched metadata, invalid
exports or configuration, incorrect capability/identity, and missing production
Compute methods. These checks do not prove that installed IAM honors policy or
that installed Compute isolates workloads; operator review remains mandatory.

## Verification evidence

[Packaged-driver integration](../../../tests/integration/driver-plugin-installation.test.mjs) installs scoped, precompiled IAM, Compute, and Configuration tarballs
with real pnpm and lifecycle scripts disabled into an isolated dependency root.
It selects all three through production startup and user session
admission backed by in-memory OCC state. Checks include `401`/`403` responses,
audited IAM identity and restriction evidence, Configuration CRUD, public signup
remaining unavailable, and Namespace reconciliation writing its identity to
`/tmp/local-test`. The test removes only its own file; it does not alter
checkout dependencies.

This test is not a PostgreSQL-backed production deployment and does not
independently prove cross-process policy visibility. The suite does not prove
private-registry authentication, a live Kubernetes cluster, a real OpenClaw
gateway, or a Codex model turn.

The package resolver and startup checks live in
[Installation composition](../../../apps/controller/src/composition/installation-config.ts).
