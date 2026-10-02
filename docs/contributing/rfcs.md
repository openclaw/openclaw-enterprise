# Propose an architectural change

Write a request for comments (RFC) when a change makes an architectural decision
the team needs to understand. An RFC explains the problem, the proposed decision,
and its consequences so that people can give useful feedback while work proceeds.
Start with the [RFC template](rfc-template.md) and adapt it to the change.
[RFCs and implementation plans](specifications.md) owns file placement,
numbering, status, and when to create a separate delivery plan.

Ordinary bug fixes, small features, and polish do not need an RFC. A large diff
alone does not make a change architectural. Reuse or update an existing RFC when
it already owns the decision. Follow the [contribution policy](../../CONTRIBUTING.md)
for review and merge.

## Develop the proposal

1. **Start with a real task.** Name the caller, current behavior, problem, and
   observable outcome. Read the relevant source and existing contracts; separate
   implemented behavior from the proposal and unfinished dependencies.
2. **State the decision early.** Explain the smallest useful change, why it
   solves the problem, and what is out of scope. Show what existing owners or
   mechanisms can be reused before introducing another component.
3. **Ask for human feedback early.** Open the RFC for review and link the code
   or planned implementation. Code and RFC revisions can proceed in parallel;
   waiting for an RFC response is not a prerequisite to starting implementation.
4. **Revise both as you learn.** Incorporate material feedback and implementation
   discoveries. Keep decisions, diagrams, and interfaces consistent with the
   final code. Record consequential open choices and who can resolve them.
5. **Land a coherent result.** Include the RFC and code in one PR or link their
   PRs and merge in dependency order. Resolve substantive findings and any
   specific security or team-decision hold. New contributors wait for maintainer
   feedback; core team authors follow the self-merge policy.

## Make the decision understandable

Aim for **under three pages** for the decision and its essential design. This is
a target, not a reason to remove needed behavior. Link substantial supporting
contracts or analysis when they have a distinct purpose, and keep enough in the
RFC for a reviewer to understand the decision without chasing links. If page
length matters, inspect a rendered or print view; word count alone does not
establish the number of pages.

Use plain language, concrete actors, and short paragraphs. Remove repeated
background and narration, but retain the security, recovery, ownership, and
verification details needed to assess the change. The
[design philosophy](design-philosophy.md) favors complete caller tasks behind
small interfaces. The [readable-code guide](readable-code.md) explains how to
keep decisions, effects, and state ownership clear.

Cover the details that matter to this decision:

- **Ownership and interfaces:** identify the caller and the owners of decisions,
  state, effects, and cleanup. Explain the changed contract, its inputs, results,
  and boundaries; link unchanged definitions rather than copying them.
- **Security and failure:** state relevant authority, trust and credential
  boundaries, defaults, denial behavior, and consequential failure or recovery.
  Explain what survives an uncertain outcome and who can act next.
- **Delivery and evidence:** identify the smallest connected result, genuine
  dependencies, and checks for success and material failure. Distinguish
  source review, integrated behavior, installed runtime, and live-service proof
  when they make different claims. Name unrun checks and unfulfilled requirements.

Use one or two diagrams for critical relationships or flows; add more when they
explain a distinct part of the decision. An ownership view and a request lifecycle
are useful starting points. Label proposed and implemented connections accurately,
show real process or trust boundaries, and explain meaningful failure paths. The
[Mermaid guidance](../../.agents/skills/mermaid-diagrams/SKILL.md) provides
readable conventions. Diagrams support the decision; they do not prove runtime
behavior.

Before requesting review, read the RFC as a new reader, then compare it with the
source and selected requirements. Check that the proposal answers the caller's
task, identifies its owners and limits, and preserves material decisions. Keep
private context and credentials out of the PR.
