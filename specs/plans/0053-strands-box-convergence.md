---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Strands and Box protected execution

- **ID:** TASK-0053
- **Delivery status:** Planned
- **Authority:** [RFC-0023](../rfcs/0023-egress-proxy-credential-lifecycle/index.md), its proposed [Installation credential ownership amendment](../rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md), the proposed [held-start amendment](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md), and the proposed [Agent-wide Box policy amendment](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-agent-policy.md)
- **Source baseline:** `962a41087083053b585b477d4791f8aded6a9f4e`

## Outcome and scope

For v1, qualify one trusted native Box parent in the Agent Pod container. It
directly starts its trampoline and contained Codex Agent child in that same
container. This removes the separate Kubernetes workload-container boundary;
Box's native isolation must be qualified before protected use.

On a clean ARM64 Helm installation, the normal Worker must deploy the Agent.
The deployed Agent must complete a real HTTP model turn, push a commit, and open
a draft pull request in its assigned GitHub repository. After Git access is
withdrawn, the same Agent
must refuse fresh Git use and complete another model turn in the same
conversation. V1 qualifies HTTP API-key inference only. Admission refuses
personal access tokens (PATs), interactive login, and WebSocket credential
delivery.

## Credential and execution boundary

Box Policy alone authorizes Box network, shell, and filesystem operations.
The selected Sandbox Driver authors supported Policy and configuration from
admitted declarations. A tool or configuration declaration requests a
capability; it does not grant an operation. Missing Policy denies, floor
restrictions can only deny, and an unsupported Policy representation must
refuse. OpenClaw Enterprise (OCE) IAM and repository policy independently admit or refuse credential
use. Credential binding or injection requires both a Box Policy permit and
current OCE authorization; it cannot grant a Box operation.

Box routes are available to every process in the same Box, and the current
callback cannot identify the executable that originated a request. The proposed
[Agent-wide Box policy capability](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-agent-policy.md)
requires explicit admission for one authenticated Agent Sandbox in the initial
isolated pilot. It cannot satisfy an
executable-specific assertion. Sandbox must enforce an asserted executable or port
restriction or refuse the policy, as required by the
[credential ownership amendment](../rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md).
Per-executable enforcement remains an implementation dependency.

The trusted Box parent owns its vault and HTTP injector. The vault replaces an
opaque placeholder only on an admitted HTTP request. The injector checks the
execution, origin, port, method, path, and credential presentation, verifies
upstream TLS, refuses dangerous redirects, and blocks known credential
disclosure in responses and diagnostics. Limit credentialed origins to trusted
providers. This design assumes that an admitted provider does not maliciously
encode or reflect its credential and that the host kernel is not compromised;
it cannot guarantee protection under either attack. The TLS certificate
authority's private signing key stays in trusted memory.

The child may receive reviewed filesystem grants, public trust material, and
opaque placeholders that convey no retrieval authority. It must neither receive
nor retrieve GitHub App signing keys, installation tokens, model API keys,
PATs, OCE issuer material, repository broker credentials, private configuration,
release authority, or a reusable ingress bearer. Sandbox must prevent access
through inherited descriptors, process inspection, filesystem aliases,
environment, mounts, shared state, home, temporary directories, persistent
volume claims, Pod manifests, arguments, logs, output, authentication or control
interfaces, proxy endpoints, and redirects.

The selected Sandbox must qualify Box's native user, mount, PID, and network
namespaces, restricted filesystem, and seccomp policy as the boundary between
parent and child. Kubernetes NetworkPolicy selects Pods, not processes;
Sandbox must isolate trusted control interfaces and prevent direct egress,
including loopback, direct DNS or upstream connections, and raw sockets. A
separate trusted proxy Pod and stronger node isolation remain future work.

