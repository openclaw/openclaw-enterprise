# Specification writing

Write the smallest decision-complete contract an implementer needs. Follow the
repository's authoritative design, approved scope, and spec destination. This
reference governs prose and design clarity; it does not authorize implementation.

## State the selected contract

Lead with the chosen model and its goal. Describe supported behavior positively;
put meaningful non-goals and deferred work beside their scope. Omit correction
history and rejected alternatives unless they explain a real tradeoff.

For each meaningful resource, name its authoritative owner, scope, identity,
cardinality, and permitted references. Explain sharing, ownership validation,
and immutable snapshots when later mutation matters. Name who owns each
credential, policy decision, and side effect, and what crosses trust boundaries.

Separate the invariant from its enforcement mechanism. “At most one active job”
does not itself require a new journal, worker, or lifecycle state. Justify each
new field, interface, and path by its current producer, consumer, and goal;
include persistence and operational cost when choosing the mechanism.

State the default, explicit alternatives, and failure behavior together. Define
what happens when a receiving service is unavailable. Do not invent fallback or
duplicate-authority paths without a concrete requirement.

## Make the work implementable

Use small request/response or before/after examples to expose meaningful seams.
Examples and diagrams must prove the prose, not introduce a different contract.
For a multi-actor lifecycle, show admission, authorization, validation,
persistence, dispatch, observable success, and a consequential denial or failure.

Name concrete work and repository touchpoints, then pair each material outcome
with an automated test or operational check. Use ordered steps by default;
introduce phases only for independently useful outcomes or material dependencies.
Keep risks, mitigation, access, and recovery beside the affected work.

Ask a concrete choice when an unresolved decision changes implementation; name
the competing outcomes and their consequences. Avoid speculative flexibility
and incidental algorithms or exhaustive wire types. Omit template sections that
add no decision, contract, or proof.

## Review the design

Check consistency among prose, interfaces, examples, tables, and diagrams first.
Then remove abstractions unsupported by the current goal; apply style edits last.
Retain explicit user decisions unless new evidence or requirements change them.
Preserve completed specifications as history; update the owning current reference
or a later spec when behavior changes.
