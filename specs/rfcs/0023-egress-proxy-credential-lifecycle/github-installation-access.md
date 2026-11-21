---
rfc: index.md
---

# GitHub installation access through the online OpenShell sender

**Part of RFC-0023.** This proposal makes installation-wide access and standing team approval separate, explicit choices. It preserves existing finite grants and does not claim that stock OpenShell meets all of the online qualification requirements.

## Decision

Let an Installation operator grant an Agent the GitHub App installation's actual repository and API permissions. OCE owns admission, the App signing key, issuance, current authorization, withdrawal and retirement. OpenShell remains the only sender and owns credential injection. No separate public Git relay, personal access token or secret in the workspace.

The current prepared Git mode issues a token for one repository, checks one writable ref, and permits one controlled draft. It cannot support routine multi-repository engineering, issues or arbitrary review branches. Keep that mode unchanged. Add a distinct installation-wide policy; never infer it from a missing ref or a wildcard. A Namespace policy and an explicit Agent binding must select it. Changing mode changes the grant fingerprint and requires a new revision and installed material. Do not adopt an earlier narrow token or widen an existing execution on restart.

For installation access, issue a GitHub installation token without `repository_ids` or permission overrides, so GitHub's App installation remains the permission ceiling. Validate the returned token, expiry, repository selection and permission response according to the issuance mode; retain cleanup ownership for rejected or uncertain issuance. The existing single-repository validation remains strict. Separate installation-wide material from narrow material in durable identity, validation and retirement. Never expose installation-wide material through the native repository broker's token-returning operation.

An admitted Agent may use Git smart HTTP for reads and writes on github.com and the ordinary GitHub REST and GraphQL APIs on api.github.com (including the GraphQL operations used by `gh`). No OCE branch, PR-head or draft-only filter applies in this mode; GitHub's installation permissions, branch protection and repository rules still apply. Public Git reads and public REST reads may use the same token. GitHub's exact handling of an explicitly narrowed token on unrelated public repositories is not assumed. For the installation-wide mode the operator has deliberately authorized every private repository the App can access as well. This is **not** a public-only guarantee.

Use a GitHub-host-scoped credential helper and the existing nonsecret OpenShell marker, support ordinary Git and `gh`, and enforce verified HTTPS, the admitted sandbox/installed generation and a current OCE grant on each request. Never inject on another host or redirects to it. Reserve token issuance/retirement to the credential owner; do not expose the App JWT, token endpoint or a generic proxy. Do not interpret a failed or truncated middleware body as an approved operation; document transport size limits and qualify actual pack traffic. API operations may have external effects: an allow is not proof of delivery, and ambiguous writes must be reconciled rather than automatically retried. The existing one-draft receipt is not an installation-wide API deduplication mechanism.

A later independently selected **public-read-only** policy must not inherit installation-wide private reads. It needs an enforceable public-visibility boundary (or material demonstrably unable to read unapproved private repos), read-only methods including Git upload-pack, and the same OCE/OpenShell sender. Merely permitting GET or checking that GitHub returned 200 does not establish public visibility. Do not advertise this narrower policy until tested.

## Acceptance

- Default and existing bindings preserve current narrow issuance, ref and draft restrictions. Unbound or withdrawn executions fail closed, even with a still-valid provider token. Switching modes cannot reuse another Agent's or revision's material.
- From one installed Agent, read an unrelated public repo via REST and Git (including an object transfer); read/write an installed repo and open/update a normal PR and issue. Use controlled repositories for API mutation and branch-protection denial. No forced merge or bypass.
- Verify GitHub refuses a private repository outside the installation. Report actual authenticated REST rate-limit accounting separately from Git traffic. Verify credentials never reach a different host, including redirects.
- Retain stock middleware/transport qualification limits. Separately measure maximum viable Git/REST/GraphQL request sizes. No credential-free fallback or second egress route is introduced by this change.

## Let a team keep Git access until it removes approval

A team installs an Agent on Monday and fetches new commits in the same conversation on Tuesday.
An authorized team member approves that access once. OCE keeps the approval until it is removed
and prepares short-lived GitHub installation tokens as needed. The team does not renew approval
every hour, deploy a new Agent revision, or give the Agent a long-lived token.

**Approval duration and GitHub permissions are separate choices.** Keep the current finite grant
and its absolute deadline as the default, including for every existing binding and stored session.
Offer an explicit _until removed_ choice only to a principal who may grant that duration and scope
under current Installation and Namespace policy. Show who approved it and how to remove it.
Record the choice, approval ID and generation, and the exact team Namespace, Agent, binding and grant:
GitHub App, installation, repository selection, allowed refs and API permissions. A team can keep
access to one repository and review branch without granting installation-wide access. Missing or
unrecognized duration cannot select standing approval. Do not encode it as a distant deadline.

