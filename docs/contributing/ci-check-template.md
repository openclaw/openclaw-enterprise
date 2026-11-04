# Document a CI check

Use this template for pages under `docs/testing/ci/`. Each page explains one
check from the [CI overview](../testing/ci.md#checks-and-gates): what it verifies,
when its result applies, how to run it, and how to interpret the evidence.

## What each section must answer

| Section            | Reader's question                                       | Include                                                                                                                                |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Overview           | What does this check prove?                             | Purpose, system under test, and whether dependencies are real, simulated, or mixed.                                                    |
| When it runs       | Will my change run it, and does failure block anything? | Events, path filters, labels, skip conditions, and merge/publication consequences. Link exact workflow policy.                         |
| Scenarios          | What action produces which observable result?           | Setup/action, expected outcome, and source link. Include meaningful failure and authorization cases; group similar cases.              |
| Run it             | How do I reproduce this coverage?                       | One recommended command, prerequisites, credentials/environment links, selection rules, and required isolation.                        |
| Results and limits | What counts as a pass, and what remains unproved?       | Job/artifact names, skip semantics, scope, cleanup/recovery, and limits such as simulated model responses.                             |
| Files              | Where is the source of truth?                           | Workflow, exact manifest, test files, important helpers, and implementation entry points. State when no manifest or test suite exists. |

## Copy the template

Replace each instruction with source-backed content. The fenced example is an
authoring outline, not a runnable command or a page to publish unchanged.

```markdown
# Check name

## Overview

Describe the reader's reason to use the check and the boundary it verifies.
Identify real and simulated dependencies.

## When it runs

State the workflow events and selection/skip rules. Explain what a failure
blocks. Link the workflow for the exact policy.

## Scenarios

| Setup and action                       | Expected outcome              | Test source                       |
| -------------------------------------- | ----------------------------- | --------------------------------- |
| Describe the initial state and action. | Name an observable assertion. | Link the owning test or manifest. |

## Run it

Link prerequisites, permissions, credentials, and disposable-resource setup.
Show the recommended command and how to select this coverage. Keep required
cleanup beside the command or link directly to its owning procedure.

## Results and limits

Name the job and artifacts to inspect. Explain missing/skipped/partial results,
what success does not prove, and where to recover from failure. Do not report
an unexecuted scenario as passed.

## Files

- Workflow: link to the Actions YAML and describe its role.
- Manifest: link exact selection, inputs, and expected-case inventory.
- Tests: link scenario assertions.
- Helpers/implementation: link only files needed to trace the behavior.
```

## Keep pages useful

Describe scenarios as **given this setup, perform this action, expect this
outcome**. “Tests deployment” is too broad; “Stop the Agent; its Pods terminate,
then start admits a new revision and chat succeeds” is verifiable.

For large checks, group related cases and link exact manifests rather than
copying hundreds of test names. Add columns for presets or automatic selection
when they change coverage. For build/publication checks, describe validation
stages explicitly; do not invent runtime tests to fill the table.

Keep the CI index to one-line purposes and links. Check pages own triggers,
scenarios, and workflow-specific results; do not repeat those details in the index.
Keep setup and credentials in their existing suite guide. Link shared
[CI configuration](../testing/ci/configuration.md) and
[cleanup](../testing/ci/run-lanes.md#results-and-cleanup) instead of copying them.
Link the page from the overview table and register it once under **Testing & CI → CI**.
Preserve old anchors with short pointers when moving existing descriptions.

Keep expected behavior separate from an execution report: a passing PR does not
prove a manual or skipped lane ran. Put per-run commit IDs, timestamps, and
results in PR verification evidence rather than the living check page.

Validate source links, selection, and failure consequences against the workflow
and current tests. Run the [documentation checks](documentation.md#preview-and-check),
then inspect the rendered page and navigation. Do not run runtime tests solely
for this documentation change.
