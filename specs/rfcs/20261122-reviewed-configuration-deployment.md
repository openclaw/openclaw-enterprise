---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Deploy a reviewed Configuration

- **ID:** RFC-20261122-reviewed-configuration-deployment
- **Created:** 2026-11-22
- **Last updated:** 2026-11-22
- **Related:** [Agent deployment](../../docs/reference/agents/deployment.md), [Harness overrides](0030-agent-harness-overrides.md)

<a id="problem-and-decision"></a>

## Summary

Require the Console to send the Configuration ID and generation shown beside **Deploy new version**. OpenClaw Control Plane (OCC) can then refuse the request if the Agent’s saved Configuration changes before admission. Other clients can still choose to deploy the latest saved settings.

## Motivation

Two authorized editors can race even when the Console checks for changes on click. We reproduced this sequence with two signed-in clients and a local Controller.

| Event                                        | Current behavior            | Proposed behavior                                                            |
| -------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| A clicks Deploy after reviewing generation 2 | The Console rereads 2       | The Console rereads 2 and sends the reviewed pair                            |
| B saves generation 3 before admission        | OCC queues a version from 3 | OCC refuses A’s request without queueing a version                           |
| A sees the result                            | **Outcome unknown**         | **This deployment wasn’t queued.** Reload and review before deploying again. |

An Agent version snapshots a deployment. Its version number is independent of the Configuration’s generation.

<a id="scope"></a>

## Scope

For paired requests, admit exactly the reviewed Configuration or refuse. Agent settings, Installation defaults, policies and credential values can still change. Acceptance does not establish runtime readiness. Ordinary deployment remains non-idempotent.

<a id="design"></a>

## Proposal

1. Authorize Agent deployment and read access to the **currently bound** Configuration. Compare its ID and generation before reading values for Channel preparation. The submitted ID cannot select a Configuration. A correct guess of an unreadable binding must yield the same denial as an incorrect guess.
2. Recheck before Secret retrieval and, under existing authority and Namespace locks, immediately before each Channel credential handoff. An edit after handoff cannot undo provider validation already started.
3. With or without a Channel, recheck authority and the pair under the Namespace, Agent and Configuration locks. Hold those locks through the admission transaction. If the pair changed, this request creates no revision, changes no desired state, queues no work and records no deployment success.
4. On that refusal, the Console keeps Deploy unavailable. The operator keeps any needed edits, reloads the page, reviews the saved draft and Harness destination, then clicks **Deploy new version** again. Preserve distinct guidance for permission denials and uncertain outcomes. Never replay the request automatically.

## Interface changes

### APIs

On [`POST /namespaces/:namespaceId/agents/:agentId/deploy`](../../packages/contracts/src/api/routes.ts), accept `expectedConfigurationId` and `expectedGeneration` together or neither. Use the existing ID and positive safe integer constraints. Invalid or partial pairs return `400`. Preserve optional Harness overrides, bodyless requests, the `202` response and guarded first-deployment receipts.

For authorized drift, return `409 RESOURCE_CONFLICT` with a fixed message and one `INVALID_VALUE` detail. Use `/expectedConfigurationId` for a changed binding, otherwise `/expectedGeneration`. Omit current values and Driver diagnostics.

### IAM

No changes.

### Database entities

No changes.

### Driver contracts

No changes.

## Simplifications

Reuse Configuration metadata and the existing deployment transaction. No reservation, new lock or additional receipt is needed.

## Acceptance Criteria

- **AC-1** On a real Controller, deploy an Agent with history and the matching pair. Check the queued revision and overrides. Reject partial input and preserve latest-saved behavior on omission.
- **AC-2** Race a save or same-generation rebind with credential handoff and final admission. Include a PostgreSQL lock wait without a Channel. Verify the refusal, unchanged deployment state, zero new work and identical denials for guesses of an unreadable binding.
- **AC-3** Repeat the two-editor browser flow. Check focus on the refusal, no request on reload and exactly one new version after a second explicit click.

## Delivery and verification

Update the serving API before relying on a new Console. Older tabs can still send unpaired requests. An older strict Controller rejects the new fields. Never retry without them. Verify AC-1 through AC-3 together before shipping.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

A browser reread leaves the race open. Requiring the pair from every client would break existing deploy-latest callers.
