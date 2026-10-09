---
status: Proposed
implementation_status: Not implemented
author: freeqaz
status_note: "Needs human review before landing. No implementation accompanies this proposal."
---

# Proposal: Truthful availability for the sandbox log source

- **ID:** RFC-0019
- **Owner:** Agent runtime logs (controller and OpenShell Sandbox Driver). Review: API
  contract owners.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** dogfood finding D114; runtime log reads
  ([flow](../../docs/flows/agent-runtime-logs.md),
  [guide](../../docs/guides/topics/agent-logs.md)); RFC #854 (open) records the
  runtime log design.

<a id="problem-and-decision"></a>

## Summary

`GET …/deployments/<id>/runtime` lists the `sandbox` log source as `available: true`
whenever the revision's Sandbox Driver can read logs. That holds even for a failed
revision that never got a Sandbox. A read of that source then answers
`503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`, and the documentation lists three possible
causes. This RFC proposes deriving availability from the revision's own Harness Pod,
which the description already lists, and adds one `unavailableCode`.

## Motivation

`withSandboxLogSource` (`packages/occ/src/index.ts`) appends the source with a fixed
`available: true` and never looks at the cluster. Container sources already report
`available: false` with `unavailableCode: "NO_POD"` when their Pod is missing, so
`occ agent runtime` shows the `agent` source as unavailable and the `sandbox` source
as available for the same failed revision. The Console's source picker and the CLI
both trust `available`. The user picks the source and gets a `503` that cannot say
which of its causes applies.

OpenShell answers `NOT_FOUND` both for a Sandbox that does not exist and for one
hidden from an identity outside its Workspace (`readSandboxLogs` in
`apps/controller/src/drivers/sandbox/openshell.ts`). The read alone cannot tell
the two apart.

## Goals

- A revision with no Sandbox does not offer the `sandbox` source as available.
- No extra OpenShell call on every follow poll.
- A misconfigured Workspace membership still surfaces as an error, not as "not
  provisioned".

## Options

### A. Follow the Harness Pod (recommended)

Describe lists the revision's `agent` Pods by the labels `openclaw.dev/revision` and
`openclaw.dev/workload-role: agent`. If the OpenShell Harness Pod carries those labels
(verify this before implementing; `providerHarnessReady` already waits on the Harness
Pod's labels), describe already lists it as the `agent` source. When that source has no Pod, report `sandbox` as `available: false` with a new
`unavailableCode: "NO_SANDBOX"`. Keep reads unchanged, so a direct read still answers
`503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`.

Cost: one schema literal (`unavailableCode` becomes `"NO_POD" | "NO_SANDBOX"`), the
description validator in `packages/occ/src/runtime-logs/description.ts`, which rejects
unknown codes today, the
regenerated API reference, a CLI and Console label, and tests. A `source=sandbox`
read currently skips the Compute description. It stays that way, because only
describe changes.

Risk: if OpenShell keeps a Sandbox's log buffer after its Pod is replaced, the source
would show as unavailable during a restart, although a read could still return lines. The picker already handles a source that changes state
between polls.

### B. Probe OpenShell on describe

Call `GetSandbox` through the narrowed reader when describing. This is exact for "the
Sandbox exists", but `NOT_FOUND` still conflates non-membership, so the code would have
to say "not found or not visible". It also adds a gRPC round trip to every describe.

### C. Keep the contract, sharpen the error

Leave `available: true`. When the `agent` source has no Pod, the read error message
says "This revision has no running Harness". No schema change, but the picker keeps
offering a source that cannot work.

### D. Do nothing

The finding is low severity. The `agent` source already shows `NO_POD`, and the guide
lists the causes.

## Decision requested

1. Choose A, B, C or D.
2. If A or B: approve the new `unavailableCode` value and its name.

## Risks

- Option A ties sandbox availability to a Pod label convention between the Kubernetes
  Compute Driver and the OpenShell Sandbox Driver. A test must pin it.
- Clients that switch on `unavailableCode` must accept the new value. Today the only one
  is `NO_POD`, and neither the Console nor the CLI switches on its value.
