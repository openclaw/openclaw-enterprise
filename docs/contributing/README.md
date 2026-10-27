# Platform developer guide

Use this guide to change OpenClaw Enterprise: the control plane, console, CLI,
Drivers, deployment packaging, or documentation. For a first code change, start
with [Local development](local-development.md) and the [first-change walkthrough](first-change.md).
To use or administer an installation, start with [Getting Started](../README.md).

To schedule work, follow [Add issues to a sprint](sprints.md) to create tasks or
assign existing issues to a two-week iteration in the project.

## Find the code and its design

- [Design](design.md) links the platform architecture, remaining design work,
  and source-backed implementation guides.
- The [RFC guide](rfcs.md) explains how to propose architectural changes and
  request feedback; start with the [RFC template](rfc-template.md).
- [RFCs and implementation plans](specifications.md) explains document choice,
  numbering, delivery tracking, and the repository-local spec skill.
- [Design philosophy](design-philosophy.md) guides interface, ownership, and
  lifecycle decisions; [Readable code](readable-code.md) works through the
  practical choices with one example.
- [Repository layout](../layout.md) shows who owns each directory and where to
  put code, tests, and documentation.
- [Driver development](driver-development.md) links the base interfaces for
  building or changing a Driver.

## Build, test, and debug

- [oce-cookbook](../../.agents/skills/oce-cookbook/SKILL.md) provides maintenance
  recipes only when deliberately invoked. Start with
  `$oce-cookbook update-openclaw-pin <ref>` to update the source pin and qualify its images.
- [Local development](local-development.md) covers the checkout, a running local
  platform, and how to choose checks for your change.
- [Console components and styles](console-ui.md) shows how to build a page with
  the shared controls, typography, and layout.
- [Console Storybook](console-storybook.md) lets you inspect console pages, states,
  and Agent flows with simulated API responses; its
  [Agent workflows](console-storybook-agent-workflows.md) walk through each Agent story.
- [Runtime flows](runtime-flows.md) helps you trace requests, worker operations,
  and Agent deployment in the source.
- [Documentation](documentation.md) explains where pages belong, how to name them,
  and how to build and check the site.
- [Documentation hosting](documentation-hosting.md) covers private publication,
  the custom domain, and the approval required to enable public access.

## Release

Use the [release guides](../release/README.md) to configure publication workflows
and publish containers, Helm charts, and OCC CLI binaries.

Read the [contribution policy](../../CONTRIBUTING.md) before opening a pull
request. It covers repository access, verification, review, and private security
reporting.
