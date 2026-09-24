---
name: local-dev
description: Develop OpenClaw Enterprise changes with proportional verification and source-backed flow documentation for non-trivial behavior.
dependencies: [enterprise-testing, mermaid-diagrams, technical-writing]
---

# Local development

Use this skill for repository development changes. Read the root and applicable
nested `AGENTS.md`, the owning current reference, and relevant source before
editing. Keep work within the approved platform scope and preserve unrelated work.
Run repository commands from its root; bundled `./` paths below are relative to
this skill directory. No global skill installation is required.
Use explicit dependency records and focused factories when extracting behavior.
The [fixture and scenario conventions](../../../docs/testing/fixtures-and-scenarios.md)
apply the same composition rules to test infrastructure.

## HARD REQUIREMENT: OPEN-SOURCE CONTENT

THIS IS AN OPEN-SOURCE REPOSITORY. NEVER MENTION INTERNAL CODE NAMES OR
CORPORATE INTERNAL NAMES IN CODE, COMMENTS, DOCUMENTATION, EXAMPLES, TEST
FIXTURES, GENERATED ARTIFACTS, COMMIT MESSAGES, OR PULL REQUEST CONTENT.
THIS REPOSITORY SHOULD NEVER CONTAIN CORPORATE INTERNAL NAMES. USE PUBLIC
PRODUCT NAMES OR NEUTRAL, DESCRIPTIVE TERMS INSTEAD. CHECK THE ENTIRE PROPOSED
CHANGE BEFORE HANDOFF OR PUBLICATION AND REMOVE ANY SUCH REFERENCES. DO NOT
COPY INTERNAL CONTEXT INTO THIS REPOSITORY, EVEN AS BACKGROUND OR PROVENANCE.

## HARD REQUIREMENT: KEEP IMPLEMENTATION-SPECIFIC BEHAVIOR OUT OF THE CORE

IMPLEMENTATION-SPECIFIC FUNCTIONALITY MUST LIVE IN DRIVERS OR BACKENDS, NEVER
BE HARDCODED INTO THE PLATFORM CORE. CORE CODE MUST DEPEND ON PLATFORM CONTRACTS,
NOT SPECIAL CASES FOR A PARTICULAR IMPLEMENTATION, VENDOR, OR DEPLOYMENT.
EXTEND THE OWNING DRIVER OR BACKEND CONTRACT WHEN NECESSARY; DO NOT BYPASS IT
WITH IMPLEMENTATION-SPECIFIC BRANCHES, DEFAULTS, OR DIRECT CALLS IN THE CORE.

IF A DEVELOPER OR AGENT PROPOSES OR INTRODUCES SUCH A VIOLATION, CALL IT OUT
EXPLICITLY AND STOP THE SESSION'S IMPLEMENTATION WORK. IDENTIFY THE OFFENDING
CODE OR DESIGN, EXPLAIN THE OWNERSHIP BOUNDARY IT VIOLATES, AND ASK FOR A DESIGN
CHANGE THAT MOVES THE BEHAVIOR INTO THE APPROPRIATE DRIVER OR BACKEND.
DO NOT IMPLEMENT, COMMIT, OR PUBLISH THE VIOLATING APPROACH. RESUME ONLY AFTER
THE REVISED DESIGN RESOLVES THE BOUNDARY VIOLATION AND THE USER APPROVES IT.

## Workflow

1. Identify the user-visible outcome, owning primitive, real caller, and affected
   lifecycle. Inspect the diff and existing `docs/flows/` before choosing docs.
2. Implement the smallest complete change through the owning contract. Preserve
   the repository's authorization, state, and ownership invariants.
3. Apply the flow-doc trigger below. For a qualifying change, read
   [the workflow](./references/flow-doc/workflow.md) and update the existing
   behavior flow in the same change. Use [the template](./references/flow-doc/template.md)
   only when no existing document owns that flow. Use $mermaid-diagrams for
   diagram semantics. For these flow docs, override its notation defaults: start
   the Mermaid block with `graph TD`, omit Mermaid YAML frontmatter, and retain
   this workflow's required sections so the bundled validator accepts it.
4. Use $technical-writing when creating, editing, or reviewing documentation.
   Update affected current references, guides, and navigation. Preserve historical
   specs and user-owned Manual Notes. Do not create a second source of truth.
5. Use $enterprise-testing to select proportional checks and satisfy repository
   integration requirements for new functionality. For instruction-only changes,
   check docs, links, skill resources, and any bundled executable; do not run
   product runtime suites solely for prose. Never run `npm run precommit`.
6. Report changed behavior, the flow updated (or a short reason none is needed),
   checks run, and remaining verification gaps. Do not equate a structural doc
   check with proof of runtime behavior.

## When a flow doc is required

A change is **non-trivial** when it adds or materially changes a runtime path,
state transition, ownership or authorization boundary, persistence behavior,
external integration, asynchronous handoff, or consequential decision/failure
handling. This includes fixes and refactors that change how these work even if
an API signature stays the same. Size and line count do not decide the trigger:
a one-line authorization or retry-policy change can qualify.

Create or update a source-backed flow doc for every such change. Cover the
changed path and its meaningful boundaries, not every touched file. Prefer a
focused update to an existing behavior-named document under `docs/flows/`;
create a new one only for a distinct runtime flow without an existing owner.
Link adjacent phases instead of duplicating their traces.

Typos, formatting, copy/link corrections, comment-only edits, behavior-preserving
local renames, and test-only or instruction-only maintenance do not require a
new flow doc when they leave the documented lifecycle accurate. Correct stale
source pointers or flow claims if those edits invalidate them. An explicit
request for a flow doc still applies. Do not manufacture runtime documentation
for an instruction change merely to satisfy this skill.

## Resources and validation

- [Flow workflow](./references/flow-doc/workflow.md): source gathering, sections,
  preservation, provenance, and the required validator command.
- [Flow template](./references/flow-doc/template.md): scaffold for new flow docs.
- [Validator](./scripts/validate_flow_doc.py): portable structural checks using
  Python 3.10+ and only its standard library; no package installation needed.

Flow guidance and validator are adapted from Specy 2.0.0. The repository owns
this adaptation; it has no dependency on personal skills, memory stores, or
session lookup tools. See the developer-skills catalog for provenance.
