# Render installation profiles

Installation profiles generate the two trusted files used by a production
OpenClaw Enterprise install: a Helm values overlay and the Installation startup
YAML mounted into the controller. Use a profile when you want the standard
OpenClaw or Codex defaults without editing the production examples by hand.

Profiles only render configuration for an already prepared environment. They do
not create clusters, Secrets, databases, DNS, certificates, hosted plugin
credentials, ChatGPT service accounts, repository registries, or Slack consumers.

## Choose a profile

Use `openclaw` for embedded OpenClaw Agents with the bundled OpenClaw
PluginDriver. Operators select plugins manually or through the API. Embedded
OpenClaw cannot enable external Slack channels; the Standard OpenClaw preset
must leave channels disabled.

Use `codex` for dedicated Codex Agents with the bundled Codex PluginDriver. By
default, hosted plugin discovery and Codex runtime authentication both use a
`codex_pat` token that you supply later: add a same-Namespace Secret or enter
the PAT during Agent creation. The renderer does not create the token or make
catalog discovery ready.

Both profiles enable:

- Native admin UI and private gateway routing.
- Standard OpenClaw and Standard Codex Preset seeding.
- Kubernetes Compute, Kubernetes Configuration, Kubernetes Secrets, native IAM,
  private metrics, digest-pinned images, DNS policy, trusted proxy CIDRs, and
  plugin-status proxy CIDRs.

Both profiles give Gateway Pods (embedded or dedicated), Harness Pods, and the
tenant namespace container default a `100m` CPU request and a four-core (`"4"`)
CPU limit. The CPU limit only permits bursts: an embedded OpenClaw Gateway runs
a full agent turn as its startup model probe, about 16 CPU-seconds of local
work, and was ready 24 to 30 seconds after start at one core against 51 to 72
seconds at `500m`. The probe uses about one core, so cores beyond the first
serve later work, not startup. The CPU request sets the scheduling reservation,
so the higher limit reserves no node capacity. The trade-off is overcommit:
several busy runtimes on one node can each take up to four cores from their
neighbors, and a `limits.cpu` namespace quota counts the whole limit.

Memory requests cover the use measured between turns, so the scheduler reserves
what each Agent actually holds; limits cover measured peaks:

| Pod                             | Request  | Limit | Measured                                                                                                                                                             |
| ------------------------------- | -------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway (embedded or dedicated) | `1792Mi` | `3Gi` | 1.2 to 1.6 GiB between turns, peaks of 1.8 to 2.2 GiB; a dedicated Codex Gateway serving native admin chat was OOM-killed at `2Gi`                                   |
| Codex Harness                   | `768Mi`  | `6Gi` | 0.45 to 0.57 GiB between turns, 1 GiB running a test suite, 1.9 GiB running `tsc`; lint, `tsc` and tests together were OOM-killed at `2Gi` and reached a `4Gi` limit |
| Container default               | `128Mi`  | `2Gi` | containers that set no resources                                                                                                                                     |

Plan node memory per Agent: an embedded OpenClaw Agent reserves `1792Mi`, and a
dedicated Codex Agent reserves `2560Mi`: `1792Mi` for its Gateway on the
`runtime.gatewayNodeSelector` pool and `768Mi` for its Harness on the
`runtime.nodeSelector` pool. A Harness runs
the Agent's shell commands, so builds and test suites in large repositories can
need more than `6Gi`; raise `resources.agent.limits.memory` in the Installation
for such workloads. Limits reserve no node memory, so Harnesses building at the
same time on one node can together exhaust it, and the kubelet then evicts Pods
using more than their requests first; size agents nodes for the turns
you expect to run concurrently.

