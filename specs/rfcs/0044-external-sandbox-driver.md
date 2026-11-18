---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Run dedicated Codex Agents in an external Sandbox

- **ID:** RFC-0044
- **Created:** 2026-11-16
- **Last updated:** 2026-11-18
- **RFC PR:** [#6346](https://github.com/openclaw/openclaw-enterprise/pull/6346)
- **Related:** [Sandbox contract](../../docs/reference/drivers/sandbox.md),
  [Credential Proxy contract](../../docs/reference/drivers/credential-proxy.md),
  [Driver packages](../../docs/reference/drivers/selection.md#package-identity-and-factory-exports), and the open
  proposals [#6396] (credential ownership), [#4889] (turn binding), [#5119] (Gateway and workspace rollout), [#5783]
  (protected workspace binding) and [#5083] (packaged Credential Gateway)

<a id="problem-and-decision"></a>

## Summary

An operator installs a Sandbox Driver package that runs each dedicated Codex Harness in a sandbox outside Kubernetes
Compute's Pods. The sandbox's own trusted process confines the workload and injects credentials; OCE's control plane
keeps the keys and decides each use. This RFC defines that **external Sandbox profile**.

Statements are marked **main** (on main at `7de293ea47`, cited by path and line), **prototype** (only on the
[prototype branch][prototype] at `d582b192e0`: evidence, not a commitment) or **proposed** (normative here).

## Motivation

OpenShell is the only bundled Sandbox. In installed prototype runs on Strands Box, an Agent opened three draft pull
requests with stock `git` and `gh` and a token the workload never held. The prototype needs provider-shaped names in
core and imports controller source, which an installed package cannot do. No open proposal separates a primitive that
any external Sandbox uses from one provider's adapter.

<a id="scope"></a>

## Goals

1. An external Sandbox package needs **no provider-specific code in core**: every core member it uses has a generic
   name, documentation and a provider-free conformance test.
2. Ordinary chat and workspace files work, with the Gateway enforcing the binding to the original execution
   ([#4889]).
3. Protected repository access uses **OpenShell's GitHub App installation-token flow**. No token or key enters the
   workload; the token's permissions and repository restriction at mint are the boundary; withdrawal refuses the next
   GitHub request while the chat continues.
4. The package installs through the existing
   [Driver package loader](../../docs/reference/drivers/selection.md#select-the-installed-driver), which validates
   every optional member it declares.

## Non-goals

- A separate credential issuer or a token flow parallel to the Worker's.
- Separating the trusted process from the workload beyond the Sandbox's own confinement (see Isolation).
- Multi-node control transport (question 5).
- Provider upstream changes.

<a id="design"></a>

## Proposal

### Owners

Proposed. Who holds the model key at rest is question 1.

| Owner                                     | Decides and holds                                                                            | Never holds                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Kubernetes Compute                        | Gateway workload, revision pins, signed release, activation, cleanup of what it created      | provider host state                           |
| Package, `sandbox` view (API, Worker)     | host provisioning, execution identity, endpoint and status observations                      | repository tokens                             |
| Package, `credential_proxy` view (Worker) | execution authentication, relay of each held request to OCE                                  | App key, request rules, stored credentials    |
| Trusted process (outside the confinement) | workload launch, egress policy, workspace mounts, injection of OCE's answer into one request | App key, request rules, stored tokens or keys |
| Worker prepared-git owner                 | App key, repository-scoped installation tokens, grant checks, request decision, use records  | —                                             |
| Agent Gateway                             | enforcement of the mounted binding on every native connection and turn                       | provider credentials                          |

### Contract surface

**Main.** The profile uses these as they are: Sandbox `provisionHarness`, `enrollHarness`, `harnessEndpoint`,
`harnessStatus`, `withdrawHarnessExposure`, `harnessHome`, `validateWorkspaceSetup` and `repositoryAccess`
(`packages/contracts/src/drivers/sandbox/index.ts:185-314`); Credential Proxy `bindRepositoryGit(authority)` with the
`github_repository` profile (`packages/contracts/src/drivers/credential-proxy/index.ts:166-167,456`); one package
selected as both Drivers (`docs/reference/drivers/selection.md:78-98`); and `network.providerHarness`, the Gateway's
route to a provider Harness (`apps/controller/src/drivers/compute/kubernetes/index.ts:598`).

**Proposed.**

| Member                                                  | Rule                                                                                                                                                                                                                                                                                                               | Draft   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `SandboxDriver.harnessTransportCredential?: "verifier"` | Harness launch requirements carry the transport verifier, not the bearer Secret reference; read on every reconcile. `harnessStatus` and enrollment still receive the bearer; the package sends it only to the Harness, after verifying the pinned TLS peer, and never puts it in host state, logs or the workload. | [#6345] |
| `maintenanceIntervalMs?`, `existingHarnessOnly`         | Maintenance of an active revision reports a missing Harness and never recreates it.                                                                                                                                                                                                                                | [#6098] |
| `@openclaw-enterprise/controller/workspace-node-launch` | Exports the stock file-only node command allowlist and the programs Compute renders, so a package imports no controller source; the prototype still does.                                                                                                                                                          | [#6353] |
| `worker.sandboxControlClaimName` (optional)             | An existing claim mounted read-only at `/run/openclaw-sandbox-control` in the Worker only, for a host control socket. Requires `controlPlane.nodeSelector["kubernetes.io/hostname"]`; refuses `executionCluster.enabled`, the bootstrap claim and overlap with the database CA mount. Empty changes nothing.       | [#6356] |

**Binding (proposed, [#6354]; no run has used these names).** Compute mounts the ordinary binding at
`/etc/openclaw-external-workspace/`: `ca.pem` and `binding.json` with exactly the keys
`format: "external-workspace-v1"`, `url`, `workspaceRoot` and `generationSha256`. The last two come from the validated
endpoint, the generation as `SandboxHarnessEndpoint.externalWorkspaceOwner.generationSha256`. The Harness proves the
generation with exactly one response header, `x-openclaw-workspace-generation`, which the Gateway checks on every
turn ([#4889]). That enforcement ships in OpenClaw first; OCE carries a patch until its pin includes it. The prototype
ran with provider-shaped spellings (question 4).

**Validation (proposed).** The installed loader refuses a registration whose optional members have the wrong type or
value: a declared Harness member that is not a function, `harnessTransportCredential` other than `"verifier"` or
without `provisionHarness` and `harnessEndpoint`, `maintenanceIntervalMs` that is not a positive integer or lacks
`provisionHarness`, or a malformed protected capability ([#5783]). Compute refuses a malformed endpoint observation,
such as an owner without a generation, before it pins, routes or releases.

### Start and release

**Prototype.** The example obtains two signed releases through main's `release(startupId)` callback, which conveys no
material (`packages/contracts/src/drivers/sandbox/index.ts:279-290`): one for its host gate, with a startup ID the
Driver picks, then one that relays the stock protected Harness program's own challenge, as OpenShell does.

**Proposed.** Credential use begins at release. A model request is answered only for the installation OCE committed,
re-observed on that request. GitHub material does not exist before activation, so the repository binding is ready when
its route is configured and the Worker is reachable. Main already treats a verified route that waits for material as
ready (`apps/controller/src/drivers/compute/kubernetes/index.ts:7740-7743`).

[#6396] renames these steps (`prepareHarnessProcess` for the host gate, `getHarnessProcessStatus` and
`releaseHarnessProcess` for the callback) and reuses the name `provisionHarness` with another signature. This RFC
uses main's members and follows that conversion if it lands.

### Request-time credentials

**Proposed.** The trusted process holds each outbound GitHub or model request and asks the `credential_proxy` view
for that one request. Nothing is delivered ahead, stored or retried. After a refusal, a timeout or a passed `sendBy`,
no request byte or credential reaches the upstream, though the host may already have connected. A standing token
delivered at start does not meet this profile.

- **Execution credential** (a pattern inside one registration, not a contract member). Without a client certificate,
  the trusted process presents a random per-execution credential. The `sandbox` view mints it and reports only its
  SHA-256 with the live process identity; the `credential_proxy` view compares digests in constant time and rechecks
  that execution and process before it answers. The principal is the
  [whole admitted execution](../../docs/reference/drivers/credential-proxy.md#registration-and-execution-release),
  siblings included.
- **GitHub** ([#6350]). The Worker binds the package with `bindRepositoryGit(authority, requests)`. Per held
  request, the view passes `requests.authorize` (`RepositoryGitRequests`) the confirmed route, the profile, a deadline
  at most 30 s ahead and the request without credentials (TLS-verified target, headers, body up to 4 MiB). OCE reads
  the material, decides online with `decideGitHubRequest`
  (`apps/controller/src/drivers/repo/github/access/protected-requests.ts`), as the bundled route does, and records
  one possible use. An allow returns the typed `credential` for that request, the use's `exchangeId` and `sendBy`; a
  refusal, a reason code the Agent sees. There is no exact-dispatch mode: such a recipient gets `route_not_ready`. The
  package keeps no copy of the rule and gains no access: it already holds the authority. Only a test fixture calls
  the port so far. Under `github_repository`, which stock `gh` needs, OCE refuses other repositories and applies no
  ref or draft rule; the mint request's permissions and repository IDs bound the rest
  (`apps/controller/src/drivers/repo/github/access/provider-transport/request-options.ts:126-132`).
- **Model.** The same ask. The Worker reads the key once per request and keeps nothing; the workload holds a
  placeholder. Where the key rests is question 1.

Until question 2 is answered, main's rule holds: OCE allows uses only after the recipient confirms each material
version (`confirmInstall`), which a request-time recipient does without holding a value.

### Isolation

**Proposed.** That only the Sandbox's own confinement separates the trusted process from the workload is an accepted
gap of this profile, not a refusal reason; the package must document each such gap with a deployment mitigation. The
injected value is the grant's installation token, so `sendBy` binds an honest host only.

**Prototype.** Box's trusted process shares a kernel with the workload, any local process on its host can use its
egress gateway, and the workload can read the credential of Codex's pre-tool-use hook relay. That hook also fails
open: one that times out does not block the call. The [known gaps][gaps] list the rest.

### Worked example: Strands Box

**Prototype.** The [example package][prototype] exports one registration. A nonroot service launches Box on a host
beside the cluster, and the workspace node runs outside Box. Box's egress gateway asks a request-time credential
source, present only in a Box fork, over the Worker control socket; OCE runs no listener for it. Runs used an x86-64
guest, where Box support is experimental.

## Acceptance Criteria

Every case uses real Kubernetes Compute, Worker, Gateway image and prepared-git owner. Kit cases live in
`tests/conformance/external-sandbox-*` ([#6355]) and run against a fixture package or a provider's own host.
**Shown** means an installed prototype run, with provider-shaped names in core; no criterion is met until it passes
with the proposed names.

- **AC-1 — Ordinary chat (Goal 2):** Given an ordinary dedicated Codex Agent on the package, when the operator deploys
  and chats, then the confined Harness replies, the Agent reads and writes a workspace marker, sibling paths are
  refused, and the Harness launch inputs hold no Gateway bearer. Kit case and installed run. Partly shown: a native
  Box check, and chat on protected Agents.
- **AC-2 — Binding and peer enforcement (Goal 2):** A missing, duplicated or different generation header, a replaced
  execution or a changed binding file closes the Gateway connection before another native frame. Neither the Gateway
  nor the package's readiness and enrollment clients send the bearer to an unverified TLS peer. Kit case. Open.
- **AC-3 — Protected push (Goal 3):** Given a protected revision granted one repository, when the Agent pushes a branch
  and opens a draft with stock `git` and `gh`, then the Worker minted the token for that repository, OCE's decision
  recorded each request, the provider shows the App as actor, and the workload holds no token or key. Installed run
  with provider readback joined to OCE's use records. Shown in three runs.
- **AC-4 — Refusal before egress (Goal 3):** OCE's decision refuses each request the profile excludes although the
  material is readable; the `credential_proxy` view refuses a missing execution credential and one from a replaced or
  ended execution or another process. Neither reaches the provider, and a later request from the live execution
  succeeds. Kit case: the fixture package and the bundled route decide alike. Shown for another repository; the
  credential cases have component tests only.
- **AC-5 — Withdrawal (Goal 3):** After the operator withdraws only the repository grant, a fresh fetch or push is
  refused, no request byte or credential reaches the provider, the model binding still answers, and the next chat
  turn in the same conversation succeeds. Kit case and installed run. Shown in one run and one dry run with a
  stand-in provider.
- **AC-6 — Validation (Goal 4):** Each malformed optional member is refused at registration with a typed startup
  error (controller lifecycle test). Compute refuses an endpoint owner without a generation before pinning, routing or
  release (kit case). Open; draft tests in [#6353] and [#6355].
- **AC-7 — No provider in core (Goal 1):** The kit passes with the fixture package, core and its tests contain no
  provider name, and OpenShell selections behave as before. Static check plus the existing OpenShell suites. Open; the
  prototype fails it.
- **AC-8 — Model withdrawal (Goal 3):** When the operator withdraws the model binding, OCE withdraws the binding
  before it deletes the key material, the next model request is refused, and GitHub requests under a live grant still
  succeed. Kit case and installed run. Open: a stand-in dry run showed the refusal, none the order, and the prototype
  refuses this withdrawal for a stopped Agent.

## Delivery and verification

1. [#6345] and [#6098], both inert unless declared.
2. [#6354] with the upstream OpenClaw change, [#6353], and the conformance kit ([#6355]).
3. The protected workspace binding ([#5119], [#5783]); the prototype's variant shares the ordinary directory.
4. [#6350], whose base is on main, and the Worker control mount ([#6356]) if question 5 accepts it.
5. The example package, after AC-3 to AC-5 and AC-8 pass with the proposed names.

Model key delivery waits for questions 1 to 3. No run has used the proposed names or the drafts above, and the kit
has only the AC-6 and AC-7 cases.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Provider names in core.** Each provider adds its own directory, header and chart value.
- **A bundled in-tree Driver.** Couples OCE releases to the provider's cadence and hides contract gaps.
- **[Native prepared Git](../../docs/reference/repository-credentials/prepared-native-git.md) with an external
  Sandbox.** Its admission requires that no Sandbox is selected; changing that splits recipient identity.
- **An importable GitHub classifier.** Isolated Driver runtimes resolve only relative imports, and a copy drifts.
- **An OCE-run forwarding sender.** A second injector beside the Sandbox's own.
- **Ref or draft rules for `github_repository`.** The token bounds the grant; this RFC adds no request rule and
  removes none.

## Unresolved questions

The author decides questions 1 to 4, the first three with [#6396]'s author. This RFC holds under each recommendation,
and under every answer no key or token enters the workload.

1. **Model key at rest.** (a) The package's own Secret, as the prototype: runs today, but is a second copy beside
   OCE's, readable by the API and Worker for every source, and needs question 3's Gateway. (b) OCE's Secret, read by
   the Worker through `SecretDriver` per request and not retained, as main's exchange read does
   (`packages/occ/src/index.ts:7779-7797`): no copy, and what [#6396] requires, but it needs a per-request read port
   and a rewrite of the prototype's model path. **Recommended: (b).**
2. **Delivery combination.** A trusted process that injects per request fits none of [#6396]'s three combinations,
   which deliver ahead and defer request-time pulls. (a) [#6396] gains a fourth, paired combination: OCE owns the
   material; the Sandbox registration supplies the proxy, enforces it in the Sandbox host and resolves per request.
   Cost: one more combination to specify and test. (b) An explicit v1 exception for this profile. Cost: a path
   [#6396] does not describe. (c) Deliver ahead into the host. Cost: the host stores credentials and renewals need a
   push path. **Recommended: (a), else (b).**
3. **Packaged Credential Gateway.** The prototype's model path builds on [#5083] and [#5096], which have no place in
   [#6396]; RFC-0023 retires Gateway Drivers and excludes installed packages from its exception
   (`specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md:17-19`). (a) Fold the function into [#6396] as
   question 2's paired combination: one ownership model, one rebase of the prototype. (b) Keep [#5083] as its own
   RFC: no rebase now, two models to reconcile later. (c) Drop it and rebase onto main: the model route has no home
   until [#6396] lands. **Recommended: (a).**
4. **One spelling for the shared primitive** (with the authors of [#6342] and [#6367]). Three exist. Proposed: this
   RFC's names. Not adopted: [#6342]'s `/etc/openclaw-external-workspace-owner`,
   `x-openclaw-external-workspace-generation` and `ingressLeafSha256`, and a built-in Driver selected by
   implementation name ([#6367] to [#6370]). Cost: the other stacks rename.
5. **For reviewers.** Keep [#4889], [#5119] and [#5783] as separate decisions, or fold them in. Accept the chart
   mount, or require an authenticated TCP control endpoint, which lifts the same-node constraint.

## References

- [Sandbox-provided Harness transport](../../docs/reference/drivers/sandbox.md#sandbox-provided-harness-transport).
- [Protected OpenShell Git](../../docs/reference/repository-credentials/protected-openshell-git.md) for the reused
  token flow.

[prototype]: https://github.com/openclaw/openclaw-enterprise/tree/d582b192e0bf713703f50423e8b53b697fb1a0e7/deploy/examples/strands-box
[gaps]: https://github.com/openclaw/openclaw-enterprise/blob/d582b192e0bf713703f50423e8b53b697fb1a0e7/deploy/examples/strands-box/KNOWN-GAPS.md
[#4889]: https://github.com/openclaw/openclaw-enterprise/pull/4889
[#5083]: https://github.com/openclaw/openclaw-enterprise/pull/5083
[#5096]: https://github.com/openclaw/openclaw-enterprise/pull/5096
[#5119]: https://github.com/openclaw/openclaw-enterprise/pull/5119
[#5783]: https://github.com/openclaw/openclaw-enterprise/pull/5783
[#6098]: https://github.com/openclaw/openclaw-enterprise/pull/6098
[#6342]: https://github.com/openclaw/openclaw-enterprise/pull/6342
[#6345]: https://github.com/openclaw/openclaw-enterprise/pull/6345
[#6350]: https://github.com/openclaw/openclaw-enterprise/pull/6350
[#6353]: https://github.com/openclaw/openclaw-enterprise/pull/6353
[#6354]: https://github.com/openclaw/openclaw-enterprise/pull/6354
[#6355]: https://github.com/openclaw/openclaw-enterprise/pull/6355
[#6356]: https://github.com/openclaw/openclaw-enterprise/pull/6356
[#6367]: https://github.com/openclaw/openclaw-enterprise/pull/6367
[#6370]: https://github.com/openclaw/openclaw-enterprise/pull/6370
[#6396]: https://github.com/openclaw/openclaw-enterprise/pull/6396
