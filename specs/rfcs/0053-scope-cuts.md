---
status: Proposed
status_note: "Decision request. Nothing in this RFC removes code. Each cut needs a maintainer decision and a separate implementation PR."
---

# Proposal: Scope cuts to reduce complexity

- **ID:** RFC-0053
- **Owner:** freeqaz (proposal). Decisions: OCE maintainers, with the Compute
  Driver and console owners for their areas.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** [#898](https://github.com/openclaw/openclaw-enterprise/pull/898)
- **Related:** [RFC-0046 (#853)][pr-853], [RFC-0047 (#855)][pr-855],
  [#519][pr-519], [#824][pr-824], [#830][pr-830], [#829][issue-829]
- **Source baseline:** `main` at `63b21fb4b`. Line counts are `wc -l` on that
  commit.

<a id="problem-and-decision"></a>

## Summary

OCE carries code, tests, docs and CI lanes for paths that nobody exercises, that
cannot deploy an Agent, or that grow with every upstream OpenClaw change. This
RFC lists seven candidates. For each one it measures the cost, names who uses
it, and recommends a decision. Most need a maintainer decision because they
remove supported functionality or change a default. Candidate 6 is an open
design question, not a recommendation.

## Motivation

Launch work since 2026-09-28 kept running into the same areas: three local
development profiles, two compute drivers that no installation in our test
environment runs, and a Gateway config rewrite that has needed four PRs. Each
area adds review load and doc surface and has its own failure modes. Removing a
path is cheaper before more installations depend on it.

<a id="scope"></a>

## Goals

- One decision per candidate, recorded on this PR.
- Each accepted cut ships later as its own PR with migration notes. This PR
  changes no code.

## Non-goals

- Removing Kubernetes Compute, embedded OpenClaw, or the OpenShell Sandbox
  path.
- Re-arguing decisions that RFC-0046 and RFC-0047 already record.

<a id="design"></a>

## Candidates

### 1. SSH Compute Driver

**What.** `apps/controller/src/drivers/compute/ssh` runs embedded OpenClaw as
one systemd unit per Agent on operator-managed Linux hosts. It can be selected
in production (`compute-ssh`).

**Size.** 1,829 lines of code (`index.ts` 663, `executor.ts` 113,
`remote-helper.cjs` 1,053), plus SSH branches in
`composition/installation-config.ts`. 1,937 test lines: conformance 1,194 and
startup 95, both in CI Required, and a real-host test of 648 lines. The real-host
test's `ssh-host` suite is not wired into any workflow. Docs: 645 lines on
three pages (`ssh-compute.md`, `testing/ssh.md`, `flows/pr-24-ssh-compute.md`),
plus plan 21 (354 lines). 33 docs pages mention it.

**Who uses it.** Added in #24 (2026-09-08). Dogfooding never used it, and none
of the planning notes mention it. Open issue #829 reports that Slack cannot be
enabled on SSH. The driver supports only embedded OpenClaw with
`harnessAuth.method: runtime`. It has no OCC-managed model credentials, no
dedicated Codex and no Sandbox. Issue #770 asked to remove embedded execution
entirely; it was closed on 2026-10-01 with no change. If that request comes
back, SSH loses its only mode.

**Removing it simplifies** the Compute contract (only one driver would deploy
Agents), installation config validation, the compute matrix, and the
`runtime` harness-auth method, which only SSH accepts.

**Risks.** It removes a supported production option. An unknown operator could
depend on it, and it came from an upstream maintainer.

**Migration.** Deprecate it for one release. The selected driver can come from
an external compute package (`drivers.compute` with a package implementation,
see `docs/flows/driver-plugin-loading.md`), so an owner can keep SSH out of
tree. Operators move to Kubernetes Compute.

**Recommendation.** Remove SSH from the bundled drivers unless a named owner
commits to maintain it and fix #829. Offer the external package as the
migration path.

### 2. Docker Compute Driver

**What.** A development-only driver that runs Agents as containers next to
the Compose control plane.

**Size.** 1,420 lines (`docker/index.ts`). 2,980 test lines: conformance 643,
which is in CI Required; real 1,904 in the `docker-model` lane; token retry 433.
Docs: `docker-compute.md` 244 lines, `testing/docker.md` 137, and the Compose
development flow pages (697). 31 docs pages mention it.

**Who uses it.** It cannot deploy an Agent: `validateHarnessAuth()` throws for
every binding (`docker-compute.md`, compute matrix). Its dedicated container
also hardcodes `CODEX_LOGIN_MODE: "api_key"` and reads `OPENAI_API_KEY` from the
worker environment. The `docker-model` lane did not complete in any of the
last seven Full Integration runs (2026-09-20 to 2026-10-01).
It is still the default: with no `OCC_DEVELOPMENT_COMPUTE_DRIVER`,
`occ dev up` runs `scripts/dev-up` with Docker Compute. A new developer
therefore gets a stack that refuses to deploy their first Agent. The quickstart
and the dogfood environment both use the Kubernetes-only k3d profile.

**Removing it simplifies** the local default, a second gateway auth contract,
Podman socket handling in the worker, and the `docker-model` lane.

**Risks.** Low. It is development-only and cannot be selected for production.
We lose a lighter-weight runtime for contributors without k3d.

**Migration.** Make `kubernetes` the default for
`OCC_DEVELOPMENT_COMPUTE_DRIVER` first, then delete the driver, its lane and
its docs. Contributors set the quickstart exports.

**Recommendation.** Remove.

### 3. Compose control plane vs k3d-only local development

**What.** `OCC_DEVELOPMENT_CONTROL_PLANE=compose` (the default) runs
PostgreSQL, the API and the worker in Compose. With Kubernetes Compute, Agents
run in k3d (the "hybrid" profile). `kubernetes` runs everything in k3d through
Helm.

**Size.** `internal/occdev` has 5,700 Go lines (980 of them tests), shared
across all profiles. The Compose-specific parts are `compose.go` (156), the
Compose branches of `up.go` and `down.go`, most of `scripts/dev-up` (707 lines
of bash, a second entry point), and `compose*.yaml` (362). Tests:
`dev-up.test.mjs` (1,603, in CI Required) and its helper (703). The `openshell`
and `dev-up-k3d` lanes each have one hybrid case. 75 docs pages mention
Compose. The hybrid profile also needs a 147-line manual routing guide
(`local-compose-kubernetes.md`) before Standard Codex works.

**Who uses it.** The quickstart, the dogfood VM and the k3d test helper
(`local-first-agent-stack.mjs`) all use `kubernetes`. Open #519 (author
kevinlin-openai, conflicting since 2026-09-28) makes `kubernetes` the default
whenever Kubernetes Compute is selected and keeps hybrid as an opt-in.

**Removing it simplifies** local setup to one profile that matches production
packaging (Helm), so the separate Compose startup, routing and cleanup paths go
away.

**Risks.** Compose may give a faster inner loop for controller-only changes; we
have not measured this. Two CI cases need to move to the Kubernetes control
plane.

**Migration.** Land #519 or an equivalent default change. Move the two hybrid
lane cases. After one release with no reported hybrid users, delete the
Compose control plane and `scripts/dev-up`.

**Recommendation.** Go k3d-only, in that order. Candidate 2 removes the only
reason the Compose+Docker default exists.

### 4. Stop growing the dedicated Codex Gateway config rewrite

**What.** On workspace-node Codex Gateways, the runtime entrypoint rewrites the
owner's OpenClaw config at every start. It withholds Gateway-local tools,
turns cron triggers off and stubs the `codex`/`openai` provider rows. That
work landed in #808 (+270), #814 (+61) and #824 (+245) and is recorded in
RFC-0046. #830 (+518/-39, open, held) stubs every provider row and strips
request `params`. A reviewer then found `channels.modelByChannel` and image,
pdf, utility and gmail model refs that still reach a model.

**Who uses it.** Every dedicated Codex Agent with a workspace node, which is the
Standard Codex preset.

**The problem.** OpenClaw cannot forbid the built-in runtime
(`AgentRuntimePolicySchema` is strict `{ id }`). Every new model-selection key
upstream opens another path, so the rewrite can never be complete. The
remaining paths are operator-driven: `/model … --runtime openclaw`, Gateway
config writes, and the Control UI terminal. The model cannot reach them
(RFC-0046, finding D89). Upstream openclaw/openclaw#156193 shows the same
silent fallback to the built-in runtime outside OCE.

**Proposal.**

1. Decline #830 and keep #824 as the last provider-row rewrite. Close #830 with
   a link to this RFC and RFC-0046.
2. Ask OpenClaw upstream for one runtime setting that disables fallback, rejects
   session runtime overrides, and ignores a plugin's declared
   `fallbackRuntime`. This ask has not been filed yet and needs owner approval.
   Once it ships, replace the provider stub with that setting.
3. Optionally, set `gateway.terminal.enabled: false` on workspace-node Codex
   Gateways in the same rewrite. That removes the operator shell in the Gateway
   Pod and the `screen terminal_show` path to it.

**Removing it simplifies** a list of override keys that would otherwise grow
with every OpenClaw release.

**Risks.** Until upstream ships the setting, an operator who has Configuration
write access on that Agent can still route a session to the built-in runtime
through a provider row #824 does not cover. RFC-0046 accepts this as an
operator-level risk. Disabling the terminal costs operators a debug shell; they
still have `kubectl exec`.

**Recommendation.** Do steps 1 and 2. Decide step 3 together with candidate 5,
because enabling browser chat by default exposes the Control UI terminal to
more users.

### 5. Native admin UI proxy pilot

**What.** OCC proxies an Agent's stock OpenClaw Control UI on an isolated
per-Agent origin for exact-Agent administrators. It is documented as a
trusted-operator pilot and is off by default (plan 31). It is also the only
browser chat.

**Size.** 770 lines of code (`gateway/native-admin-proxy.ts` 553,
`native-admin.ts` 111, console `native-admin.mjs` 106). 2,924 test lines
(access 859 in CI Required, session/Postgres 970, k3d real 1,095 in the
`gateway-routing` lane). The deploy guide, reference and flow pages total 615
lines.

**Who uses it.** Dogfooding uses it for every chat (57 mentions in the findings
log). Recent fixes include #554, #839, #849 and #858; #873 is open. Finding D69:
enabling it takes devtools to copy the derived origin, a hand merge of two JSON
blocks and a second deploy for every Agent, even though OCC already knows the
origin.

**Options.** (a) Keep it, drop the "pilot" label, and when the installation
sets `agentNativeAdmin.domain`, render trusted-proxy auth and the derived origin
into the managed config at first deploy (D69). (b) Remove it. OCE would then
have no browser chat, which removes supported functionality.

**Risks.** Option (a) exposes full native operator administration, including
the terminal (candidate 4), to every Agent administrator by default. Option (b)
breaks the dogfood workflow and the console's chat entry.

**Recommendation.** Option (a), gated on the candidate 4 terminal decision.

### 6. Does dedicated Codex need a separate Gateway Pod? (open question)

**What.** Dedicated Codex runs a trusted Gateway in a control-plane namespace
and an untrusted Codex Harness in the data-plane namespace
(`docs/reference/harness-execution.md`). The Gateway reaches the Harness
workspace through a paired OpenClaw node.

**Complexity the split carries.**

- Workspace-node pairing and binding: about 520 lines in one block of
  `kubernetes/index.ts` (setup-code Secret and Pod annotation refresh, binding
  ConfigMap, a 20 s ack poll, an 8 s pairing budget per setup, NetworkPolicy).
  About 120 lines in `runtime-entrypoints.ts` refer to the node or its peer,
  along with 20 test files and 13 docs pages.
- The Gateway-side isolation from candidate 4, which exists because the Gateway
  process can also run tools.
- RFC-0047's 16-PR first-deploy pipeline, the cluster-wide `patch` on `pods`,
  and the status-proxy CIDR requirement.

**What a single Pod would cost.** If both containers ran in the data-plane Pod,
the Gateway would share the network namespace and node with model-run code.
That would undo the control-plane Gateway placement (plan 36) and the
Gateway–Harness storage split (RFC 28). Channel credentials
and the transcript would then sit next to untrusted code, as embedded OpenClaw
does today.

**Ask.** Before more Gateway-side isolation or activation work lands, the
Compute and security owners should state whether the trust split is a launch
requirement. If it is, candidates 4 and 5 stay as proposed. If it is not, a
follow-up RFC should cost a two-container Pod.

### 7. Stale draft RFC PRs

All seven predate the current spec layout (#757), so none use
`specs/rfcs/NNNN-*`. Only #247 has had no activity for seven days. Most of the
others last changed through a main-merge or a small commit on 09-29 or 09-30.
Their other recent activity is automated review comments.

| PR     | Topic                                     | Last activity                                        | Recommendation                                                                               |
| ------ | ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [#247] | Agent execution identity (SPIRE)          | commit 09-24; maintainer deferred it on 09-21        | Close as deferred; reopen after repository credentials settle                                |
| [#248] | gVisor container support                  | commit 09-29 rescoped it to 1.x                      | Close and park for 1.x                                                                       |
| [#250] | Agent history and audit retention         | main-merge 09-29; last human review 09-21            | Close as superseded by #574 (same `specs/31-basic-observability`)                            |
| [#458] | Guarded Kubernetes runtime activation     | main-merge 09-29; no human review                    | Close; RFC-0047 links it as the open activation-evidence proposal. Number 42 is now RFC-0042 |
| [#460] | Settlement for uncertain console edits    | commit 09-30; no human review                        | Close and park; it adds a new state mechanism, out of quality scope                          |
| [#574] | Lifecycle history and audit retention     | main-merge 09-29; external review question 09-30     | Park until after launch with #577; answer the question first                                 |
| [#654] | OpenShell projections for dedicated Codex | commit 09-30; maintainer offered a design sync 09-30 | Keep open until that sync happens                                                            |

No other open draft RFC PR predates 10-01. Draft feature PRs #378 and #508
have had no activity since 09-26 and 09-28. They are not RFCs and are outside
this RFC.

## Summary of recommendations

| #   | Candidate                    | Code / tests / docs (lines)                                        | Users found                            | Recommendation                                                | Needs                           |
| --- | ---------------------------- | ------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| 1   | SSH Compute Driver           | 1,829 / 1,937 / 645 + plan 354                                     | None in dogfood or planning; #829 open | Remove from bundled set; external package path                | Maintainer decision             |
| 2   | Docker Compute Driver        | 1,420 / 2,980 / 1,078                                              | None; cannot deploy an Agent           | Remove after the default switch                               | Maintainer decision             |
| 3   | Compose control plane        | Compose share of 5,700 Go + 707 bash + 362 YAML / 2,306 / 75 pages | Quickstart and dogfood use k3d         | k3d-only after #519 and one release                           | Maintainer decision             |
| 4   | Codex Gateway config rewrite | +576 landed; #830 +518                                             | Every Standard Codex Agent             | Decline #830; upstream no-fallback ask; terminal off optional | Owner approval for upstream ask |
| 5   | Native admin UI pilot        | 770 / 2,924 / 615                                                  | Dogfood, the only browser chat         | Keep; default-enable per D69                                  | Owner decision, tied to 4       |
| 6   | Separate Gateway Pod         | ~520 + 120 / 20 files / 13 pages                                   | Every dedicated Codex Agent            | Open question; no recommendation                              | Compute and security owners     |
| 7   | Stale draft RFC PRs          | 7 PRs                                                              | See table                              | Close 5, park 1, keep 1                                       | Authors                         |

## Delivery and verification

Each accepted cut ships as its own PR. That PR moves defaults first, deletes
code, tests, lanes and docs in the same change, and keeps CI Required green. The
measurements above come from source review and `wc -l` on the baseline. No
runtime behavior was tested for this RFC.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Keep everything.** Each path keeps costing review time, doc words and CI
  minutes, and candidates 2 and 3 keep a broken default in front of new
  contributors.
- **Feature-flag instead of remove.** Flags keep the code and the tests,
  which is the cost we want to cut.

## Unresolved questions

Candidate 6, and whether SSH has a maintainer. Each is listed above with the
owner who decides it.

## References

- RFC-0046, dedicated Codex Gateway isolation: [#853][pr-853]
- RFC-0047, first-deploy activation: [#855][pr-855]
- Compute matrix: [`docs/reference/drivers/compute-matrix.md`](../../docs/reference/drivers/compute-matrix.md)
- Local profiles: [`docs/guides/deploy/local-kubernetes-development.md`](../../docs/guides/deploy/local-kubernetes-development.md)

[pr-519]: https://github.com/openclaw/openclaw-enterprise/pull/519
[pr-824]: https://github.com/openclaw/openclaw-enterprise/pull/824
[pr-830]: https://github.com/openclaw/openclaw-enterprise/pull/830
[pr-853]: https://github.com/openclaw/openclaw-enterprise/pull/853
[pr-855]: https://github.com/openclaw/openclaw-enterprise/pull/855
[issue-829]: https://github.com/openclaw/openclaw-enterprise/issues/829
[#247]: https://github.com/openclaw/openclaw-enterprise/pull/247
[#248]: https://github.com/openclaw/openclaw-enterprise/pull/248
[#250]: https://github.com/openclaw/openclaw-enterprise/pull/250
[#458]: https://github.com/openclaw/openclaw-enterprise/pull/458
[#460]: https://github.com/openclaw/openclaw-enterprise/pull/460
[#574]: https://github.com/openclaw/openclaw-enterprise/pull/574
[#654]: https://github.com/openclaw/openclaw-enterprise/pull/654
