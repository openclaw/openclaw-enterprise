# Production controller settings

This reference owns production controller settings. Start with the
[settings reference](../settings.md) for startup configuration and precedence.

## Required production controller environment

The production API is internal-only by default. Operators must provision an
internal Kubernetes `ClusterIP` Service and a default-deny ingress
`NetworkPolicy` that allows only explicitly approved namespace and Pod
selectors. The cluster must enforce NetworkPolicies. Do not expose the listener
through a `NodePort`, `LoadBalancer`, `hostNetwork`, or public endpoint.

The Helm charts allow DNS egress on UDP/TCP ports `53` and `5353` to their
configured `dns.namespace` and `dns.podLabels` peers. Port `5353` supports
OpenShift DNS backends after Service address translation. These grants cover
API, worker, initialization, collector, Slack proxy, Envoy, and observability
demo workloads.

The trusted-operator native admin pilot is the only documented public-ingress
exception: the console host and Agent wildcard hosts route to OCC through the
procedure in [Deploy native admin UI access](../../guides/deploy/native-admin.md).
Envoy and Agent gateway Services remain private, and OCC strips the shared OCE
session cookie before forwarding to the native gateway.

| Variable                                   | Required value or format                                                                                           | Behavior                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | Exactly `production`.                                                                                              | Enables durable production controller composition.                                                                      |
| `OCC_HOST`                                 | One explicit Pod interface IP address.                                                                             | Wildcard addresses and implicit hostnames are rejected.                                                                 |
| `OCC_PORT`                                 | Decimal integer from `1` through `65535`.                                                                          | Selects the internal listener port exposed by the operator's Service.                                                   |
| `OCC_DATABASE_URL`                         | Explicit PostgreSQL application-role URL.                                                                          | Must connect to the already migrated controller database.                                                               |
| `OCC_CONFIG_PATH`                          | Absolute path to trusted Installation startup YAML.                                                                | Selects Configuration, IAM, Compute, and optional account Drivers.                                                      |
| `OCC_AUTH_SECRET`                          | Mounted high-entropy Better Auth secret.                                                                           | Signs and verifies session material without logging it.                                                                 |
| `OCC_AUTH_BASE_URL`                        | Absolute controller base URL.                                                                                      | Defines the production Better Auth base URL and cookie origin.                                                          |
| `OCC_GATEWAY_API_KEY_PATH`                 | Optional absolute path to the private gateway service-key file.                                                    | API only; validates at startup and reads each operation for rotation. Requires Compute endpoint resolution.             |
| `OCC_CHANNEL_DIRECTORY_PROXY_URL`          | Optional HTTP(S) proxy URL with one literal IPv4 address and explicit port, or the exact Helm-managed Service URL. | API only; routes Slack lookup and credential validation through an HTTP CONNECT tunnel. Invalid values fail startup.    |
| `OCC_CHANNEL_DIRECTORY_MANAGED_PROXY_HOST` | Optional exact Helm-managed proxy Service host.                                                                    | API only; the one DNS host the Slack directory Driver accepts in the proxy URL instead of an IPv4 address.              |
| `NODE_EXTRA_CA_CERTS`                      | Optional PEM bundle for a private gateway CA.                                                                      | Node reads it at process startup. Normal leaf renewal under that CA does not require a restart; root-bundle changes do. |

