---
rfc: index.md
---

# Helm capability inventory

This inventory supports the [two-profile proposal](index.md).
Baseline: `e06ff9625e72ff5ab3483a504a2f02a69a370cbb`, inspected 2026-09-28.
Defaults below are current chart defaults, not proposed profile choices.
All listed features have source implementations; successful rendering proves
manifest generation only. No live cluster was inspected or changed in this task.

> Historical baseline: this inventory records the pre-implementation discovery
> phase at `e06ff962`. It does not describe the current installation profile
> renderer, managed Slack proxy wiring, or post-implementation qualification.
> For current operator guidance, see [Render installation profiles](../../../docs/guides/deploy/installation-profiles.md)
> and [Installation Profile Rendering Flow](../../../docs/flows/installation-profile-rendering.md).

## Main chart

The chart's [values](../../../deploy/helm/openclaw-enterprise/values.yaml) are the
complete exposed Helm setting surface. [Chart.yaml](../../../deploy/helm/openclaw-enterprise/Chart.yaml)
has no dependencies. PostgreSQL, Envoy Gateway, Gateway API CRDs, cert-manager,
DNS, storage, and external credentials are operator prerequisites.

| Capability                 | Owning values and defaults                                                                                                                                                                | Required inputs, dependencies, limits                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API and worker             | `images.controller: ""`; `api.port: 8080`; `resources.requests` 100m/128Mi; limits 500m/512Mi                                                                                             | Immutable approved image digest required. One API and one worker replica; no replica/HA switch. Console ships in API image.                                                                                                    |
| Installation startup       | `installation.name: openclaw-enterprise`, `secretName: occ-installation-startup`, `key: installation.yaml`                                                                                | Existing startup Secret mounted into both roles at `OCC_CONFIG_PATH`; chart does not generate or semantically validate it.                                                                                                     |
| Authentication             | `auth.baseUrl: ""`, `secretName: occ-auth`, `secretKey: secret`                                                                                                                           | Required URL and dedicated high-entropy signing Secret; authenticated Console/API. External IdP configuration is not exposed here.                                                                                             |
| Bootstrap administrator    | `bootstrap.adminEmail: ""`; `password.claimName: ""`, `mountPath: /var/lib/openclaw/bootstrap`, `fileName: initial-admin-password`; `serviceKey.fileName: initial-admin-service-key.json` | Existing protected PVC; distinct simple output filenames. Init hook migrates then bootstraps. It has no mounted Kubernetes API token.                                                                                          |
| PostgreSQL                 | `database.secretName: occ-database`; `appUrlKey: application-url`, `migrationUrlKey: migration-url`; `cidrs: []`, `port: 5432`                                                            | External database, separate application/migration credentials, exact IPv4 `/32` endpoints. No database or backup provisioning.                                                                                                 |
| Database TLS trust         | `database.caSecretName: ""`, `caKey: ca.pem`, `caMountPath: /etc/openclaw/database-ca`                                                                                                    | Optional operator CA Secret; supplied URL/TLS configuration must agree.                                                                                                                                                        |
| Placement and rollout      | `controlPlane.nodeSelector: {}`, `installationChecksum: ""`                                                                                                                               | Selector applies to API, worker, init and managed Envoy. Optional SHA-256 rollout annotation; external Secret changes do not automatically compute it.                                                                         |
| API admission network      | `api.clients: []`                                                                                                                                                                         | Required exact namespace and nonempty Pod selectors. Always-on default deny; authenticated ingress/proxy itself is external.                                                                                                   |
| Kubernetes API network     | `cluster.cidrs: []`, `cluster.port: 443`                                                                                                                                                  | Required exact IPv4 `/32` API endpoints observed by Pods; local tunnel addresses are unsuitable.                                                                                                                               |
| DNS                        | `dns.namespace: kube-system`, `dns.podLabels: {k8s-app: kube-dns}`                                                                                                                        | Match actual DNS Pods and enforcing CNI. Bootstrap has separate DNS/database-only policies.                                                                                                                                    |
| Worker lifecycle           | `worker.pollIntervalMs: 250`, `leaseDurationMs: 5000`, `maxAttempts: 5`, `convergenceTimeoutMs: 900000`                                                                                   | API health/readiness endpoints and worker filesystem probes exist. Pod readiness alone does not prove Agent/provider readiness.                                                                                                |
| Kubernetes access          | Chart-owned API/worker ServiceAccounts and scoped role definitions; no toggle                                                                                                             | Tenant RoleBindings and admission controls remain prerequisites; roles do not imply unlimited tenant authorization.                                                                                                            |
| ChatGPT backend            | `backend.chatgpt.enabled: false`, `secretName: occ-chatgpt-admin`, `key: admin-key`, `providerCidr: ""`                                                                                   | API-only admin key mount plus exact `/32` HTTPS destination for `api.chatgpt.com`. This is network allowance, not a forward proxy; pair with Installation Backend/ServiceAccount driver.                                       |
| Console Slack directory    | `api.channelDirectoryProxyUrl: ""`                                                                                                                                                        | Empty disables production lookup. HTTP(S) literal IPv4 endpoint with explicit port; proxy must allow CONNECT to `slack.com:443`. API environment and exact egress are already wired. No proxy workload or consumer is created. |
| API HTTPS discovery        | `api.modelDiscoveryCidrs: []`                                                                                                                                                             | Optional `/32` HTTPS allowances. Model enumeration is optional. Hosted plugin discovery currently also needs API HTTPS access but has no separately named chart setting; see Installation inventory.                           |
| Separate execution cluster | `executionCluster.enabled: false`; `apiKubeconfigSecretName`, `workerKubeconfigSecretName`: empty; `kubeconfigKey: kubeconfig`; `apiCidrs: []`, `apiPort: 6443`                           | Distinct role-specific Secrets mounted at `/etc/openclaw/execution/kubeconfig`; Installation must explicitly select them. Remote endpoint reachability, RBAC and execution chart remain external.                              |

