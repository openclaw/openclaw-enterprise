---
rfc: index.md
---

# Protected network destination catalog

[RFC-0023](index.md) · [Interfaces and records](contracts.md) · [Security and migration](security.md)

Proposed amendment for [issue #4509, allow non-overlapping per-Agent network rules under protected execution](https://github.com/openclaw/openclaw-enterprise/issues/4509). It extends the shared service admission contract that [PR #4505, public clone and fetch alongside protected Git](https://github.com/openclaw/openclaw-enterprise/pull/4505) proposes in `contracts.md`. It does not qualify an installed runtime.

## Decision

An operator publishes a catalog of named, credential-free HTTPS destinations. A protected, dedicated Codex Agent selects names from it. Protected execution admits each selected destination as a frozen service descriptor on the shared contract. Free-form Agent network additions stay refused.

**Example:** An operator lists `python-docs` (`docs.python.org`, GET and HEAD). A protected Codex Agent that has a Git binding selects `python-docs`. It reads the documentation site and still reaches GitHub only through the Credential Proxy.

## Problem

When an Installation selects the Credential Proxy, OCC refuses every saved Agent network addition at save, live apply and deploy with `SANDBOX_POLICY_PROTECTED_EXECUTION` ([Agent sandbox policy](../../../docs/guides/topics/agent-sandbox-policy.md)). The worker and the OpenShell Driver apply the same refusal later. It holds even when an addition overlaps no governed route, so an operator who turns on protected Git loses per-Agent network rules.

The refusal is deliberate. An addition compiles to an OpenShell rule that skips TLS inspection for a binary the caller chooses, so OpenShell cannot see the methods or paths of that traffic. Every process in a protected execution [shares its egress authority](contracts.md), so one such rule opens its host to any process the Agent starts.

## Non-goals

- Destinations that need a credential. They stay Credential Proxy routes, so this does not enable Jira.
- Free-form additions, live apply to a protected revision, TLS skip, ports other than 443, raw TCP and IP addresses.
- Other Harnesses, as for the public reader, and unprotected Agents in a protected Installation.

## Proposal

### Owners and flow

- **Operator.** The Compute Driver's Installation settings hold the catalog: for each entry, a name, one DNS host and a list of operations.- **Agent.** The Agent's Codex plugin configuration lists entry names, beside the public-read selection that PR #4505 proposes. An empty list selects nothing.
- **Compute.** `admitServiceAccess` returns one `ComputeServiceAccess` descriptor per selected name. The `id` is the entry name. OCC accepts lowercase letters, digits and hyphens, starting with a letter, up to 64 characters. The `endpoint` is `https://<host>`, and `configuration` repeats the host and lists the operations. The compilers refuse a mismatch, because the Credential Proxy reads the host from `endpoint`. An unknown name, a missing catalog or a covering native Codex proxy deny refuses admission. The public reader selects nothing in these cases, but a catalog name is an explicit request, and silence would hide a mistake.
- **OCC and Sandbox Driver.** OCC freezes the descriptors on the Agent revision without interpreting them. `admitProtectedNetworkPolicy` acknowledges them in `SandboxPolicySnapshot.serviceAccess`. The Sandbox Driver refuses a name that equals a default rule name or starts with the reserved prefix `oce-agent-`. Compute cannot check this, because `admitServiceAccess` does not see the Sandbox defaults.
- **Both compilers.** The OpenShell compiler and the Credential Proxy each qualify every frozen entry. A missing, extra or changed entry refuses release.
- **Kubernetes egress.** For the reader, Compute grants egress to the exact selected supervisor. The supervisor's NetworkPolicy must also admit Internet catalog hosts. Question 6 asks who supplies their addresses.

This changes required behavior, not a signature. Today the OpenShell qualifier accepts exactly one service, `public-github-read`. It must accept several entries of two enumerated kinds: the public reader and the catalog destination. A new kind needs an RFC amendment. A catalog entry compiles without a runtime credential binding.

### Qualify an entry

Both compilers refuse an entry unless it meets all of these rules:

- The host is a literal DNS name. They refuse IP addresses in any spelling, `localhost`, single-label names, `.svc`, `.cluster.local`, `.internal` and metadata-service names.
- The port is 443, with inspected REST in enforce mode. They refuse TLS skip and passthrough.
- The rule lists explicit operations, each a method and a path. The first release allows GET and HEAD without a request body. A path has literal segments and single-segment placeholders. They refuse `**`, `.`, `..`, empty segments, encoded slashes and access presets.
- The entry has no credential, credential binding, provider alias, header injection or `allowed_ips`, so OpenShell keeps its internal-address check.
- The executable paths are the public reader's list (`node`, `curl` and Git's HTTPS helpers). An entry cannot choose them. Any process in a protected execution can start those programs, so the list does not contain an arbitrary script. The host and operation rules do.
- The entry overlaps no governed route and no other entry, on any port or binary. Governed routes are the Credential Proxy route origins, Credential Gateway endpoints, the GitHub family, the enrollment host, the OCC public and internal origins, service peers, the Kubernetes API address, cluster DNS and link-local metadata.

