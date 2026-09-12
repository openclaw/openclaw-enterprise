---
name: deslop
description: Clean only the current Enterprise diff before autoreview, preserving behavior, security boundaries, required TODOs, and useful test-intent comments.
---

# Deslop

Keep cleanup confined to the current diff and strictly behavior-neutral. Use it
before requested [autoreview](../autoreview/SKILL.md); cleanup does not replace
correctness or safety review.

## Scope and checklist

Establish the intended branch base from the PR or repository metadata. Inspect
committed changes from its merge base to HEAD, plus staged, unstaged, and relevant
untracked changes. Preserve unrelated work; never sweep the repository or change
the base to make the cleanup larger. Read surrounding code to judge each hunk.

Look for:

- Comments that narrate syntax or repeat code without explaining intent.
- Unnecessary intermediate variables or one-use helpers that add no meaning.
- Type assertions such as `as any` or `as unknown as T` that hide a type problem.
- Defensive checks, catch blocks, retries, aliases, or fallbacks that appear
  inconsistent with the supported contract.
- Naming, imports, formatting, or control flow inconsistent with nearby code
  and [Enterprise style](../../../AGENTS.md#typescript-style-and-verification).

These patterns require judgment. Apply only trivial, demonstrably
behavior-neutral edits. Removing a guard, catch, retry, fallback, or type cast
can change behavior or expose a real type-contract defect: leave uncertain or
functional changes in place and report them for separate review. Do not hide
errors with wider types or replace security checks with assumptions.

## Preserve required intent

Keep real fail-closed checks, authorization and credential boundaries,
configuration rejection, and attributable audit behavior. Redundancy alone is
not evidence that a security check is removable.

Preserve [deferred-work TODOs](../../../AGENTS.md#deferred-implementation) while
the capability remains unimplemented. Preserve integration-test comments that
explain scenarios, non-obvious setup, expected outcomes, or security invariants;
remove only narration that contributes no such information. Do not label
permanent security boundaries as temporary work.

Use [enterprise-testing](../enterprise-testing/SKILL.md) for proportional
verification of edits and run `git diff --check`. If behavior neutrality cannot
be established, report the candidate instead of applying it as style work.
Summarize in one to three sentences what changed and any non-trivial candidates
left for the author.

## Provenance

Adapted from OpenClaw; see [source and intentional adaptations](../../../docs/testing/developer-skills.md#provenance-and-updates).
