---
rfc: ../rfcs/0024-strands-box-sandbox.md
---

# Implementation plan: Strands Box sandbox integration

- **ID:** RFC-0024
- **Delivery status:** In progress
- **Authority:** [Proposed decision](../rfcs/0024-strands-box-sandbox.md)
- **Source baseline:** `7d472f3f7d3b5104deb7e18ae7a2627ce1da0f91`

## Outcome

Deploy a dedicated Codex Agent through normal OCE APIs with Strands Box as the
selected Sandbox Driver. Prove a real model tool call and revision lifecycle.
Credential Proxy remains outside this phase.

## Work and proof

1. Submit RFC-0024 for human review before changing the Installation/Driver
   configuration contract. Keep the proposed decision separate from acceptance.
2. Package the fixed Box build and persistent adapters in a runtime compatible
   with the existing OCE runtime source and Codex version. Verify native ARM64
   loading; the preliminary Box binary was built against Debian 13, while the
   existing runtime uses Debian Bookworm. Do not assume ABI compatibility.
3. Preserve all `HarnessWorkloadRequirements` in the new Driver. Implement
   admission, exact Pod/PVC/Secret projection, private workspace initialization,
   provision, endpoint, authenticated status, peer labels, observation, logs,
   revision cleanup, and Namespace cleanup. Refuse unsupported attachments and
   auth modes explicitly. Verify Secret values never enter stored Box config.
4. Implement the proposed selector in Installation composition and update its
   configuration definition. Keep provider logic in the Driver and its runtime
   adapters. Update the current Driver reference, operator instructions, and
   source-backed flow documentation in the same change.
5. Install the control plane and PostgreSQL in the owned k3d environment, with
   exact controller/runtime identities and separate database roles. Verify
   NetworkPolicies and the candidate seccomp profile on the actual image.
6. Register real Agent scenarios in the QA matrix: create/deploy, native handshake,
   workspace-node enrollment, model tool call, allowed workspace write, denied
   outside access and network destination, reconnect, stop, redeploy, and
   persistence. Check failed authentication and unavailable/missing profile
   paths. Do not replace model execution with a fixture.
7. Run focused type, lint, formatting, package-boundary, and integration checks.
   Retain review evidence, exact versions, and a resumable resource inventory.
   Remove only test resources that no longer serve this task.

## Current evidence and gaps

The Bookworm runtime and fixed-source Box build, containment probes, and
persistent transport prerequisites have run. A local real Helm installation has
completed database initialization and started the API and Worker. Normal APIs
created a dedicated Codex Agent using an explicitly synthetic model credential.
The new Driver is wired in the local prototype; no model tool turn has passed.

Restricted tenant admission rejects the candidate's `procMount: Unmasked`, even
with Pod user namespaces enabled. Keep that as an explicit compatibility gap.
A scoped local admission exception, if authorized, demonstrates conditional
functionality only. It does not qualify the default OCE security configuration.

A personal API key was separately verified with direct native Codex, but it has
not been delivered to this installation. Finish credential-free startup checks
before using a few short model calls. Record every remaining packaging, mount,
startup, and lifecycle gap. No production rollout or internal pin change is
authorized.

## Change record

- 2026-10-22: Drafted from the pinned source and local ARM64 probes during local qualification. RFC submitted as draft PR #3230; implementation remains unqualified.

- 2026-10-22: Submitted the Namespace provider-route refinement before changing
  the Sandbox/Kubernetes Compute contract. Ordinary Box egress rejects WebSocket
  upgrades; Node requires jitless execution. Native adapter probes passed, but
  regular Agent integration remains pending. Use a small number of short model
  calls after credential-free checks; do not run broad model matrices by default.
