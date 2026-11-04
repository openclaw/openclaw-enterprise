# Implementation plan: reliable production deployment tools

- **ID:** TASK-0050
- **Delivery status:** In progress
- **Owner:** Deployment tooling maintainers
- **Authority:** [Production deployment](../../docs/guides/deploy.md),
  [production upgrades](../../docs/guides/deploy/production-upgrade.md), and
  [platform architecture](../../docs/design.md).
- **Source baseline:** `c8a9b55bd67175e0d1ae3fbb7fefe1a0de44f573`.

## Outcome and scope

Operators can choose the correct installation procedure, detect conflicting
configuration before rollout, and continue an interrupted upgrade without
repeating a completed operation. Keep the existing Helm chart, configuration
renderer, OCC operations, and production upgrade command as the owners.

An installation-specific recovery script is not a portable installer. Resource
identities, protected credentials, and operation receipts remain outside the
source checkout. Do not add another orchestrator that invokes historical scripts
or imports their source fragments. A timeout or missing response does not prove
that an operation failed before taking effect.

This plan distinguishes source changes from release qualification. It does not
authorize a live deployment or establish that an installation can serve an Agent
conversation. Existing Driver contracts and supported runtime profiles remain
unchanged.

## Contract and source touchpoints

| Operator task                                 | Existing owner                                                                                                                                                     | Required distinction                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Choose an installation procedure              | [Deployment guide](../../docs/guides/deploy.md)                                                                                                                    | OpenShell setup and custom Helm profiles have different inputs and session helpers.        |
| Generate paired configuration                 | [Profile renderer](../../scripts/render-installation-profile.mjs)                                                                                                  | Rendering is not installation or live connectivity proof.                                  |
| Reject inconsistent chart and Compute routing | [Chart helpers](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl), [startup composition](../../apps/controller/src/composition/installation-config.ts) | Compare the effective listener selection before replacing the API.                         |
| Upgrade images                                | [Production upgrade command](../../scripts/upgrade-production-images)                                                                                              | An interrupted operation can resume; a completed operation cannot resume as a new release. |
| Recover first deployment admission            | [PR #4232](https://github.com/openclaw/openclaw-enterprise/pull/4232)                                                                                              | Admission, runtime readiness, and a successful model response are separate outcomes.       |
| Recover installation initialization           | [PR #2905](https://github.com/openclaw/openclaw-enterprise/pull/2905)                                                                                              | A retained Job UID identifies the original attempt; a new Job does not settle it.          |

## Implementation

### 1. Correct the existing release path

- Refuse `--resume` when the upgrade evidence records completion. Write that
  record only after the command's required checks and final evidence capture.
  Preserve recovery of incomplete runs and their separate dispatch journals.
- Compare Helm's effective private Gateway selection with Kubernetes Compute's
  effective routing settings in the existing startup preflight. Reuse the chart's
  hostname derivation. Report the conflicting field without printing supplied
  configuration or credential values.
- Clarify installation choices and their next steps in the existing guides.
  Keep current URLs and heading anchors. Update the startup and upgrade flows
  with the implemented failure and completion behavior.

### 2. Finish recovery through its current owners

Review and finish the existing proposals before adding substitute protocols:

- [#4232](https://github.com/openclaw/openclaw-enterprise/pull/4232): recover a
  first deployment after losing its response. Once available, integrate its
  commands with the production onboarding caller in
  [operator-session.sh](../../docs/snippets/openshell-quickstart/operator-session.sh).
  Preserve the distinction between an absent receipt and a request still running.
- [#2905](https://github.com/openclaw/openclaw-enterprise/pull/2905): report where
  initialization stopped using the original Job identity.
- [#3253](https://github.com/openclaw/openclaw-enterprise/pull/3253): start API
  access before enabling worker reconciliation.
- [#4051](https://github.com/openclaw/openclaw-enterprise/pull/4051): explain
  invalid baseline YAML without exposing protected values.

These PRs were open when this plan was written. Their existence does not prove
that their commands are available in a published release. Preserve each PR's
author, branch, review requirements, and specific holds.

### 3. Qualify the normal operator workflow

Audit the selected setup's supplier endpoint, tenant permissions, workspace
admission, and network policies through its actual owners. Check both supplier
and workload-controller identities where they are distinct. Place each proven
configuration correction in the chart, setup tool, or owning Driver rather than
an installation-specific post-render patch. A Driver contract change requires
the repository's RFC process before implementation.

Use the existing work on [served Console verification](https://github.com/openclaw/openclaw-enterprise/pull/3384)
and [populated upgrade qualification](https://github.com/openclaw/openclaw-enterprise/pull/4492).
Keep provider-readiness changes in [#2695](https://github.com/openclaw/openclaw-enterprise/pull/2695)
subject to the decision in [RFC #2696](https://github.com/openclaw/openclaw-enterprise/pull/2696).
Do not make those unfinished proposals prerequisites for unrelated local fixes.

## Verification

| Required outcome                                                    | Check                                                                                                                                    | Status                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A completed upgrade cannot repeat cluster operations through resume | Existing production-image-upgrade integration scenarios; compare command and evidence records before and after the rejected resume       | Pending final results                                               |
| An interrupted upgrade retains its recovery path                    | Existing upgrade recovery scenarios, including restored dispatch evidence                                                                | Pending final results                                               |
| Chart and Compute routing conflicts fail before rollout             | Actual rendered installation-check hook with matching and mismatching configuration                                                      | Pending final results                                               |
| Installation guides lead to the correct caller                      | Source-backed command review, Markdown checks, and existing anchors                                                                      | Pending final results                                               |
| A release serves its users                                          | Authorized populated installation: human sign-in, selected Agent readiness, real model reply, and required repository/channel operations | Not run by this cleanup; source and fixture checks are insufficient |

Do not replace missing cluster or credential prerequisites with simulated proof.
Record the tested source and exact limits of local checks. Keep screenshots,
private operation records, and provider credentials outside the repository.

## Delivery record

The initial change covers milestone 1. Milestones 2 and 3 remain separate work;
this plan is not a claim that deployment tooling is fully qualified or released.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-04 00:26: Record the existing owners, immediate corrections, and remaining qualification work. (authoring-run/a85b1fc7-d58e-4c10-b80c-6464a0aaaa4f; source `c8a9b55bd67175e0d1ae3fbb7fefe1a0de44f573`)
