# Platform design

Start with [platform architecture](../design.md) to understand the OpenClaw
Control Plane's components, ownership, and trust boundaries. Its
[implementation status](../design.md#implementation-status) and
[remaining design work](../design.md#remaining-design-work) distinguish current
behavior from approved requirements that are not yet supported.

## Find the right source

- The [RFC guide](rfcs.md) explains how to propose architectural decisions and develop
  them alongside implementation.
- [Design philosophy](design-philosophy.md) explains how to put complete caller
  tasks behind small interfaces with clear ownership and failure behavior.
- [Readable code](readable-code.md) develops those principles through functions,
  values, composition, and an illustrative TypeScript example. Use the
  [design-review skill](../../.agents/skills/design-review/SKILL.md) to assess a
  design or refactor through a supported caller.
- [Driver development](driver-development.md) collects the base contracts for
  extending infrastructure behavior. For supported products and setup, use
  [Integrations](../guides/integrations/README.md).
- [Runtime flows](runtime-flows.md) trace how the current code processes
  requests, deploys Agents, and runs background work.
- [Repository layout](../layout.md) maps packages and source directories to
  their owners.
- [RFCs and implementation plans](specifications.md) explains how to record
  decisions and delivery. The [specification index](../../specs/README.md) links
  individual workstreams; their recorded status is not proof of availability.

Keep architecture pages about components, ownership, trust boundaries, and major
interactions. Put a feature's detailed behavior in its current reference and
link it from architecture when it changes a system boundary. See
[Documentation](documentation.md) for file ownership and verification.
