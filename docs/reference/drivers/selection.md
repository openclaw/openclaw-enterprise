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
The OpenShell development path remains experimental and unqualified; see its
[qualification requirements](openshell-sandbox.md#qualification-contract).

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

| Capability           | Shared contract                                                             | Selection boundary                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration`      | [ConfigurationDriver](configuration.md)                                     | Required in Installation YAML; bundled Kubernetes or installed package.                                                                                  |
| `channel`            | [ChannelDriver](channel.md)                                                 | Controller-selected bundled Slack directory Driver; no Installation YAML selector.                                                                       |
| `iam`                | [IAMDriver](iam.md)                                                         | Required in Installation YAML; bundled native IAM or installed package.                                                                                  |
| `compute`            | [ComputeDriver](compute.md)                                                 | Required in Installation YAML; bundled Kubernetes, bundled SSH, or installed package.                                                                    |
| `secret`             | [SecretDriver](secret.md)                                                   | Required in trusted Installation YAML, including SSH; bundled Kubernetes only.                                                                           |
| `sandbox`            | [SandboxDriver](sandbox.md)                                                 | Optional; bundled OpenShell or installed package, and currently requires bundled Kubernetes Compute.                                                     |
| `credential_proxy`   | [CredentialProxyDriver](credential-proxy.md)                                | Optional; the selected Sandbox and Credential Proxy must come from one Driver registration, supplied by bundled OpenShell or a selected Sandbox package. |
| `credential_gateway` | [CredentialGatewayDriver](credential-gateway.md)                            | Required with the bundled OpenShell Sandbox, otherwise omitted; bundled OpenShell Backend member only.                                                   |
| `credential_refresh` | [CredentialRefreshDriver](credential-refresh.md)                            | Optional; bundled OpenShell only, on the selected Credential Gateway's Backend.                                                                          |
| `service_account`    | [ServiceAccountDriver](service-account.md)                                  | Optional bundled ChatGPT Backend member; no installed-package selector.                                                                                  |
| `plugin`             | [PluginDriver](plugin.md)                                                   | Optional bundled `occ-plugin` or `codex-plugin`; no installed-package selector.                                                                          |
| `repo`               | [RepositoryPolicyDriver](../repository-credentials.md#repo-driver-contract) | Optional bundled GitHub Backend member; Kubernetes supports native Git or the protected sender described below.                                          |

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

## Select a protected sender

Implementers should start with the [Credential Proxy contract](credential-proxy.md)
and [Driver walkthrough](../../contributing/credential-proxy-driver.md). The contract
distinguishes request-time exchange, recipient installation and sender guarantees.

With bundled Kubernetes Compute, select the trusted package under
`drivers.sandbox.package`, then set `drivers.credential_proxy.id` to the
same Driver ID and its `configuration` to `{}`. Configure the package once,
under `drivers.sandbox.configuration`. The API and worker each load one
registration and compare its identity with the admitted revision.

For protected repository Git, set `repository.id`,
`repository.configuration.sessionDurationSeconds`, and `repository.preparedGitHub`.
The ID must match the GitHub Backend's `drivers.repo` policy member. Omit the
Installation's `drivers.repo` and `repository.nativeSender`. A separately installed
sender also omits `repository.openShell`. No native control socket or broker CA is needed. The Driver must implement
both Sandbox repository access and the Credential Proxy's `bindRepositoryGit`.
At release, Compute checks the installed recipient. Select the guarantee that
the actual sender can enforce:

| Admission | Required behavior                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| v3        | Protected request-time routes and response custody; not repository delivery.                                                                      |
| v4        | Exact dispatch: enforce exclusive `sendStartBy` before connecting and again before writing if setup took time.                                    |
| v5        | Online authorization: return the decision by `replyBy`; an authorized request may finish after withdrawal. External packages can select this too. |
| v6        | Bundled OpenShell preview: observe the request hook per start; this does not prove the hook cannot later be disabled.                             |
| v7        | Exact dispatch plus verified policy reduction v2; can retain independently admitted routes and the same recipient when Git is removed.            |

A lost authorization reply leaves possible use recorded; do not retry that
exchange. v7 support in OCC is available to a capable Driver, not evidence that
stock OpenShell enforces it. Selection establishes neither isolation nor release
qualification. See the [contract](credential-proxy.md#delivery-profiles) and
[OpenShell qualification boundary](../repository-credentials/protected-openshell-git.md).

### Supply protected Git credentials with Helm

After selecting your installed sender in the Installation, add these values to the
[production chart](../../../deploy/helm/openclaw-enterprise/values.yaml). Use your own
resource names. Replace the example IP address with an approved issuer destination.
Keep Secret contents out of Helm values.

```yaml
repositoryCredentials:
  delivery: credential-proxy
  authority: prepared-git
  registryConfigMapName: repository-registry-v1
  appKeySecretName: repository-app-key
  preparedCustodySecretName: git-custody
  upstreamCidrs: ["198.51.100.23/32"]
```

Leave `repositoryCredentials.enabled` and `openshellGit.enabled` false. The chart
mounts `/etc/openclaw/repository-registry/registry.json` for the API, worker and
upgrade check. Only the worker gets `private-key.pem` and `custody.key` under
`/etc/openclaw/prepared-repository`, plus an egress rule to the issuer on TCP 443.
Your sender supplies its own listener, trust and network policy. Before switching from
a broker, stop admissions and settle existing sessions with their original owner.
The worker's `Recreate` rollout cannot establish that custody is settled.

## Backend membership

An Installation-scoped [Backend](../backends.md) groups an authenticated
client with exact related Driver selections. `backend[].drivers` owns
membership, and composition injects the Backend into the concrete member.
The generic Driver contract has no Backend identity field. All declared members
are required and must match the selected registry `(capability, id)`. The bundled ChatGPT Backend requires its selected
ServiceAccount Driver; the bundled GitHub Backend requires its selected Repo
Driver; the bundled OpenShell Backend requires both its Sandbox and Credential
Gateway Drivers, and its Credential Refresh Driver when it declares one. A
selected Credential Gateway or Credential Refresh Driver must belong to a
configured Backend. There is no per-Agent Driver selection.

Runtime Backend injection is limited to those bundled Drivers. Installed factory
arguments remain the contract below; Backend loading or injection into
installed packages is deferred.

## Configuration definitions and discovery

Each selected implementation supplies `ConfigurationDefinition<T>`: a serializable
`configurationSchema` and synchronous `validateConfiguration(input)` semantic checks.
The platform checks plain JSON input against the schema once per admission call,
then passes an isolated, frozen copy typed as `Readonly<T>` to the Driver. The
callback returns `readonly ErrorDetail[]`; an empty list means success. It cannot
return replacement configuration. The platform returns the original input to the
caller and retains the typed `ConfigurationResult<T>` for preview responses.
Returning `undefined`, a data envelope, malformed field errors, or throwing fails
closed. Independent constructor entry points still perform their own admission.

Use JSON Schema 2020-12, or omit `$schema`. The installed TypeBox evaluator and its
meta-schema check registration; unknown formats and unresolved references are
refused. Validation does not coerce, insert defaults, strip fields, perform I/O,
or transform submitted values. Diagnostics have bounded JSON Pointer paths,
uppercase codes, and safe messages. The platform returns at most 32 errors;
submitted secrets and sensitive dynamic keys never belong in diagnostics.

Composition registers startup as `(capability, driverId, installation, startup)`.
An implementation can also export `configurationContributions`, with a stable
`scope` and `key` on each definition. `startup` is reserved. Unknown scopes,
duplicate identities, unsupported schemas, and missing resource-owner bindings
fail registration. The current runtime binding is Sandbox
`(agent, sandbox-network-policy)`; its owner is
[SandboxPolicy](../sandbox-policies.md). The Configuration Driver still owns
native configuration rendering. The registry introduces no persistence layer.

Installation administrators can inspect schemas in **Settings**, or call
`GET /installation/driver-configurations`. This returns contextual descriptors
without startup values, validators, or mutation actions. Agent discovery uses
`GET /namespaces/{namespaceId}/agents/{agentId}/driver-configurations`; the exact
Agent and contribution owner's read permissions determine the returned sections.
Owner bindings supply same-origin actions and availability. Actions always
reauthorize; discovery is not an authorization capability.

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

A standard npm package manifest provides identity and an ESM entry point. One
leading UTF-8 byte order mark is accepted, as it is by Node:

```json
{
  "name": "@acme/enterprise-configuration-driver",
  "version": "1.2.3",
  "type": "module",
  "exports": { ".": "./dist/index.js" }
}
```

The root export is resolved as Node's `import()` resolves it: ordered target
arrays and the `node`, `import`, `module-sync`, `node-addons`, and `default`
conditions in key order, with `"."` only at the top level. Invalid targets and
unmatched conditions permit another array entry. The selected target must name
an existing file exactly (no extension, directory, or `main` lookup). Its query
and fragment remain part of the imported module URL, as in Node. A selected
missing file, directory, or failed import stops startup. The entry must be
`.mjs`, or `.js` whose nearest `package.json` within the package declares
`"type": "module"`; Node's import uses that file, not always the package root.
The refusal names that `package.json`. Node can also load a `.js` file outside a
module scope when it detects ESM syntax; the controller refuses it on purpose.
For every entry the controller accepts, Node fixes the format from package
metadata alone, before any package code runs; neither the file's contents nor
Node's `--no-experimental-detect-module` flag changes it. Accepting detected
ESM would tie startup to Node's detection heuristic, which has changed between
releases, and the only way to read a detected format without running the file
is Node's process-lifetime module hooks. Node itself treats the shape as a
mistake: outside `node_modules` it warns about such a file and asks for
`"type": "module"`. To fix a refusal, add `"type": "module"` to the
`package.json` it names, or rename the entry to `.mjs`. See the
[breaking-change notices](../../guides/deploy/breaking-changes.md).

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
  // Shape is already checked. Return only semantic errors, never submitted values.
  return configuration.endpoint.startsWith("https://")
    ? []
    : [{ path: "/endpoint", code: "INVALID_VALUE", message: "Use an HTTPS endpoint." }];
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
