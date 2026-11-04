---
kind: reference/ci
---

# First Agent Smoke

## Overview

First Agent Smoke installs the Kubernetes platform from images built from the checkout
and exercises embedded OpenClaw and dedicated Codex Agents. It uses a simulated
model provider, so it tests deployment, chat, logs, and stop/start without proving access to a
real model service.

<a id="when-it-runs"></a>

## Trigger

This is a job in the CI workflow, selected when CI Impact chooses `full` mode.
Documentation-only and recognized test-only changes skip it. CI also runs on
`main` pushes, merge groups, and manual dispatch.

The job is outside `CI Required`, so its failure does not fail that merge gate.
A failed main-push CI workflow can still block container and CLI publication,
which require successful CI for their source.

## Scenarios

The [smoke script](../../../scripts/ci/first-agent-smoke.mjs) owns these checks;
it does not use a suite manifest.

| Setup and action                                                                   | Expected outcome                                                                                                                                                                          | Source                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Build the checkout images and run Kubernetes-only Local Setup.                     | Installation becomes available with the selected images.                                                                                                                                  | Smoke script: `buildImages` and `startLocalSetup`.                                   |
| Create an embedded OpenClaw Agent and a dedicated Codex Agent; send chat requests. | Both Agents return the expected simulated-provider response.                                                                                                                              | [First-Agent helper](../../../scripts/first-agent.mjs) and smoke script: `chatTurn`. |
| Read gateway logs and dedicated Agent logs through the CLI.                        | `occ agent logs` returns nonempty logs for the selected sources.                                                                                                                          | Smoke script: `readLogs`.                                                            |
| Withdraw public Git reader access and deploy a revision without that access.       | The old workload and policy are removed and open connections close. The retired revision and the successor without reader access make no further reads; the control Agent retains access. | Smoke script: `proveRetirement`.                                                     |
| Stop and start both Agents, then chat again.                                       | Stopped Pods terminate, starting the Agents creates new revisions, and both chat turns succeed.                                                                                           | Smoke script: `stopAgent`, `deployAgent`, and `chatTurn`.                            |

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
node scripts/ci/first-agent-smoke.mjs images
node scripts/ci/first-agent-smoke.mjs run
```

The second command builds images; `run` requires those build results. Do not
substitute a production cluster for the script's disposable installation.

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

For tests with real model providers and browser interaction, use [QA Matrix Advisory](qa-advisory.md).
A skipped job does not verify the installed Agent workflow.

## Files

- [CI workflow](../../../.github/workflows/ci.yml): job eligibility, runner, tools, and execution steps.
- [Smoke script](../../../scripts/ci/first-agent-smoke.mjs): installation, lifecycle, reader isolation, diagnostics, and cleanup.
- [First-Agent helper](../../../scripts/first-agent.mjs): embedded Agent workflow.
- [Local Setup](../../../internal/occdev/up.go): installation entry point used by the CLI.
