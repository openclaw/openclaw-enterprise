# Control-plane Gateway placement execution plan

## Outcome and scope

OCC's Kubernetes Compute Driver deploys each dedicated Agent Gateway in a
managed control-plane runtime namespace and its Harness in the tenant data-plane
namespace. Both retain exact logical Namespace/Agent/revision ownership. This
work covers dedicated execution only. Embedded OpenClaw is outside its design,
implementation and runtime acceptance scope; its existing data-plane path remains.
The authoritative architecture remains `docs/design.md` and its workload chapter.

Base: fresh upstream `main` at `150ec08f059cebc4897b839d8318f7b1e3aba0e3`,
merged into the published branch without rewriting history.

## Decisions

- Keep placement inside Kubernetes Compute; use existing worker and Driver lifecycle.
- Allocate one Gateway runtime namespace per logical Namespace, preserving tenant
  isolation rather than co-locating tenants with controller credentials.
- Gateways have separate ServiceAccounts, private PVCs, configuration and admitted
  credential material. They receive no Harness model credential or workload token.
- Use explicit cross-namespace DNS and exact-owner network peers. Keep the paired
  node's private authenticated route. Do not claim mTLS for existing token-based
  app-server transport.
- Keep stop, revision retirement, Agent deletion and Namespace deletion distinct;
  preserve durable Agent state until final deletion, including partial failure.
- Runtime release pins, dedicated OpenClaw workers, remote Skills features, custom
  bootstrap paths, and live deployment are outside this change.
- Support the expected final layout only. Do not add old-layout discovery,
  relocation, dual-layout operation or compatibility branches for migration.

### Namespace placement decision

One Gateway namespace per logical Namespace is this Kubernetes implementation's
isolation choice, not a platform requirement. It preserves namespace-scoped RBAC,
quotas and tenant deletion boundaries without putting Agent resources alongside
OCC API/worker credentials. A shared Gateway-only namespace is another possible
implementation, but would require resource-level tenant isolation and cleanup
instead of reusing those namespace boundaries. Gateway node placement still needs
an explicit trusted pool; namespace separation alone does not establish trust.

### Revised credential ownership decision

Canonical tenant Configuration and Secret sources belong to trusted control-plane
storage. With Kubernetes-backed Drivers, use the tenant's managed control-plane
namespace; a separately selected trusted Secret store can own the same logical
contract. Gateway-only passwords, channel credentials, policy and private state
remain there. The Gateway receives only its admitted references, without a
data-plane-to-control-plane Secret synchronization dependency.

Compute delivers only the selected Harness revision's execution configuration,
model authorization, app-server transport material and node enrollment material
to the data plane. These are disposable runtime projections; the Harness cannot
write canonical credentials, policy, routes or active-revision state. Credential
domains must use separate Secrets, so a Harness transport Secret cannot also
contain a Gateway password or channel token.

Idempotent workload reconciliation still repairs missing projections from
control-plane desired state. Credential issuance, version changes, rotation and
revocation need explicit lifecycle semantics; repeated byte copying is not a
rotation or revocation protocol. Deleting a Secret cannot revoke a token already
loaded into a process or accepted by a provider.

Cross-boundary RPCs must authenticate the endpoint and exact Agent/revision role,
preserve confidentiality in transit, and treat Harness responses as untrusted
data. The current capability-token app-server `ws://` path does not implement
transport encryption. Node credentials authorize only the enrolled node role,
never native operator or OCC administrator access. Current direct model-key
delivery remains an explicit exposure to Harness execution; merely projecting
an account-wide key does not narrow its provider-side authority.

This PR changes existing Kubernetes Drivers and workload rendering. It adds no
credential framework, broker, rotation controller, database migration, or new
public platform primitive. Embedded execution retains its existing combined
workload; canonical Kubernetes storage is shared by both modes, so only the
necessary consumer delivery adapts to that storage change.

## Work

- [x] Inspect current design, interfaces, callers, lifecycle and split-storage implementation.
- [x] Reuse a clean worktree from a merged PR; pin fresh main without changing other work.
- [x] Implement placement, credential delivery, routing, networking and lifecycle.
- [x] Update production packaging and development/fixture configuration.
- [x] Extend regular Kubernetes integration to check cross-namespace placement,
      allowed/denied connectivity, replacement and exact-owner cleanup.
