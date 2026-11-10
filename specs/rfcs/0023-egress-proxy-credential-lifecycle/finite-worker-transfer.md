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

A PostgreSQL storage experiment used an experimental nullable delivery field and
synthetic authority. After restart, a read-only transaction found the committed
acknowledgment. After an uncommitted write was abandoned, recovery found no
acknowledgment. An identical write was idempotent, and conflicting startup or deadline values were refused. This
establishes storage behavior only. If the launcher reply is lost, or no exact
record survives, keep Git closed. Reconcile an uncertain commit by reading the
record and rechecking authority. Never replay release, provider writes or Git.

### Verify the current recipient, then transfer ownership

A successor starts closed. It independently verifies the current workload and
supervisor, process/network identity, effective policy, mandatory request hook and
exact installed generation/material against the original evidence. It does not
substitute the current Agent draft, a different supervisor or another admission.
Missing or inconsistent observations, an uncertain provider operation, or an
unsupported profile cannot produce a positive result.

A replacement in the scheduled maintenance pass must present the live claim for
this revision and operation. The queue token identifies a claim. The worker's
selected Git runtime identifies the successor. After lock waits, check both,
the expected predecessor and fence, the original acknowledgment, admission,
withdrawal and database-time expiry before moving the fence. The existing
[`CredentialDeliveries.adopt`](../../../packages/occ/src/state/credential-deliveries.ts)
can advance the fence twice when two contenders observed the same predecessor.
A conditional update comparing that predecessor allowed one winner.

A real PostgreSQL experiment ran two worker instances sequentially in one
process with synthetic deliveries. After ordinary reconciliation finished, the
replacement claimed scheduled maintenance and advanced its delivery from fence
1 to 2 once. A different Agent's claim, withdrawal committed during a lock wait,
and a claim that expired during a lock wait all left the predecessor in place.
The experiment performed no protected Git request. The deployer permission check
read IAM separately from the fence update. Authorization owners must specify how
participating permission writers, transfer and request checks serialize before
relying on that check during replacement.

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

Pair the installed positive in case 3 with a real restart of the protected
process under the stock workspace launcher. For the positive, verify the admitted
sandbox and execution, restart policy and count, main instance and start time,
workload Pod and container, recipient evidence above, and authenticated serving
through that sandbox's bearer-passthrough service. For the negative, keep the
outer identities and original grant, restart just the protected process, and
observe its new held startup ID. Require refusal before the fence moves, with no
second release, Git authorization or origin request.

The stock workspace launcher holds each replacement at a fresh startup ID. A
controlled launcher probe rejected the previous release there. Separately, an
independently started listener outside that launcher reproduced the serving
probe's responses. The serving check alone cannot identify a particular
descendant. Neither probe exercised the complete installed transfer. Qualify
the stock pair first. If hostile in-sandbox listener substitution is in scope,
evaluate whether it can pass the complete checks and obtain a protected read
before proposing a new challenge.

## Alternatives and review questions

Retaining the current refusal and requiring an authorized new revision is safe,
but interrupts B despite its otherwise valid finite admission. Merely removing
`close-preview`, trusting a launch hash, or retaining the old worker does not prove
cold replacement. Converting the grant to standing approval changes its duration
and is outside this proposal.

The existing human review owns the decision. The proposed division is for OCC
to record the original startup acknowledgment once on the delivery, OpenShell
Git and Sandbox to qualify the stock recipient checks, and repository
authorization to order permission changes with transfer and request checks.
Every path preserves the original finite deadline. Installed transfer and
protected Git use by a successor remain unproven.
