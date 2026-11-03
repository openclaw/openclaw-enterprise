---
rfc: ../rfcs/0027-shared-model-provider.md
---

# Implementation plan: Shared model provider configuration

- **ID:** RFC-0027
- **Delivery status:** In progress
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
   restrictions. Check the admitted provider during preparation, both activation paths, and recovery, before direct-Secret delivery or runtime changes.
5. Update current configuration, source, setup, and runtime-flow documentation,
   affected Console stories, and required QA scenario registration.
6. Complete scoped tests, browser proof, formatting, lint, typecheck, workspace,
   generated API and documentation checks, diff cleanup, and independent review.
   Publish the implementation on the RFC branch or a linked PR; do not merge.

## Verification

| Required outcome                                    | Proof                                                                                                                                                        | Status                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Shared/default destinations for both Harnesses      | Real Agent admission and deployment workflow plus rendered native configuration                                                                              | Four HTTP deployment cases and native rendering checks passed; no live model turns.                  |
| Removed settings and source field rejected          | Installation renderer and actual source API requests                                                                                                         | Passed; the removed source field is accepted on the original code and refused after the change.      |
| Credential destination remains immutable            | Source creation, attachment, retry, and protected dispatch mismatch cases                                                                                    | Source/API and protected-proxy checks passed.                                                        |
| Old custom sources cannot redirect keys             | Seed realistic stored records, refuse inference, preserve authorized read/delete                                                                             | Refusal, read, and deletion checks passed.                                                           |
| Provider changes between preparation and activation | Prepare with a direct Secret, change or remove the provider, then activate embedded OpenClaw and dedicated Codex; refuse before key reads or workload writes | Both activation paths passed; removing the comparison changes routing state in the negative control. |
| Unrelated credentials and egress unchanged          | Existing owner tests and review of policy output                                                                                                             | Existing owner checks passed.                                                                        |
| Setup surfaces agree                                | Rebuilt Storybook, browser interaction, screenshots and recording                                                                                            | 54 browser checks passed; rebuilt Storybook and before/after media inspected.                        |

Use Node 24.22.1 or newer and the repository's pinned pnpm and Bun. Run checks
on this task's DevBox. Live Kubernetes proof, if required, uses only a verified
task-owned disposable cluster with an explicit kubeconfig. Report unavailable
infrastructure separately; synthetic keys do not establish a live provider turn.

## Delivery record

[PR #4528](https://github.com/openclaw/openclaw-enterprise/pull/4528) submitted the
RFC before contract code. The implementation uses Compute's existing admission
record to bind the provider; both activation paths compare it before delivery.
The regression prepares ready direct-Secret workloads, changes or removes the
provider, and checks that activation reads no Secrets and changes no objects.
Removing the comparison in an isolated negative control lets activation change
routing state, which the regression detects.

Local validation passed: 767 owner tests and 54 browser tests, typecheck, lint,
formatting, workspace isolation, generated API, documentation, and test-lane
registration. Fourteen existing cases were not selected: twelve need Helm, one
needs PostgreSQL, and one needs a pinned native runtime image.

[Visual evidence](https://gist.github.com/kevinlin-openai/dd5c4f4a206055eb5f5ba7fae5ec96dd)
shows simulated Console behavior. Implementation-head CI and independent review
remain tracked in the PR. The local
independent reviewer could not authenticate; no completed local review is claimed.
No real model credential, live model turn, or cluster execution was used.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-03: Drafted from the source baseline above for the shared-provider task.
