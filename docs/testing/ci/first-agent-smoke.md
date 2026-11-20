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
model provider, so it tests deployment, chat, logs, and stop/start without proving access to a
real model service.

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
A failed main-push CI workflow can still block container and CLI publication,
which require successful CI for their source.

## Scenarios

The [smoke script](../../../scripts/ci/first-agent-smoke.ts) owns these checks;
it does not use a suite manifest.

| Setup and action                                                             | Expected outcome                                                                                                                                                                          | Source                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Build the checkout images and run Kubernetes-only Local Setup.               | Installation becomes available with the selected images.                                                                                                                                  | Smoke script: `buildImages` and `startLocalSetup`.                                  |
| Create embedded OpenClaw and dedicated Codex Agents. Send chat requests.     | Each runtime returns the expected reply. For each revision, an authorized reader finds the start and result of the turn in the audit API.                                                 | [First-Agent helper](../../../scripts/first-agent.ts) and smoke script: `chatTurn`. |
| Read gateway logs and dedicated Agent logs through the CLI.                  | `occ agent logs` returns nonempty logs for the selected sources.                                                                                                                          | Smoke script: `readLogs`.                                                           |
| Withdraw public Git reader access and deploy a revision without that access. | The old workload and policy are removed and open connections close. The retired revision and the successor without reader access make no further reads; the control Agent retains access. | Smoke script: `proveRetirement`.                                                    |
| Stop and start both Agents, then chat again.                                 | Stopped Pods terminate, starting the Agents creates new revisions, and both chat turns succeed.                                                                                           | Smoke script: `stopAgent`, `deployAgent`, and `chatTurn`.                           |

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

For tests with real model providers and browser interaction, use [QA Matrix Advisory](qa-advisory.md).
A skipped job does not verify the installed Agent workflow.

Use the `qa-openshell-k3d` pull request label to select the Kubernetes
[OpenShell test](../openshell.md#guided-native-openclaw-redeployment).
It starts a disposable installation with a Sandbox Driver, enables the same
audit setting, and tests two revisions of a dedicated OpenClaw Agent. The
test sends a message with `chat.send` and compares the ID in the audit event
with the ID in chat history. It reads the original text through the audit API
even if the model reports an error. Separate checks require the expected
reply and a tool result from the assigned worker.
After redeployment, the API must refuse to open the previous revision's message.

For embedded OpenClaw and dedicated Codex, the smoke test sends two messages
in one Gateway chat. A reader with `read_audit` can list the events. The
message request must return HTTP 403. The test grants `read_audit_content` on
the same Agent and opens the earlier event. Its message ID must match the ID
in chat history. Its text must match the first message.

For Codex, the test checks that PostgreSQL records the event ID when the
reader opens its message. The test then makes PostgreSQL refuse the next
disclosure record. The message request must return HTTP 503.

For each runtime, the installed test sends two requests to
`POST /agents/{agentId}/chat` in one session. Both requests contain the
same text. Each JSON response must have a different turn ID. The test
compares the message ID for each turn with the ID in chat history. An
authorized reader must get the exact text through the audit API.

In both OpenClaw modes, the test also sends two user messages in one
HTTP request. The turn must finish. Its audit event must omit the message
ID because the turn has two inputs. The message lookup must return HTTP 404.

For embedded OpenClaw, the smoke test finds the model call and its result
by turn ID. It then disables audit, deploys a new revision, and sends a
message. The test expects a reply and zero runtime audit records for that revision.

For dedicated Codex, the test matches the response ID from the test provider
to its hash in the audit API. It repeats this check after the provider rejects
the first request and Codex retries. It also checks the session records after
the first chat and session deletion. It checks the turn result after cancellation.

To test recovery, PostgreSQL temporarily rejects the record for the start of
one Codex turn. The provider receives the request. The test restarts the Gateway
in the same Pod, then restores database writes. It checks that the API returns
the original audit ID once and that the interrupted turn has no recorded result.

## Files

- [CI workflow](../../../.github/workflows/ci.yml): job eligibility, runner, tools, and execution steps.
- [Smoke script](../../../scripts/ci/first-agent-smoke.ts) dispatches the command, runs the smoke phases, and reports results.
- [Image selection](../../../scripts/ci/first-agent-smoke/images.ts) builds, publishes, and selects images for Local Setup.
- [Local Setup and model routing](../../../scripts/ci/first-agent-smoke/setup.ts) install the stack, capture startup diagnostics, and route model traffic.
- [Agent checks](../../../scripts/ci/first-agent-smoke/agents.ts) verify deployment, chat, logs, and stop/start.
- [Public reader checks](../../../scripts/ci/first-agent-smoke/reader.ts) install the reader, verify access and retirement, and collect failure diagnostics.
- [First-Agent helper](../../../scripts/first-agent.ts): embedded Agent workflow.
- [Local Setup](../../../internal/occdev/up.go): installation entry point used by the CLI.
