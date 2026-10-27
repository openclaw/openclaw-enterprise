# Documentation templates

## Overview

Use these templates to write one useful page at a time. Choose the reader's task
and check for an existing owner before creating a page. Replace the prompts in
the selected template. Remove optional sections that do not apply; keep required
sections in the linked Driver, flow, RFC, and plan templates.

Start with a short Overview. Use the same subject names in indexes and detailed
pages. Give each fact, contract, and procedure one owner. Other pages summarize
and link to that owner. Keep current behavior separate from proposed work and
historical decisions.

| Type           | Use it for                                            | Starting point                                     |
| -------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Index / README | Orientation and links to a subject's detail           | [Index template](#index--readme)                   |
| Guide          | One task, including a quickstart or testing procedure | [Guide template](#guide)                           |
| Reference      | Exact supported behavior and contracts                | [Reference template](#reference)                   |
| Cheat sheet    | A compact lookup with links to definitions            | [Cheat sheet template](#cheat-sheet)               |
| Flow           | Runtime execution through current source              | [Existing flow template](#flow)                    |
| Specification  | A proposed decision or implementation plan            | [Existing specification templates](#specification) |

Follow [Repository layout](../layout.md#documentation-placement) for destinations
and [Write platform documentation](documentation.md) for naming, navigation,
and checks. A menu choice does not require a file move. The templates below
define page structure, not new navigation groups.

## Index / README

Own the starting path and links. Keep setup commands and full feature inventories
in their detailed pages. Use short descriptions that help readers choose a link.

```markdown
# [Subject]

## Overview

[Who this section helps, what it covers, and its boundary.]

## Start here

[Link the recommended first page and state the result it helps achieve.]

## Find a task

| Task            | Owning page                                   |
| --------------- | --------------------------------------------- |
| [Reader's goal] | [Link using the detailed page's subject name] |

## Related

[Link adjacent subjects only when they help the reader continue.]
```

## Guide

Own one complete procedure. A quickstart uses the minimum steps for first
success. Testing uses this same template: put fixtures and permissions in
Requirements, success and failure cases in Steps, and proof limits in Verify
the result. Add cleanup for resources created by the procedure.

```markdown
# [Verb and task]

## Overview

[Outcome, intended reader, and supported environment.]

## Requirements

- [Required version, access, input, or existing resource and how to check it.]
- [Link shared setup instead of repeating it.]

## Steps

1. [Action. Put permissions, side effects, and consequential limits here.]
   [Working directory, exact command or UI action, and expected result.]
2. [Next action and expected result.]

## Verify the result

[Observable check and expected outcome. State what this proves and what it
does not prove. A testing procedure also checks consequential failure cases.]

## Cleanup

[Remove only resources created by this procedure. Omit if none need cleanup.]

## Troubleshooting

| Symptom            | First check                          | Recovery and proof |
| ------------------ | ------------------------------------ | ------------------ |
| [Observed failure] | [Check that distinguishes its cause] | [Fix and recheck]  |

## Related

[Link the owning reference and the next useful task.]
```

## Reference

Own supported behavior, defaults, and constraints for a defined surface. Link
procedures and test-only settings to their guides. For a base Driver contract,
use the [`reference/driver` template](../base-driver-docs-template.md), which owns
its required sections. Generated API pages remain owned by their generator.

```markdown
# [Surface] reference

## Overview

[Purpose, owner, scope, and supported environments.]

## Interface

[Exact operation, command, or contract. State authentication and permissions.]

## Inputs

| Name               | Type   | Required / default       | Meaning and constraints |
| ------------------ | ------ | ------------------------ | ----------------------- |
| [Exact identifier] | [Type] | [Requirement or default] | [Units, scope, limits]  |

## Results and effects

[Outputs, state changes, side effects, and lifecycle rules.]

## Errors and limits

[Error conditions, observable response, recovery, and supported limits.
State precedence and retry behavior where they affect this contract.]

## Examples

[One realistic invocation and representative result. Link shared setup.]

## Related

[Link procedures, implementation flows, and adjacent contracts.]
```

## Cheat sheet

Provide a fast lookup. Do not introduce a second definition of a contract or
copy setup. Use exact names and link every entry to its owner. Update generated
cheat sheets through their generator.

```markdown
# [Subject] cheat sheet

## Overview

[What this lookup covers and which source owns the definitions.]

## Lookup

| Name         | Purpose             | Owning definition                      |
| ------------ | ------------------- | -------------------------------------- |
| [Exact name] | [Short description] | [Link to the specific page or section] |

## Related

[Link the setup guide or next useful lookup.]
```

## Flow

Copy the repository's [flow template](../../.agents/skills/local-dev/references/flow-doc/template.md)
and follow its [authoring workflow](../../.agents/skills/local-dev/references/flow-doc/workflow.md).
These remain the owning template and validation contract; do not create a second
scaffold from this summary.

The template contains Overview, Entry Points, Flow, Execution Trace, Debugging
and Verification, Related docs, Manual Notes, and Changelog. It also requires
creation and update metadata. Trace actual runtime order from a verified trigger
to the final effect or named handoff. Cite source in each phase and explain
state changes, ownership, and consequential failures where they occur.

The diagram and trace must describe the same behavior. Keep proposed execution
in a specification. Preserve user-owned Manual Notes when updating a flow.

## Specification

Select one of the existing templates through the
[specification process](specifications.md):

- **RFC:** use the [RFC template](rfc-template.md) for an architectural decision.
  Describe the problem, proposed design, owners, alternatives, and required
  outcomes. Keep decision status separate from implementation status.
- **Implementation plan:** use the [plan template](../../.agents/skills/spec/assets/plan-template.md)
  for concrete delivery work. State the outcome, contract and source touchpoints,
  implementation steps, verification, open decisions, and delivery record.
  Link the owning RFC when one exists instead of repeating its design.

Use each template's opening summary to explain its purpose and scope. Follow
the existing required metadata and heading structure. The specification process
owns numbering, placement, and status; this catalog does not redefine them.
Keep completed and superseded specifications as historical records. Update
current references and guides when implemented behavior changes.
