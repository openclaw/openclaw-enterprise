---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Check the local k3d quickstart

## Overview

Exercise the quickstart through browser onboarding and Linear on one Agent
in a fresh local installation. This workflow uses real model and integration
credentials.

<a id="when-it-runs"></a>

## Trigger

Dispatch manually from protected `main`. The workflow also accepts pushes to its
named development branch only by the configured author and when the commit
matches `OCE_QUICKSTART_REVIEWED_SHA`; see the exact workflow condition. It has
no scheduled trigger and is not part of `CI Required`.

## Scenarios

The stages use the same Agent throughout installation, integration changes,
and redeployment. Setup executes the quickstart's published shell examples.
The reusable CI runtime job builds this workflow's source before installation.
Quickstart verifies the same-run artifact's source, checksum, OCI configuration,
and platform before loading it. Image preparation builds the controller from
the same checkout and records both immutable references through a run-owned
loopback registry. Both selections are exported before operator credentials
are staged; the launcher does not repeat either build. The registry is removed
after the run, including failed preparation.

| Setup and action                                                                         | Expected outcome                                                                                                                            | Source                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Create a fresh local installation and onboard a model-only Agent through the Control UI. | The Agent completes onboarding, saves its identity and the user's preference in workspace files, and returns a terminal assistant response. | [Setup](../../../scripts/ci/k3d-quickstart/setup.sh) and [browser checks](../../../scripts/ci/k3d-quickstart/browser.ts).                 |
| Enable Linear through the published Add Plugin procedure and ask for a known team.       | The real `codex_apps.linear.list_teams` result and reply contain the configured team ID, which was not supplied in the prompt.              | [Linear stage](../../../scripts/ci/k3d-quickstart/linear.sh).                                                                             |
| Reopen the original Control UI conversation after redeployment.                          | The same Agent and conversation recall the saved preference after Linear deployment.                                                        | [Recall stage](../../../scripts/ci/k3d-quickstart/browser-recall.sh) and [browser checks](../../../scripts/ci/k3d-quickstart/browser.ts). |
| Delete the Agent and the installation.                                                   | The Agent returns 404 and the local cluster and state are removed.                                                                          | [Teardown](../../../scripts/ci/k3d-quickstart/teardown.sh).                                                                               |

<a id="run-it"></a>

## Execution

Configure these inputs at the **repository** level:

| Input                              | Purpose                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Secret `OCE_QUICKSTART_CODEX_PAT`  | Codex service account with the selected model and an authorized Linear connection |
| Variable `OCE_QUICKSTART_MODEL`    | Model available to the service account                                            |
| Variable `OCC_TEST_LINEAR_TEAM_ID` | ID of a team the connected account can read                                       |

Dispatch the [k3d quickstart workflow](../../../.github/workflows/k3d-quickstart-e2e.yml) on `main`:

```sh
gh workflow run k3d-quickstart-e2e.yml --ref main
```

## Results and limits

Use the workflow result and its sanitized receipts to check onboarding, the
Linear tool result, conversation recall, and teardown. The prior Git stage
verified the retired protected exchange. Source-backed Git has separate
[native delivery checks](../openshell.md). Keep the private operator session on
the runner.

The job has a 300-minute timeout. Inspect the
`k3d-quickstart-<run-id>-<attempt>` artifact, retained for seven days. Its
`status.json` records the source commit and stage outcomes; successful stages
also supply browser, Linear, image-digest, and cleanup receipts.
The receipt collection script checks that the completed workflow used one Agent and
the same conversation before and after redeployment. Missing or skipped stages
do not count as a completed workflow.

Setup has a 102-minute subprocess deadline inside its 105-minute step limit.
On expiry, the wrapper terminates the setup process group before reporting
sanitized startup timings and entering teardown. Raw command output remains private.
Setup saves the Agent's identifiers before its first deployment so failure diagnostics
and teardown can use that Agent. Failed setup and Linear stages report
source-defined deployment and worker codes without publishing provider messages.
The diagnostic deployment read has a 20-second deadline and does not suppress
runtime logs when it fails.

An always-run step removes private input files. Uploaded evidence contains selected sanitized receipts, not
raw private logs, operator credentials, or conversation bodies.

This qualifies the local k3d quickstart and its selected live integrations.
It does not establish coverage for every installation type or provider.

## Files

- [Quickstart workflow](../../../.github/workflows/k3d-quickstart-e2e.yml): eligibility, browser workflow, assertions, and recovery evidence. It does not select a test-lane manifest.
- [Private stage runner](../../../scripts/ci/k3d-quickstart/private-step.sh): execution with private stage output.
- [Receipt collector](../../../scripts/ci/k3d-quickstart/receipts.sh): stage outcomes, cross-stage assertions, and upload selection.
- [Scenario scripts](../../../scripts/ci/k3d-quickstart): setup, browser, Linear, and cleanup implementations linked above.
- [Local Setup guide](../../guides/deploy/local-setup.md) and [first-Agent guide](../../guides/deploy/deploy-first-agent.md): user procedures exercised by the workflow.
