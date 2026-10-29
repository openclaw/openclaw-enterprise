# Named workspace runtime attachment

`namedWorkspace.stage: runtime` in Helm attaches an already bootstrapped,
single-namespace installation. It reuses its initialized database without running
initialization or migrations. It does not convert a divergent database history
or adopt resources.
Supply exactly `stage`, `installationId`, `namespaceId`, `uid`, and `startupCycle`.
The chart passes this object as `OCC_NAMED_WORKSPACE`. The disabled default uses
empty IDs and `startupCycle: independent`. Bootstrap stage is unsupported.

The Installation ID must match the stored singleton, and the logical Namespace
must be `provisioning` or `ready`, without `existingNamespace`. Bootstrap leaves
it `provisioning` with queued work; attachment preserves that state and work. A single read-only database transaction checks both identities.
Kubernetes Compute verifies
the original physical UID, derived name, ownership, restricted Pod Security and
private gateway membership on exact-name GETs. API startup and `/readyz` repeat
these checks. Missing, forbidden or replaced Namespaces fail closed; no binding
write repairs them. Configuration and Secret Drivers use the same exact binding.

Named runtime requires bundled single-cluster Kubernetes and OpenShell Sandbox,
with existing private routing identities. OpenShell may select only its Sandbox
member: attachment needs no Credential Gateway, Credential Proxy or Git credential issuer.
Repository authority, credential refresh and prepared GitHub custody are rejected.
This contract is separate from the closed `preprovisionedNamespace` diagnostic
profile; configuring both fails.

Attachment has two operational stages: start the API with workers stopped, then
enable one worker after verifying its dependencies. For initial attachment set
`worker.replicaCount: 0`, `startupCycle: independent`,
`api.clients: []`, and disable Slack, native admin and Git integrations. The chart
renders one Recreate API, no initialization hooks or initialization ServiceAccount,
exact-name
Namespace GET for both API and worker, and only API tenant/configuration
RoleBindings. The worker ServiceAccount and narrow cluster binding remain at zero
replicas. The chart retains the private Gateway, EnvoyProxy, certificates, TLS
issuers, SecurityPolicy and Envoy NetworkPolicies within the existing release.
Gateway route admission and Envoy tenant peers require both the existing gateway
membership label and the derived physical namespace name. Keep resource names,
CA references and membership unchanged; attachment does not adopt resources.
GitHub Console sign-in may retain its normal recovery account and organization
or team allowlist and explicit IPv4 egress CIDRs for the approved sign-in networks.
Default routes (`/0` or `/1`) are refused. Sign-in
grants no additional authorization or Kubernetes rights. Public GitHub read,
sandbox listeners, ChatGPT packaging and nonempty API client lists are refused.
API ingress remains deny-all. Other cluster bindings can broaden permissions;
the operator must independently verify effective RBAC and NetworkPolicies.

After API readiness succeeds, enable `worker.replicaCount: 1` only when the
selected dependencies can start without a worker-hosted Git broker. The chart
then adds worker tenant and configuration RoleBindings.

`startupCycle: gateway-readiness` explicitly selects the worker startup gate. It
requires a direct HTTPS OpenShell endpoint with bearer-file or mTLS authentication.
The worker checks logical and physical identity, public Health, then authenticated
`GetCurrentUser` before recovery or claims. The identity read must return a nonempty
subject and `oidc` or `cloudflare_access` for bearer authentication, or `mtls` for
certificate authentication, including operator certificates. Missing or unsupported
identity reads, malformed identities and `local_dev` responses fail closed. This
check does not establish Workspace permissions or authorization for later work.
Missing identity, forbidden access, pending readiness
and unknown original work age keep it closed. A positively old age is reported,
then normal original deadline and lease rules apply. Every process restart closes
the gate; it never renews leases, resets attempts or changes original timestamps.
`independent` has no startup gate and must not be used for a gateway with that cycle.
The Git transport startup cycle is unsupported by this Git-disabled contract.

See the [runtime flow](../../flows/named-workspace-runtime.md) for startup ordering and failure behavior.
