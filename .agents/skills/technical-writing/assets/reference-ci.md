---
kind: reference/ci
---

# Check name

## Overview

Describe the reader's reason to use the check and the boundary it verifies.
Identify real and simulated dependencies.

## Trigger

State the workflow events and selection/skip rules. Explain what a failure
blocks. Link the workflow for the exact policy.

## Scenarios

| Setup and action                       | Expected outcome              | Test source                       |
| -------------------------------------- | ----------------------------- | --------------------------------- |
| Describe the initial state and action. | Name an observable assertion. | Link the owning test or manifest. |

## Execution

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
