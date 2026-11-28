---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# First Agent Smoke

## Overview

First Agent Smoke installs the Kubernetes platform from images built from the checkout
and exercises embedded OpenClaw and dedicated Codex Agents. It uses a simulated
model provider, so it tests deployment, chat, logs, stop/start, and saved workspace edits
without proving access to a real model service.

<a id="when-it-runs"></a>

## Trigger

This is a job in the CI workflow, selected when CI Impact chooses `full` mode.
Documentation-only and recognized test-only changes skip it. CI also runs on
`main` pushes, merge groups, and manual dispatch.

In hosted CI, the job reuses the same verified runtime artifact as the four
ordinary image lanes. It adds test trust to the runtime and pushes that image
and the controller to its existing local registry. The simulated provider uses
the pinned Node base, copies the WebSocket package from the verified runtime,
and loads into the job's Docker engine. All installation, chat and lifecycle
checks still run.
See [shared runtime images](run-lanes.md#shared-runtime-image-in-ordinary-ci) for
artifact verification and rerun behavior.

The job is outside `CI Required`, so its failure does not fail that merge gate.
A failed main-push CI workflow can still block standalone container and CLI publication,
which require successful CI for their source.

## Scenarios

The [smoke script](../../../scripts/ci/first-agent-smoke.ts) owns these checks;
it does not use a suite manifest.

| Setup and action                                                                   | Expected outcome                                                                                                                                                                          | Source                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Build the checkout images and run Kubernetes-only Local Setup.                     | Installation becomes available with the selected images.                                                                                                                                  | Smoke script: `buildImages` and `startLocalSetup`.                                  |
| Create an embedded OpenClaw Agent and a dedicated Codex Agent; send chat requests. | Both Agents return the expected simulated-provider response.                                                                                                                              | [First-Agent helper](../../../scripts/first-agent.ts) and smoke script: `chatTurn`. |
| Read gateway logs and dedicated Agent logs through the CLI.                        | `occ agent logs` returns nonempty logs for the selected sources.                                                                                                                          | Smoke script: `readLogs`.                                                           |
| Withdraw public Git reader access and deploy a revision without that access.       | The old workload and policy are removed and open connections close. The retired revision and the successor without reader access make no further reads; the control Agent retains access. | Smoke script: `proveRetirement`.                                                    |
| Write and read Codex `USER.md`, then stop and start both Agents.                   | Stopped Pods terminate and new revisions start. Before another write, the Codex file matches the saved edit. A new edit also reads back exactly, and both Agents can chat.                | `checkCodexWorkspaceFile`, `stopAgent`, `deployAgent`, and `chatTurn`.              |

<a id="run-it"></a>

## Execution

Use the CI job on a code/configuration change for a hosted run. For local
reproduction, use a disposable host with the workflow's Docker, Kubernetes,
Helm, Go, and Node tooling. The script uses named containers, a local registry,
and a disposable cluster; select a distinct
[smoke slot and directories](#local-isolation) before concurrent runs.
It needs no real model credentials.

From the repository root:

```sh
pnpm cli:build
node scripts/ci/first-agent-smoke.ts images
node scripts/ci/first-agent-smoke.ts run
```

The second command builds images; `run` requires those build results. Do not
substitute a production cluster for the script's disposable installation.

Image build commands have a 40-minute budget. The protected prepared-Git job
allows 120 minutes for image builds and its installed proof; the ordinary
artifact-backed smoke job allows 40 minutes. These are cancellation limits,
not expected durations.

### Local isolation

Keep the same directory and slot for `images` and `run`. Only a distinct slot
isolates host-wide names; changing the directory alone does not.

| Setting                           | Default                                                       | Purpose                                                                                                       |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `OCC_FIRST_AGENT_SMOKE_DIRECTORY` | `$RUNNER_TEMP/first-agent-smoke`, or `/tmp/first-agent-smoke` | Images, certificates, and Local Setup state.                                                                  |
| `OCC_FIRST_AGENT_SMOKE_SLOT`      | `0`                                                           | `0`–`31`; selects distinct cluster, registry, and model names, port, and subnet. Also vary development ports. |

## Results and limits

Inspect the **Build checkout images** and **Install, deploy, chat, stop and start**
steps. The script prints named stages, timing, assertions, and failure diagnostics.
An image build alone is not a passing lifecycle check. Verify that the run
completes, including cleanup, before reporting success.

Search for `wait observed` and the deployment label. Each line
records the first poll that sees `deployment-succeeded`, `active-revision`, or
a selected previous-attempt code. The selected codes are
`PREDECESSOR_STOP_YIELDED`, `REVISION_INCOMPLETE`, `WORKSPACE_NODE_PENDING`, and
`WORKSPACE_NODE_BINDING_PENDING`. `elapsedMs` is the time since the wait started.
Each poll reads the deployment and Agent separately, so the responses are not an
atomic snapshot. The wait completes when the same poll reports deployment status
`succeeded` and the intended revision in the Agent's `activeRevisionId`. A
previous-attempt code describes an earlier report, not the current cause of
delay. These observations have polling granularity. They do not measure phase
durations or prove that the Agent can serve requests.

If a channel proxy deployment is slow, find its `wait` time in the log. Look
for `sampled gateway Pod intervals` with the same deployment label. The three
intervals cover creation to scheduling, scheduling to Gateway container start,
and container start to the latest time the Pod became Ready. Values are in
milliseconds. The Pod timestamps have whole-second precision and can come from
different clocks. The test reads the selected Pod after deployment and omits
intervals it cannot measure. A failed deployment can have no sample. The
intervals exclude work before Pod creation and can extend past the deployment
wait if readiness changed again.

To see where the time before Gateway creation went, compare three log fields
for the same deployment. Each measures milliseconds since PostgreSQL recorded
the Agent revision.

| Field                               | Event                                                    |
| ----------------------------------- | -------------------------------------------------------- |
| `revisionToHarnessPodCreationMs`    | Kubernetes created the sampled Harness Pod.              |
| `revisionToHarnessPodLatestReadyMs` | The Harness Pod last became Ready, if it is still Ready. |
| `revisionToPodCreationMs`           | Kubernetes created the sampled Gateway Pod.              |

For example, if the Harness Pod appeared at 2 seconds, became Ready at 18 seconds,
and the Gateway Pod appeared at 20 seconds, look first at Harness startup. The
Gateway can also appear first. The test reports Harness timings only when one
live Harness Pod matches the Agent and revision in the same Pod list.

Either Pod can be a replacement. Timestamps come from different clocks, and
Pod timestamps have whole-second precision. These samples cannot establish
which component waited for another or how long users lost access. The test omits
missing or invalid values and offsets outside 0–60 minutes.

For tests with real model providers and browser interaction, use [QA Matrix Advisory](qa-advisory.md).
A skipped job does not verify the installed Agent workflow.

## Files

- [CI workflow](../../../.github/workflows/ci.yml): job eligibility, runner, tools, and execution steps.
- [Smoke script](../../../scripts/ci/first-agent-smoke.ts) dispatches the command, runs the smoke phases, and reports results.
- [Image selection](../../../scripts/ci/first-agent-smoke/images.ts) builds, publishes, and selects images for Local Setup.
- [Local Setup and model routing](../../../scripts/ci/first-agent-smoke/setup.ts) install the stack, capture startup diagnostics, and route model traffic.
- [Agent checks](../../../scripts/ci/first-agent-smoke/agents.ts) verify deployment, chat, logs, and stop/start.
- [Public reader checks](../../../scripts/ci/first-agent-smoke/reader.ts) install the reader, verify access and retirement, and collect failure diagnostics.
- [First-Agent helper](../../../scripts/first-agent.ts): embedded Agent workflow.
- [Local Setup](../../../internal/occdev/up.go): installation entry point used by the CLI.
