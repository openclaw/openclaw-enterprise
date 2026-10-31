# Kubernetes Compute configuration

**Contents**

- [Authentication](#authentication)
- [Images and resources](#images-and-resources)
- [Network](#network)
- [Workload identity](#workload-identity)
- [Runtime](#runtime)
- [Private routing](#private-routing)
- [Experimental execution cluster](#experimental-execution-cluster)
- [Example](#example)

Set these fields under `drivers.compute.configuration` in the Installation
startup YAML. Both API and worker load the file at `OCC_CONFIG_PATH`; restart
both after changes. The [schema and validator](../../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
reject unknown fields and invalid combinations before provisioning.
[Selection fields](../compute.md#configuration) are shared with other Drivers.

Required rows have no default. Requirements inside an optional object apply
when that object is supplied; conditional requirements appear in the last column.
See the [implementation limits](../kubernetes-compute.md#limits) before deployment.

## Authentication

| Setting                         | Type   | Requirement | Value, default, and constraints                                                                                |
| ------------------------------- | ------ | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `authentication.mode`           | string | Required    | `inCluster` uses the controller ServiceAccount and cluster CA; `kubeconfig` uses an explicit file and context. |
| `authentication.kubeconfigPath` | string | Optional    | Required with `kubeconfig`; no ambient-file fallback.                                                          |
| `authentication.context`        | string | Optional    | Required with `kubeconfig`; no current-context fallback.                                                       |

Kubernetes API certificates must be verified in either mode. Credentials remain
in the controller's ServiceAccount or protected kubeconfig, not inline YAML values.

## Images and resources

| Setting                                 | Type       | Requirement | Value, default, and constraints                                                                            |
| --------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `images.gateway`, `images.agent`        | string     | Required    | Approved image references with lowercase repository paths.                                                 |
| `images.requireImmutableDigest`         | boolean    | Required    | Must be `true` in production, requiring lowercase `@sha256:` digests.                                      |
| `resources.gateway`, `resources.agent`  | object     | Required    | Each has `requests` and `limits`, both with `cpu` and `memory` quantity strings. Requests must fit limits. |
| `resources.namespace.quota`             | string map | Required    | Nonempty Kubernetes resource quota; nonnegative quantity strings.                                          |
| `resources.namespace.containerDefaults` | object     | Required    | Namespace default `requests` and `limits`, each with `cpu` and `memory`.                                   |

Quotas and defaults cover both roles in a shared tenant namespace; the two-cluster
profile applies them to each physical target. Quote quantities such as `cpu: "4"`.
The [installation profiles](../../../guides/deploy/installation-profiles.md) explain
the measured memory defaults. Invalid resource pairs, quotas, and selector labels
fail before resource creation.

## Network

A peer object has required `namespace` and `podLabels` fields. Use exact workload
selectors; see [networking and isolation](networking-and-isolation.md#networking)
for label constraints, egress rules, and source-address verification.

| Setting                                | Type         | Requirement | Value, default, and constraints                                                                                                            |
| -------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `network.dns`                          | peer         | Required    | Cluster DNS namespace and Pod labels.                                                                                                      |
| `network.gatewayPort`                  | integer      | Required    | `1`–`65535`; cannot use runtime-status port `18791`. Sandbox routing also reserves the next port.                                          |
| `network.gatewayTrustedProxyCidrs`     | string array | Required    | Nonempty proxy socket-source CIDRs; all-source ranges are rejected.                                                                        |
| `network.gatewayClients`               | peer array   | Optional    | Nonempty without `gatewayRouting`; must be omitted with private routing.                                                                   |
| `network.pluginStatusProxySourceCidrs` | string array | Optional    | API-server Pod-proxy sources, preferably `/32` or `/128`. Omission adds no diagnostics ingress.                                            |
| `network.repositoryCredentials`        | object       | Optional    | Broker peer plus `port` (`1`–`65535`). Omission adds no broker peer rule.                                                                  |
| `network.publicGithubRead`             | object       | Optional    | Reader peer plus IPv4 ClusterIP `address`; single-cluster only. No reader rule by default.                                                 |
| `network.providerHarness`              | object       | Optional    | Provider peer plus IP `address` and `port` (`1`–`65535`). No bridge by default; supported only for the documented local OpenShell profile. |

## Workload identity

| Setting                                         | Type    | Requirement | Value, default, and constraints                                                                                   |
| ----------------------------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `servicePrincipalCredentials.mode`              | string  | Required    | `disabled` or `projectedServiceAccountToken`. Production requires projection unless a Sandbox Driver is selected. |
| `servicePrincipalCredentials.audience`          | string  | Optional    | Required nonempty audience when projecting a token; no default.                                                   |
| `servicePrincipalCredentials.expirationSeconds` | integer | Optional    | Required with projection; `600`–`86400` seconds, no default.                                                      |

## Runtime

`runtime` is optional in the schema, but required for production workloads.
Omission selects the verification runtime. Storage requirements are defined in
[storage and credentials](storage-and-credentials.md).

| Setting                                         | Type       | Requirement | Value, default, and constraints                                                                                                                                                    |
| ----------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.transportSecretPrefix`                 | string     | Required    | Must form a DNS-safe Secret name with `-` and a 12-character suffix.                                                                                                               |
| `runtime.gatewayStorageClassName`               | string     | Required    | DNS-safe StorageClass name for private `10Gi` RWO gateway disks with filesystem locking and durability.                                                                            |
| `runtime.nodeSelector`                          | string map | Optional    | Harness and embedded Pod placement. Omission adds no selector.                                                                                                                     |
| `runtime.gatewayNodeSelector`                   | string map | Optional    | Required for dedicated real Gateways, including their state initializer. Use separate trusted and tenant node pools.                                                               |
| `runtime.nativeOpenClawSessionCapacity`         | integer    | Optional    | `1`–`1024`, default `8` retained native session workers per AgentRevision Sandbox.                                                                                                 |
| `runtime.codexSeccompProfile`                   | string     | Optional    | Relative localhost profile installed on every eligible node. Omission uses `RuntimeDefault`.                                                                                       |
| `runtime.codexModelBaseUrl`                     | string     | Optional    | HTTPS streaming Responses endpoint ending in `/v1` for dedicated Codex API-key auth; omission retains OpenAI's default.                                                            |
| `runtime.codexModelSupportsStandaloneWebSearch` | boolean    | Optional    | Default `false` for an explicit endpoint; `true` requires `codexModelBaseUrl`. See [provider capabilities](managed-native-configuration.md#custom-codex-provider-capabilities).    |
| `runtime.channels`                              | object     | Optional    | Requires `proxyUrl`; optional `managedProxy` has `hostname`, `namespace`, `podLabels`, and `port`. No channel proxy by default. See [channel egress](networking-and-isolation.md). |

Stopping a hosted native session releases its slot; saved history does not consume
capacity. OpenClaw does not retire idle paired-node workers, so size capacity
against workload CPU and memory limits.

`codexModelBaseUrl` rejects wildcards, port `0`, `@` or credentials, spaces,
controls, missing `//`, queries, fragments, and shorthand IPv4. A non-443 port,
IPv6, or excluded IPv4 [starts with a warning](../../../guides/operate/network-isolation.md#if-a-check-fails).
OpenShell credential sources select their own endpoint. OAuth, account logins,
and OpenClaw ignore this option. Only the Harness receives the key. Private
Gateway configuration qualifies parent and subagent selections (strings or
primary/fallback objects), preserving native IDs and admitted values. Transport
uses the authenticated app server and fail-closed HTTP; see [Harness execution](../../harness-execution.md).

## Private routing

`gatewayRouting` is optional. When supplied, omit `network.gatewayClients`;
Compute derives the Envoy peer. See [private routes](networking-and-isolation.md)
for deployment and authentication requirements.

| Setting                               | Type    | Requirement | Value, default, and constraints                                                                                                                   |
| ------------------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gatewayRouting.gatewayName`          | string  | Required    | Existing Gateway name.                                                                                                                            |
| `gatewayRouting.gatewayNamespace`     | string  | Required    | Namespace containing the Gateway.                                                                                                                 |
| `gatewayRouting.envoyNamespace`       | string  | Required    | Namespace containing the Envoy proxy.                                                                                                             |
| `gatewayRouting.hostname`             | string  | Optional    | DNS hostname without port/path. Omission derives an internal hostname from Gateway identity; two-cluster execution requires an explicit hostname. |
| `gatewayRouting.endpointPort`         | integer | Optional    | External endpoint port, `1`–`65535`; default `443`.                                                                                               |
| `gatewayRouting.envoyHttpsTargetPort` | integer | Optional    | Envoy target port, `1`–`65535`; default `10443`.                                                                                                  |
| `gatewayRouting.sandbox`              | object  | Optional    | Requires `domain`; `publicPort` defaults to `443`. Requires `runtime` and a valid, unreserved gateway port plus one. No sandbox route by default. |

## Experimental execution cluster

Omit `executionCluster` for a single cluster. Two-cluster execution requires
`runtime` and an explicit control-plane routing hostname. Diagnostics identify `/executionCluster/...` fields, including
`/executionCluster/caBundle`. This profile still needs [complete runtime acceptance](../../../testing/kubernetes.md#two-cluster-validation).

| Setting                                                 | Type         | Requirement | Value, default, and constraints                                                                                       |
| ------------------------------------------------------- | ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `executionCluster.authentication`                       | object       | Required    | `mode: kubeconfig` with its own explicit `kubeconfigPath` and `context`.                                              |
| `executionCluster.harnessRouting`                       | object       | Required    | `hostname`, `gatewayName`, `gatewayNamespace`, `envoyNamespace`; optional `envoyHttpsTargetPort` defaults to `10443`. |
| `executionCluster.network.dns`                          | peer         | Required    | Execution-cluster DNS selector.                                                                                       |
| `executionCluster.network.harnessEndpointCidrs`         | string array | Required    | Explicit nonempty Harness endpoint ranges.                                                                            |
| `executionCluster.network.gatewayEndpointCidrs`         | string array | Required    | Explicit nonempty Gateway endpoint ranges.                                                                            |
| `executionCluster.network.pluginStatusProxySourceCidrs` | string array | Required    | Explicit nonempty Pod-proxy source ranges.                                                                            |
| `executionCluster.caBundle`                             | string       | Optional    | Up to 65,536 characters of X.509 PEM certificates and whitespace. Omission uses default trust.                        |

## Example

Replace the illustrative image digests, StorageClass, node labels, and proxy
source CIDR with verified values for your cluster:

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      authentication:
        mode: inCluster
      images:
        gateway: registry.example/openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        agent: registry.example/openclaw-codex@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        requireImmutableDigest: true
      resources:
        gateway:
          requests: { cpu: 100m, memory: 2560Mi }
          limits: { cpu: "4", memory: 4Gi }
        agent:
          requests: { cpu: 100m, memory: 768Mi }
          limits: { cpu: "4", memory: 6Gi }
        namespace:
          quota: { pods: "10" }
          containerDefaults:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: "4", memory: 256Mi }
      network:
        dns:
          namespace: kube-system
          podLabels: { k8s-app: kube-dns }
        gatewayPort: 8080
        # Replace with verified source CIDRs for your authenticated proxy.
        gatewayTrustedProxyCidrs: ["<actual-proxy-source-cidr>"]
        gatewayClients:
          - namespace: openclaw-system
            podLabels: { app: approved-gateway-client }
      servicePrincipalCredentials:
        mode: projectedServiceAccountToken
        audience: openclaw-enterprise
        expirationSeconds: 900
      runtime:
        gatewayStorageClassName: sqlite-block
        nativeOpenClawSessionCapacity: 8
        nodeSelector: { oce-role: agents }
        gatewayNodeSelector: { oce-role: control-plane }
        transportSecretPrefix: openclaw-agent-transport
        # Optional; first install this reviewed profile on every eligible node.
        codexSeccompProfile: profiles/codex-0.160.0.json
```

The [complete Installation example](../../../guides/deploy/production-installation.md#configure-the-installation)
adds the other required Drivers and settings.
