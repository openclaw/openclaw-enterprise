# Drivers quickstart

<span id="driver-selection-and-package-contracts"></span>

Select Drivers in the Installation configuration to choose where OCC stores
configuration, authorizes operations, and runs Agents. Only the Installation
operator can select Drivers, add controller dependencies, or publish controller
images; individual Agents cannot choose their own implementations.

## Choose a bundled Driver

1. Use bundled Kubernetes Compute and Kubernetes Secret for a new Installation
   or for [local Agent deployment](../../guides/quickstart.md). The
   [production Installation example](../../guides/deploy/production-installation.md#configure-the-installation)
   shows a complete YAML document with the required OCC and Driver settings.
   If you need embedded OpenClaw on existing Linux hosts with credentials
   supplied on those hosts, start with [SSH Compute](ssh-compute.md) instead.
2. Select the required Configuration, IAM, Compute, and Secret implementations.
   The table below lists each capability and its allowed choices. Omit optional
   Sandbox, Credential Gateway, ServiceAccount, Plugin, and Repo selections
   unless you need them.
3. Set `OCC_CONFIG_PATH` to the absolute path of that trusted YAML and select
   `NODE_ENV=development` or `NODE_ENV=production` explicitly. Run the API and
   worker with the same file and controller image. Follow the
   [deployment guide](../../guides/deploy.md) for the chosen environment.
4. Verify the Agent on the selected Driver. On local Kubernetes,
   [deploy your first Agent](../../guides/first-agent.md). On production
   Kubernetes, [verify an existing Agent's model response](../../guides/operate/model-verification.md).
   On SSH, follow the [host-managed credential requirements](ssh-compute.md#credentials-and-supported-boundaries)
   and send a model request through the host's configured gateway or channel;
   the Kubernetes verification commands do not apply. Successful OCC startup
   or gateway readiness alone does not prove that an Agent can use its model.

Default Docker or Podman Compose can run the control plane for development,
but its Docker Compute Driver rejects the authentication used for new Agents.
Stock OpenShell cannot provide the app-server token and workload-identity
projections needed to deploy a sandboxed Agent; see its
[current upstream blockers](openshell-sandbox.md#current-upstream-preconditions).

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

| Capability           | Shared contract                                                 | Selection boundary                                                                                     |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `configuration`      | [ConfigurationDriver](configuration.md)                         | Required in Installation YAML; bundled Kubernetes or installed package.                                |
| `channel`            | [ChannelDriver](channel.md)                                     | Controller-selected bundled Slack directory Driver; no Installation YAML selector.                     |
| `iam`                | [IAMDriver](iam.md)                                             | Required in Installation YAML; bundled native IAM or installed package.                                |
| `compute`            | [ComputeDriver](compute.md)                                     | Required in Installation YAML; bundled Kubernetes, bundled SSH, or installed package.                  |
| `secret`             | [SecretDriver](secret.md)                                       | Required in trusted Installation YAML, including SSH; bundled Kubernetes only.                         |
| `sandbox`            | [SandboxDriver](sandbox.md)                                     | Optional; bundled OpenShell or installed package, and currently requires bundled Kubernetes Compute.   |
| `credential_gateway` | [CredentialGatewayDriver](credential-gateway.md)                | Required with the bundled OpenShell Sandbox, otherwise omitted; bundled OpenShell Backend member only. |
| `service_account`    | [ServiceAccountDriver](service-account.md)                      | Optional bundled ChatGPT Backend member; no installed-package selector.                                |
| `plugin`             | [PluginDriver](plugin.md)                                       | Optional bundled `occ-plugin` or `codex-plugin`; no installed-package selector.                        |
| `repo`               | [RepoDriver](../repository-credentials.md#repo-driver-contract) | Optional bundled GitHub Backend member; requires bundled Kubernetes Compute without Sandbox.           |

Installed packages run unsandboxed with control-plane authority and
access to controller credentials, database state, and Kubernetes identity.
OCC asks selected IAM to authorize operations, but malicious IAM can disregard
persisted policy and malicious Compute can violate workload isolation. Operator
review of installed code is the security boundary; lockfile integrity does not
establish publisher trust.

SSH supports embedded OpenClaw on preprovisioned Linux hosts using
operator-managed runtime credentials. Kubernetes-only production image, Codex
runtime, and projected-credential checks apply only to bundled Kubernetes Compute. `drivers.sandbox` with `compute-ssh` fails startup;
OCC Secret delivery to SSH hosts is unsupported even though the Installation
contract still requires the Secret selection.

## Backend membership

An Installation-scoped [Backend](../backends.md) groups an authenticated
client with exact related Driver selections. `backend[].drivers` owns
membership, and composition injects the Backend into the concrete member.
The generic Driver contract has no Backend identity field. All declared members
are required and must match the selected registry `(capability, id)`. The bundled ChatGPT Backend requires its selected
ServiceAccount Driver; the bundled GitHub Backend requires its selected Repo
Driver; the bundled OpenShell Backend requires both its Sandbox and Credential
Gateway Drivers. A selected Credential Gateway must belong to a configured
Backend. There is no per-Agent Driver selection.

Runtime Backend injection is limited to those bundled Drivers. Installed factory
arguments remain the contract below; Backend loading or injection into
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
Secret selection accepts only the bundled Kubernetes implementation. The optional
Repo selection accepts only the bundled GitHub implementation with its declared
Backend member, and the optional Credential Gateway selection accepts only the
bundled OpenShell implementation; none of these selections accepts an installed package. Installed implementation identity is
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
[complete production Installation example](../../guides/deploy/production-installation.md#configure-the-installation)
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

## Related

- [Drivers overview](../../guides/integrations/drivers.md)
- [Compute comparison](compute-matrix.md)
- [Packaged-driver testing](../../testing/local.md#packaged-driver-integration)

The [Driver package loader](../../../apps/controller/src/composition/driver-packages.ts)
resolves installed packages and checks their factories;
[Installation composition](../../../apps/controller/src/composition/installation-config.ts)
validates selections and constructs the runtime bundle.
