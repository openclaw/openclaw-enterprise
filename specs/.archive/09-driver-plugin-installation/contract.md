# Feature Spec: Installation-scoped Driver package extensions: contract

[Spec overview](../09-driver-plugin-installation.md). Original record; decisions and status are preserved.

## Contract

### Selection and module exports

Keep `drivers.<capability>.{id,implementation,version,configuration,package}` as
the single selected-Driver authority. `package` is optional for IAM, Compute,
and Configuration in every environment. Omitting it selects the existing
bundled implementation. Each selected capability has its own explicitly
approved package, schema, configuration, and structural Driver contract.

```yaml
drivers:
  iam:
    id: acme-iam
    implementation: acme/iam
    version: 1.0.0
    package: "@acme/enterprise-iam-driver"
    configuration: {}
  compute:
    id: local-test-compute
    implementation: acme/local-test-compute
    version: 1.0.0
    package: "@acme/test-compute-driver"
    configuration:
      provisionPath: "/tmp/local-test"
  configuration:
    id: acme-configuration
    implementation: acme/configuration
    version: 1.2.3
    package: "@acme/enterprise-configuration-driver"
    configuration:
      endpoint: "https://config.acme.example"
```

Reject unknown selection keys, unsafe prototype keys, plaintext secrets,
`secretRef`, reserved external `occ/` implementation names, and package values
that are not exact npm names. Defaults remain explicit operator configuration.
Package-backed Drivers validate against their own exported closed configuration
schema; bundled Kubernetes-only configuration rules do not leak into unrelated
external implementations.

Each package is a strictly exact direct production dependency of
`apps/controller/package.json`, pinned by `pnpm-lock.yaml`; reject semver ranges
and unpinned versions. Normal npm metadata supplies identity, exact version, and
a compiled ESM entry:

```json
{
  "name": "@acme/enterprise-iam-driver",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" }
}
```

Resolve only selected direct controller dependencies. A trusted internal
`packageRoot` override permits integration tests to install `file:...tgz`
fixtures into an isolated temporary dependency root; neither override nor local
tarball selection is exposed through tenant or operator YAML. Require matching
configured and installed identity/version, compiled exports, package-root
containment, a closed configuration schema, semantic validation, and the exact
selected capability, identity, implementation, and required methods.

```js
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
export function validateConfiguration(configuration) {}
export function createDriver({ id, implementation, configuration, state }) {}
```

Only selected IAM package factories receive `state`, the freshly loaded persisted
IAM policy. The startup result carries a selected-package-bound
`createIAMDriver(persistedNativeIAMState)` factory; API composition and worker
policy refresh call that same selected factory after loading current state.
The worker also supplies its exact selected Configuration Driver and the IAM
Driver created during worker startup through the Compute lifecycle-owner contract.
Bundled IAM uses the existing native constructor with the exact selected
implementation identity.
Require exact Driver identity, `lookupIdentity`, `authorize`, principal lookup,
fresh actor-revocation checks, exact-resource decisions, and attributable audit.
Never substitute `NativeIAMDriver` after selecting an external IAM package.

Compute acceptance is structural: require `ensureNamespace`, `deleteNamespace`,
`prepareRevision`, and `retireRevision`; validate optional lifecycle hooks and
run an optional behavioral `preflight` before activation when supplied. Keep
immutable-image, projected-service-account-token, approved runtime, and existing
Kubernetes preflight checks for bundled Kubernetes Compute configuration only.
External Compute owns its schema and never bypasses admission, authorization,
scope, or audit. Environment and class identity are not trust proxies.

`loadInstallationConfiguration` remains the sole public asynchronous startup
entry point and returns the selected Installation, Compute Driver,
Configuration Driver, and state-aware IAM factory. Pass validated modules
directly to private construction. Preserve OCC registration collision checks
and fail closed on missing packages, invalid exports, identity mismatches,
invalid policy state, and incompatible capability contracts. Introduce no
global module registry, duplicate selection authority, or staged-activation
framework.

Installed package code has full controller access to credentials, cluster
identity, and tenant operations. Integrity checks and schemas do not sandbox
it or establish publisher provenance; only the trusted operator controlling
reviewed dependencies, image publication, and the Installation Secret approves
selection.

### Installation, deployment, and removal

Install each reviewed public, scoped, or private Driver as an exact production
dependency:

```bash
pnpm --filter @openclaw-enterprise/controller \
  add '@acme/enterprise-iam-driver@1.0.0' \
  --save-exact --ignore-scripts
```

For private registries, supply operator-owned npmrc credentials only through
`NPM_CONFIG_USERCONFIG` and the existing ephemeral BuildKit dependency-stage
secret (`Dockerfile:15`). `.dockerignore` already excludes `.npmrc` and
`**/.npmrc` (`.dockerignore:10`). Production dependencies install with
`pnpm install --frozen-lockfile --prod --ignore-scripts`. Never put tokens in
source, build arguments, image layers, lockfiles, Helm, startup YAML, logs, or
runtime pods. Drivers ship compiled JavaScript; package lifecycle scripts never
run.

Deploy the same immutable image to API and worker. Changing package selection or
configuration requires a restart; adding, updating, or removing a package also
requires a reviewed dependency, lockfile, and rebuilt image. Roll back the
previous image and matching configuration. No persistent installation state,
deployment coordinator, or runtime package installer is introduced.

