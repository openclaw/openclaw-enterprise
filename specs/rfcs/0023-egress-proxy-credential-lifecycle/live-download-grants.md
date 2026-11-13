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

Before dispatch, record the operation ID, the immutable Sandbox identity, the
provider’s compare-and-swap version, and the hashes of the intended policy and
the Installation limits. If the write response is lost, look up that original
operation through the authenticated read-only provider path, including after a
restore. Recovery never resends the original write. A later policy version alone cannot
establish which operation produced it. The protected pair must agree on the new
policy in subsequent wiring and health checks. Confirm the expected source and effective rules,
including absence of removed access, and match the supervisor’s loaded version
and hash to the **post-update** policy on the current Sandbox and instance.
A queued write, a successful RPC, or the previous deployment witness alone
cannot establish enforcement. Refuse the feature where the pair cannot produce
that evidence.

Show **Pending** from admission until confirmation. **Applied** identifies the
confirmed policy and running revision. **Failed** explains the refusal or
unconfirmed outcome and retains the last confirmed version with its timestamp.
A timeout does not prove rollback. On concurrent edits, report the stale
version and reload the authoritative view. Cancel obsolete work on revision
replacement or deletion and prevent late acknowledgments from marking a
successor applied. Desired grants survive controller restart and are revalidated
at the next deployment against current delegation and Installation limits.
A replacement Sandbox or supervisor needs fresh evidence.

If an original write is still uncertain when a different revision and Sandbox
become active, first fence the old writer. In the same transaction that admits
the new change, preserve the old operation’s reconciliation data on its original
Agent-owned work row. This optional private field is empty on existing and
ordinary work. Keep the operation identity, original target and precondition,
requested scope, optional provider commit receipt, and prior confirmed witness
through retries, cancellation and ordinary result changes. An uncertain approval cannot extend the replacement’s delegation.

Only the recovery owner reads this private data. Preserve it through queue
retries until an authorized read verifies the original effect or confirms that
the exact old recipient has retired. Retirement closes the old recipient’s
ability to act. Its historical policy outcome may remain unknown. In one
transaction, record the terminal result and a sanitized audit disposition, then
clear the private data. Reporting rollback requires independent confirmation that
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
   delivered. Check an unauthorized Agent and an unlisted destination stay denied.
2. Exercise the signed Debian package workflow and an exact shared-host archive
   after a redirect. Check the artifact integrity, a sibling path, a write
   method and an unapproved redirect hop. A delegated editor cannot approve an
   unseen name. Record a ceiling refusal and an unsupported pair’s reason.
3. Remove the domain in the browser and time the first fresh connection denial.
   Exercise an already open connection separately. Retest model and Git access,
   verify unchanged runtime identities and confirm a second Agent’s policy
   never changed. Exercise stale writes, worker restart after provider update,
   revision replacement, and stale supervisor evidence. On replacement, verify
   that interrupted admission preserves the original operation and its witness,
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
