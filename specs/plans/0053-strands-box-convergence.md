---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Strands and Box protected execution

- **ID:** TASK-0053
- **Delivery status:** Planned
- **Authority:** [RFC-0023](../rfcs/0023-egress-proxy-credential-lifecycle/index.md), its proposed [Installation credential ownership amendment](../rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md), and the proposed [held-start amendment](../rfcs/0023-egress-proxy-credential-lifecycle/strands-box-held-launch.md)
- **Source baseline:** `962a41087083053b585b477d4791f8aded6a9f4e`

## Outcome and scope

Select a trusted Box companion in the Agent Pod for v1. On a clean ARM64 Helm
installation, the normal Worker deploys a Codex Agent into the untrusted
`box-workload`. The Agent completes a real model turn, pushes a commit, and
opens a draft pull request in its assigned GitHub repository. After Git access
is withdrawn, model turns continue in the same conversation. V1 qualifies HTTP
API-key inference only. Admission refuses personal access tokens (PATs),
interactive login, and WebSocket credential delivery.

## Credential and execution boundary

The trusted companion owns the Box vault and HTTP injector. The vault replaces
an opaque placeholder only on an admitted HTTP request. The injector checks
the execution, origin, port, method, path, and credential presentation, verifies
upstream TLS, refuses dangerous redirects, and blocks known credential
disclosure in responses and diagnostics. Limit credentialed origins to trusted
providers. This design assumes that an admitted provider does not maliciously
encode or reflect its credential and that the host kernel is not compromised;
it cannot guarantee protection under either attack. The TLS certificate
authority's private signing key stays in trusted memory.

The workload can receive opaque placeholders. It must neither receive nor
retrieve GitHub App signing keys, installation tokens, model API keys, PATs,
OpenClaw Enterprise (OCE) issuer material, repository broker credentials, or a
reusable ingress bearer. This restriction covers its environment, mounts,
shared state, home, temporary directories, persistent volume claims, Pod
manifest, arguments, logs, output, authentication or control interfaces, proxy
endpoints, and redirects. A placeholder conveys no retrieval authority.

Containers in one Pod share loopback; Kubernetes NetworkPolicy selects Pods,
not containers. The Sandbox must enforce the boundary inside the Pod, isolate
the workload from trusted control interfaces, and prevent direct egress. A
separate trusted proxy Pod and Service, and stronger node isolation, remain
future work.

Compute owns Agent revision Pods, storage, placement, and lifecycle, and observes
generic readiness or refusal. Under the proposed ownership amendment, the
selected TokenService Driver holds usable credentials and issuer keys and
issues or renews tokens. CredentialProxy owns the committed effective policy,
versioned delivery, and aggregate readback from serving copies. The trusted
Sandbox and Box companion hold startup, authenticate its exact target and fresh
challenge, and release it only after trusted credential delivery and version
acknowledgment. Missing, stale, or ambiguous acknowledgment keeps startup held.
Sandbox owns isolation, private transport, and mandatory egress. Harness owns
Codex and its session.

Before Box transfers any privileged launch descriptor, the trusted installer or
runtime must bind both ends of the live connection to the authorized launcher
and receiver incarnations using trust supplied independently to each end, or
provision an authenticated preconnected channel for that exact pair. A shared
UID, protected socket directory, image digest supplied by the peer, or nonce
exchanged on the same unauthenticated stream does not meet this requirement.
The Kubernetes mechanism for this bootstrap has not been selected or implemented.
The Box handoff work remains blocked until that contract exists.

## Ordered pull requests

Deliver five dependent PRs, preferably below 2,000 changed lines each. Update
the owning references and flows with each behavior change. Submit a covering
RFC for human review before changing a Driver contract, including required
behavior or configuration, and preserve every explicit hold. [RFC-0024](../rfcs/0024-sandbox-harness-mode-support.md)
proposes OpenClaw mode reporting; it does not approve Box or Codex support.

1. **Boundary and ingress.** Stage a held Box workload through the Worker.
   Establish the independently trusted launcher/receiver binding before launch
   descriptor transfer, authenticate ingress, and bind release to its exact
   target incarnation, process, and startup challenge. Refuse a substituted
   listener, a foreign first connector, and stale or cross-run peers without
   transferring descriptors. Preserve live authored-source identities, writable
   alias restrictions, and the public CA's read-only same-object grant. Exercise
   invented credential sentinels across
   the workload surfaces above. Deny bypass through loopback, control sockets,
   direct upstream connections, direct DNS, and raw sockets. Exercise peer,
   cross-revision, replacement, and confused-deputy attacks against ingress and
   release authority.
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
   Deny GraphQL until body-aware repository and operation enforcement exists.
   From the running Agent, push and create a draft PR; read both effects back at
   GitHub. Deny another eligible repository and out-of-scope refs and PR
   actions. Preserve existing OpenShell Git behavior and coverage.
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

At the source baseline, Kubernetes Compute supports provider-owned Harnesses,
protected enrollment, and held failure status after the provider Pod readiness
gate. It requires exactly one matching live Pod with `Ready=True` before it
reads Harness status. A held, unready Box Pod therefore needs the proposed
scoped observation path. Main contains no Strands/Box Sandbox implementation or
authenticated launcher channel. The baseline change
[#6098](https://github.com/openclaw/openclaw-enterprise/pull/6098) concerns
Sandbox maintenance cadence; it does not supply the Box topology.

Treat [Box #482](https://github.com/strands-agents/box/pull/482) as candidate
source, not an authenticated handoff. Its current UID-based descriptor transfer
cannot identify the authorized pair of process incarnations. Keep an explicit
inventory of the minimum Box changes, and do not import a credential fork or
unapproved branch wholesale. The reverse HTTPS backend route
([Box #311](https://github.com/strands-agents/box/pull/311)) is not a CONNECT
proxy; TLS, address, identity, and request semantics still need qualification.
The [implementation status](../../docs/design.md#implementation-status) lists
general credential-free inference as planned. All five milestones and installed
qualification remain unproved.

## Manual Notes

## Changelog

- 2026-11-18 — Record the v1 decision and delivery order against the source baseline above.