Check these rules at Installation load, deploy, provisioning, replay and rehydration.

### Prove it before acceptance

Qualify each entry as if an arbitrary script in the execution uses it. Run these checks through the regular Agent workflow on a protected OpenShell runtime, with success and denial evidence:

- **Admission.** Selected entries freeze on the Agent revision, and replay uses them. An unknown name, IP address, internal name, overlap, `allowed_ips`, port other than 443 or other method is refused before effects.
- **Host and SNI.** On HTTP/1.1 and HTTP/2, a request to a catalog host with `Host` set to a governed origin, and the reverse, causes no credential read, send permit or provider request. Credential middleware attaches by host name, and nothing shows that OpenShell binds `Host` to the TLS server name.
- **Protocol.** The [destination controls](security.md#destination-response-and-git-controls) cover DNS, destination and TLS authority, redirects, raw TCP, opaque SSH, UDP and QUIC. Add Upgrade, CONNECT and h2c. A redirect to a governed host gains no catalog privilege: the follow-up request meets that host's own route rules.
- **Operations.** A GET to a catalog host works while protected Git works. A method or path outside the list is denied, and an extra, missing or changed rule fails `wiringStatus`.
- **Lifecycle.** A changed or missing entry stops access, and revocation removes every entry. A restart never restores withdrawn access. Grant expiry keeps the entry, if question 1 confirms it.

Two residual risks stay open for the security owner: path and query exfiltration to an admitted host, and DNS resolution or fronting behind a catalog name.

### Select and authorize

Selection uses the same carrier as the public reader, so there is no second producer or snapshot. It is frozen at deploy, the deploy audit must record the selected names, and a protected revision never accepts live apply. The shared section requires explicit per-Agent authorization and asks a catalog to define its IAM requirements. This amendment does not define them yet. Question 3 must be settled before acceptance.

### Lifecycle

A catalog entry is a static OpenShell allow rule. The public reader refuses every request once its 10-minute lease expires. A catalog entry has no such check and stays open until the policy changes or the Harness stops.

A frozen entry keeps the authority of its Agent revision, so scheduled expiry of a finite repository grant does not remove it. This follows the shared code path, where the worker renews frozen services when Git access expires. Question 1 asks the security owner to confirm it for a rule with no lease. Revocation, credential rejection, plan loss, the last-owner hold, operator stop and revision retirement close every entry. This list is new: the shared section names only execution retirement and withdrawal of a service's own authorization.

`maintainServiceAccess` acts only on the public reader today. This amendment extends it: a changed or missing catalog entry withdraws access and stops the affected Harness, as when the reader's peer changes. A restart never restores withdrawn access.

## Delivery and verification

The shared contract in PR #4505 lands first or with this change, and this text links to that PR until then. A plan then allocates a task number and connects OCC, Compute, the OpenShell Sandbox Driver and the Credential Proxy in one change. It shares runtime tests with the public-read work. Nothing has run. Stock OpenShell 0.1.6 behavior for per-method rules, `deny_rules` and query matchers is unverified.

## Rationale and alternatives

- **Keep the refusal, or freeze free-form additions per revision.** The first leaves Agents that need extra destinations unprotected. The second is rejected: the compiled rule skips TLS inspection for a caller-chosen binary, and every process shares its reach.
- **Catalog selected by name (proposed).** It extends the artifact rule precedent (`policy.codexArtifactRuleNames`, see [Protected Codex artifact downloads](contracts.md#protected-codex-artifact-downloads)). The operator gives up per-Agent host choice, other ports, TLS skip and raw TCP.
- **Catalog in Sandbox Driver startup configuration.** It follows the artifact precedent more closely, but the shared contract has no way to pass selected names to the Sandbox Driver.
- **A separate Installation without the Credential Proxy.** It loses protected repository Git.

## Unresolved questions

Each keeps two invariants: refuse, never drop; no live apply.

1. May a catalog entry keep its rule after scheduled expiry of a finite repository grant, as proposed? If not, entries close with the grant. Deciders: RFC-0023 owner and security owner.
2. Does Compute or the Sandbox Driver own the catalog? Deciders: RFC-0023 owner and PR #4505 author.
3. Must selecting an entry also need policy authority (`manage_policy` and `sandboxPolicyEditing`), not only Agent Configuration write authority? Deciders: security owner and maintainers.
4. How does `admitServiceAccess` learn the Namespace, so an operator can limit an entry per Namespace? It receives none today. Decider: PR #4505 author.
5. Are the two residual risks acceptable? Decider: security owner.
6. How does the supervisor's Kubernetes NetworkPolicy learn the address ranges of catalog hosts, and who owns them? Deciders: PR #4505 author and RFC-0023 owner.
