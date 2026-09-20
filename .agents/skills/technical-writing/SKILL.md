---
name: technical-writing
description: Write, edit, or review Enterprise developer documentation, specifications, and technical instructions from current source evidence; always finish with a plain-language cleanup.
dependencies: []
---

# Technical writing

Use for repository documentation, including READMEs, guides, references, flow
docs, specifications, and technical PR descriptions. Read the applicable
`AGENTS.md` first; it owns documentation destinations, length limits, and
repository terminology. This skill needs no global tools or skill installation.

## Establish the reader and evidence

1. Identify the reader, intended action or decision, page scope, and source of
   truth. Read current code, schemas, tests, command output, and the relevant diff.
2. Choose the requested mode: create from evidence, edit while preserving useful
   facts and the author's intent, or review with findings before proposed fixes.
3. Lead with what the reader can accomplish and one recommended path. Mention
   implementation first when explaining architecture or internals is the task.
4. Verify claims, examples, defaults, paths, and failure behavior. Label material
   uncertainty and name the missing evidence; polished prose is not verification.
5. Before handing off any writing, complete the [required plain-language pass](#always-deslop-the-writing).

## Write precise prose

- Use present tense, active voice, concrete nouns, and one term per concept.
  Expand unfamiliar abbreviations at first use; use established product names.
- Define unfamiliar concepts through their owner, action, and observable role.
  Replace “the controller handles deployment” with what it reads, decides, and
  starts, when those details matter to the reader.
- Make every sentence help the reader decide, act, or understand a boundary.
  Delete repeated background, meta-commentary, and generic benefits.
- Treat `all`, `only`, and `never` as literal claims. Name the surface they cover.
  Use `must` for requirements and `can` for options; preserve consequential limits.
- Use sentence-case, action-specific headings and descriptive links. Explain why
  when it changes a decision or prevents a failure.
- Give each contract, default, and behavior one owning page. Link its definition
  from other pages rather than copying it into competing references.
- Make diagrams agree with prose: actors and resources are nodes, containment
  uses regions, and arrows describe interactions. Do not imply deployment proof
  from source alone or rely on color alone to convey meaning.

## Always deslop the writing

Run this pass whenever you write, edit, or review prose, including small changes,
PR descriptions, and review findings. The user does not need to request it.
For edits, clean up the prose in scope and read the surrounding text for flow.
For a review-only task, clean up your feedback and flag wording in the document
when it obscures meaning; do not silently rewrite the source.

- Name who does what and under which conditions. Replace vague verbs and noun
  piles such as “performs readiness observation” with “checks whether the
  workload is ready.” Prefer familiar words; define necessary technical terms.
- Delete filler, canned transitions, empty claims, and repeated explanations.
  Remove contrasts or caveats the reader does not need. Avoid invented labels.
- Put the main point first. Split a sentence when the reader has to untangle
  several actions, actors, or conditions; give each paragraph one main point.
- Check the edit against the original and the evidence. Preserve scope, required
  actions, permissions, warnings, failure behavior, and uncertainty. Do not make
  an unsupported claim sound certain or cut a useful detail merely to shorten it.

## Choose the smallest useful page

| Page                          | Include                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview or README            | Reader outcome, scope, recommended starting path, and links to detail.                                                                                       |
| Quickstart                    | Prerequisites, minimum configuration, one runnable example, expected result, and next step.                                                                  |
| Operator guide                | Inputs, command, completion evidence, and recovery in execution order. Keep required inputs separate from optional inputs and show defaults beside options.  |
| API or CLI reference          | Purpose, permissions, exact inputs, defaults, constraints, outputs, side effects, errors, and examples. Keep generated schemas owned by their generator.     |
| Testing guide                 | Setup, fixtures and permissions, success/failure proof, cleanup, and differences from production.                                                            |
| Troubleshooting               | Observable symptom, first discriminating check, likely causes, concrete fix, and proof of recovery.                                                          |
| Architecture or specification | Selected model, owners, boundaries, invariants, tradeoffs, and proof; read [specification guidance](./references/specifications.md).                         |
| Runtime flow                  | Trigger, source pointers, runtime order, state and ownership transitions, decisions, failures, and handoff; follow the repository's local-dev flow contract. |

Omit empty or irrelevant sections. Split independently useful topics when a page
mixes too many reader tasks. Keep the root documentation map and affected links
current, following repository page ownership and length limits.

## Driver contracts

When writing or rewriting a base Driver contract, read and follow the
[Driver contract template](./references/driver-contracts.md). Use its eight
sections: Overview, Interface, IAM, Lifecycle, Limits, Troubleshooting,
Implementations, and Related. Keep concrete backend setup and behavior in
implementation pages; the template takes precedence over the generic option to
omit sections.

## Make examples usable

Show realistic, safe inputs and exact identifier types. Mark placeholders
clearly, quote YAML values when needed, and specify each code block's language.
Include the working directory, prerequisites, invocation, and expected success
output when they are necessary to run a command. Verify examples when feasible;
report when they have not been executed.

Put permissions, secret handling, destructive effects, concurrency limits,
timeouts, ordering, retries, and recovery beside the affected step when mistakes
have consequences. Separate development, test, and production behavior. Never
include real credentials. Remove explanation before removing information needed
for a command to succeed safely. Keep internal orchestration in its owning flow
or reference unless the operator needs it to make a decision.

## Edit and verify

Correct inaccurate or unsafe claims first, add missing requirements or failure
handling, then remove repetition and tighten prose. Update current docs with the
behavior they describe; mark a page stale with a source-of-truth link if a full
update cannot be completed. Preserve historical specs and user-owned Manual Notes.
Do not rewrite history to match later implementation.

Check commands, examples, terminology, local links, and navigation. Follow the
repository's documentation checks and applicable formatting; report checks run
and gaps. Technical prose changes alone do not require product runtime tests.

For a review, cite the conflicting text, explain its consequence, and suggest
the smallest correction. Order findings by reader impact, distinguish
correctness from optional polish, and state what evidence was checked. Say when
no actionable findings remain.

## Provenance

Adapted from Docy's core technical-writing and document-lifecycle guidance,
developer documentation, concise instructions, and specification references.
The repository maintains this self-contained selection; see the developer-skills
catalog for source details. Docy's CLI and personal installation are not required.
