---
created: "2026-09-18"
updated: "2026-10-24"
last_updated_session: authoring-run/3ab680f7-bea5-4377-bb8c-14e6b81c49b4
---

# Agent repository credential flow

## Overview

The Console lists approved repositories; deployment freezes grants. Prepared native sessions reach
Compute-owned dedicated Codex without a Sandbox Driver. The opt-in
[OpenShell path](../reference/repository-credentials/protected-openshell-git.md) gives the sandbox a
placeholder: the worker delivers prepared material to the provider and checks each signed
request against the live grant without returning a token.
See [service forwarding and retirement](repository-credentials.md) and
[runtime qualification](../testing/repository-credentials.md).

## Entry Points

- `apps/controller/src/index.ts:createFastifyApp` registers repository-option and
  Agent lifecycle routes. Discovery requires Agent-create or exact-Agent update.
- `apps/controller/src/console/agents/repositories.mts:createRepositoryFields`
  renders discovery and inherited or custom access.
- `apps/controller/src/worker.ts:ControllerWorker.prepareRevision` prepares
  repository sessions before invoking Compute.

For access across session expiry, see [standing repository approval](../guides/repository-credentials.md#keep-git-access-on-the-same-running-agent).

## Flow

```mermaid
graph TD
  Console["<b>Console form</b><br/>Load Namespace choices"] --> Options["<b>Repo Driver</b><br/>Refs, names, profiles"]
  Options --> API["<b>Agent API</b><br/>Recheck and save refs"]
  Options -->|Unverified authorization or discovery error| CreateBlocked["<b>Create blocked</b><br/>Retry before writes"]
  API -->|Known zero-binding rejection| OrdinaryRetry["<b>Ordinary retry</b><br/>Reuse Configuration"]
  OrdinaryRetry --> API
  API -->|Known repository-scoped rejection| FormLocked["<b>Recovery locked</b><br/>Keep Configuration ID; block retry"]
  FormLocked -->|Reload choices| Options
  Options -->|Successful reload| Reselect["<b>Reselect scope</b><br/>At least one repo and profile"]
  Reselect -->|Explicit selection| API
  Options -->|Reload denied, conflict or unavailable| FormLocked
  Options -->|Expired or obsolete view| ViewStop["<b>No current-view retry</b><br/>Sign in or ignore stale completion"]
  API --> Version["<b>Deploy</b><br/>Freeze grants and deadline"]
  Version --> Worker["<b>Claimed worker</b><br/>Recheck actor and policy"]
  Worker -->|Denied or expired| Close["<b>Cleanup</b><br/>Close exact attempts"]
  Worker -->|Native sender| Capability["<b>Check capability</b><br/>Fresh admissions only"]
  Worker -->|Protected Driver| Protected["<b>OCC finite session</b><br/>Prepare and install through Driver"]
  Protected --> Compute
  Worker -->|Active standing Git evidence missing| Observe["<b>Observe existing Harness</b><br/>No preparation or issuance"]
  Observe -->|Durable check within five seconds| Worker
  Capability -->|Available| Attempt["<b>Persist opening</b><br/>Before control request"]
  Capability -->|Unavailable| Blocked["<b>Block new admission</b><br/>Worker stays unready"]
  Attempt --> Service["<b>Private control</b><br/>Check bound registry grant"]
  Service --> Receipt["<b>Journal</b><br/>Commit exact admission"]
  Receipt -->|Acknowledged| New["<b>New material</b><br/>Record ID before delivery"]
  Service -->|Open session| Retained["<b>Retained material</b><br/>No bearer recovery"]
  Service -->|Lost response| Recover["<b>Recover only</b><br/>Find or fence, then close"]
  Recover -->|Never delivered or disposed| Attempt
  Recover -->|Known closing session| Wait["<b>Wait for disposal</b><br/>Retry, no remint"]
  Wait --> Worker
  Recover -->|Known session missing| Refuse["<b>Fail version</b><br/>Retain cleanup obligation"]
  New --> Compute["<b>Compute</b><br/>Validate complete set"]
  Retained --> Compute
  Compute -->|Missing retained files| Repair["<b>Repair exact subset</b><br/>Close and verify disposal"]
  Repair -->|Disposed| Compute
  Repair -->|Closing| Wait
  Repair -->|Missing| Refuse
  Refuse --> Close
  Compute --> Pod["<b>Consumer</b><br/>Matching Agent revision ID and material generation"]
  Pod --> Command["<b>Git or gh command</b><br/>Pin target and session"]
  Command -->|Other requests| Gateway["<b>HTTPS gateway</b><br/>Exact repository/profile"]
  Command -->|Managed push with policy| PushRefs["<b>Pre-push</b><br/>Check destination refs"]
  PushRefs -->|Allowed| Gateway
  PushRefs -->|Denied| PushDenied["<b>Reject whole push</b><br/>No ref update"]
  Pod -->|Durable maintenance| Worker
  Pod -->|Stop or retire| Close
  Close -->|Unavailable or pending| Queue["<b>Durable cleanup</b><br/>Coalesce by version and purpose"]
  Queue --> Close
  Close -->|Confirmed disposal| Terminal["<b>Receipt</b><br/>Commit exact result"]
  Terminal --> Done["<b>Cleanup settled</b><br/>Retain immutable evidence"]
  Pod -->|Delete Agent| Delete["<b>Delete</b><br/>Queue cleanup and retire Compute"]
  Delete -->|Independent cleanup| Queue
  Delete -->|Runtime retired| Finalize["<b>Finalizer</b><br/>Detach and remove live rows"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef condition fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class API,Version,Attempt,Queue,FormLocked,Receipt,Terminal state
  class Console,Options,Worker,Service,New,Retained,Compute,Pod,Command,Gateway,Close,Done,Delete,Finalize operation
  class Recover,Repair,Refuse,Wait,ViewStop,CreateBlocked,OrdinaryRetry,Reselect,PushRefs,PushDenied,Capability,Blocked condition
```

## Execution Trace

### 1. Project choices and resolve Namespace policy during Agent admission

`OpenClawController.listRepositoryOptions` authorizes Namespace Agent creation or
exact-Agent update, checks Compute-owned availability, then projects opaque references, names and
profiles through `GitHubRepositoryPolicy.listOptions`. Exact Harness validation remains at
deployment. No approvals yields `[]`; closed Namespaces conflict. Classified optional
discovery failures map to `503 REPOSITORY_OPTIONS_UNAVAILABLE`.

`createRepositoryFields` searches up to 1,000 choices with 16 attachments.
`repositorySettings` resolves inheritance through RepositoryPolicyDriver; the database
checks bindings. Only fresh, empty drafts permit the classified outage. The approved
registry supplies GitHub choices; the native sender does not issue metadata credentials
or enrich choices with provider descriptions.

The form saves Configuration first and preserves it after known Agent rejections.
Retries reuse it; repository retries require a successful reload and nonempty reselection.
Failed reloads block creation; obsolete completions cannot change the view. Unknown
outcomes require stored Agent and Configuration reads.

`packages/occ/src/index.ts:OpenClawController.repositoryBindingSelections`
uses `resolveRepositoryBindings` after authorization. Without a repository Driver, save answers
`409 RESOURCE_CONFLICT`. Inputs contain distinct opaque
references and optional profiles, never provider tokens or caller-selected grant identities;
selections keep request order. The
`apps/controller/src/drivers/repo/github/policy.ts:GitHubRepositoryPolicy.resolve`
uses local registry policy, defaults omitted legacy profiles to `git-write`, and
makes no control-socket or GitHub calls.

`apps/controller/src/drivers/repo/github/credentials/registry.ts:resolveGitHubRepositoryBinding`
requires the exact Namespace/reference/profile combination. Its fingerprint binds provider,
App, installation, repository, duration policy, complete Namespace profile policy, exact permissions
and optional normalized push-ref allowlist. Each binding has one grant; installations can
supply several repositories. OCC stores normalized selections; an omitted update array
preserves them and an empty array clears them.

<a id="2-freeze-a-deployable-revision" class="anchor-alias"></a>

### 2. Freeze a deployable version

`packages/occ/src/index.ts:OpenClawController.admitRepositoryCredentials`
re-resolves the draft, validates Compute topology and freezes Driver identity,
grants and an absolute deadline unaffected by renewal or recovery.

`apps/controller/src/composition/repository-credentials/platform.ts:composeRepositoryAccess`
constructs `GitHubRepositoryPolicy`, with its ID pinned by the GitHub Backend's `repo`
member. Protected installations select `repository.preparedGitHub` and the installed
Sandbox/Credential Proxy Driver. OCC creates finite sessions without a native sender,
control socket, broker CA or session files.

Explicit `repository.nativeSender` selects `GitHubNativeRepositorySender` and requires
prepared GitHub custody. It owns session operations and files, receives no App key, and
cannot coexist with protected delivery. Controller startup rejects `drivers.repo` in
every mode, before it constructs a worker or allocates an attempt. Operators must
drain accepted work on the original owner before cutover.
Cleanup matches recorded owner identity without resolving policy or restoring authority.
The worker's prepared provider owns issuance and custody.

### 3. Record ownership before opening a session

`apps/controller/src/worker/repository-credentials.ts:RepositoryCredentialLifecycle.prepare`
rechecks actor, Namespace, Agent, revision, Driver, grant and deadline.
`GitHubNativeRepositorySender.checkAdmissionReady` checks broker capability with a
two-second timeout. Failure blocks fresh admission, not recovery or cleanup. Each fresh
OPEN carries `preparedOnly: true`: an old parser rejects it after socket replacement,
and current control requires a prepared backend.
Under the live claim and Namespace/Agent locks, State records immutable cleanup
context before calling the Driver. Stopped or deleting owners are rejected.
State stores identifiers and phases, never bearers or files.

`apps/controller/src/backends/repository-credentials/control-client.ts:UnixRepositoryCredentialControlClient`
sends the bound request over the private socket.
`apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts:createPreparedGitHubRegistryFactory`
resolves and compares its grant. The client validates status: `DISPOSED` permits historical
revoked/expired counts, but no outstanding obligations. Only a created response contains a bearer.
`apps/controller/src/drivers/repo/github/credentials/client/config.ts:encodeRepositoryCredentialSessionFiles`
encodes files; the worker records the session ID before passing them to Compute.

Confirmed open sessions yield `retained` bindings without files. `recoverOnly` finds or
fences unfinished admissions and closes recovered sessions. Fresh material requires
confirmed disposal or a missing opening without a recorded session ID. Invalidated known
sessions block replacement. Closing raises `REPOSITORY_CLEANUP_PENDING`, subject to Work
bounds and the revision deadline. Cleanup uses the configured interval while any session
closes. Otherwise, an unsettled obligation retains its code and retries at `age / 40`,
bounded by the configured interval and ten minutes.
`apps/controller/src/worker.ts:processRepositoryCleanup` logs
`worker.repository-cleanup-warning` with `cause` once per worker.

`apps/controller/src/drivers/repo/credentials/control.ts:createControlAdmission`
reserves before releasing material.
`apps/controller/src/backends/repository-credentials/receipt-store.ts:RepositoryReceiptStore`
retains fences and original-broker disposal evidence across service pruning.
Transport failure cannot establish absence. The receipt store matches
`preparedOnly` to protocol 3 throughout receipt operations. Unmarked v1 requests
can recover and close on their original IDs but cannot reserve.
`RepositoryCredentialLifecycle.verifyRelease` and
`apps/controller/src/drivers/repo/github/credentials/prepared-repository-git.ts:sessionQuery`
require protocol 3 for native release and prepared-material selection.
Protected sessions retain protocol 2. The query matches policy-reduction version 2
with execution admission v7. It retains the exact installed-plan, recipient,
standing-approval and session-lifetime checks before selecting prepared material.

### 4. Deliver and retain one complete runtime generation

`apps/controller/src/drivers/compute/kubernetes/repository-material.ts:repositoryMaterialSpec`
validates `new | retained` bindings against the version and hashes sorted
reference/session pairs.
`apps/controller/src/drivers/compute/kubernetes/repository-material-store.ts:RepositoryMaterialStore.prepare`
validates ownership, contents and deadlines before creating immutable Agent/version-owned
Secrets. It rechecks deadlines after requests and before creation or return; expiry
leaves Secrets for owned cleanup. For missing retained bindings,
`RepositoryCredentialLifecycle.repair` closes that subset, requires disposal and
retries Compute once. Missing inventory fails; pending closure blocks replacement
until disposal is confirmed.

`apps/controller/src/drivers/compute/kubernetes/repository-material.ts:repositoryMaterialDeployment`
mounts Secrets only in the first initializer. Sorted projections prevent key-order rollouts;
session replacement still rolls.
`apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts:REPOSITORY_MATERIAL_INIT_ENTRYPOINT`
validates the complete projection, then writes mode-0700 directories and
mode-0600 files in memory. `REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT` mounts the
private subPath at `/run/oce/repository-credentials`, avoiding the fsGroup-writable root. It calls
`apps/controller/src/drivers/repo/github/credentials/client/native-git.ts:prepareNativeGitConfiguration`
with private-file checks. Retry removes only a validated private `gitconfig`.
Both gate startup; the consumer mount is read-only. Metadata and gateway
bearers remain separate.

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.activateRevision`
replaces consumers when material changes, even within one version. Readiness requires
role, version, generation and current deadlines. Dedicated replacement preserves enrollment
and version-private storage.
`KubernetesComputeDriver.prepareRevision` rechecks material after plugin,
gateway and node observations; generation changes, lost readiness or expiry return incomplete.
Activation rechecks deadlines after final observations.
Dedicated gateways lack repository material and repository-gateway egress.
Both consumers trust CAs through `SSL_CERT_FILE`, `GIT_SSL_CAINFO` and
`NODE_EXTRA_CA_CERTS`; overrides fail.
Compute grants consumer egress; Helm admits consumers through
[credential-sidecar ingress selectors](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).
For [prepared native Git](../reference/repository-credentials/prepared-native-git.md),
`apps/controller/src/drivers/compute/kubernetes/repository-compute-ingress.ts:reconcilePreparedRepositoryIngress`
admits the revision's ingress peer only when the session's hostname, TLS port and
worker selector match the Helm-recorded broker Service. A mismatch refuses admission
without widening policy. Native preparation writes aggregate `gitconfig` without reading
bearers. System Git includes
`/run/oce/repository-credentials/gitconfig`, preserving HOME/global configuration.
Embedded `repositoryNativeConfiguration` keeps the `gh` router first in
`tools.exec.pathPrepend`. `AGENT_RUNTIME_ENTRYPOINT` sets Codex's
`allow_login_shell=false` and `shell_environment_policy.set.PATH`. Model authentication remains intact.
App keys, JWTs, installation tokens and the control socket never enter consumer material.
The [networking contract](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)
defines Codex plugin and repository-bound filesystem and proxy access, explicit denies,
and dedicated/embedded eligibility. Unbound policy, broker authorization and TLS
verification stay in force.

### 5. Authenticate native Git and route GitHub CLI commands

Stock Git owns commands, remotes, push URLs, worktrees and settings. Configuration
rewrites canonical HTTPS hosts to their gateway origin. The scoped helper checks host/path,
generation and deadline before supplying the bearer. `OCE_REPOSITORY_REF` disambiguates
bindings, not destinations. Local identity, hooks, aliases, overrides and other helpers
remain available; there is no whole-command preflight or egress confinement.
See the [routing limits](../reference/repository-credentials.md#client-routing-and-limits).
`pushRefAllowlist` selects image-owned hooks.
`apps/controller/src/drivers/repo/github/credentials/client/hook-dispatch.ts:checkPush`
checks every destination ref and rejects the whole push before updates, though discovery may
contact the service. It delegates original arguments and input to common-directory hooks.
Custom hook paths and API writes remain outside this
[best-effort guardrail](../reference/repository-credentials/push-ref-guardrail.md), which
also describes matching and linked worktrees.

`apps/controller/src/drivers/repo/github/credentials/client/router.ts:routeRepositoryClient`
routes supported `gh` commands using explicit targets or effective Git remotes. It pins
generation, reference and session, selects private `gh` configuration and preserves HOME
without changing shared selection.

See [draft creation from a prepared Git session](../reference/repository-credentials/protected-openshell-git.md#use-the-admitted-repository).

`apps/controller/src/drivers/repo/github/credentials/profiles.ts` owns the exact
Reader, Contributor and Collaborator permission maps. The GitHub route classifier admits
profile-selected REST operations and GraphQL limited by token permissions for all three.
Every GraphQL POST is a possible write; Reader's token, not a query parser, enforces its
read-only grant. See
[access levels](../reference/repository-credentials/access-levels.md).

The [service exchange flow](repository-credentials.md#4-reserve-acquire-and-dispatch)
enforces bearer, immutable repository/profile, capacity and deadlines, acquiring
fresh installation tokens under the same grant until the version deadline.

### 6. Maintain, recover and retire ownership

`apps/controller/src/composition/repository-credentials/transport.ts:bindRepositoryGitTransport`
calls `RepositoryGitBinding.reconcile` serially with 25-second abort signals and
one-second delays. Close aborts and joins. Independent readback settles the original
OCC delivery without reinstalling or restoring withdrawn access. OpenShell is unchanged.

The worker commits activation and next maintenance together, preserving the actor.
Maintenance uses 30 seconds, the selected native sender interval or a shorter Compute
interval. A missing known session is invalidated, never reminted after restart.
Users may deploy another version during cleanup.

If standing Git evidence is missing, the worker keeps Git closed and observes the existing
Harness without preparing or activating it. It checks again within five seconds, rechecking
model authority, withdrawal, stop and replacement each pass. Harness readiness is not Git
authority. See the [standing worker integration test](../../tests/integration/postgres-standing-session-worker.test.ts).

`apps/controller/src/worker.ts:ControllerWorker.processRepositoryCleanup` consumes
owner-bound Work without admission or material delivery. Terminal-runtime Work fences
attempts, closes sessions and calls `stopRevision` for the original version, preserving
its replacement. Compute mismatch or stop failure remains retryable beyond foreground
limits. Completion requires session disposal and runtime retirement; `CLOSED`, missing
inventory and invalidation do not prove disposal. Retained attempts survive version deletion.

`ControllerWorker.withdrawExpiredRepositoryAccess` retires the original version for IAM
refusal, confirmed actor or Agent-principal absence, required model-source withdrawal,
or unsupported Git withdrawal. Model withdrawal precedes Gateway readiness.
Failed reads stay pending unless independent facts prove authority loss. Optional withdrawals
cannot justify retirement. Maintenance recovers exhausted original and companion source work
through `recoverPendingCredentialWithdrawals`, preserving outstanding work and manual-replay
holds. The v7 reducer observes stored operations without reapplying.
See [tests](../../tests/integration/postgres-standing-expiry-authority.test.ts).

`ControllerWorker.processAgentDeletion` retires Compute and queues cleanup without waiting
for sessions. Cleanup uses its version key for dispatch and audits.
`PostgresWorkQueue.completeAgentDeletion` calls `occ.finalize_agent_deletion` under the claim
to detach attempts, delete live rows and audit deletion atomically. Attempts and cleanup
survive without fabricated disposal. Unresolved provisioning effects defer completion
without consuming retries.

Compute retirement waits for owned Pods to stop before removing material. It preserves Secrets
referenced by Pods and current Deployments, and limits deletion to exact ownership with UID
preconditions. Stop removes only the stopped version's route and preserves newer shared
resources. Route and Deployment deletion require the observed resourceVersion. Shared cleanup
remains retryable after partial failure; service restart cannot prove remote token revocation.

## Debugging and Verification

Compare `occ agent get AGENT_ID --output json` with the admitted `activeRevisionId`.
Inspect worker events for
`REPOSITORY_BINDING_CHANGED`, `REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED`,
`REPOSITORY_SESSION_RECOVERY_UNSAFE`, `REPOSITORY_CLEANUP_PENDING` or
`REPOSITORY_CLEANUP_COMPLETE`. Check registry identity and deadline before retry.
A cleanup that stays pending logs `worker.repository-cleanup-warning` with its
`cause` once.

`repository-not-admitted` means an unselected target; `name-one-repository-target`
or `name-one-repository-ref` requires explicit selection. Inspect metadata
and Pod generation without printing credentials.

The [test guide](../testing/repository-credentials.md) distinguishes lifecycle,
installed-runtime and live-provider proof. The
[image volume case](../testing/docker.md#repository-runtime-volume-test-environment)
checks Docker mounts; Helm checks rendered ingress. Neither proves CNI enforcement.
Console recordings cover fixture/API behavior, not model, Slack or GitHub execution.
The registered Driver test pushes two commits to one draft PR at a local provider.
On the same Agent revision, the shipped Codex client completes a turn before and after Git
withdrawal. On a team installation, verify that the Agent updates the PR itself, Git is
denied before reaching the provider, and chat continues.

## Related docs

- [Repository credential reference](../reference/repository-credentials.md)
- [Install repository access](../guides/repository-credentials/installation.md)
- [Create and use a repository Agent](../guides/repository-credentials.md)
- [Controller worker lifecycle](controller-worker.md)
- [Credential service execution](repository-credentials.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-24 22:30: Name the missing repository Driver. (fix-2361-2362 - 476c1b350)

- 2026-10-22 06:30: Preserve independent authority facts and source recovery. (authoring-run/3ab680f7-bea5-4377-bb8c-14e6b81c49b4 - 221dff2ff7985a19cd34dad392d68cf5549e1136)

- 2026-10-22 06:08: Distinguish definite authority loss from unavailable expiry evidence. (authoring-run/0070b799-5882-41af-9b5a-de66c2b5bd4c - 21efaa2ac0a04eb86cc45062522b5ca7551747fd)

- 2026-10-22 05:40: Tighten the flow while preserving lifecycle boundaries. (authoring-run/6a3ac3a3-9ca1-4fe8-a71e-ce0445cc7840 - 6abb03f892181bfe093472a4721b8428659d245b)

- 2026-10-22 05:05: Match reducible protected Git sessions to admission v7 in prepared-material selection. (authoring-run/8df2bc1b-5c23-4628-8351-ed2e23b279bf - 4c2054cd056be2d70b6343babeeea411d6aaf873)

- 2026-10-22 04:11: Trace selected registered delivery reconciliation. (authoring-run/13ded5bb-8707-46f5-8aa3-7a334529d124 - f4a2ca6139625059f1f8c58855f6343864ee7528)

- 2026-10-22 02:32: Require prepared authority at native OPEN, durable receipt and release; reject legacy controller selection. (authoring-run/b8149a96-d1dc-4681-8930-7d5434fbf1e3 - 2fca4e18d905f7bf760d0da70cb916f20186169e)

- 2026-10-21 22:49: Separate repository policy, protected composition and explicit native session ownership. (authoring-run/fb0df3aa-3a65-40ec-9da0-20de1db91b2f - 41137910011b9c4fc1a713b234a92c87a6717e3f)

- 2026-10-21 22:10: Document standing Git supervision with the accompanying uncommitted worker change. (authoring-run/5f4d0dab-1a03-4fa9-a469-a8778c8ad3d4 - 390a3627b97535f4d21107001efda8af6152355d)

- 2026-10-17 06:00: Keep joiners in words and emoji and the three subdivision flags in repository descriptions. (lows-1017h - 49397a014)

- 2026-10-17 05:00: Replace invisible and bidi characters in repository descriptions; escape them in the picker. (lows-1017g - 3a02bef00)

- 2026-10-17 00:15: Preserve Unicode repository descriptions across truncation and discovery. (authoring-run/f538c999-f9bf-4549-ba36-19dca6101420 - 42fb0a90337209e28318765c1b537bc4f3623506)

- 2026-10-16 21:13: Restrict prepared Git draft body input to explicit text; bind prepared Git session origins to the Helm-owned broker Service before ingress admission. (authoring-run/97826393-386f-4988-ace7-afc669f1922f - dac53babe; authoring-run/c21f74f4-95aa-4ba6-878d-84586bd6ecb7 - d2200df9a)
- 2026-10-12 07:39: Recovery fences a reserved receipt whose fence did not commit. (authoring-run/aee1dd2c-5ac0-4499-aaf6-a4c36928423e - b195e54e9b0ce98ead2b2306015a5209325e837b)

- 2026-10-03 16:30: Log a stuck repository cleanup's cause once and slow its rechecks with age. (fix-repo-cleanup-backoff)
- 2026-10-01 17:20: Point the safe version response projection at its Agent HTTP owner. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-09-30 05:21: Deliver broker CA settings to both repository consumers. (01a0ed9e-6c22-7671-9ee1-a58e1df39acd - ab0a1838)

- 2026-09-30 03:57: Recheck material deadlines. (authoring-run/00e5c01e-b8c9-46df-a8ac-45aa0e6932da - 5334a55faf3ced4bf9e0971daad6fd34ad2fe982)

- 2026-09-29 20:00: Trace repository descriptions, inheritance and overrides. (public-pr/374)

[Agent repository credential documentation history](agent-repository-credentials/history.md) preserves the older dated entries.
