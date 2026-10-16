# Qualify Strands Box egress and Dogwood policy with OCE Credential Proxy

An operator can select the `strands-box` backend for a dedicated, protected execution. On Linux,
Kubernetes contains the workload. The separately deployed sender uses the portable Amazon Strands Box
HTTPS inspection gateway and an execution-scoped Dogwood policy engine. OCE still owns admission,
current authority, credential access, the final send permit and response protection. This backend
does not require an AWS model key, Bedrock inference, or an Amazon-managed sandbox service.

## Run the installed and ordinary deployment tests

Use an isolated Linux x86-64 Docker host, with Node 24, the repository's pinned pnpm, Rust toolchain,
k3d, kubectl, Helm 3, jq, curl and OpenSSL. Install the lockfile dependencies and build the controller
from the source under review. Build or receive its supported OCE Linux runtime image using
`deploy/runtime/Dockerfile`; the production test records the actual runtime manifest digest. Allow
roughly 20 minutes after the Rust build, enough memory for the OCE runtime and both test executions,
and space for K3s, the runtime images and a fresh PostgreSQL database.

```sh
pnpm install --frozen-lockfile
pnpm build

# The default sender build fetches the pinned public Strands Box revision, applies the small
# terminal delegated-request hook in runtimes/strands-credential-proxy/upstream, then builds locked.
deploy/strands-credential-proxy/build-image.sh oce-strands-sender:review

# Exercise both the real installed data path and ordinary production controller/worker deployment.
STRANDS_QUAL_OCE_RUNTIME_IMAGE=oce-runtime:review \
  scripts/qualification/strands-box-credential-proxy-k3d.sh
```

`build-image.sh` accepts a second argument for an already built Linux sender. The test runner accepts
`STRANDS_QUAL_GATEWAY_BINARY` for that purpose, `K3D` for a k3d binary path, and `STRANDS_QUAL_HELM_BIN`
for Helm. A previously built binary saves compilation time; record its SHA-256 alongside the source
under review. On a 2 TiB scratch filesystem, the optional `STRANDS_QUAL_LARGE_DISK_RESERVE=60Gi`
retains a hard disk reserve when the default percentage would reserve hundreds of GiB. Leave it unset
on an ordinary host. The runner never clears a pressure taint.

Run this qualification on a dedicated, authorized Linux host outside shared or production clusters.
Use disposable local resources that you can remove when the test ends. Give the test processes and
workloads no ambient cloud credentials or workload identity. Block access to instance metadata and
verify the block from inside the workload. Kubernetes NetworkPolicy alone may not cover traffic to
the node itself. If you cannot establish these boundaries, stop before creating resources.

The script creates a uniquely named cluster with K3s's NetworkPolicy controller, private kubeconfig,
locally imported sender, and private test origin. It verifies the platform-specific image import
through CRI, and runs the sender as UID 65532 with an executable readable by that UID. Nothing is
pushed to a registry. The tests generate their own authorities, keys and synthetic provider material.
The ordinary deployment test also installs the supplier's pinned Envoy Gateway 1.6.7 and cert-manager
1.18.4, the actual workspace gateway and node enrollment, and PostgreSQL 18 with separate app and
migration roles. The fixture controller has admin access to this disposable cluster. This is not a
least-privilege controller RBAC qualification. The ordinary Gateway uses OCE's 4 GiB acceptance-test
limit for the full native Gateway, including its plugins and worker bundle; this sets no production
sizing default. In the event of an interrupted run, inspect its named
cluster and containers and remove only those exact owned resources. An observation timeout is not
permission to replay a provider operation.

## Read the two evidence levels

1. **Installed data path and boundary.** With the runtime image variable omitted, only this lane runs.
   It uses real source admission, IAM, authoritative versioned Kubernetes Secrets, the production
   paired Sandbox/Credential Proxy drivers, actual installed-policy readback, and an ordinary HTTPS client in a
   default-deny tenant. It first refuses source adoption before any material read while Kubernetes is healthy but the
   installation is absent. The first source POST must return 503 before a material read. The test
   then installs the actual chart, negotiates the running pinned sender profile, and admits the source.
   It independently repeats live installation verification with a read-only API
   identity that cannot get Secrets. A test Compute owner signs the supplier's release challenge; a minimal test
   Harness verifies the signature and serves an authenticated WebSocket. The test distinguishes a
   permitted origin send from temporal denial before Credential Proxy, direct origin and authority bypass,
   and a different execution trying to enter the same sender. It probes a real forbidden final
   trailer and a lost origin reply: the origin sees one write, while Credential Proxy honestly retains possible
   dispatch with no response observation and no retry. The blocked-trailer case also requires the
   supplier's exact blocked-response receipt. A separate revocation between resolution and final send
   requires a settled refusal with no dispatch and zero new decrypted application bytes at the origin.
   Dropping the authority's authorize reply after committing its dispatch opportunity produces no
   sender permit and no origin application bytes, while the supplier retains an uncertain receipt.
   This does not simulate a lost database COMMIT acknowledgement or a PostgreSQL restart.
   Two simultaneously authorized executions receive distinct, overlapping responses. The observer
   counts first decrypted application bytes separately from complete headers and finished bodies.
   A TCP or TLS connection may already exist before the final send check. Another protected
   execution has zero routes and must deny all provider access. Withdrawing the sole binding while a
   test finalizer keeps the sender terminating must preserve the fence and history. The test then
   releases only its finalizer and verifies retirement and refusal to reprovision that execution.
   It also rolls the platform profile to a genuinely different image manifest with the same sender
   bytes. The still-running old sender must lose authority before material access, with no new origin
   application bytes. The upgraded Driver must be able to retire the old execution and release its history.
   This is whole-execution retirement, not an in-place policy reduction. The stale-installation test adds a policy
   whose missing-label `NotIn` selector actually reaches a harmless canary. The sender must now
   refuse provider traffic before material access, and recover the exact installation only after the
   policy is removed. The lane also probes permission withdrawal and an unavailable authority. For a blocked complete response or an uncertain send, the client must receive
   only the fixed gateway refusal, with no provider body, headers or trailers. It separately admits an
   explicit credential-free repository identity read. That positive requires both fresh signed gates
   to select no material, a matching confirmed receipt with an empty injection digest, zero attempted
   provider Secret reads, a bodyless verified TLS origin request without any credential, and only the
   two allowed identity fields at the client. Authorization withdrawal must stop the next request.
   A separately admitted, credential-bearing repository request exercises the real warm-only reader
   and preparation owner with an in-memory preparation store. A cold miss cannot mint or send; one explicit
   preparation permits the exact authenticated metadata read without issuing another credential.
   Only synthetic material is allowed at the origin. Serving is checked separately: the fixture
   rejects missing and incorrect capabilities, sustains the authenticated ping/pong beyond two
   freshness intervals, then proves that dropping the retained connection loses readiness until a
   genuinely fresh observation. This checks capability behavior, not cryptographic server identity.
   Readiness is not provider authority. This test does not stand
   in for the production Compute work queue.

