---
rfc: ./index.md
---

# Change download access for a running protected Agent

In the Admin Console, open the running Agent’s network policy and enter a hostname.
For a shared host, also enter the exact archive path. Choose **Allow download**.
As soon as the policy shows **Applied**, retry the
download in the same shell. **Remove access** withdraws the grant on that Agent.
Neither action deploys a revision, restarts a workload, or requires a second
save or apply. This amendment proposes those actions for a qualified protected
Sandbox and Credential Proxy pair in restricted mode.

## Who may grant access

Today the [Agent policy flow](../../../docs/flows/agent-sandbox-policy.md) supports
live updates for unprotected revisions. OCC rejects ordinary additions for
protected revisions. Its Installation delegation ceiling is copied at controller
startup. Removing the protection check would let the ordinary policy compiler
replace network rules that the protected pair owns. Asking operators to edit
that ceiling in Helm for every new host also defeats the Console workflow.

An already running Agent can adopt the feature in place if its installed pair
supports the contract and can verify the same complete protected baseline
against its admitted revision. Otherwise the Console explains which capability
or evidence is missing and leaves the Agent running.

At Installation setup the operator enables protected download editing and sets
its hard limits, including exclusions and eligible downloader executables. Within
those limits an Installation administrator with the exact Agent and SandboxPolicy
permissions can authorize a previously unseen public DNS name for **this Agent**
in the same Console action. Persist the administrator’s exact approved scope
on that Agent’s SandboxPolicy as its delegation ceiling. A delegated editor can
enable or disable downloads within that approval or existing Installation
delegation. Only an authorized administrator can expand the Agent’s ceiling.
The Console distinguishes disabling a grant from withdrawing its delegation.
Withdrawing approval also removes any grant that depends on it. Neither action
widens another Agent’s ceiling. This proposes new admission behavior under
existing IAM. It does not depend on the [proposed Guardrails override](https://github.com/openclaw/openclaw-enterprise/pull/2968).

OCC checks editing, Agent `manage_policy`, SandboxPolicy `read` and `update`,
and Installation administration for new delegation. Check the expected policy
version and active revision together. Record the actor, scope change and
application identity in the existing mutation audit. The worker rechecks
authority, current limits, placement and active revision before effects.

## What the destination permits

- A hostname selects verified HTTPS on port 443 for credential-free GET and
  HEAD by approved download clients. Match an exact public DNS name and enforce
  the method on each request. Refuse wildcards, raw IPs, private or metadata
  destinations, overlapping managed routes, and destinations already reachable
  through another policy that would defeat withdrawal. Preserve DNS and peer
  protections when names resolve again. Expose no credential selector,
  upstream header injection, general CONNECT tunnel, write method or TCP rule.
- An operator may explicitly admit plain HTTP on port 80 for a Debian mirror such as
  `deb.debian.org` when the distribution’s configured package sources require
  it. Keep APT’s signed repository metadata and package hash verification enabled.
  The UI shows HTTP and the port. A normal hostname grant cannot downgrade TLS.
- On a shared host such as `storage.googleapis.com`, require the exact verified
  object path for the toolchain or browser archive. Inspect the canonical path
  and method. A sibling object or bucket-wide prefix must be denied. Recheck
  each redirect hop against its own scheme, host, port and path. A redirect
  cannot authorize a second destination. Where a service supplies signed query
  parameters, keep those values out of policy, UI history, audit and diagnostics.

The Installation chooses eligible mirrors and shared-host objects. These examples
confer no built-in exception for either domain.

## Apply and confirm one policy version

One versioned SandboxPolicy mutation saves desired grants and enqueues their
application to the exact active AgentRevision and Sandbox through the existing
durable work queue. The Driver pair reconstructs the complete protected policy
from admitted revision and validated runtime bindings, adds only the separately
approved download grants, and verifies the current installed baseline against
the last confirmed composition. Preserve model, Git, plugin, frozen artifact,
workspace enrollment and request-hook rules, credential bindings, TLS and
other static protections. Reject overlap, unexpected drift or an unsupported
composition before changing the provider. The separate
[frozen artifact contract](contracts.md#protected-codex-artifact-downloads)
and ordinary unprotected editor retain their existing behavior.

Before the worker dispatches a provider write, OCC commits the recovery data
on the original Agent-owned work row. Record the operation ID, revision,
immutable Sandbox and instance, provider compare-and-swap version, requested
scope, hashes of the intended policy and Installation limits, and last confirmed
installation. Store any later provider commit receipt on the same row.
If the write response is lost, the recovery owner uses the authenticated
read-only provider path to look up that operation, including after a restore.
A later policy version alone cannot identify which operation produced it.

### Publish the confirmed installation

The Driver pair verifies the original operation receipt, the resulting policy
source and effective rules, and the supervisor’s loaded version and hash on
the same Sandbox and instance. Verify that only the approved download rules
changed and that the model and Git rules, bindings and authorized recipients
match the predecessor. Wiring and health checks must agree on that policy.
Refuse the feature where the pair cannot produce that evidence.

Today OCC reads the deployment receipt or a confirmed credential reduction.
The proposed download edit must also advance the installation used for
credential checks. In one transaction, OCC rechecks the operation, current
authority and grants, running revision, recipient and exact predecessor.
It records the confirmed SandboxPolicy, the successor installation with the
verified effective policy hash, and the matching Git route evidence. Report
**Applied** only after commit. Preserve the original deployment receipt.
Both credential reductions and download edits must start from the current
confirmed installation. A stale edit cannot overwrite a reduction, restore
withdrawn access or publish against a replacement.

Through the transition, the qualified pair’s credential checks require current
grants and an exact match between the verified execution policy hash and the
published installation. Refuse credential use if the supervisor has loaded
the new hash before publication or the recipient cannot be verified. After publication,
model and Git credential checks read the same successor, including during
issuance or renewal for that recipient. Each request stays bound to its
installation through credential release and its final authorization check.
A request already past its final authorization check may finish.

Show **Pending** from admission until confirmation. **Applied** identifies the
confirmed policy and running revision. **Failed** explains the refusal or
unconfirmed outcome and retains the last confirmed version with its timestamp.
A timeout does not prove rollback. On concurrent edits, report the stale
version and reload the authoritative view. Cancel obsolete work on revision
replacement or deletion and prevent late acknowledgments from marking a
successor applied. Desired grants survive controller restart and are revalidated
at the next deployment against current delegation and Installation limits.
A replacement Sandbox or supervisor needs fresh evidence.

### Reconcile an unconfirmed write

Keep the private recovery data on the original work row through retries,
failure, cancellation and supersession, even if the displayed application
changes. The field is empty on existing and ordinary work. While a write to
the same running Sandbox remains unconfirmed, OCC refuses a second download
edit and identifies the operation awaiting confirmation. The recovery owner
continues read-only reconciliation after **Failed**. If the original receipt
arrives late and the pair verifies its effect, OCC uses the same publication
checks to record that operation as **Applied**. Recovery never resends the
write. If publication fails, record the observed outcome against the original
work only. Keep edits to that Sandbox blocked until OCC can verify its current
installed baseline, including any intervening credential reduction. A subsequent
edit must pass fresh admission against that baseline.

When a different revision and Sandbox become active, fence the old writer
before admitting a change for the replacement. Admission must preserve the
original work row and its recovery data in the same transaction. Qualify the
replacement independently. An uncertain approval cannot extend its delegation.

Only the recovery owner reads this private data. If the provider effect is
verified but OCC publication has yet to commit, retain the original record and
refuse further download edits on that Sandbox. The owner can retry publication
after rechecking current authority, the recipient, the predecessor and both
Drivers’ evidence. Clear the record only when publication commits, an
authorized reconciliation verifies the installed policy against the current
published installation, or the exact old recipient is confirmed retired.
Record the terminal disposition and clear the private data in one transaction.
Retirement closes the old recipient’s ability to act. Its historical policy
outcome may remain unknown. Reporting rollback requires independent confirmation that
the original recipient loaded the restored policy. A successful change on the replacement
leaves the old outcome uncertain. Successful final Agent deletion removes its
work rows under the existing lifecycle. Restored work remains isolated from live
writers while the recovery owner checks outstanding effects.

Withdrawal denies new connections to the removed scope once confirmed. Bytes
already delivered cannot be recalled. An admitted connection or in-flight
transfer can outlive a rule change. Show that limit at removal and qualify
connection reuse separately before claiming it stops on withdrawal.

## Acceptance criteria

Extend the [Console policy fixture](../../../tests/browser/console-sandbox-policy-fixture.ts)
and the [real OpenShell workflow](../../../docs/testing/openshell-coverage.md)
to run one browser and one shell against the same protected Agent. Use the
existing SDK and CI environment to create and clean up the fixture. Record the
Agent, revision, Sandbox, Pod and supervisor identities throughout.

1. Start with a denied download and a working model turn and authorized Git
   read. Add a previously unseen eligible domain in the browser. Time the
   click, provider confirmation and first successful fresh shell download.
   Verify response bytes at a controlled origin, with no platform credential
   delivered. While the grant is active, make a fresh model turn and authorized
   Git read through their usual credential paths on the same instance. Verify
   both use the confirmed installation. Check that a request with the new hash
   before publication and one with the old hash after publication are refused.
   Check an unauthorized Agent and an unlisted destination stay denied.
2. Exercise the signed Debian package workflow and an exact shared-host archive
   after a redirect. Check the artifact integrity, a sibling path, a write
   method and an unapproved redirect hop. A delegated editor cannot approve an
   unseen name. Record a ceiling refusal and an unsupported pair’s reason.
3. Remove the domain in the browser and time the first fresh connection denial.
   Exercise an already open connection separately. Retest model and Git access,
   verify unchanged runtime identities and confirm a second Agent’s policy
   never changed. Exercise stale writes and stale supervisor evidence. In a
   separate run, race publication with a credential reduction and verify the
   withdrawn route stays denied.
4. Lose the provider reply after it accepts a write. Restart the worker, let
   confirmation fail, then attempt a second edit on the same running Sandbox.
   Verify the refusal preserves the original work row and published installation.
   Make the original receipt available, then fail the first OCC publication
   after the pair verifies the loaded policy. Verify that another edit is still
   refused and that the original recovery record survives. Let recovery publish
   the original operation, check that the provider received exactly one write,
   and admit the next edit against the confirmed version.
5. On revision and Sandbox replacement, verify that interrupted admission
   preserves the original operation and its witness,
   and that a separately verified successor succeeds independently. A late
   acknowledgment cannot settle either operation by itself. Read the original
   operation to settle it and clear its private data without replay. Confirm that
   pending or failed deletion preserves unresolved evidence, successful final
   deletion removes its row, and status, logs and audit omit the private payload.
   Measure update latency separately from setup and deployment.

The [CI pin](../../../scripts/ci/openshell.mjs) selects OpenShell 0.1.8.
Its [policy matcher](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/crates/openshell-supervisor-network/data/sandbox-policy.rego)
checks request methods and canonical paths. Its [policy status protocol](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/proto/openshell.proto)
distinguishes a queried policy revision from the active loaded version.
Qualify the installed Gateway and supervisor together for these cases before
exposing the actions. This proposal supplies no installed-runtime or latency result.