Sources: [validation helpers](../../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl),
[Deployments](../../../deploy/helm/openclaw-enterprise/templates/deployments.yaml),
[bootstrap Job](../../../deploy/helm/openclaw-enterprise/templates/jobs.yaml),
[NetworkPolicies](../../../deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml),
[bootstrap policies](../../../deploy/helm/openclaw-enterprise/templates/bootstrap-networkpolicies.yaml),
[RBAC](../../../deploy/helm/openclaw-enterprise/templates/rbac.yaml).

## Repository broker

| Values and defaults                                                  | Inputs and operational requirements                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryCredentials.enabled: false`, `image: ""`, `backendId: ""` | Approved broker image and matching Installation GitHub Backend/repo driver. Worker sidecar behind HTTPS Service 443, target 8443.                                               |
| `serviceName: ""`, `clusterDomain: cluster.local`, `hostname: ""`    | Fresh service name derives `git`; hostname derives the namespace-qualified FQDN. Preserve exact origin/TLS name for upgrades; set existing `serviceName` explicitly on upgrade. |
| `registryConfigMapName: ""`, `registryKey: registry.json`            | Operator-created immutable/versioned registry shared by API, worker, broker; exact Namespace and GitHub repository authorization.                                               |
| `serviceConfigSecretName: ""`, `serviceConfigKey: config.json`       | Service configuration containing matching registry/backend/TLS identities and limits.                                                                                           |
| `appKeySecretName: ""`, `appKeyKey: private-key.pem`                 | GitHub App private key and installation authorization; never place key content in profile values.                                                                               |
| `tlsSecretName: ""`                                                  | Server certificate/key with SAN matching rendered origin.                                                                                                                       |
| `publicCaSecretName: ""`, `publicCaKey: ca.crt`                      | Separate public-trust Secret, not a private-credential Secret.                                                                                                                  |
| `upstreamCidrs: []`                                                  | Explicit provider destination allowlist. Installation also supplies exact broker Pod peer/port.                                                                                 |

Enabling changes worker strategy to `Recreate` with 75-second termination grace.
Private/control volumes are memory `emptyDir`. Sessions are process-local;
worker replacement restarts the broker and can invalidate credentials. No
session durability or high availability is provided. Fresh bootstrap requires
Namespace IDs before building the registry, so enabling repositories is a
second stage. See the [Installation inventory](installation-inventory.md#repository-access).

Sources: [broker validation](../../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl),
[sidecar](../../../deploy/helm/openclaw-enterprise/templates/deployments.yaml),
[Service](../../../deploy/helm/openclaw-enterprise/templates/repository-credentials-service.yaml).

## Routing and native administration

`gatewayRouting.enabled` defaults false. Empty `hostname` derives private Envoy
Service DNS. `gatewayClassName` and `apiKeySecretName` are empty required inputs when enabled.
Empty `gatewayName` derives `<release>-agent-gateways`; empty `tlsSecretName`
derives `<gatewayName>-tls`. Defaults: `envoyNamespace:
envoy-gateway-system`, `serviceType: ClusterIP`, `remoteNodeCidrs: []`,
`tenantGatewayPort: 8080`, `envoyHttpsTargetPort: 10443`.

`issuerRef` defaults `{name: "", kind: ClusterIssuer, group: cert-manager.io}`;
empty name generates a private root and CA issuer. An external issuer may need
`caSecretName`/`caSecretKey` (both empty). The API-key Secret contains `occ`.
`envoyGatewayPodLabels` defaults to `control-plane: envoy-gateway` and
`app.kubernetes.io/name: gateway-helm`.

The chart creates EnvoyProxy/Gateway/SecurityPolicy/Certificate and isolation
rules after dependencies exist. It does not install their controllers.
`agentNativeAdmin.enabled: false`, `domain: ""`, `sharedCookieDomain: ""`
controls native Agent UI admission separately from Console. Enabling requires
routing and a valid trusted cookie parent plus operator-managed wildcard DNS/TLS.
The [native admin pilot](../../../docs/design.md#native-admin-pilot-exception)
grants full native administration; it is not generic per-operation authorization.

Main routing egress admits tenant gateway TCP 8080. Private plugin status on
TCP 18791 additionally requires the Installation's observed proxy sources.
Source: [routing templates](../../../deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml).

## Observability

| Capability                | Defaults                                                                                    | Prerequisites and limits                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private metrics           | `metrics.enabled: true`, `port: 9464`, scraper namespace/Pod labels `{}`                    | Both selectors must be supplied for scraper ingress; empty admits none. No Prometheus/ServiceMonitor in main chart.                                             |
| CRI logs                  | `logging.collector.enabled: false`; pinned Collector image in values                        | Optional DaemonSet reads `/var/log/pods`, nonroot with supplemental group 0; admission/host permissions must permit it. Do not duplicate an existing collector. |
| Collector config          | `configSecretName: occ-otel-collector-config`, `envSecretName: occ-otel-collector-exporter` | Config keys `collector.yaml`, `kubernetes.yaml`, `exporter.yaml`; optional exporter environment Secret.                                                         |
| Collector exporter        | `exporter.cidr: ""`, `namespaceLabels: {}`, `podLabels: {}`, `port: 443`                    | Select one exact `/32` destination or paired selectors. Endpoint/auth still belong in collector configuration.                                                  |
| Collector metrics         | `logging.collector.metrics.enabled: true`, scraper selectors `{}`                           | Private listener, explicit scraper access.                                                                                                                      |
| Collector resources/state | requests 100m/128Mi, limits 500m/384Mi; `state.sizeLimit: 128Mi`, `tmp.sizeLimit: 64Mi`     | Disposable buffers; not durable log storage or guaranteed delivery.                                                                                             |

Sources: [metrics](../../../deploy/helm/openclaw-enterprise/templates/metrics.yaml),
[collector](../../../deploy/helm/openclaw-enterprise/templates/collector.yaml).

## Companion charts

[Execution values](../../../deploy/helm/openclaw-execution/values.yaml) configure
private routing and API/worker RBAC in a separate execution cluster, not workloads.
Required: `routing.hostname`, `gatewayClassName`, `tlsSecretName`,
`controlPlaneCidrs`. Defaults: `gatewayName: oce-harnesses`,
`envoyNamespace: envoy-gateway-system`, `serviceType: ClusterIP`,
`envoyHttpsTargetPort: 10443`, DNS `kube-system`/`k8s-app: kube-dns`.
Service type accepts ClusterIP or LoadBalancer. Preexisting TLS, GatewayClass,
Envoy and correct post-NAT sources are required. Policies allow Agent ports
18790 and 18791; this does not itself establish tenant ingress correctness.
See [routing](../../../deploy/helm/openclaw-execution/templates/routing.yaml).

[Observability demo values](../../../deploy/helm/openclaw-observability-demo/values.yaml)
select pinned Prometheus/Loki/Grafana images and require `occ.namespace`,
`occ.release`, `cluster.cidrs` and `grafana.adminSecretName`. Defaults:
`occ.metricsPort: 9464`, `grafana.adminSecretKey: password`, `cluster.port: 443`,
and normal DNS selectors. `grafana.clients: []` means port-forward-only access.
Each workload has one replica, `storage.sizeLimit: 1Gi` emptyDir, requests
100m/128Mi and limits 1 CPU/512Mi. Prometheus retains 24h/256MB.
The demo provides neither durable storage nor HA.

## Environment requirements and absent knobs

Local Kubernetes and EKS/general Kubernetes use the same value contracts.
Compute requires Kubernetes 1.35.0 or newer in production for each cluster.
Both environments need enforcing CNI, actual Pod-observed endpoint addresses,
protected bootstrap storage, namespace-scoped bindings, compatible runtime
storage and image access.
EKS-specific node/CSI/IAM/API reachability work remains operator-owned; no EKS
switch exists. Local cluster provisioning is likewise outside these charts.

No chart value selects a profile, Agent preset, plugin driver, runtime image,
tenant disk size, model credential, Slack consumer, arbitrary extra environment,
Ingress, HPA, PDB, tolerations, image-pull Secret or database backup. Some are
Installation/resource concerns; others are packaging gaps. There is no
`values.schema.json`; validations are template code. Referenced Secrets, CRDs,
TLS, database connectivity and cross-document consistency cannot be established
by rendering.

## Verification recorded in this task

These non-mutating commands passed, using existing example placeholders:

```sh
helm lint deploy/helm/openclaw-enterprise -f deploy/examples/production/values.yaml
helm template audit deploy/helm/openclaw-enterprise --namespace occ \
  -f deploy/examples/production/values.yaml
```

Bare `helm template` failed as expected on missing immutable controller digest.
Bare `helm lint` exited zero while logging missing-input failures, so require
successful rendering as well as lint. The rendered example is not installable
without replacing placeholders and provisioning prerequisites.

Both companion charts rendered with synthetic inputs: execution used
`execution.example.invalid`, class `eg`, Secret `example-tls`, source
`192.0.2.1/32`; demo used OCC namespace `occ`, release `audit`, Secret
`example-admin`, cluster `192.0.2.1/32`. These reserved examples are validation
inputs, not reusable profile defaults.

Existing [packaging coverage](../../../tests/integration/production-kubernetes-packaging.test.mjs)
was inspected, not run. No new local runtime, EKS, provider, or restart proof was
obtained. Runtime qualification belongs to the [acceptance plan](installation-inventory.md#qualification-plan).