**Admit the execution.** The OpenShell Git trial requires a repository broker session and excludes
`credential_proxy`. For new protected Git admissions, select the
[Driver's Sandbox and Credential Proxy capabilities](contracts.md#select-sandbox-and-credential-proxy-from-one-driver).
OCC establishes successive finite sessions under the same approval. Before
preparation or installation, check approval ID and generation, current policy, grant, active Agent
revision and verified execution. Admit, renew, authorize and withdraw without a repository broker,
control socket, session bearer or broker receipt.

**Authorize the Git operation.** Repo defines repository, ref and operation constraints. The
Token Service prepares short-lived tokens in the background. Credential Proxy binds the actual
request and signed sandbox identity to this execution. Before allowing it, check current OCC authority
and the exact installed token attempt, version and expiry. In that transaction, record possible use
and consume any applicable draft allowance. Serialize with withdrawal and replacement. Bound the allow
by the earliest applicable deadline. With [online authorization](online-authorization.md), OpenShell injects the
credential and sends. Keep the conversation usable across renewal and report any Git interruption.

**Stop using the approval.** Commit removal and advance its generation before acknowledging it.
Deny the next authorization even while GitHub would accept the token. Stop preparation, detach
the Git credential and retire issued material through the existing [withdrawal protocol](protocol.md#withdraw-and-recover).
Report those outcomes separately. An already authorized request can still arrive; removal cannot
erase a clone, undo a push or recall a bearer token. Policy loss also denies new use. Stopping the
Agent closes that execution's authority. An explicit resume needs a fresh admission against approval
that is still current; neither resume nor replacement can adopt a stopped or revoked execution's grant.

**Recover without restoring old authority.** A worker restart may resume the same approval and
verified execution. Record the owner, approval generation and attempt before issuing or installing a token.
An identical operation returns its recorded outcome. Commit a result only while that owner and
generation are current, so a late writer cannot undo removal. After a lost reply, inspect that attempt; never repeat an
uncertain mint, installation or Git write. If OCE cannot establish current authority and eligible
installed material, deny Git and report what needs recovery. Granting access again creates a new
approval generation; restart, policy restoration or token renewal cannot revive a withdrawn one.

Give this path a distinct admission. Fence the old owner and settle overlapping custody before
issuance. Old receipts cannot grant access. Preserve spent or possibly spent draft allowances by
grant across migration and renewal; if uncertain, deny another create. Dedicated Kubernetes Codex
without a Sandbox can still select native Git, where the broker authorizes and sends. Never fall back to it.

### Hand off a standing Git session during a planned controller update

**Proposed decision.** Allow a serving worker to transfer an Agent’s current OpenShell Git session
during a controller-only update. Start with one selected repository. Preserve its operations, ref
and draft limits, Agent revision, execution, material and deadlines. The [current upgrade helper](../../../docs/reference/repository-credentials/worker-replacement.md)
refuses to stop a required original worker. Its ordinary update stops both API and worker Pods.
The first qualifying pair needs compatible storage and two builds that can overlap while the Agent
serves. An incapable incumbent still requires refusal or an authorized interruption.

Use the protocol proposed for [finite Git grants](https://github.com/openclaw/openclaw-enterprise/pull/5005).
The launcher acknowledges release of the exact startup. Its fenced worker durably binds that
acknowledgment to the delivery, execution, recipient and material attempt. While the incumbent
serves, the candidate independently verifies the same running recipient and its route. On a failed
check the incumbent can continue only while it holds current authority.

The credential-delivery owner must order transfer with retirement, renewal, approval or policy
changes and request authorization. After lock waits, recheck the maintenance claim, revision,
open session and admission, approval ID, generation and scope fingerprint, effective grant, eligible
material and deadlines. Advance the expected predecessor fence once. After an uncertain commit,
read back the owner and fence before proceeding. Only ordinary standing renewal may open a successor
session or issue replacement material.

At the final credential-use check, validate current authority and fence after any wait. A request
authorized before transfer cannot redeem on the old fence afterward. Route fresh requests to the
successor. Keep the predecessor’s serving path alive until exchanges already past that check
settle. They may complete after withdrawal. Preserve spent or uncertain draft allowances. If the
origin outcome of a write cannot be established, report it as unknown and never replay it.

**Installed acceptance.** Replace the actual controller with a distinct build. Keep a conversation
stream and Git exchange open through cutover. Require one terminal reply on the original connection
and continuation of the same conversation. Sample fresh requests throughout. After the fence moves,
fetch a new private object through the normal Agent route on the first attempt. Correlate the
origin response with the successor worker, new fence, original execution and material. Verify
unchanged Gateway and Sandbox identities. For a writable binding, keep a permitted push in flight
past its final credential-use check as the fence moves. Count one attempted push at the controlled
origin and verify one ref change. Verify a forbidden ref stayed unchanged. Set request deadlines
and the maximum allowed observation gap before the run. Record client timestamps, failures, retries
and the largest actual gap. A gap above that limit leaves continuity unverified. Exercise withdrawal during
transfer, stale redemption, a replaced recipient and lost commit response. Qualify ordinary renewal
after the original deadline separately. Availability between observations remains unmeasured.

### Keep supervising a running Agent when Git cannot be verified

For an active Agent execution admitted under standing approval, with no retirement intent, OCC continues
normal Harness and model-authority supervision when Git evidence is pending or missing. Deny Git
until current authority and eligible material are established. Missing evidence alone does not
establish withdrawal, stop or replacement, or end independently authorized chat.

Compute may offer an optional, read-only `observeRevision` for the exact revision and execution,
reusing `Sandbox.observeHarness` where available. It reports observations; it cannot create, adopt,
attach, repair or release work, prepare material, grant credentials or reauthorize anything. A Driver
without it gains no new assurance. Pod readiness does not prove identity or authority.

OCC durably schedules a bounded next check when evidence is inconclusive, including after restart.
Apply confirmed replacement, explicit stop and withdrawal of Git or model authority under their
rules. Verify repeated missing Git evidence while normal Harness and model supervision continues;
distinguish observation from authorization.

### Report repository execution that cannot resume

Propose an explicit terminal result on the existing read-only
`ComputeDriver.verifyRepositoryExecution` and `SandboxRepositoryAccess.verifyExecution`
contracts. A Driver may throw OCC's `RepositoryExecutionRequiresRedeployError` only when
it has durable evidence that repository authority cannot resume on this execution.
Missing evidence, a timeout, an unavailable dependency or absence of local process state
is not that evidence: those paths keep their current unknown/retry behavior.

The OpenShell implementation uses this result for a held launch whose exact persisted
binding, owner and unchanged fence establish replacement by a worker that cannot inherit
that launch. The verification remains read-only. It does not adopt the route, issue
material, relax recipient identity or authorize an uncertain provider write.

OCC revalidates its claim and the active revision under the existing ownership locks.
In one transaction it closes repository admission, registers the existing standing
withdrawal obligation and completes the originating maintenance work with
`REPOSITORY_EXECUTION_REDEPLOY_REQUIRED`. Subsequent workers continue withdrawal and
independent runtime supervision, rather than retrying Git renewal. The existing cleanup
owner retains or retires the runtime according to its actual evidence; this result does
not by itself prove that model execution can safely continue.

The authorized deployment-detail read projects this exact revision-bound outcome as
optional `repositoryAccess` with state `redeploy-required`, the fixed code and recovery
guidance. It preserves the historical deployment status and exposes no provider payload
or credential. An absent field does not prove current Git availability. No new endpoint,
resource, table or permission is introduced.

Use the typed result rather than a general retry limit: an outage must remain recoverable.
Verify a real worker and OpenShell runtime-owner replacement over PostgreSQL, no new Git
issuance, durable recovery guidance across another restart, and unchanged transient
recovery. This amendment remains proposed.

### Prove the same Agent can still fetch after the old deadline

1. Install without the repository broker. Grant standing access once. Use a controlled private
   repository that denies anonymous reads; fetch a known object into an empty object store.
   Record Agent, revision, execution, conversation, approval generation and material version.
   Reuse existing push and pull request evidence.
2. Wait past both the first session's expiry (one hour for the former default) and the first token's
   expiry. In the same conversation and repository, fetch an object absent locally and verify its ID.
   Record actual elapsed time, both deadlines, unchanged identities, the successor session and a
   different token version installed under the original approval. A shorter controlled-clock test
   complements this run. An allow decision alone cannot identify the token OpenShell sent.
3. Remove approval while the latest token would still be valid. Show a fresh fetch denied before any
   provider request, and a reply in the same conversation if chat remains authorized. Also cover policy
   loss, stop and explicit resume, replacement, stale renewal and finite grants expiring on schedule.
   At controlled transaction boundaries, race withdrawal with installation and authorization. Lose
   an issuance, installation or send reply and verify no second attempt. Qualify a released,
   unmodified OpenShell against the [online release requirements](online-authorization.md) before offering
   mandatory online authorization. The
   [operator-controlled preview](online-authorization.md#preview-the-configured-request-hook)
   is a separate admission, not evidence that this release requirement passed.
