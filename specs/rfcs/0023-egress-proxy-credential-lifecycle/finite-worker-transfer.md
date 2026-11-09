---
rfc: index.md
---

# Proposed amendment: transfer finite Git authority to a replacement worker

**Part of RFC-0023; proposed and not implemented.** Request human architectural
review before implementation. This amendment preserves the earlier decisions in
this RFC and changes none of the current release requirements by itself.

## Decision requested

Let the existing OpenShell Git owner transfer one previously released, still-valid
finite `online-request` admission to a replacement worker. Preserve the same Agent
revision, execution, binding, credential material and absolute deadline. Transfer
requires durable evidence of the original launcher's acknowledged release,
independent verification of the current recipient, and atomic fencing of the old
owner against withdrawal and request authorization.

This is an extension of the existing route lifecycle, not a new credential service
or an upgrade-orchestration operation. It neither grants standing approval nor
renews, reissues or widens a finite grant. The
[restart preflight proposal](https://github.com/openclaw/openclaw-enterprise/pull/4999)
reports whether a worker can be stopped; it does not perform this transfer.

## Current boundary

At `1f2246768b293bc2efdf5ce56750c0fb29a1b676`,
[`OpenShellGitRuntime`](../../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts)
requires the original launcher for selected held Git launches. A replacement takes
the route fence with `close-preview`, records `worker_replaced`, and refuses to
adopt that authority. The [current operator contract](../../../docs/reference/repository-credentials/protected-openshell-git.md#route-state-restarts-and-recovery)
requires a new revision for those paths.

The [route store](../../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts)
retains identity, custody/delivery metadata, fence, installed material version/attempt
references and recipient observations, never token values. Its retained
launch hash can be established during
[installation observation](../../../apps/controller/src/drivers/egress-proxy/openshell-git-installation.ts),
before final release. `releasePreview` separately checks the exact `startupId`
and delivery acknowledgment, then sets `release = "acknowledged"` in memory.
The [Sandbox observation](../../../apps/controller/src/drivers/sandbox/openshell.ts)
also requires that acknowledgment before treating an authenticated serving socket
as the released execution. A v5 runtime conformance test observed a successful release callback.
The route-store fixture held identical delivery records before and after the
acknowledgment, so a replacement reading that record cannot tell whether the
original worker received it.
Neither the hash nor a surviving Pod proves release.

The existing [standing-approval recovery proposal](github-installation-access.md#let-a-team-keep-git-access-until-it-removes-approval)
and the older [credential-service restart scope](../0008-repository-credentials/restart.md)
do not authorize recovery of this finite held-launch authority.

## Proposed ownership and transition

The existing OpenShell Git runtime and route-store adapter own release evidence
and recipient verification. OCC's existing credential-delivery and repository
authority owners retain custody, deadlines, withdrawal and per-request checks.
The paired Sandbox supplies current execution observations. No generic Compute
adoption flag, caller-supplied proof or new public endpoint can grant access.

### Record the original acknowledged release

Store a write-once, nonsecret acknowledgment on the existing OCC credential
delivery. Only the original worker holding the current route fence may record
that it received the launcher's exact release acknowledgment. Record the original worker
and fence, and bind the acknowledgment to the startup, Namespace, Agent,
revision, execution, binding, admission, recipient observation, provider generation and installed material
version/attempt. Preserve the original finite deadline and applicable token expiry.
It is evidence about that release, not a reusable permission to launch again.

Commit the evidence under the same authority and withdrawal checks that guard
route use. A late acknowledgment from a fenced or withdrawn owner cannot restore
access. Do not infer acknowledgment from a launch hash, readiness, a socket, a
successful earlier Git request or the absence of a pending write.

A crash after sending release but before recording its acknowledgment leaves no
transferable authority. Do not resend release, repeat an uncertain provider write,
or mint a replacement token to repair that gap. If a commit reply is lost, reconcile
the exact durable record; absence or uncertainty keeps Git closed. Legacy records
without this evidence remain ineligible, as do already blocked or expired routes.

### Verify the current recipient, then transfer ownership

A successor starts closed. It independently verifies the current workload and
supervisor, process/network identity, effective policy, mandatory request hook and
exact installed generation/material against the original evidence. It does not
substitute the current Agent draft, a different supervisor or another admission.
Missing or inconsistent observations, an uncertain provider operation, or an
unsupported profile cannot produce a positive result.

After observation, the proposed PostgreSQL transfer transaction must validate the
expected original worker and fence against the delivery and verify that the
replacement holds the live work claim for this revision and operation. After
activation, that means checking the applicable maintenance claim. The queue's
claim token alone does not identify the replacement worker. Recheck the
release record, admission and deadlines in that transaction before moving ownership.
Losing the claim after observation but before commit must leave the fence unchanged. Serialize this transition with binding withdrawal,
Agent stop/replacement and per-request authorization. Only the successful successor
may authorize new requests; competing successors and the old worker must fail their
fence checks. Observation alone never opens the route.

This requires an extension: the current
[`CredentialDeliveries.adopt`](../../../packages/occ/src/state/credential-deliveries.ts)
advances an open row without comparing an expected predecessor owner/fence.
In an experimental two-session PostgreSQL race, both contenders observed fence 1.
Exercising unrestricted adoption directly on the open delivery
let the first contender take fence 2 and the loser advance it to 3. A prototype
that compared the expected owner and fence left the winner at fence 2. The
shipped replacement path closes the route. The experiment isolates the race
that a transfer implementation would introduce if it simply removed that closure.

Withdrawal that commits first prevents transfer. Withdrawal after transfer denies
the next authorization even if GitHub still accepts the token. An operation already
authorized may finish: online authorization is not an exact send receipt and cannot
recall an in-flight push. No uncertain Git operation is replayed. A later observation
failure closes Git under existing rules; independently authorized chat is not
implicitly withdrawn.

The transfer preserves the exact finite admission, scope, material and original
deadline. It performs no issuance, installation, renewal, release delivery or
redeployment. At the earliest applicable expiry, access ends under the existing
lifecycle; a worker restart never extends it.

## Delivery and required proof

Keep current refusal until the complete transition is implemented and qualified.
An implementation plan must specify the acknowledgment fields and the lock order
shared by delivery, work claim, withdrawal and request authorization.
Update the current reference and flow only when behavior changes.

1. Exercise separate original and replacement worker processes over real
   PostgreSQL through the ordinary repository lifecycle. Demonstrate a successful
   transfer with unchanged admission/material/deadline, stale-owner and competing
   successor refusal, and no new issuance or release. Include crash after release
   send, after acknowledgment receipt but before durable commit, and lost commit
   response. Include a historical delivery with no acknowledgment field. Check
   that historical and uncertain releases remain closed and that recovery never
   duplicates a release, provider write, token issuance or Git operation.
2. Race transfer with withdrawal, stop and request authorization at controlled
   transaction boundaries. Lose the successor's reconciliation claim after recipient
   observation but before commit: require no fence move or new authority. Check
   changed predecessor owner/fence, recipient/policy, pending provider writes,
   expired deadlines and old records. No race may revive a withdrawn route or allow
   a stale owner to authorize a new request. Controlled peers prove only their
   protocol boundary; they do not replace installed verification.
3. Exercise the proposed two-Agent installed transfer case. The [revocation scope decision](https://github.com/openclaw/openclaw-enterprise/pull/5016#issuecomment-6730327462)
   assigns B's positive Git read after replacement to this amendment. Finish this
   case while both original finite grants remain within their deadlines. After a genuine worker replacement, Agent A's removed binding
   gets an exact `access_withdrawn` denial attributed to the named replacement
   worker. A generic 403 or `no_binding` does not qualify. Controlled origin probes
   confirm that A's original credential remains accepted before and after the
   refusal; A's denied Agent request produces no origin request, and no new
   credential is issued. Agent B's fresh protected read uses its original credential
   and execution. Both execution identities remain unchanged, and A receives the
   next reply in the same conversation before those deadlines. Do not substitute a
   redeploy, standing profile or direct origin-token probe for B's protected read.
4. Separately prove natural expiry: access ends at the original finite deadline
   after transfer. Neither the transfer nor this separate expiry case may extend
   that deadline or replace the pre-expiry withdrawal proof.

The PostgreSQL experiment covers competing ownership updates. Successful
transfer through the installed Worker and Git request path remains unproven.

## Alternatives and review questions

Retaining the current refusal and requiring an authorized new revision is safe,
but interrupts B despite its otherwise valid finite admission. Merely removing
`close-preview`, trusting a launch hash, or retaining the old worker does not prove
cold replacement. Converting the grant to standing approval changes its duration
and is outside this proposal.

Should OCC record the original release acknowledgment once on the existing
delivery and transfer that delivery only when the expected original worker and
fence, the replacement's live claim and the independently observed recipient
all match? OpenShell Git, credential-custody and authorization reviewers should
confirm the transaction boundary with withdrawal and per-request checks. Sandbox
reviewers should confirm which live observations identify the same recipient.
Broader renewal redesign, new trust modes and changes to running installations are outside
this amendment.
