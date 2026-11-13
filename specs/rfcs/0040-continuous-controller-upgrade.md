---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Keep the API serving during a controller upgrade

An authenticated Installation read can return 502 during an ordinary controller
upgrade. The [upgrade command](../../scripts/upgrade-production-images) stops
the API and worker before the migration hook runs. The [chart](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml)
deliberately uses a single API Pod with `Recreate` because each process maintains
its own sign-in limits. A faster hook shortens the interruption.

## Proposed decision

For qualified controller-only upgrades, keep the existing API Service and run
the old and new API Pods together during handoff. Keep a single worker entitled
to dispatch work. An authorized Console, TUI or HTTP request should complete
on its first attempt within its ordinary deadline. A long-lived chat connection
may reconnect and recover the acknowledged turn in its original conversation.

[RFC-0011](0011-coordinated-image-upgrade.md) continues to govern image selection
and the maintenance-window procedure. Operators first install a handoff-capable
chart and controller through that procedure. The chart owns two API Deployments
with disjoint slot selectors and a common Service selector. Normally one slot has
one replica and the other is empty. Helm remains the sole owner of both slots.

## Upgrade sequence

1. **Select the path before changing workloads.** Bind qualification to both
   controller digests, the chart and the enabled Installation configuration.
   Require surge capacity, unchanged runtime and startup configuration,
   identical migration catalogs and completed migration history. Qualify both
   API versions against the incumbent worker and the candidate API against
   the replacement worker. Exclude configurations whose active Agent or Git
   session would retire when the worker changes. Report the expected interruption
   for a maintenance upgrade. A request for continuous service must stop before
   mutation if the pair is ineligible.
2. **Start the candidate.** Stage a Helm revision that retains the incumbent API
   and worker. The [initialization hook](../../deploy/helm/openclaw-enterprise/templates/jobs.yaml)
   must verify current schema and bootstrap state with read-only database access
   and unwritable bootstrap outputs. Compare the Installation ID read from the
   candidate database with the ID the command already binds through the authenticated
   API and the live startup Secret. A different Installation can have the same
   name and administrator and pass the existing bootstrap check. A missing or
   mismatched ID stops the handoff before the candidate serves.
   Keep candidate startup effects, including IAM and authentication
   initialization, preset updates and repository observers, under their existing
   owners. An unready Pod can already perform these actions today. Each owner
   must serialize or defer them before overlap is eligible.
3. **Serve through the existing route.** Once the candidate can authenticate,
   authorize and reach its route dependencies, let Kubernetes publish its ready
   endpoint. Observe an authenticated first attempt reach that specific Pod
   through the ordinary ingress while the incumbent is still healthy. A Pod
   readiness response alone does not establish this.
4. **Drain the incumbent.** The upgrade operator targets the incumbent slot
   and exact Pod UID for withdrawal. Make it unready while it still serves
   requests arriving through stale endpoints and pooled connections. Finish
   admitted requests and give established chat clients a resumable disconnect.
   Scale the slot to zero only after endpoint withdrawal, ingress connection
   drain and settlement of admitted work. A drain timeout preserves the listener
   and reports the outstanding work. Replace the worker through its existing
   claim and repository restart checks while the candidate API continues serving.
   Require the expected Agent revisions and working public route before completion.

## What must survive overlap

Both API processes must enforce the same sessions, revocations, sign-in budgets,
rate limits and concurrent-request limits. Put shared admission state under
the existing PostgreSQL-backed owners. Preserve the current key scopes, charge
attempts consistently across Pods, and reconcile abandoned concurrency slots.
Apply the same checks to raw WebSocket upgrades and to reads with side effects.

Keep conflicting writes serialized at the resource owner. Preserve the operation
identity, transaction, audit and durable work semantics of each route across
both versions. For external effects, the existing dispatcher must deduplicate
or reconcile an outstanding operation before sending again. A lost response
does not authorize a second dispatch. An enabled route that cannot meet its
contract during overlap keeps the pair on the maintenance path.

Record each Helm submission and both slot identities in the command's existing
evidence directory. After interruption, reconcile live Helm history, Pod UIDs,
endpoints, admission state and worker claims before advancing. If the candidate
fails before it serves, keep the incumbent. After candidate writes, reverse the
handoff only if the predecessor can read and act on the resulting state.
Otherwise keep the compatible serving version and recover forward.

## Acceptance criteria

Use the normal command, production images, ingress, PostgreSQL, IAM and a running
Agent. Collect evidence from before preflight through worker replacement.

- **AC-1.** Exercise authenticated Installation reads, Console actions, TUI
  operations and mutations across enabled route families. Record first-attempt
  status, latency and serving Pod. Require expected responses through every
  phase, requests served by both versions, and continuous ready endpoints.
- **AC-2.** Send requests to both versions while changing an authorization and
  consuming a shared quota. Verify the same decisions as on one API. Hold an
  admitted mutation across drain and interrupt its response. Verify the single
  logical effect in durable state, the audit record and the downstream receiver.
- **AC-3.** Acknowledge one chat submission before drain. Reconnect through the
  same public route and recover one terminal reply. Verify the original Agent
  revision, Gateway Pod and conversation, then complete a distinct continuation.
- **AC-4.** Point the candidate at a second valid database with the same
  administrator and a different Installation ID. Require refusal with both
  databases and the bootstrap outputs unchanged while the incumbent serves.
  Exercise an ineligible pair, pending migration, failed candidate, incomplete
  ingress drain and interruption after Helm submission.
  Verify the documented refusal or recovery at the stage where it applies.
  Exercise both a compatible reverse handoff after a write and refusal of
  an incompatible rollback.

The first implementation step is a verification-only initialization path.
Shared admission, graceful drain and an installed release-pair rehearsal are
required before a release can advertise continuous API service.