Denying the 11 bundled plugins an OpenAI-only Agent does not use
(`plugins.deny`) saved only about 50 MiB. Profile input cannot change these
values; for others, write the Installation from the production example (see
[Images and resources](../../reference/drivers/kubernetes-compute.md#images-and-resources)).
An existing Installation keeps its values on upgrade; adopted values apply to
each Agent at its next deployment. Before adopting them, check each agents node's
free memory: during a rollout the old and new Harness Pods of an Agent can run
together on one node, because they share its workspace volume.

Seeding both Presets does not change the profile's PluginDriver. An Agent
created from the other profile's Preset still needs a compatible driver,
runtime, harness mode, credentials, and channel support.

To seed additional Presets, add `"presets": { "files": ["/app/deploy/presets/swe-preset.json"] }`
to the input JSON and rerender. This example adds **SWE Agent** alongside the
standard Presets. Both controller processes must be able to read the files at
startup; the renderer validates the list but does not read container files. See
[Preset initialization](../../reference/presets.md#installation-defaults) for path
resolution and startup validation.

Repository support is optional. When enabled, the renderer wires the broker
container, GitHub Backend, Repo Driver, and Compute peer. The repository registry
needs Namespace IDs that only exist after the first bootstrap, so most installs
render with repositories disabled, bootstrap the platform, create the registry,
then rerender with `repository.enabled: true`.

## Prepare inputs

Create a JSON file outside the repository or under an ignored local output
directory. The renderer rejects any field it does not consume: unsupported
fields fail preflight. `controlPlane.releaseName` must satisfy Helm's lowercase
release-name syntax and be at most 53 characters. Image references in
`controlPlane.controllerImage`, `runtime.image`, and enabled `repository.image`
must use literal `sha256` and 64 lowercase hexadecimal characters. Invalid digest
casing fails preflight without emitting deployable files. The controller reference
also follows the chart and bootstrap-volume helper: a letter or digit first,
then letters, digits, `.`, `_`, `:`, `/`, or `-` before the digest. `controlPlane.adminEmail`
must be an administrator email the bootstrap Job accepts after trim and lowercase:
one `@` and a dotted domain.

```json
{
  "controlPlane": {
    "releaseName": "oce",
    "namespace": "openclaw-system",
    "clusterName": "production-west",
    "controllerImage": "registry.example/openclaw-enterprise/controller@sha256:<64-hex>",
    "authBaseUrl": "https://console.example.internal",
    "adminEmail": "admin@example.invalid",
    "bootstrapPasswordClaimName": "occ-bootstrap-admin-password",
    "apiClients": [{ "namespace": "operator-tools", "podLabels": { "app": "operator" } }],
    "databaseCidrs": ["10.45.0.12/32"],
    "clusterCidrs": ["10.43.0.1/32"],
    "dns": { "namespace": "kube-system", "podLabels": { "k8s-app": "kube-dns" } },
    "gatewayClassName": "eg",
    "gatewayApiKeySecretName": "occ-private-gateway-key",
    "agentNativeAdminDomain": "agents.example.internal",
    "sharedCookieDomain": "example.internal",
    "gatewayTrustedProxyCidrs": ["10.46.0.0/24"],
    "pluginStatusProxySourceCidrs": ["10.47.0.10/32"],
    "nodeSelector": { "oce-role": "control" }
  },
  "runtime": {
    "image": "registry.example/openclaw-enterprise/runtime@sha256:<64-hex>",
    "gatewayStorageClassName": "occ-gateway-rwo",
    "nodeSelector": { "oce-role": "agents" },
    "gatewayNodeSelector": { "oce-role": "control" },
    "transportSecretPrefix": "openclaw-agent-transport"
  },
  "channels": {
    "managedSlackProxy": true
  }
}
```

For the `codex` profile, merge the reviewed Codex seccomp profile and model
discovery egress into the base input:

```json
{
  "runtime": {
    "codexSeccompProfile": "openclaw/codex-0.163.0-alpha.2-<profile-sha256>.json"
  },
  "codex": {
    "modelDiscoveryCidrs": ["198.51.100.20/32"]
  }
}
```

To have OCE issue managed ChatGPT service-account runtime credentials, add the
optional managed ServiceAccount binding. Do this only after you qualify the
ChatGPT Backend admin credential path:

```json
{
  "codex": {
    "managedServiceAccounts": {
      "workspaceId": "11111111-1111-4111-8111-111111111111",
      "adminSecretName": "occ-chatgpt-admin",
      "adminSecretKey": "admin-key",
      "providerCidr": "198.51.100.30/32"
    }
  }
}
```

`workspaceId` must be a UUID the controller accepts at startup: version digit
1–8 and variant 8, 9, a, or b, as in the example. Any other spelling, including
a nil UUID, is a preflight error. Managed issuance is separate from the default
`codex_pat` path. The rendered Backend and ServiceAccount Driver wiring does not
prove that live service-account creation works. Optional `credentialTtlSeconds`
must be an integer from 1 through 2592000, the lifetime the API accepts; omit it
to use 2592000.

To show Installation administrators an external **Observability** console link,
set `controlPlane.observabilityUrl`. The renderer writes it as
[`observability.url`](../../reference/configuration.md#installation-startup-configuration)
and rejects URLs the controller would reject at startup.

### External sign-in and trusted proxies

Activation of GitHub, Google or OIDC sign-in is one-way, so keep these inputs in every
later rerender. Adding `controlPlane.github` or `controlPlane.google` (`{}` uses
the chart's Secret defaults), or `controlPlane.oidc` with its `issuer`,
`authorizationUrl`, `tokenUrl` and `jwksUrl` ([OIDC sign-in](oidc-sign-in.md)), renders
`auth.github`, `auth.google` or `auth.oidc` with
`enabled: true` and `agentNativeAdmin.enabled: false`; remove
`agentNativeAdminDomain` and `sharedCookieDomain`. `recoveryUserId` and an HTTPS
`authBaseUrl` are required. Optional `passwordSignIn: "recovery-only"` renders
[`auth.passwordSignIn`](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in);
preflight lists attaching every ordinary account's identity first. Follow
[Enable GitHub browser sign-in](production-installation.md#enable-github-browser-sign-in).
Behind a proxy that adds forwarded headers, such as ingress-nginx, set
`trustedProxy` ([presets](../../reference/settings/production.md#github-sign-in-and-trusted-proxies));
it works with or without external sign-in. Without it, preflight warns (it does
not fail), because an Installation whose API sees each client's own address, such
as behind a source-preserving NLB, needs none.

```json
{
  "controlPlane": {
    "recoveryUserId": "<administrator user ID>",
    "github": {
      "secretName": "occ-github-login",
      "egressCidrs": ["140.82.112.0/20"]
    },
    "google": { "allowedDomains": ["example.com"] },
    "trustedProxy": { "preset": "ingress-nginx", "cidrs": ["10.42.0.0/16"] }
  }
}
```

Client-ID and client-secret Secret keys must differ. Preflight compares custom
keys with the chart defaults (`client-id` and `client-secret`) when a key is omitted.
Each provider needs its own Secret, as the chart requires: its `secretName`
(default `occ-github-login`, `occ-google-login` or `occ-oidc-login`) must not
name another provider's Secret, `gatewayApiKeySecretName`, the ChatGPT admin
Secret when `codex.managedServiceAccounts` is set, a repository Secret, or the
chart's `occ-installation-startup`, `occ-database` and `occ-auth` Secrets.

`github`, `google` and `oidc` also accept `secretName`, `clientIdKey`, `clientSecretKey`
and `egressCidrs`; `github` also accepts `allowedOrgs` and `allowedTeams`
([allowlist](../../reference/authentication/external-sign-in.md#organization-and-team-allowlist));
`oidc` also accepts `tokenAuth` and `displayName`;
`trustedProxy` accepts `clientAddressHeader`, required for the `generic` preset.
Each `google.allowedDomains` entry must be a lowercase DNS name of at most 253
characters, such as `example.com`, and its last label must start with a letter.
Preflight refuses `example.123` and any longer name, which the chart and the API
also refuse.

If you opt in to repositories, add the broker inputs:

```json
{
  "repository": {
    "enabled": true,
    "image": "registry.example/openclaw-enterprise/repository-credentials@sha256:<64-hex>",
    "backendId": "github-primary",
    "registryConfigMapName": "occ-repository-registry-v1",
    "serviceConfigSecretName": "occ-repository-service-config",
    "appKeySecretName": "occ-repository-app-key",
    "tlsSecretName": "occ-repository-tls",
    "publicCaSecretName": "occ-repository-public-ca",
    "serviceName": "git",
    "upstreamCidrs": ["198.51.100.0/24"]
  }
}
```

`serviceName` is optional. When omitted, the renderer leaves it out of
`values.yaml`: a new installation gets the chart's `git` Service, and a Helm
upgrade fails until you set it. When upgrading an installation whose broker
Service has another name, set `serviceName` to that current name so TLS and
active repository sessions keep working, then switch it deliberately after
sessions drain. A set name must be a DNS-1035 label of at most 63 characters:
a lowercase letter, then lowercase letters, digits, or hyphens, ending in a
letter or digit. Preflight refuses any other spelling, which the chart also
refuses.

## Render files

Run the renderer from the repository root with Node.js 24 or newer. With native
admin, run `pnpm install` first: the public suffix check uses the API's list.

```sh
node scripts/render-installation-profile.mjs \
  --profile codex \
  --input .build/profile-inputs/codex.json \
  --out-dir .build/profile-renders/codex
```

On success, the output directory contains:

- `values.yaml`: Helm values for `deploy/helm/openclaw-enterprise`, including
  `controlPlane.installationChecksum` computed from the exact rendered
  `installation.yaml` bytes.
- `installation.yaml`: Installation startup YAML for the
  `occ-installation-startup` Secret.
- `preflight.json`: rendered output paths, warnings, prerequisites, and next
  steps.

After validating the CLI arguments, the renderer deletes these three files from
the output directory before it reads the input. It keeps other files. If
required input is missing or unsupported input is present, it writes
`preflight.json` with `ok: false` and only the report path in `outputs`, leaves
both YAML files absent, and exits nonzero. If the input JSON is unreadable or
malformed, it exits without writing a preflight report.

## Use rendered files

Set `OCC_INPUT_DIRECTORY` to the output directory, then complete the
[production shell and context setup](production-installation.md#configure-the-installation).
That setup reads the cluster kubeconfig from `$OCC_INPUT_DIRECTORY/kubeconfig`:
copy it there with mode `0600` first, or render straight into the protected
directory as the runbook's [profile branch](production-installation.md#recommended-generate-profile-configuration)
does.
Skip both configuration-generation branches and continue at the
[shared bootstrap PVC and configuration checks](production-installation.md#shared-bootstrap-pvc-and-configuration-checks).
The runbook covers Secret creation, Helm installation, bootstrap key retrieval,
and authenticated API verification.

If `controlPlane.databaseCa` supplies a CA Secret, omit `mountPath` to use
`/etc/openclaw/database-ca`, or choose a path distinct from the other active
database-client mounts. Preflight rejects collisions with platform mounts and,
when enabled, repository credentials or managed ChatGPT account mounts before
writing deployment files. See the [rendering flow](../../flows/installation-profile-rendering.md#4-build-helm-values).

`controlPlane.nodeSelector`, `runtime.nodeSelector` and `runtime.gatewayNodeSelector`
require Kubernetes label keys and label values that are empty or a label name of
at most 63 characters, matching Helm, bootstrap-volume preparation and Pod
admission.
Preflight rejects invalid placement labels before writing deployment files.

If rendering fails or either YAML file is absent, stop and fix the input. Do not
copy manual examples into the same output directory. Rerender successfully so
`values.yaml`, `installation.yaml`, and `controlPlane.installationChecksum` stay
paired.

`runtime.transportSecretPrefix` must form a DNS-safe Kubernetes Secret name after
`-` and 12 hex characters are appended, with at most 253 characters in total.
Preflight refuses a prefix that the controller would reject at startup.

## Required environment checks

The renderer does not check these prerequisites. Verify them before you treat
the install as ready:

- Kubernetes 1.35 or later, enforced NetworkPolicies, and exact API/database
  egress destinations.
- Envoy Gateway, cert-manager, and, unless external sign-in disables native
  admin, wildcard DNS and TLS for native admin and the shared cookie parent domain.
- A default ReadWriteOnce storage class for dedicated Codex workspace claims and
  `runtime.gatewayStorageClassName` for gateway state.
- For Codex, the configured localhost seccomp profile installed and verified on
  every node selected by `runtime.nodeSelector`.
- For Slack, a proxy route for both gateway runtime traffic and Console
  directory lookup. The managed proxy serves both; external proxies need both
  URLs. Rendering proxy wiring does not enable a Slack consumer. Either profile
  can install the managed
  proxy for API directory lookup and dedicated gateway use, but Slack-enabled
  Agents require dedicated Codex execution. The example input sets
  `managedSlackProxy: true` to use the chart-managed proxy Service. Its network
  policy allows public IPv4 HTTPS, excluding private and reserved ranges, and the
  proxy authorizes Slack hostnames, so connectivity survives Slack DNS rotation.
  For an external proxy, omit `managedSlackProxy` and provide literal IPv4
  `runtimeProxyUrl` and `directoryProxyUrl` inputs.
- For Codex hosted plugin discovery and runtime authentication, a
  same-Namespace `codex_pat` token Secret or a PAT entered during Agent creation.
- For optional OCE-managed ChatGPT service-account runtime credentials, the
  admin Secret, workspace authority, and app connections described in
  [Configure the ChatGPT Backend](../integrations/chatgpt.md). Treat managed
  issuance as unverified until the admin credential flow is separately proven.
- For repositories, create the registry ConfigMap after the first bootstrap
  creates Namespace IDs, then rerender with repository support enabled.
  Preserve the existing installation's approved GitHub ranges in
  `repository.upstreamCidrs`. For a new installation, obtain the current API and
  Git IPv4 ranges from [GitHub Meta](https://api.github.com/meta), following the
  [repository installation guide](../repository-credentials/installation.md).
  Do not replace provider ranges with a snapshot of DNS answers: GitHub rotates
  addresses within those ranges. Both profiles pass these CIDRs through unchanged.

## Related

- [Production installation](production-installation.md)
- [Amazon EKS](eks.md)
- [Codex sandbox setup](codex-sandbox.md)
- [ChatGPT Backend](../integrations/chatgpt.md)
- [Repository credential installation](../repository-credentials/installation.md)