- [x] Update architecture, references, setup and the existing execution flow.
- [x] Run focused local type, lint, formatting, documentation and packaging checks.
- [ ] Run real Kubernetes fixtures and runtime replacement/reconnect acceptance
      with the required disposable cluster, database and compatible runtime images.

## Acceptance

Dedicated preparation and activation create Gateway resources only in the Gateway
runtime namespace and Harness resources only in the tenant namespace. Same-Agent
transport succeeds; other Agents and Namespaces cannot use it. Stale retirement
does not remove an active Gateway, its route or its state. Stopping retains state;
Agent deletion removes only owned resources in both targets. Namespace deletion
cannot delete another tenant or shared controller infrastructure. Missing placement,
permissions or credential delivery fails explicitly without a data-plane fallback.

## Evidence and open checks

Source inspection: current storage split removed the common workspace mount but
Gateway placement, Secret references, app-server DNS and network peers still assume
one namespace. Existing lifecycle and runtime status callers must all select the
correct target. Runtime fixtures and real model proof must be reported separately.

Current references: [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md)
and [platform architecture](../../docs/design.md). This change does not deploy
the implementation or relocate existing runtime volumes.

Local validation: 246 targeted conformance and real Helm-rendering tests passed,
with no failures or skips. The updated credential-boundary test also passed in
all 113 Kubernetes Compute cases. TypeScript build, changed-file ESLint, workspace
boundary, documentation links/length and the three credential flow validators passed.
A full local conformance run reported six additional failures involving macOS
missing `/usr/bin/gh`, control-directory/command cleanup or SSH preflight; these are not treated as green
or as proven base failures. The earlier plugin fixture failure was repaired and
its 48-test suite passed. Exact-lockfile CI is the remaining check.

Local checks and CI results are recorded with the PR revision. Installed
TypeScript is version 7 while the manifest selects the TypeScript 6 alias;
dependencies were not installed or reconciled. Exact-lockfile CI remains required.
Real runtime pins, staging/model turns, replacement/reconnect and disjoint node-pool
placement remain separate deployment acceptance. Single-node fixture success is
not proof of node isolation or a real model turn.

## Review follow-up

Kevin's four comments on PR #327 were checked against the source. Cross-mode
retirement now preserves shared data-plane resources while another Gateway
revision survives in the other target. Final Agent deletion inspects both targets
regardless of the current draft mode. The operator port-forward uses the selected
Gateway namespace; the Slack test uses data-plane placement for Harness lookup.
These are lifecycle fixes, not state migration or full mode-switch qualification.

Six regression scenarios failed before the fixes and pass afterward; all 252
focused Kubernetes, credential, plugin and packaging tests pass. The public
API/worker cluster test also edits each Agent's draft mode before deletion and
checks historical resources disappear. Local cluster discovery skips its three
cases because cluster prerequisites are absent; CI and real-runtime acceptance
remain separate. TypeScript, changed-file lint, docs links/length and the topology
flow validator pass.

## CI repair after review

Run 35910713902 tested merge SHA `caaf28e92fad1ef7b932c313069d7ed5186f7bcd`
for branch head `df4ca44`. Checks/baseline passed 1337 tests and failed the stale
activation fixture because its model Secret reference still named the DP target.
The two cluster lanes failed six cases: fixture credential delivery skipped CP-to-DP
materialization without native runtime options, and the adopted-namespace test
still read canonical Configuration from DP. The two Pod-local credential
regressions and stale-activation case reproduce locally and pass with these fixes.
All 256 focused Kubernetes/credential/plugin/packaging tests pass. Cluster rerun
is required; local discovery is not cluster acceptance.

Upstream provisioning PR #322 is merged from `8adfd86`. Its new exact Configuration
create/recovery methods use CP storage too. The import conflict is resolved without
dropping either workflow. No dependency upgrade or migration code is introduced.

Run 35914598195 tested merge SHA `a0ef7c86bbe26f7b2e01fb4bb2922126fed48269`
for branch head `d91e9af`: baseline passed 1347 cases and State/Lifecycle passed
all four. The Fixture/Configuration job initially failed node readiness before
running tests. Its retry ran all four cases, passing the external-namespace and
API/worker deployment workflows but exposing two remaining test integration gaps:
a stale controller Secret-denial assertion and the newly merged provisioning
fixture's single-target authorization. The fixture now grants both exact targets,
checks CP Configuration and separately owned transport/password Secrets, and
cleans up both namespaces. RBAC coverage checks controller access only in granted
targets and denies both workload identities Secret reads in either target. These
changes still require a successful real-cluster CI run.

