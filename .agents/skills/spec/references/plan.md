# Implementation plan workflow

## Invocation and destination

Use `plan <description>` for implementation planning, whether or not an RFC
exists. Use `plan RFC-0001 <description>` or an explicit RFC path when the caller
selects its architectural owner.

Read `AGENTS.md`, `docs/contributing/specifications.md`, and `specs/README.md`.
Follow the specification process for numbering and historical exceptions:

- For the first plan of an owning RFC, reuse its number and topic under
  `specs/plans/`, unless an existing task already owns that work. Keep that
  task’s ID and path when making it the primary plan.
- Update an active plan within its scope. For materially different follow-up
  work under the same RFC, allocate a fresh `TASK` ID and link the RFC in
  frontmatter. Preserve the completed primary plan.
- Without an RFC, allocate an independent task ID under `specs/plans/`.
  An implementation plan does not require an artificial RFC.
- Search for the existing owner first. Resolve an explicit ID exactly; if a
  historical number names multiple documents, use the topic/path or ask. If an
  explicit RFC cannot be found, clarify rather than silently creating a task.
- An existing task plan that later gains an RFC keeps its ID and path. Link the
  relationship in frontmatter and preserve the work instead of duplicating or
  relocating it.
- Use document IDs to identify the numbering sequence; all plans share one directory.

Use one Markdown file by default. When companions are needed, use
`specs/plans/<number>-<topic>/index.md` and put companions beside it. When converting an existing single file, preserve its ID and content,
update incoming and relative links, and remove the former top-level file.
Recheck number and path collisions before writing. Do not change the archive
during normal plan authoring.

## Gather evidence

Read the owning RFC or existing architecture, affected current reference and
flow docs, and the real source and tests. Identify the caller, selected owner,
current contract, resource scope and identity, state/lifecycle effects, existing
invariants, and consequential failure or recovery behavior.

Before proposing a new field, state, interface, or component, identify its real
producer, consumer, and need. Stay within approved platform boundaries. If
planning uncovers an unresolved architectural decision, flag it and link or
propose an RFC; do not silently treat the choice as accepted. Planning can
proceed alongside RFC review subject to actual holds.

## Write the plan

Start from the bundled `./assets/plan-template.md` (relative to `SKILL.md`).
Remove optional prompts that do not apply. For a new plan use delivery status
**Planned** and the allocated ID; retain an existing plan's evidence-backed status.
Set `rfc` in YAML frontmatter to the relevant RFC's path relative to the plan
file. Include `index.md` for an RFC in a folder. Omit the key (and an otherwise
empty frontmatter block) when no RFC applies. Preserve other existing metadata.
Adjust this link when moving either document; do not infer a relationship merely
from matching numbers. Keep additional RFC dependencies as body links.

1. State the observable outcome and selected scope. Link the RFC's requirements
   instead of repeating its rationale and complete design. For an independent
   plan, describe the selected contract and existing architectural authority.
2. Identify affected owners and repository touchpoints. Record implementation
   decisions only where needed to make the work executable; link unchanged
   contracts rather than restating them.
3. List concrete ordered changes, including the supported caller, platform
   integration, and required current documentation. Use phases only for
   independently useful outcomes or real sequencing dependencies. Put required
   access, credentials, infrastructure, risks, and recovery beside the work
   they affect. Do not add speculative components or migration procedures.
4. Pair material success and failure outcomes with their real verification path.
   Use the enterprise-testing guidance. New platform functionality requires
   integration through the supported Agent workflow; mocks of the behavior under
   proof do not satisfy it. Planning names these checks; it does not claim to
   have run them. Name unavailable prerequisites and remaining proof explicitly.
5. Keep Open decisions only for unresolved choices that affect implementation.
   Record the owner or evidence needed to resolve them and any blocked work.
   Do not turn optional feedback into an invented approval gate.

## Maintain and finish

Update scope, dependencies, checklists, and evidence as work proceeds. Required
proof that has not run keeps its milestone incomplete. Record completion with
actual implementation and verification evidence and current-documentation links;
never equate RFC acceptance or a green fixture suite with full delivery.

Preserve existing Manual Notes byte-for-byte. Keep historical contracts and
results intact; use a new linked plan for materially different follow-up work.
Completed and stopped plans stay in place. Put substantial evidence beside the
plan's `index.md` only when needed, and keep PR media outside the repository.

Link the RFC back to its plan when present. Keep plans out of the RFC-only
`specs/README.md` index. Record plan status only in its owner. Use the template's change
record for material authoring updates, with actual date, source revision, and
session identifier when available; never fabricate provenance.

Review for duplicate requirements, unnecessary phases, unsupported interfaces,
and missing caller or failure proof. Run documentation length, link, and scoped
formatting checks using the installed toolchain. Run `node scripts/check-specs.mjs`
(or `pnpm docs:check`, which includes it) to check spec metadata and link targets.
Do not install dependencies or run product tests merely to validate a plan. Follow requested independent review.
Report the ID/path, RFC relationship or independent scope, open blockers, and
checks performed. Stop at planning unless implementation was also authorized.