For the Helm deployment, prefer `slackProxy.enabled`. The chart then passes the
managed Service URL and its matching host only to the API Pod and grants API
egress only to the proxy Pods. For an external proxy, set
`api.channelDirectoryProxyUrl` to the approved proxy IP and port; the chart grants
egress only to that exact IPv4 `/32` and TCP port. The proxy must allow CONNECT to
`slack.com:443`; restrict its other destinations at the proxy. When neither
setting is used, the chart renders no proxy egress rule, and Slack lookup and
credential validation require another approved network route. See the
[Slack Channel Driver](../drivers/slack-channel.md#enable-lookup-in-production).

`OCC_AGENT_RUNTIME_LOGS_ENABLED` (`true` or `false`, default `true`) switches the
[Agent logs](../../guides/topics/agent-logs.md) routes; `false` makes them answer
`501`. The chart sets it from `agentRuntimeLogs.enabled`.

When the native admin pilot is enabled, the API also requires:

| Variable                         | Required value or format                                                                                                                                     | Behavior                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `OCC_AGENT_NATIVE_ADMIN_ENABLED` | `true`.                                                                                                                                                      | Enables the trusted-operator Agent native admin UI path.                                                    |
| `OCC_AGENT_NATIVE_ADMIN_DOMAIN`  | Agent host suffix, such as `agents.oce.example.com`, without scheme, wildcard, port, or path.                                                                | Derives stable per-Agent browser hosts.                                                                     |
| `OCC_AUTH_COOKIE_DOMAIN`         | Shared OCE session cookie parent, such as `oce.example.com`; not a public suffix and must contain the console host and Agent suffix on DNS-label boundaries. | Scopes the ordinary Better Auth session cookie to the console and Agent hosts when native admin is enabled. |

For changes to startup `logging.level`, follow the
[log-level procedure](../../guides/observability.md#1-choose-the-log-level).

The API and worker load the same trusted startup YAML; only the API initializes
the optional [Backend client](../backends.md). Both validate Backend membership
and stored ownership before accepting work. When the bundled Kubernetes Compute
Driver is selected, its `drivers.compute.configuration` section contains the
`KubernetesComputeDriverOptions` shape described in the
[Kubernetes Compute Driver guide](../drivers/kubernetes-compute.md#configuration).
Production use of that Driver requires `images.requireImmutableDigest: true`,
digest-pinned gateway and Agent image references, and exactly one in-cluster
identity or explicitly named kubeconfig/context. The processes then verify
authenticated, TLS-checked, read-only Kubernetes Namespace access before serving
requests or claiming work. Installed Drivers validate their own reviewed
configuration and implementation-specific prerequisites.

Agent workspace-file requests use the selected Compute Driver's private gateway
endpoint. Kubernetes derives the URL from the optional `gatewayRouting.hostname`
and the admitted Namespace and Agent IDs. If the hostname is omitted or empty,
Compute derives the chart's Service DNS hostname from the required `gatewayName`,
`gatewayNamespace`, and `envoyNamespace`; see the
[hostname contract](../drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes).
`gatewayName` and `gatewayNamespace` identify the route's parent Gateway;
`envoyNamespace` selects its data-plane namespace.
Compute derives the allowed Envoy peer from those routing settings and rejects
explicit `network.gatewayClients` in routed mode. It does not read a per-Agent
endpoint file or persist a URL in Agent Configuration.

`OCC_GATEWAY_API_KEY_PATH` mounts a dedicated, high-entropy Envoy service key into
the API only. Missing or invalid configured key files fail startup; a file that
becomes unavailable during rotation makes new requests unavailable. Never reuse
the Better Auth signing secret or a model-provider credential. The worker needs
route configuration and namespace-bound HTTPRoute permissions, but no service
key or CA bundle for native file access.

With Helm routing enabled and no `gatewayRouting.issuerRef.name`, cert-manager
bootstraps a private CA and issues Envoy's certificate. The chart projects only
the generated root Secret's public `tls.crt` into the API and sets
`NODE_EXTRA_CA_CERTS`; the CA signing key is never mounted into OCC. An explicit
issuer selects operator-managed issuance instead. Its optional `caSecretName`
and `caSecretKey` must be supplied together when additional CA trust is needed.

See [private Agent gateway routes](../drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
for the Compute contract, and the
[deployment procedure](../../guides/deploy/workspace-routing.md#agent-workspace-files) for Envoy,
cert-manager, native trusted-proxy configuration, and key/certificate rotation.
Kubernetes gateway authentication is always trusted-proxy; private routing
still requires the Installation, Helm, and service-key settings above. Unsupported Drivers and unavailable endpoints return
`503 DEPENDENCY_UNAVAILABLE`.

Missing, invalid, expired, or revoked sessions or service keys return `401`; an
authenticated Principal or ServicePrincipal without the exact existing IAM grant
receives `403`. Neither credential grants rights without IAM. See
[Authentication](../authentication/service-api-keys.md#service-api-keys) for service-key issuance,
scope, and revocation, and the [deployment guide](../../guides/deploy/service-keys.md#service-api-keys-for-automation)
for the procedure. Normal issuance and verification require no additional
settings; initial-key delivery uses the bootstrap settings below.
Auth-secret rotation takes effect after
replacing the mounted Secret and restarting the process; it also invalidates every
[known-device cookie](../authentication.md#known-devices) until each browser's next sign-in.
Revoking one account's cookies needs no rotation: reset its password.

### GitHub sign-in and trusted proxies

These optional variables apply to the API only. The chart never passes them to
the worker or initialization Job.

| Variable                           | Helm value                                 | Behavior                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OCC_AUTH_GITHUB_CLIENT_ID`        | `auth.github` Secret key `clientIdKey`     | GitHub App client ID. Set the client ID, client secret, and recovery user ID together or not at all.                                                                                                                     |
| `OCC_AUTH_GITHUB_CLIENT_SECRET`    | `auth.github` Secret key `clientSecretKey` | GitHub App client secret, read from the dedicated `auth.github.secretName` Secret.                                                                                                                                       |
| `OCC_AUTH_GITHUB_ALLOWED_ORGS`     | `auth.github.allowedOrgs`, comma-joined    | Optional GitHub organization logins whose active members may sign in; see [allowlist](../authentication/external-sign-in.md#organization-and-team-allowlist). At most 10 entries with the teams. Requires the client ID. |
| `OCC_AUTH_GITHUB_ALLOWED_TEAMS`    | `auth.github.allowedTeams`, comma-joined   | Optional `org/team-slug` entries whose active members may sign in. The GitHub App needs organization permission Members: read.                                                                                           |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID` | `auth.recoveryUserId`                      | Existing local password administrator's user ID; designates the recovery account on first activation.                                                                                                                    |
| `OCC_AUTH_PASSWORD_SIGN_IN`        | `auth.passwordSignIn`                      | `all` (default, not rendered) or `recovery-only`: only the recovery account may use a password. Needs GitHub, Google or OIDC; see [recovery-only](../authentication/external-sign-in.md#recovery-only-password-sign-in). |
| `OCC_AUTH_TRUSTED_PROXY_CIDRS`     | `api.trustedProxy.cidrs`                   | Comma-separated IPv4 or IPv6 CIDRs, never `/0`. Requests whose socket peer is inside them may carry forwarded headers.                                                                                                   |
| `OCC_AUTH_TRUSTED_PROXY_PRESET`    | `api.trustedProxy.preset`                  | `ingress-nginx` (default), `aws` or `generic`. Named presets read `x-forwarded-for`. Set with the CIDRs.                                                                                                                 |
| `OCC_AUTH_CLIENT_IP_HEADER`        | `api.trustedProxy.clientAddressHeader`     | Lowercase header name, up to 64 characters, `generic` only. Sign-in limits key on the client address it carries from a trusted peer.                                                                                     |

The chart's API Deployment always uses the `Recreate` strategy: an upgrade stops
the old API Pod before starting the new one, so two controllers never serve
together. Activation still requires closed ingress and stopped identity writers.

With `auth.github.enabled`, the chart adds an API-only egress policy on TCP 443
for `github.com` and `api.github.com`. Empty `auth.github.egressCidrs` allows
`0.0.0.0/0`. To narrow it, list the `web` and `api` IPv4 ranges from
`https://api.github.com/meta`, and update them when GitHub changes them.

`api.trustedProxy` is off by default: the API rejects `Forwarded`,
`X-Forwarded-*`, and `X-Real-IP` with `403`. Failed password sign-ins are then
limited per email only, because every browser behind a proxy shares its address.
With GitHub, Google or OIDC, start, callback, and result then key on the browser's own
cookies, not the address; start has no per-client limit, only an active cap and
the 1,000 pending attempts. Startup logs `authentication.sign-in-limit-warning`,
and Helm's install notes and the profile renderer warn; none of them fail. Set
`api.trustedProxy` unless the API sees each client's own address. Presets:

- `ingress-nginx`: `cidrs` is the ingress controller Pod CIDR; the header
  is `x-forwarded-for`. Keep ingress-nginx `use-forwarded-headers` off.
- `aws`: an Application Load Balancer targeting API Pods; `cidrs` are its
  subnets and the header is `x-forwarded-for`. A Network Load Balancer
  preserves the client source and needs no preset unless it fronts ingress-nginx.
- `generic`: `cidrs` and `clientAddressHeader`, such as `x-real-ip`, are required.

Trust only proxies that overwrite or append the header, and admit them through
`api.clients`. Rendering fails on incomplete GitHub values, an allowlist entry that is
not an organization login or `org/team-slug`, more than 10 allowlist entries, a shared Secret,
`agentNativeAdmin.enabled` with GitHub, `/0` proxy CIDRs, another header with a
named preset, or credential, routing and internal headers such as `cookie`.

### Google sign-in

These optional variables also apply to the API only. Google sign-in uses the same
guarded profile and `OCC_AUTH_GITHUB_RECOVERY_USER_ID` recovery user as GitHub; see
[Google sign-in](../../guides/deploy/google-sign-in.md).

| Variable                          | Helm value                                 | Behavior                                                                                                                                           |
| --------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_AUTH_GOOGLE_CLIENT_ID`       | `auth.google` Secret key `clientIdKey`     | Google OAuth web client ID; determines the provider instance. Set it with the client secret and recovery user ID, or not at all.                   |
| `OCC_AUTH_GOOGLE_CLIENT_SECRET`   | `auth.google` Secret key `clientSecretKey` | Google OAuth client secret, read from the dedicated `auth.google.secretName` Secret.                                                               |
| `OCC_AUTH_GOOGLE_ALLOWED_DOMAINS` | `auth.google.allowedDomains`               | Optional comma-separated hosted domains. When set, the ID token's `hd` must match one and `email_verified` must be `true`. Requires the client ID. |

With `auth.google.enabled`, the chart adds the API-only egress policy
`openclaw-enterprise-api-google-login-egress` on TCP 443 for
`oauth2.googleapis.com` and `www.googleapis.com`. Empty `auth.google.egressCidrs`
allows `0.0.0.0/0`; narrow it with an egress proxy. Rendering fails on incomplete
Google values, a Secret shared with GitHub or any other chart Secret,
`agentNativeAdmin.enabled` with Google, an HTTP base URL, or an allowed domain that
is not a DNS name.

### OIDC sign-in

These optional variables also apply to the API only, with the same guarded profile and
recovery user; see [OIDC sign-in](../../guides/deploy/oidc-sign-in.md).

| Variable                                                     | Helm value                                          | Behavior                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OCC_AUTH_OIDC_ISSUER`                                       | `auth.oidc.issuer`                                  | The exact `iss`; with the client ID it determines the provider instance.                    |
| `OCC_AUTH_OIDC_AUTHORIZATION_URL`, `_TOKEN_URL`, `_JWKS_URL` | `auth.oidc.authorizationUrl`, `tokenUrl`, `jwksUrl` | `https:` on 443 on the issuer's DNS host, no userinfo, query or fragment. Never discovered. |
| `OCC_AUTH_OIDC_CLIENT_ID`, `OCC_AUTH_OIDC_CLIENT_SECRET`     | `auth.oidc` Secret keys                             | Read from the dedicated `auth.oidc.secretName` Secret. All required values or none.         |
| `OCC_AUTH_OIDC_TOKEN_AUTH`                                   | `auth.oidc.tokenAuth`                               | `client_secret_post` (default, not rendered) or `client_secret_basic`.                      |
| `OCC_AUTH_OIDC_DISPLAY_NAME`                                 | `auth.oidc.displayName`                             | Optional Console label, 1–40 printable characters.                                          |

With `auth.oidc.enabled`, the chart adds the API-only egress policy
`openclaw-enterprise-api-oidc-login-egress` on TCP 443. Empty `auth.oidc.egressCidrs`
allows any address except `169.254.0.0/16`. The port is the destination Pod's port; an
IdP inside the cluster on another target port needs
[its own egress policy](../../guides/deploy/oidc-sign-in.md#configure-the-chart). Rendering fails on values the API refuses,
a Secret shared with GitHub, Google or any other chart Secret, `agentNativeAdmin.enabled`
with OIDC, or an HTTP base URL.

### Production Installation bootstrap environment

Both environments run `node scripts/bootstrap-installation.mjs` after migration.
`NODE_ENV` selects `development` or `production`; no other mode is accepted.
The initializer uses the application-role database and Better Auth settings.
Development consumes the [`OPENCLAW_DEV_*` defaults](development.md#required-development-controller-environment) and only the private
service-key output path; it never writes a password file. API/worker startup
requires the resulting Installation and does not create credentials.

The packaged Helm initialization Job creates the singleton Installation,
human and service administrators, and initial [`default` Namespace](../namespaces.md#initial-namespace)
before starting the API or worker. Namespace provisioning completes asynchronously
through the worker. Its separate migration
init container receives only `OCC_MIGRATION_DATABASE_URL`; the bootstrap
container receives the application-role `OCC_DATABASE_URL`, Better Auth
settings, and the following bootstrap settings. The Job sets `backoffLimit: 0`;
failed initialization requires [manual repair](../../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap)
before another attempt.

| Variable                          | Required value or format                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OCC_AUTH_SECRET`                 | Same mounted Better Auth secret used by the API.                                                        |
| `OCC_AUTH_BASE_URL`               | Same absolute Better Auth base URL used by the API.                                                     |
| `OCC_BOOTSTRAP_ADMIN_EMAIL`       | Email address for the first administrator account.                                                      |
| `OCC_BOOTSTRAP_PASSWORD_FILE`     | New file path on protected operator-owned storage for the generated password.                           |
| `OCC_BOOTSTRAP_INSTALLATION_NAME` | Nonempty display name used when creating the Installation.                                              |
| `OCC_BOOTSTRAP_SERVICE_KEY_FILE`  | New private absolute JSON path; on fresh production bootstrap, a distinct sibling of the password file. |

Repeated bootstrap preserves the existing Installation only when the exact
administrator account and IAM identity still match; a mismatch fails closed.
Existing Namespaces and their configuration remain unchanged; no initial
Namespace is backfilled or recreated.
On fresh bootstrap, both files are created exclusively with mode `0600`; their
parent directory must be private and neither destination may already exist.
Helm sets the key path from `bootstrap.password.mountPath` and
`bootstrap.serviceKey.fileName` (default `initial-admin-service-key.json`). The
key filename must be a simple basename distinct from `bootstrap.password.fileName`.
Both use the existing `bootstrap.password.claimName` PVC. Reruns do not inspect,
replace, or regenerate output; see [recovery](../../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap).

## Production operational logging collection

`logging.collector` configures the bundled Helm Collector; `enabled` defaults to
`false`. For enablement, existing-Collector reuse, Secret creation, networking,
and delivery checks, use
[Configure platform observability](../../guides/observability.md#kubernetes-and-helm).

When enabled, the chart requires a digest-pinned image, an exact exporter
destination (IPv4 `/32` or paired namespace/Pod selectors), a TCP port, and
nonempty dedicated configuration and environment Secret names. Neither Secret
may reuse the Installation, database, auth, or ChatGPT Backend Secret, or, when
the feature is enabled, a GitHub, Google, or OIDC sign-in Secret, the gateway API
key, a repository-credentials Secret, or an execution-cluster kubeconfig. The named
Secrets must be in the control-plane namespace:

- `configSecretName` supplies `collector.yaml`, `kubernetes.yaml`, and
  `exporter.yaml` keys.
- `envSecretName` supplies exporter variables, including
  `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, through `envFrom`.

Relevant Helm values:

```yaml
logging:
  collector:
    enabled: true
    image: docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc
    configSecretName: occ-otel-collector-config
    envSecretName: occ-otel-collector-exporter
    exporter:
      cidr: 203.0.113.10/32
      port: 443
    state:
      sizeLimit: 128Mi
```

See [chart defaults](../../../deploy/helm/openclaw-enterprise/values.yaml) for
`resources`, `state.sizeLimit`, and `tmp.sizeLimit`. The
[security reference](../security.md#operational-log-collection-boundary) owns the
credential, runtime-export, and workload isolation boundaries.

### Private telemetry defaults

`metrics.enabled` defaults to `true`, with API and worker listeners on their Pod
IP at port `9464`. Both `metrics.scraperNamespaceLabels` and
`metrics.scraperPodLabels` default to empty: no metrics ingress is granted until
both are set. Partial selectors and invalid or API-colliding ports fail rendering.
See [scraping and discovery](../../guides/observability/metrics.md).

For an in-cluster log receiver, set both
`logging.collector.exporter.namespaceLabels` and `podLabels`, set its `port`,
and leave `cidr` empty. This alternative cannot be combined with a CIDR.
Collector metrics use the same paired selector contract under
`logging.collector.metrics`, on fixed port `8888`; metrics ingress is opt-in.
The chart grants only the selected peer and port. Other NetworkPolicies remain
additive, so review them when assessing effective access.
