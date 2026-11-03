# Implementation plan: per-Agent Sandbox network additions and policy denials in OCE

- **ID:** TASK-0045
- **Delivery status:** In progress
- **Owner:** Sandbox Driver, Agent lifecycle/IAM, persistence, runtime logs, console, and local development owners
- **Authority:** Existing [platform architecture](../../docs/design.md), planned [SandboxPolicy resource](../../docs/design/resources.md), current [SandboxDriver contract](../../docs/reference/drivers/sandbox.md), and [Agent logs](../../docs/guides/topics/agent-logs.md); independent implementation plan.
- **Source baseline:** `a28596ab8cf5e028a5eb91c276feb19a3775554c`

## Outcome and scope

An Agent's Python tool attempts an unapproved network request. OpenClaw Enterprise
(OCE) shows the denial on that Agent. When an administrator enables user-managed
network additions, an authorized user can review a narrow grant, apply it, and
retry. Other Agents retain their policies.

Retain the dev-up policy-file override as an independent slice. Per-Agent policy
and console implementations await verification and merge evidence. OCC admits
and audits; Drivers enforce. Keep demo files local and first-agent unchanged.
Exclude automatic grants, persistent denials, and filesystem/process editing.

## Baseline before implementation

- The architecture's Namespace-owned `SandboxPolicy`, Agent references, and
  revision snapshots were unimplemented in shared contracts at the source baseline.
- [OpenShell provisioning](../../apps/controller/src/drivers/sandbox/openshell.ts)
  applied Installation defaults plus generated transport rules. Existing-Sandbox
  verification expected that spec without live network updates.
  [Local Setup](../../internal/occdev/kubernetes.go) generates the Installation;
  changing the input file does not update a running stack.
- [Sandbox log reads](../../packages/occ/src/runtime-logs/sandbox.ts) already
  provide bounded, authorized, audited, revision-scoped follow and gap notices.
  [OCC sanitization](../../packages/occ/src/runtime-logs/sanitize.ts)
  extracted OpenShell fields. The Driver's
  [protobuf subset](../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto)
  omitted the recommendation APIs.