## Open work and release boundaries

This PR owns [#75](https://github.com/openclaw/openclaw-enterprise/issues/75):
placement, canonical CP sources, consumer-specific delivery, cross-namespace
routing/policy and exact-owner lifecycle. Merge acceptance requires the changed
fixture workflows and negative ownership tests to pass. It does not close the
following work merely because Gateway Pods moved.

| Open item                                                                 | Tracking and owner                                                                                                                                                                                                                                                                                | Boundary for this PR                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime release/version alignment and staging replacement/reconnect       | Separate runtime acceptance work; Kimi coordinates                                                                                                                                                                                                                                                | Deployment acceptance prerequisite; do not label local conformance or fixture CI as real-runtime proof.                                                                                                              |
| Provider-owned Harness compatibility                                      | [#78](https://github.com/openclaw/openclaw-enterprise/issues/78), GitHub unassigned                                                                                                                                                                                                               | Existing Secret/Service/identity contract remains required. An unsupported provider must fail; this PR does not repair upstream OpenShell compatibility.                                                             |
| Dedicated sandbox and Gateway local-execution boundary                    | [#79](https://github.com/openclaw/openclaw-enterprise/issues/79), Free                                                                                                                                                                                                                            | Placement alone does not prove all untrusted execution has left Gateway. Qualify allowed plugins/local execution before claiming the complete sandbox boundary.                                                      |
| Credential mediation and raw model-key removal                            | [#85](https://github.com/openclaw/openclaw-enterprise/issues/85), [#116](https://github.com/openclaw/openclaw-enterprise/issues/116), Free; model-provider integration coordinated with Steven                                                                                                    | Existing selected model credentials still reach Harness. CP ownership and narrow delivery do not narrow provider-side authority. No broker implementation in this PR.                                                |
| Broker authorization, OpenShell integration, revocation and qualification | [#117](https://github.com/openclaw/openclaw-enterprise/issues/117), [#118](https://github.com/openclaw/openclaw-enterprise/issues/118), [#119](https://github.com/openclaw/openclaw-enterprise/issues/119), [#120](https://github.com/openclaw/openclaw-enterprise/issues/120), GitHub unassigned | Separate implementation and acceptance; no claim of per-access authorization or immediate revocation here.                                                                                                           |
| Authenticated/encrypted workload transport and lifecycle identity         | [#106–110](https://github.com/openclaw/openclaw-enterprise/issues/106), GitHub unassigned; concrete app-server transport hardening DRI TBD                                                                                                                                                        | Current app-server path is bearer-authenticated `ws://`. NetworkPolicy and labels are not mTLS or cryptographic revision identity. Security release policy must explicitly account for this remaining transport gap. |
| Finite credential lifetime and replacement                                | [#101](https://github.com/openclaw/openclaw-enterprise/issues/101), GitHub unassigned                                                                                                                                                                                                             | No automatic rotation; source/projection deletion cannot revoke a loaded credential. Deploy consumers after an update; coordinate transport replacement separately.                                                  |
| Active/candidate credential dependencies                                  | [#90](https://github.com/openclaw/openclaw-enterprise/issues/90), GitHub unassigned                                                                                                                                                                                                               | Preserve existing deletion guards; this PR does not claim the wider credential lifecycle qualification is complete.                                                                                                  |
| Dedicated OpenClaw worker                                                 | [#77](https://github.com/openclaw/openclaw-enterprise/issues/77), GitHub unassigned                                                                                                                                                                                                               | Separate workstream; dedicated Codex proof does not qualify this worker. Embedded OpenClaw is excluded from the new boundary.                                                                                        |

GitHub assignments were checked on 2026-09-23. A named adjacent workstream owner
is not an assignment to finish this PR's remaining transport or release checks.
Broader platform/Harness secret classification, remote Skills features and custom
bootstrap paths remain deferred. Follow-up changes should be separately scoped
and verified as their runtime contracts become available.
