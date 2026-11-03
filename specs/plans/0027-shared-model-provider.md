---
rfc: ../rfcs/0027-shared-model-provider.md
---

# Implementation plan: Shared model provider configuration

- **ID:** RFC-0027
- **Delivery status:** Planned
- **Source baseline:** `5fdd03a69781a11ab91600ace1608aea5160198e`
- **Authority:** [Shared model provider RFC](../rfcs/0027-shared-model-provider.md)

## Outcome and scope

Use one Installation-owned endpoint for Codex and OpenClaw while preserving
immutable credential destination authorization. The RFC owns the contract,
defaults, failure behavior, recovery, and exclusions.

## Implementation

1. Submit the RFC and inspect review holds before implementation.
2. Extend Kubernetes Compute configuration, composition, and the installation
   profile renderer with the shared object. Reject removed settings explicitly.
   Reuse endpoint validation and Harness configuration projection.
3. Update the OpenShell Gateway and protected OpenAI provider catalog. Separate
   destination authorization from route selection; reject old routing fields and
   mismatched grants before credentials can be delivered. Preserve cleanup of
   unsupported stored sources.
4. Integrate shared selection into Codex and both OpenClaw topologies. Keep
   unrelated provider/authentication paths, model metadata checks, and egress
   restrictions. Check saved configuration during preparation and recovery.
5. Update current configuration, source, setup, and runtime-flow documentation,
   affected Console stories, and required QA scenario registration.
6. Complete scoped tests, browser proof, formatting, lint, typecheck, workspace,
   generated API and documentation checks, diff cleanup, and independent review.
   Publish the implementation on the RFC branch or a linked PR; do not merge.

## Verification

| Required outcome                               | Proof                                                                            | Status  |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ------- |
| Shared/default destinations for both Harnesses | Real Agent admission and deployment workflow plus rendered native configuration  | Not run |
| Removed settings and source field rejected     | Installation renderer and actual source API requests                             | Not run |
| Credential destination remains immutable       | Source creation, attachment, retry, and protected dispatch mismatch cases        | Not run |
| Old custom sources cannot redirect keys        | Seed realistic stored records, refuse inference, preserve authorized read/delete | Not run |
| Unrelated credentials and egress unchanged     | Existing owner tests and review of policy output                                 | Not run |
| Setup surfaces agree                           | Rebuilt Storybook, browser interaction, screenshots and recording                | Not run |

Use Node 24.22.1 or newer and the repository's pinned pnpm and Bun. Run checks
on this task's DevBox. Live Kubernetes proof, if required, uses only a verified
task-owned disposable cluster with an explicit kubeconfig. Report unavailable
infrastructure separately; synthetic keys do not establish a live provider turn.

## Delivery record

RFC and plan drafted; contract code has not started.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-03: Drafted from the source baseline above for the shared-provider task.
