# Strands Box protected egress on Kubernetes

Select the `strands-box` backend to run a dedicated Codex Harness with an execution-specific
[Strands Box](https://github.com/strands-agents/box) HTTPS gateway and persistent
[Dogwood](https://github.com/dogwood-policy/dogwood) policy history. Kubernetes contains
the Linux workload. Box inspects its TLS requests, and Dogwood can deny an operation based on
earlier attempts. An allowed operation enters the same [protected Credential Proxy](../../../specs/rfcs/0021-egress-proxy-credential-lifecycle/security.md)
that authorizes the operation, reads the selected credential, checks authority again before send,
and protects the actual provider response. This is an experimental, opt-in backend.

The example counts every inspected HTTP attempt in an inclusive, sliding 3,600-second window.
The current attempt counts, a denial extends the window, and Codex's startup probe consumes the
allowance. Choose a policy that covers startup and the intended work. Dogwood sees the method,
canonical path and original body size before Credential Proxy authorizes or minimizes a request.
Its execution-local history cannot establish which bytes reached a provider, client delivery, or
effects outside this gateway. A TCP or TLS connection can precede the final send permit. Cancelling
a pending connect marks its Box permit indeterminate and gives no permission to try again.
After an ambiguous send, consult the existing operation evidence before starting new work.

The catalog also supports an explicitly authorized, credential-free repository identity read.
Consent names the exact Agent, repository and origin. The sender derives this profile from the
installed grant, and both Credential Proxy checks must select no material before one bodyless GET.
An unavailable credential or an absent selection cannot turn a credentialed request into that read.
With OCE's prepared GitHub lifecycle configured, the same sender can instead use an already prepared
installation credential for its exact repository metadata grant. A cold or expired selection refuses
the request; it cannot mint, refresh or schedule credentials on the request path.

## Qualify the cluster before enabling the backend

Use a controlled execution namespace with an enforcing ingress **and** egress NetworkPolicy
implementation. Test that an admitted workload cannot connect directly to a controlled provider
origin, and that a different workload cannot reach its sender. A stored policy, a proxy
environment variable, or a running sender alone cannot prove either property. Qualify host and
cloud metadata access separately. Kubernetes NetworkPolicy treats node-local traffic specially.

The cluster administrator, CNI, admission, storage, trusted sender and Credential Proxy are in the trust
boundary. Only the controller and trusted cluster operators may create or modify Pods, labels,
policies, Services, Secrets, admission, or volumes in the execution namespace. In particular,
anyone who can create a Pod there can potentially mount a sender Secret or its history. The
Harness must have neither those privileges nor a route to an unrestricted relay. The backend
rechecks the admitted objects and additive network grants but cannot make hostile cluster
administration safe or provide an atomic snapshot of a changing cluster.

Supply a fixed, operator-qualified IPv4 address and port for the authority and for each provider
hostname. The sender has a narrow egress policy for those addresses and verifies TLS against the
original provider hostname. Address changes require a new admitted execution. For a provider
with rotating addresses, qualify an appropriate name-aware enforcement plane first. Keep the
authority signing key in the controller's protected mounted files. Use only an issuer and key
dedicated to this authority, and verify that its public key matches the listener configuration.
Use a persistent volume class accessible to the non-root sender; retain only history appropriate
to the execution. Loss of an enrolled history must not silently reset the budget.

## Select the paired drivers

For a Helm installation, explicitly enable `strandsBoxCredentialProxy.enabled` on the enterprise chart
or, for split execution, on the execution cluster's chart. Set its
`strandsBoxCredentialProxy.gatewayImage` to the same immutable platform-manifest reference as the
Driver's `gatewayImage`. The chart installs a single profile Pod in the trusted execution-platform
namespace. It runs the actual pinned sender binary in profile mode, with no Service, credentials,
volumes, or egress. Only the trusted operator may change that installation. The API and worker get
read-only access to its exact Pod and proxy, in addition to the tenant worker's Pod lifecycle and
signed-release POST and the tenant API's installation observations. No Secret read permission is added.

Before OCE adopts a source, it verifies the actual running image digest, challenges that Pod's
compiled protocol and required and supported capabilities, then confirms Pod and container identity
did not change across the exchange. Missing, stale or incompatible installation refuses adoption
before provider material access. Configuration, wiring and fresh verification repeat this check.
The profile describes what the installation supports. The per-execution proof below establishes
what it actually installed for this workload. The worker keeps the sender seed and bearer private;
the verifier reads their public-key registration and a commitment to the bearer, then challenges
the live sender. Existing single-cluster source-store authority remains a separate trusted role.

Add the following to the ordinary Installation startup YAML with the bundled Kubernetes Compute
Driver, a configured dedicated Codex runtime, and immutable workload images. Paths refer to
controller mounts. The documentation-only addresses and image reference must be replaced with
your qualified endpoints and reviewed sender digest. The source catalog never accepts legacy
gateway material writes. Source bindings and provider semantics remain subject to ordinary OCC
admission, including its restriction to at most one explicit protected binding per execution.

```yaml
backend:
  - id: strands
    type: strands-box
    configuration: {}
    drivers:
      sandbox: sandbox-strands
      credential_gateway: source-strands
      credential_proxy: credential-proxy-strands
drivers:
  sandbox: { id: sandbox-strands, configuration: {} }
  credential_gateway: { id: source-strands, configuration: {} }
  credential_proxy:
    id: credential-proxy-strands
    configuration:
      authority:
        host: 0.0.0.0
        port: 8443
        certificatePath: /run/oce/listener.pem
        privateKeyPath: /run/oce/listener-key.pem
        issuerPublicKeyPath: /run/oce/issuer.pub
        issuer: oce-strands
        audience: oce-exchange
        keyId: issuer-1
      strandsBox:
        installationNamespace: oce-execution-system
        authorityUri: https://192.0.2.1:8443
        authorityCaPath: /run/oce/authority-root.pem
        issuerPrivateKeyPath: /run/oce/issuer-key.pem
        gatewayImage: registry.example/strands-credential-proxy@sha256:REPLACE_WITH_REVIEWED_DIGEST
        dogwoodPolicyPath: /run/oce/operation-policy.dw
        qualifiedNetworkPolicy: kubernetes-enforced
        storageClassName: qualified-execution-volume
        originOverrides:
          provider.example.test:
            connectIp: 192.0.2.2
```

For a private origin, put only its appropriate public CA bundle in `originCaPem` beside
`connectIp`. If Compute admits a workspace-node gateway, `workspaceGateway: {hostname: …,
address: …}` resolves its operator-selected hostname without granting general workload DNS.
The backend recognizes only Compute's exact admitted workspace egress rule. Set an explicit
`drivers.compute.configuration.runtime.nodeSelector` for the qualified execution nodes. Both the
sender and Harness are constrained to those nodes, and their exact selectors are part of admission.
Qualify every selected node, the CNI and reachability of Pod proxy from the execution API server.
Readiness cannot establish cloud metadata isolation or make an untrusted node safe.

## How protected execution becomes ready

1. The controller installs an execution-specific sender, its history volume, the network fences,
   and the nonsecret route and policy document. The signing key for this execution stays on the
   sender side. The Harness gets the public interception CA and its ordinary admitted workspace.
2. The controller challenges the sender through the Kubernetes API. It checks a fresh signature
   over the exact policy, process, exchange public key, public interception CA, and projected
   bearer digest. The policy commits to the required sender image digest. The controller matches it
   to the admitted Pod image and the running container's actual manifest, checking the same Pod and
   container across the challenge and in the release fence. An upgrade to a different sender image
   requires a newly admitted execution; the old execution can still be retired without granting it
   access again. A sender still waiting for a volume, image, or projected bearer is not ready.
   For this backend Compute requests ordinary active-revision maintenance every two minutes.
   Reconciliation renews the 30-minute bearer in its last five minutes, for this same execution and
   exchange key. The verifier refuses a projection that differs from its recorded commitment.
   If maintenance or projection stops, protected operations stop at expiry instead of using stale authority.
3. Credential Proxy records the authenticated installation. Compute verifies it again, commits the
   association, and signs the Harness's fresh startup challenge. The Harness validates the
   release before login or its first model probe. At activation the observer requires an explicit
   authentication rejection without a capability, then an authorized WebSocket to the released
   Harness. It keeps that connection, not the bearer. After at most five seconds, ordinary readiness
   requires a matching ping nonce on that live connection and a fresh rejection without a capability.
   This detects accidental authentication disablement in the trusted runtime. Client capability
   authentication does not establish server identity against a deliberate fake inside the same Pod.
4. For each allowed request the existing authority verifies the current installation at both
   credential checks. It rejects changed Pods, policy, identity, binding or authority. An
   authority outage, rejected policy, uncertain send, or blocked response grants no direct
   fallback or retry permission. Zero admitted routes still require protected installation and
   admit no provider operation. Withdrawing the sole binding retires this execution. The adapter
   records a nonsecret retirement marker, stops the sender first, and preserves the network fence
   until both Pods are gone. It keeps history until revision cleanup and retains the marker until
   namespace deletion, so stale maintenance cannot start a fresh budget. This adapter cannot reduce
   a multi-binding policy in place. A new revision is a new budget, subject to fresh admission.

A replacement sender may generate a different interception CA. Keep the installation fenced and
re-admit it explicitly when the client CA or installation changes. The persistent-history unit test
demonstrates temporal denial, not transparent sender replacement, history rollback detection, or
permission to reset an allowance.

The source-level selection and negative checks are in
[strands-box-credential-proxy-control.test.mjs](../../../tests/integration/strands-box-credential-proxy-control.test.mjs).
Use installed qualification with a controlled TLS origin to establish what your cluster actually
enforces. A controlled origin result and live-provider qualification are different evidence.