OpenClaw Control Plane (OCC) and IAM own metadata, bindings, and admission. Compute owns Agent revision
Pods, storage, placement, lifecycle, generic observation, and the release
decision. TokenService holds usable credentials and issuer keys and issues or
renews tokens. CredentialProxy owns effective credential policy, target-bound
versioned delivery to the trusted recipient, serving-copy readback, and
withdrawal delivery. Sandbox owns containment, private transport, startup hold,
and enforcement of release for the exact child incarnation, process, and fresh
startup challenge. Compute authorizes release only after current delivery and
projection acknowledgment; missing, stale, or ambiguous readback keeps startup
held. Harness owns Codex and its session. The proposed paired Box Sandbox and
CredentialProxy registration must connect the real Box callback to that trusted
serving recipient; it does not introduce another credential issuer or give the
Harness source-resolution authority. The proposed
[contract selection](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md#credentialproxy-contract-selection)
requires explicit `drivers.credential_proxy.contract: 'deployment'`. Installation,
Compute, and Worker must consume the typed deployment view from the same selected owner.
Omission preserves the unchanged legacy contract and Git authority; invalid, unsupported,
or incompatible selections must refuse before a Driver package factory or provisioning effect,
without inference or fallback. This admission remains pending.

The native parent creates its child directly, so it must prove that launch
provenance and inherited state bind only that child. If a future design transfers
a privileged descriptor to an independently launched receiver, the trusted
installer or runtime must first authenticate both exact endpoint incarnations
using independently supplied trust, or provision an authenticated preconnected
channel for that pair. A shared UID, protected socket directory, peer-supplied
image digest, or nonce exchanged on the same unauthenticated stream is
insufficient. That separate bootstrap remains unresolved; it is not a
prerequisite for the direct-parent experiment.

## Ordered pull requests

Deliver five dependent PRs, preferably below 2,000 changed lines each. Update
the owning references and flows with each behavior change. Submit a covering
RFC for human review before changing a Driver contract, including required
behavior or configuration, and preserve every explicit hold. [RFC-0024](../rfcs/0024-sandbox-harness-mode-support.md)
proposes OpenClaw mode reporting; it does not approve Box or Codex support.

1. **Boundary and ingress.** First extend normal Installation composition and the
   Worker/Compute preparation path to consume the selected CredentialProxy deployment
   view. Through that real caller, verify explicit deployment selection and the same
   owner throughout. Treat invalid or unsupported selection, incompatible pairing,
   selection inferred from Driver identity, fallback, and any factory or provisioning
   effect after refusal as P0 failures. Verify omitted selection preserves legacy Git
   success and refusal cases. Then exercise the real native Box parent, trampoline,
   and contained child with invented sentinels. Verify an authored Policy permit,
   denial and absent-Policy refusal. In the isolated Agent-wide pilot, run the
   [same-route/binding subprocess and refusal cases](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-agent-policy.md#acceptance-criteria)
   through the real Agent. Verify executable/port enforcement or policy refusal,
   native isolation, exact child and challenge
   binding, unintended descriptor inheritance refusal, live authored-source
   identities, writable-alias refusal, and the public CA's read-only same-object
   grant. Deny credential and control leaks, loopback, direct upstream and DNS,
   and raw-socket bypass. Then extend the real Worker, paired Sandbox and
   CredentialProxy path with honest held observation, target-bound delivery and
   serving-copy readback, Compute-authorized release, and stale, cross-revision,
   replacement, and confused-deputy refusals. If a separate receiver is later
   selected, also refuse substitute listeners, foreign first connectors, and
   stale or cross-run peers before descriptor transfer.
2. **Protected inference.** Route a real Codex turn through mandatory egress to
   the selected HTTP provider. Verify a genuine reply and injection at the
   admitted origin. Refuse another destination, dangerous redirect, known
   response disclosure, missing credential, incompatible presentation, and
   unsupported authentication mode through the real admission and request
   paths. Use invented sentinels to test response headers, bodies, trailers,
   errors, and logs.
3. **Prepared Git.** Extend the shipped [Worker and prepared Git path](../../docs/reference/drivers/selection.md#select-a-protected-sender)
   through Sandbox `repositoryAccess` and `CredentialProxyDriver.bindRepositoryGit`.
   Reuse the selected issuer. Authorize the assigned repository, permitted push
   refs, and explicitly granted REST pull request operations and head/base refs.
   Deny GraphQL by default. Stock `gh` draft creation requires a pending, narrowly
   scoped correction for its exact GraphQL request shapes, variables, repository
   identity, head/base refs, and draft restrictions, with trusted effect readback
   and uncertain one-draft recovery. The current scoped selector does not admit
   those shapes; installation-wide GitHub API authority is not a substitute.
   From the running Agent, push and create a draft PR only after that correction
   is qualified; read both effects back at GitHub. Deny another eligible
   repository and out-of-scope refs and PR actions. Preserve existing OpenShell
   Git behavior and coverage.
4. **Rotation, withdrawal, and recovery.** Acknowledge rotation only after every
   serving copy reports the effective version. Refuse fresh Git use after
   withdrawal or expiry; a rejected withdrawal is not complete. Exercise failed
   delivery, a stale copy, and a lost reply. Reconcile the current instance and
   policy before recovery; do not replay an uncertain operation or fall back to
   direct egress. Prove a further model turn succeeds in the same conversation.
5. **Clean ARM64 qualification.** Install the Helm chart and Worker built from
   the exact candidate commit. Record chart, image, and source identities.
   Verify installer egress, RBAC, DNS, bootstrap, and held-start diagnostics; run
   the installed Agent journey, denials, rotation, withdrawal, recovery, and
   cleanup with authorized provider and GitHub access. Capture independent
   effect readback. Fixture results establish only their tested boundaries.

## Delivery baseline

The original source baseline above is historical. At that revision, Kubernetes
Compute required exactly one matching live Pod with `Ready=True` before reading
provider Harness status. It could observe a held failure only after that gate,
so the plan proposed scoped observation for an unready protected startup. The
baseline [#6098](https://github.com/openclaw/openclaw-enterprise/pull/6098)
concerns Sandbox maintenance cadence, not the Box topology.

The native experiment starts from public Box commit
`956764b58f2c5ccb12bb7048fd1ced3d8ca1b5d4`. It must qualify the direct parent,
contained child, paired serving path, and ordinary Worker integration. Treat
[Box #482](https://github.com/strands-agents/box/pull/482) as a separate,
unqualified descriptor-handoff candidate; its UID check cannot identify the
exact authorized endpoint pair. Preserve incumbent branches and import only
reviewed changes. The reverse HTTPS backend route
([Box #311](https://github.com/strands-agents/box/pull/311)) is not a CONNECT
proxy; TLS, address, identity, and request semantics still need qualification.
The [implementation status](../../docs/design.md#implementation-status) lists
general credential-free inference as planned. Local or container evidence does
not establish clean ARM64 Helm, installed Worker, provider, or GitHub proof.
All five milestones remain incomplete.

## Manual Notes

## Changelog

- 2026-11-18 — Record the v1 decision and delivery order against the source baseline above.
- 2026-11-19 — Select the direct native Box parent experiment and retain conditional descriptor-handoff requirements.
