---
status: Proposed
implementation_status: Implemented
author: freeqaz
status_note: "Needs human review before landing. The accompanying draft implements Option B only."
---

# Proposal: Repository options when no repository Driver is configured

- **ID:** RFC-0019
- **Owner:** Controller HTTP API and Console Agent creation. Review: API contract owners.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** finding D283 from live testing of #374; the analogous credential-source
  fix `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` (D100); current contracts in
  [repository credentials](../../docs/reference/repository-credentials.md) and
  [Console create and deploy](../../docs/reference/console/create-and-deploy.md).

<a id="problem-and-decision"></a>

## Summary

Installations without a repository credential Driver answer every
repository-options read with `503 REPOSITORY_OPTIONS_UNAVAILABLE` and the fixed
message "Repository options are unavailable." The Console then offers **Retry
repository choices**, which cannot succeed until an operator changes the
Installation. This RFC decides how the API and Console report that state. It
recommends keeping the documented status and code. The message should name the
cause and the runbook, and the create form should stop offering Retry in its
draft-only state.

## Motivation

On the dogfood install, which has no repository Driver,
`GET /namespaces/<ns>/agents/repository-options` and the per-Agent variant
answer `503` with no cause. A `503` invites clients to retry. The create form
shows "Repository choices are unavailable. Set up repository access…" next to a
Retry button. Credential sources answer the same situation with a specific
`409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` and a documentation pointer.

`RepositoryOptionsUnavailableError` is raised only for fixed composition:
the Compute Driver lacks repository support, the SandboxDriver composition is
incompatible, or no repository Driver is selected. Transient Driver listing
failures already map to `503 DEPENDENCY_UNAVAILABLE`.

## Goals

- Callers learn why repository options are unavailable and where the operator
  procedure lives.
- The Console does not offer an action that cannot succeed.
- Creating an Agent without repositories stays possible in this state.

## Options

### A. New `409 REPOSITORY_DRIVER_NOT_CONFIGURED`

This matches D100. It adds a public error code and changes the status for one
cause. The Console currently treats every `409` from this route as a Namespace
lifecycle conflict that blocks creation, and the OpenAPI contract documents
`503 REPOSITORY_OPTIONS_UNAVAILABLE` as the one outcome that permits creation
without bindings. Option A needs a contract change, a Console change that lets
this `409` proceed, a regenerated API reference, and a note for any client that
already relies on the `503`.

### B. Keep `503 REPOSITORY_OPTIONS_UNAVAILABLE`, explain it, and hide Retry (recommended)

- The API keeps status and code. The message becomes "Repository options are
  unavailable. <cause> See docs/guides/repository-credentials/team-runbook.md."
  The cause is one of the fixed composition messages, for example "This
  Installation selects no repository credential Driver." It carries no
  upstream detail.
- The create form hides **Retry repository choices** in its draft-only state,
  which this code alone produces. It keeps the existing setup link and still
  allows creation without repositories.
- The edit path (an existing Agent with bindings) is unchanged: it keeps Retry
  and blocks saving, as its tests require.

This adds no API surface. It does treat the code as configuration-only, which
the current contract implies but does not state.

### C. Keep the status and code, add `error.details.reason`

A machine-readable reason (`not_configured`, `unsupported_composition`) would
let clients distinguish causes. It adds response surface that no current caller
needs.

## Decision requested

1. Approve Option B, or choose A or C.
2. Confirm that `REPOSITORY_OPTIONS_UNAVAILABLE` is documented as
   configuration-only, so clients should not retry it automatically.

## Verification of the draft (Option B)

- `tests/integration/repository-credentials-admission.test.mjs`: 29/29 pass.
  The missing-composition case asserts the cause and runbook message.
- `tests/browser/console-agents.test.mjs` (repository cases) and
  `tests/browser/console-agent-repositories.test.mjs`: pass. The
  unavailable-choices case asserts that Retry is hidden and fails without the
  Console change.
- Not provided: Storybook screenshots and video for the changed create-form
  state. Collect them before landing.

## Risks

- An operator who configures a repository Driver while a create form is open
  must reload the page instead of pressing Retry.
- The message now names the Installation's composition gap to anyone allowed
  to create Agents in the Namespace. It reveals no secret or upstream detail.