2. **Ordinary deployment and real Codex.** With `STRANDS_QUAL_OCE_RUNTIME_IMAGE` set, the second lane
   loads the production installation file separately for the API and worker, uses the PostgreSQL
   queue and real Kubernetes Compute, and waits for the exact admitted revision to become active.
   It checks that the rolled workload uses the supplied immutable runtime and the Compute-generated
   startup entrypoint under review. It decodes both layers of the controller-rendered startup and
   checks that the actual non-root UID can write Codex configuration under the private home, including
   when kubelet prepares the nested workspace mounts. The positive controls are the genuine Codex startup probe and a
   completed authenticated Codex app-server turn, with an independently counted TLS provider
   observing exactly those two Responses requests. The native app must explicitly reject missing
   and wrong capabilities and stay ready past two freshness intervals. We wait for the natural
   two-minute durable Compute maintenance pass and its queued successor: same active revision,
   workload, sender and bound history, with no further provider access. This does not claim that the
   thirty-minute bearer naturally expired during the test. In a Git-backed workspace, the origin
   independently checks that the native turn metadata in the body and its single matching HTTP header
   are still present and agree, but neither contains the optional repository workspace telemetry.
   We retire the exact owned Gateway before
   its GatewayClass so the finalizer does not strand collection. The provider is synthetic.
   A test name, skipped
   test, loaded configuration, or ready Pod alone does not establish those observations.

## Deployment requirements and scope

Use the complete production selection in
`tests/integration/strands-box-credential-proxy-production-worker-k3d-real.test.mjs` as an executable example.
Select one backend entry of type `strands-box` with matching `sandbox`, `credential_gateway` and
`credential_proxy` driver IDs. Put installation-owned authority TLS, issuer and `strandsBox` settings on the
Credential Proxy, including an immutable sender image, mounted trust and policy files, the enforced network
policy qualification, the exact authority address, and operator-owned origin address pins. Origin
TLS verification is against the admitted name even when the network address is pinned. A change to
the origin address, trust root, route or policy requires a new admitted installation. Use the normal
OCE workspace routing and enrollment prerequisites for dedicated Harnesses.

The untrusted workload receives the sender's public inspection CA and proxy address. It does not
receive the sender signing seed, authority bearer or provider credential. A proxy environment
variable is only a client convenience; the per-execution ingress and egress policies and a genuinely
enforcing CNI provide the tested network boundary. Protect the namespace and selectors from workload
mutation, deny privileged Pods and host networking, and retain the execution's history volume until
the sender and workload have stopped. An unconfirmed or possibly dispatched operation remains tied to
the original OCE receipt. A missing reply or a Dogwood event is not proof that the provider did
nothing.

Native Codex can put the checkout path, remote URLs, commit and dirty state in optional
`workspaces` turn telemetry. That telemetry is outside the protected Responses request grant. The
sender removes it from both the native metadata in the request body and its matching HTTP header,
before OCE classifies and authorizes the request actually sent. This does not scrub repository
information that a user or tool includes in model input, or authorize other unapproved metadata.

Dogwood sees operations actually inspected by this gateway, not every read, shell command or native
tool effect in the workload. The sample one-attempt policy demonstrates history after a real request;
it counts all inspected HTTP attempts, including a protected startup probe and denied attempts
in an inclusive sliding hour. The persistent history is pruned policy state rather than a complete
provider audit or a rollback detector. Choose a reviewed policy appropriate to the admitted
execution. The included qualification exercises bounded HTTPS Responses with static material and an explicitly credential-free repository
identity, as well as the actual sender's cold and warm prepared-repository metadata path. Git
transport, production preparation custody, a different provider, resource limits, multi-node isolation,
cloud workload identity and the intended production CNI need their own qualification.
