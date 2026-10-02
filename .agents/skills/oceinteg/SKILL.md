---
name: oceinteg
dependencies: [enterprise-testing]
description: Run named OpenClaw Enterprise end-to-end integration scenarios against real supported installations. Use only when explicitly invoked.
---

# OCE integration scenarios

Use this skill only when the user explicitly invokes `oceinteg <scenario>` or
`$oceinteg <scenario>`. Do not activate it for general integration-testing requests.
Follow $enterprise-testing for real-runtime prerequisites, evidence, and failure
classification, then read only the selected scenario below.

| Invocation      | Scenario                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oceinteg main` | [Main acceptance test](./references/main.md): fresh installation, both runtime presets, repository permissions, Slack, Linear approvals, and native UI continuity. |

If the scenario is missing or unknown, show the available names and ask which
one to run. Do not substitute another scenario or start infrastructure work.
Creating or editing this skill does not run its scenarios.

Add future scenarios as `references/<scenario>.md` and register them here. Keep
each scenario's inputs, external effects, procedure, assertions, and cleanup in
its own reference. This is an agent workflow, not an installed shell command.

For `main`, also read [Runtime and isolation acceptance](./references/runtime-acceptance.md)
and [Supply credentials](./references/credentials.md). These are required parts
of main, not separately invokable scenarios.

Choose one setup reference per selected topology before running main:

| Topology                   | Setup                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| EKS with Helm OCC          | [EKS setup](./references/setup-eks.md)                            |
| Local k3d with Helm OCC    | [Kubernetes-only setup](./references/setup-k3d.md)                |
| Local k3d with Compose OCC | [Compose and Kubernetes setup](./references/setup-compose-k3d.md) |

These references sequence the user-facing guides; those guides own commands
and supported configuration. Setup references are not additional invocations.
