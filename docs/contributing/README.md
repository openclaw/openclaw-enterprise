# Platform developer guide

Use this guide to change OpenClaw Enterprise: the control plane, console, CLI,
Drivers, deployment packaging, or documentation. For a first code change, start
with [Local development](local-development.md) and the [first-change walkthrough](first-change.md).
To use or administer an installation, start with [Getting Started](../README.md).

## Find the code and its design

- [Design](design.md) separates the current architecture, approved target, and
  source-backed implementation guides.
- The [RFC guide](rfcs.md) explains how to propose architectural changes and
  request feedback.
- [Design philosophy](design-philosophy.md) guides interface, ownership, and
  lifecycle decisions; [Readable code](readable-code.md) works through the
  practical choices with one example.
- [Repository layout](../layout.md) shows who owns each directory and where to
  put code, tests, and documentation.
- [Driver development](driver-development.md) links the base interfaces for
  building or changing a Driver.

## Build, test, and debug

- [Local development](local-development.md) covers the checkout, a running local
  platform, and how to choose checks for your change.
- [Console Storybook](console-storybook.md) lets you inspect console pages, states,
  and Agent flows with simulated API responses.
- [Runtime flows](runtime-flows.md) helps you trace requests, worker operations,
  and Agent deployment in the source.
- [Documentation](documentation.md) explains where pages belong, how to name them,
  and how to build and check the site.
- [Documentation hosting](documentation-hosting.md) covers private publication,
  the custom domain, and the approval required to enable public access.

Read the [contribution policy](../../CONTRIBUTING.md) before opening a pull
request. It covers repository access, verification, review, and private security
reporting.