- The pinned [OpenShell protocol](https://github.com/NVIDIA/OpenShell/blob/021400be8af471f8669369e679de3e18cf0bd672/proto/openshell.proto)
  exposes `GetDraftPolicy`, `GetDraftHistory`, and draft notifications through
  `WatchSandbox`, alongside `GetSandboxLogs`. Draft chunks can aggregate
  observations or be agent-authored; workflow history is not an exhaustive
  denial stream. The live comparison below records their behavior in this setup.

## Proposed policy contract

### Defaults, additions, and delegation

Add a provider-neutral delegation ceiling to trusted Installation configuration,
alongside Driver selection. OCC uses the same ceiling in API and worker.
Defaults grant access; the ceiling permits user requests but grants nothing.
An absent ceiling permits no user additions. Existing OpenShell
`policy.networkPolicies` and the startup override remain defaults. Local Setup
needs a separate operator input for the ceiling; preserve the defaults-only file
contract. Compute isolation, credentials, and mandatory restrictions still apply.

Use the planned Namespace-owned `SandboxPolicy`, associated with exactly one
Agent initially. Reject cross-Namespace and cross-Agent references; live
references prevent deletion. Integrate with regular Agent create/read/update/
deploy and CLI/API representations.

User editing defaults to disabled; only administrators change that Agent setting.
Adding, editing, removing, and live application require a separate exact-Agent
policy permission and enabled editing. Ordinary Agent editing is insufficient;
redeployment also requires deploy permission. Independently authorize policy
resources and reference changes to prevent bypass. Defaults are read-only.
Disabling editing preserves approved grants and prevents future user changes;
revocation requires an explicit change, re-enabling editing when necessary.

Support exact hostnames, hostname wildcards, and port ranges where the Driver
supports them; executable paths remain exact. Every destination and port covered
by a grant must fit the ceiling. Reject unsupported constraints and reserved or
conflicting rule identities. Preserve required model, workspace, and infrastructure
access. Do not expose arbitrary OpenShell YAML through Agent configuration.

### Admission and application

Extend the Sandbox contract with optional per-Agent network-policy support,
explicit constraints, and complete-policy validation. The existing `networking`
facet does not imply editable policy. Drivers must reject binary-scoped grants
they cannot enforce without broadening access. Unsupported Drivers retain their
existing deployment behavior.

OCC resolves and authorizes references, admits the policy, and freezes identifiable
defaults and additions into the initial revision. Workers cannot reinterpret that
snapshot using changed defaults. Provider parsing, rendering, and RPCs stay in
the Driver. Persist approved desired additions in OCE, regardless of suggestion
source; validate the complete resulting policy before provider effects.

Declare live application separately. Apply live when supported for the change;
otherwise offer explicit redeployment with its interruption. Use durable desired
state, expected-version checks, exact Sandbox/revision targeting, and effective
provider-version confirmation. Reconcile failed or unknown outcomes and retain
additions across deployments. Existing-Sandbox verification must recognize
approved updates. Record later policy versions separately from immutable revision
snapshots. Saving or acknowledging a mutation does not establish application;
failed live updates must not trigger automatic redeployment.

### Denial evidence and recommendations

Keep observed denial records separate from suggested policy changes, including
provenance and counts. A suggestion is an untrusted candidate grant, not proof of
an individual blocked request. Policy editing works independently of log
availability, log-read permission, and recommendations.

Add an optional, provider-neutral recommendation-read capability to
`SandboxDriver`, using native OpenShell recommendations for review. Drivers may
support this independently of logs or live application. OCC scopes, authorizes,
and audits reads, validates/redacts results, and bounds responses. Native approval cannot
bypass OCE admission, persistence, or reconciliation. Use provider approval only
if its candidate and concurrency semantics preserve those guarantees; otherwise
apply the canonical admitted OCE policy through the Driver.

Retain typed denial metadata on `SandboxLogLine` where needed for readable rows,
troubleshooting, or log-derived proposal prefill. Move recognized OpenShell
parsing into its Driver; unknown lines remain raw. Normalizing every log record
is not a prerequisite for native suggestions. Application truth comes from the
Driver's effective version, and retry success from the actual tool result.

## Implementation

### 1. Retain the startup policy override

Keep `--sandbox-network-policy-file <path>` on `occ dev up` and `scripts/dev-up`:

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
OCC_DEVELOPMENT_CONTROL_PLANE=compose \
OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell \
./scripts/dev-up --sandbox-network-policy-file ./python-policy.yaml
```

Preserve input validation, generated-rule protection, saved snapshots, and
recreation semantics. This slice configures defaults and grants no editing rights.

### 2. Compare live OpenShell sources before finalizing contracts

Completed on 2026-10-15 against the pinned runtime: Compose OCC, Kubernetes
Compute, dedicated Codex Agent, and unchanged OpenShell settings/policy.

- Python reached `example.com` (HTTP 200); `example.org` failed with permission
  denied. Matching denial records appeared through OCC CLI and the current
  console Sandbox Logs view.
- `GetDraftPolicy` automatically produced one pending executable/host/port grant,
  rationale, validation result, review token, and complete current/candidate
  policies with hashes. No advisor opt-in was needed; settings were unconfigured.
- Repeating the denial updated the same chunk's `hit_count` from 1 to 2.
  `draft_version` stayed 3. `GetDraftHistory` retained one `proposed` entry;
  neither value is an individual-denial count or a complete change signal.
- `WatchSandbox` delivered denial logs, but no draft-update notification during
  the 115-second observation. Poll bounded recommendation responses independently.
- An `ALLOWED` Python record also appeared, correcting the earlier assumption
  that this source has no allowed records. Keep the initial tab denial-focused.

Select native recommendations for review and logs for denial evidence. Upstream
logs retain 2000 lines in memory; drafts use provider persistence without API
pagination. Bound message/result sizes explicitly. Provider reads used this
profile's existing unauthenticated mode; authenticated `config:read` scope and
retention across restart remain unverified. Full config decoding encountered
unset map entries; a settings-only decoder confirmed unconfigured values.
No approval or policy update was attempted. Preserve manual/log-prefilled editing
when recommendations are unavailable.

### 3. Implement the selected Driver read contracts

Implement native recommendation reads based on step 2. Keep suggestion
identity, provenance, lifecycle, and provider versions distinct from denial
metadata. Do not synthesize individual denials from aggregate proposals.

For recognized log denials, normalize optional outcome/enforcement evidence,
executable, destination, reason, rule, engine, and provider generation; export
public types through the contracts index. OCC validates/redacts fields and raw
messages, rejects malformed records, and preserves existing exact-revision log
permissions, audit, budgets, follow, deduplication, and gaps. Missing metadata
stays unknown; label **Blocked** only with enforcement evidence. Keep OCE policy
identity distinct from provider generation.

### 4. Integrate governed policy changes with the Agent workflow

Extend [contracts](../../packages/contracts/src/index.ts),
[PostgreSQL storage](../../packages/occ/src/state/postgres-schema.ts),
[OCC lifecycle](../../packages/occ/src/index.ts), IAM, HTTP schemas, and CLI.
Implement the Agent setting, policy ownership, ceiling validation, independent
reference authorization, snapshots, and attributable mutation/denial audit.
Consume admitted policies through actual OpenShell provisioning and the selected
live/redeploy path. Recommendation approval must use this same workflow.

### 5. Build the console workflow from validated sources

Reuse the [Agent Logs lifecycle](../../apps/controller/src/console/agents/logs.mts).
The Policy denials tab shows retained denial records with
**Denials in the loaded window**; count records rather than unique requests or
lifetime totals. Omit the allowed-decisions toggle. Keep gap/withheld-record notices visible. Show
`Denied · python3 → example.org:443`, reason and provenance, with sanitized source
on expansion. Distinguish loading, permission denial, unavailable/unsupported
logs, missing metadata, and gaps. An empty window says
**No denials in this window.** Stop follow on close; reset on revision changes.
Do not imply chat-turn correlation or infer success from an empty window.

Present native suggestions separately, with their own status/count, when
supported. Do not mirror OpenShell's full history or bulk-approval workflow.
Offer **Review policy addition** for supported, enabled, authorized editing.
Prefill from a validated suggestion or narrow log metadata; incomplete records
require user input. Show the complete proposed access and application behavior
before explicit submission. Treat either source as untrusted.

Show read-only defaults and editable additions, saved/effective versions, pending,
failed, and unknown states. Support manual add/edit/remove without logs; explain
disabled editing, insufficient permission, and unsupported capabilities distinctly.
Make redeployment explicit; do not automatically retry commands.

Rebuild Storybook scenarios, inspect controls, and capture screenshots/video
outside the checkout. Upload final evidence before merge; label simulated proof.

### 6. Update current documentation with implementation

Update affected references, operator guides, navigation, and the owning
[provisioning](../../docs/flows/agent-provisioning.md),
[OpenShell](../../docs/flows/openshell-sandbox-provisioning.md),
[log](../../docs/flows/agent-runtime-logs.md), and
[Agent editing](../../docs/flows/platform-console/agent-editing.md) flows.
Describe supported behavior after implementation.

## Local demonstration

Use Compose OCC, Kubernetes Compute, and OpenShell with Python defaults allowing
`example.com:443`. Permit `example.org:443` in the ceiling without granting it.
Verify the executable path before using this defaults file:

```yaml
networkPolicies:
  - name: python-web
    binaries:
      - path: /usr/bin/python3.11
    endpoints:
      - host: example.com
        ports: [443]
        tls: skip
```

1. Follow the [OCC CLI deployment procedure](../../docs/guides/deploy/openshell-credential-sources.md)
   with authorized credentials: dedicated Codex, native execution enabled, exact
   Credential Source granted, runtime credentials provisioned, revision active.
2. Enable [native Control UI](../../docs/guides/deploy/native-admin.md#configure-each-agent)
   and print the OCE Agent URL for the human console session.
3. Prompt Python's standard-library HTTP client to request `https://example.com`
   and `https://example.org` separately, with timeouts, bounded output, and
   continuation after failure. OCC CLI has no chat/invoke command.
4. Inspect `occ agent logs ID --source sandbox --revision REVISION_ID` and OCE.
   Compare CLI recommendations with denial records; use authorized provider
   investigation for native history. Record request results and denial evidence.
   A failed request alone does not prove enforcement.
5. After implementation, enable editing administratively, review/apply the grant,
   wait for confirmed application, and retry manually. Verify actual tool success.
6. Verify another Agent remains denied and unauthorized users cannot change policy.

## Verification

Real-runtime proof uses enforcing k3d, PostgreSQL, selected images, and authorized
model credentials. The 2026-10-19 native checks use production source
`14b4dd30b75f33717f85b552e6d989df83eaa234` plus uncommitted fixture changes;
CI has not run on this local head.

| Required outcome | Evidence and remaining proof |
| --- | --- |
| Startup input | Go validation, snapshot, and ceiling/default separation passed; prior real startup proof retained. |
| Source selection | Live logs/drafts/history comparison passed with aggregation/version/watch limits. |
| Agent enforcement | Automated deny/grant/allow/remove/deny, loaded confirmation, disable-preserve, and second-Agent isolation passed. |
| Delegation/persistence | [HTTP/PostgreSQL integration](../../tests/integration/postgres-agent-sandbox-policy.test.mjs) covers disabled editing, independent resource authority, ceiling rejection, stale edits, database constraints, and explicit redeployment snapshots. |
| Application truth | Queued revocation of either exact permission prevented native dispatch. Post-write worker restart recovered without duplicate UpdateConfig; revision snapshot stayed unchanged. |
| Read contracts | Native status/recommendation/write RPCs passed authenticated sandbox:read, config:read, and config:write boundaries. Workspace role isolation remains unqualified. |
| Console workflow | Fresh prepared fixture previews and real browser review/save/apply exercised. Full Storybook build awaits explicit dependency-install authorization. |
| UI evidence | Final screenshots and real interaction video captured outside the checkout; upload before merge. |

Register cases in owning CI lanes. Parsing fixtures do not replace runtime proof.

## Remaining verification

The extended real OpenShell suite passed (1 test, no skips) on linux/amd64 with
OpenShell v0.1.4 and Codex/gpt-5.1 through an API-key provider. The full lane
also requires an unavailable Codex PAT. Finish
final checks, UI evidence, independent review, and CI before merge. Full conformance encountered three prerequisite
failures because installed GitHub CLI 2.97.0 differs from required 2.100.0; no tool
upgrade or dependency installation was performed implicitly.

## Delivery record

On 2026-10-14, this branch implemented the startup option and launched Compose
OCC with Kubernetes Compute and OpenShell. A dedicated, tool-enabled Codex Agent
is active; browser checks reached its Control UI. Existing Sandbox log reads
return startup denials with destination, binary, and reason in CLI and browser.
Go validation, Driver composition, and live Agent integration passed. Python execution
remains a manual step. Decision decoration and Policy denials UI are pending.
A failed request alone or a simulated row does not prove enforcement.

On 2026-10-15, the user expanded the goal to Agent-specific additions and
optional user editing. The earlier development environment has been shut down.
The startup slice remains implemented; Python denial execution was not recorded
as completed. Shared policy, delegation, decision decoration, and console work
remain planned. No runtime implementation changed during this plan update.

Length review: keep this single workflow together so policy authority, application
behavior, and required proof can be reviewed alongside the denial-to-policy UX.

On 2026-10-15, implemented shared policy, ceiling, IAM, persistence, CLI,
OpenShell reconciliation, denial decoration, and console workflow. The live
Compose/Kubernetes demo completed denial → grant → allowed connection → removal
→ denial, with a second Agent isolated. The allowed request received HTTP 403
from Cloudflare; OpenShell logged ALLOWED, distinguishing remote rejection from
sandbox enforcement. Current behavior is owned by the
[policy reference](../../docs/reference/sandbox-policies.md).

On 2026-10-19, addressed PR #2599: preserved main's history, appended policy SQL,
made recovery atomic, added facets, and corrected fixtures. PostgreSQL and browser
checks passed. Native interruption/revocation execution, full Storybook build,
PR media, CI, and review remain pending.

## Manual Notes

## Changelog

- 2026-10-19: Complete native lifecycle, authority revocation, post-write worker recovery, and authenticated scope proof; retain qualification limits.

- 2026-10-19: Address PR #2599 migration, recovery, fixture, and contract feedback; record passing local checks and remaining native/UI proof. (authoring-run/545665b0-3aef-44dc-beb8-492b753b1a13 - bc3ba215dd9927692bc2882ffaf06a35c27fed4a)

- 2026-10-15: Implement TASK-0045 locally; record real enforcement, browser, HTTP/PostgreSQL, and wire proof with remaining verification gaps.

- 2026-10-15: Complete live Python/API comparison; select native recommendations plus denial logs, record aggregation/version/watch limits, and correct the allowed-log assumption.

- 2026-10-15: Put live OpenShell API comparison before contract/UI work; separate observed denials from optional native recommendations, preserve OCC admission authority, and retain independent delivery of the startup override.

- 2026-10-15: Clarify denial normalization as the observation contract for diagnosis and proposal prefill, independent of policy editing/application.
- 2026-10-15: User selected preserving approved grants when editing is disabled; all six product decisions are recorded, with technical contract details remaining.
- 2026-10-15: User selected add, edit, and remove rights for authorized policy users; Installation defaults stay read-only.
- 2026-10-15: User selected hostname wildcards and port ranges where supported, with exact executable paths and full grant coverage bounded by the Installation ceiling.
- 2026-10-15: User selected a separate exact-Agent policy permission for editing and live application; Agent editing alone does not grant it.
- 2026-10-15: User selected one policy per Agent initially; policies cannot be shared across Agents.
- 2026-10-15: User selected an operator-defined delegation ceiling; propose trusted, provider-neutral Installation configuration separate from default grants.
- 2026-10-15: User selected Driver-dependent application: live when supported, otherwise explicit redeployment; record live policy versions separately from immutable revision snapshots.
- 2026-10-15: Remove the allowed-decisions toggle from the denial-only log workflow; require the actual tool result to establish retry success.
- 2026-10-15: Expand TASK-0045 to per-Agent network additions, optional delegated editing, shared Driver admission, and denial-to-policy UI; retain live application as an open decision (source `a28596ab8cf5e028a5eb91c276feb19a3775554c`).
- 2026-10-14: Implement startup policy input and prepare the live Control UI demonstration; retain existing first-agent behavior.
- 2026-10-14: Limit merge scope to the general dev-up policy override and policy decision logs/UI; use a local OCC CLI recipe and Control UI prompt instead of extending first-agent.
- 2026-10-14: Replace Python-specific dev-up configuration with a general Sandbox network policy file; retain Python as the first-agent demonstration.
- 2026-10-14: Draft the Python policy demonstration and Sandbox log decoration plan against `a28596ab8`.
