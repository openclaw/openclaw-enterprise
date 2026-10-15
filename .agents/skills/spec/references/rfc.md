# RFC workflow

## Invocation

`$spec rfc <description>` creates or updates the decision document that owns
the requested architectural change. An explicit existing ID or path selects a
revision of that document, subject to historical preservation.

## Establish the decision

1. Read `AGENTS.md`, `docs/contributing/specifications.md`,
   `docs/contributing/rfcs.md`, and `specs/README.md`. The first owns repository
   boundaries; the specification process owns numbering and lifecycle; the
   RFC process owns feedback and review.
2. Search existing RFCs and plans for the decision before creating another.
   Read relevant current references and `docs/design.md` implementation status,
   then inspect the actual caller, contracts, implementation, and meaningful
   tests. Distinguish implemented behavior, requirements, and unverified claims.
3. Identify the reader's decision: the problem and affected caller, the smallest
   proposed change, existing owner, trust and state boundaries, and consequential
   alternatives. Ask only about missing choices that materially change the
   proposal; record unresolved decisions and who can resolve them. Do not invent
   acceptance or policy approval.

## Draft or revise

For a new document, allocate an RFC ID by the specification process, then use
the frontmatter and proposal scaffold in `docs/contributing/rfc-template.md` at
`specs/rfcs/<number>-<topic>.md`. This contributor template is the shared source
for both manual authoring and this skill; do not maintain a second copy in the
skill assets. If companions are needed, write the main document at
`specs/rfcs/<number>-<topic>/index.md` and put companions in the same directory.
When converting an existing single file, preserve its ID and content and update
all incoming and relative links; do not leave a top-level duplicate.
Start the file with YAML frontmatter containing `status: Proposed`,
`implementation_status: Not implemented`, and the required `author` GitHub login,
as defined in the specification process. Treat the author as the RFC owner;
keep attribution in frontmatter and the index without repeating it in the body
or adding a separate owner field. Companion
Markdown notes use an `rfc` frontmatter link to the main document and inherit
its decision status; do not duplicate the status in companions. When adding
metadata to historical RFCs, use recorded decision evidence. If no decision is
established, use `status: Unspecified` with a `status_note` explaining the gap,
without rewriting historical body text. Recheck that the path and number are not
already assigned before writing. Use the specification process's old-to-new lookup
to resolve historical RFC names; never guess from a duplicated old number.

State the proposed decision early, followed by the behavior and ownership needed
to assess it. Include security and failure consequences beside the affected
boundary. Explain meaningful alternatives, including retaining current behavior
when relevant; do not enumerate implausible choices to fill a template. Keep
required observable outcomes in the RFC and detailed execution in its plan.
Use a diagram only when it clarifies an interaction or boundary.

A small change can retain a short delivery section. For a bigger feature, link
an existing implementation plan or name the next `plan` step. Do not create a
second document automatically unless the request includes planning.

When revising, preserve historical decisions and Manual Notes exactly. Edit an
active proposal to reflect discoveries; create a linked successor for a
substantial change to a historical decision. Never mark the RFC Accepted because
it was drafted, a plan exists, or implementation began. Follow the contribution
policy and actual decision evidence.

## Finish

- Remove unused template prompts and optional sections. Keep links repository
  relative, and verify their paths and any referenced heading anchors.
- Add or update the RFC’s row in `specs/README.md`, showing its linked number
  and name in the first column, the emoji for `implementation_status` from the
  index legend in the second,
  evidence or remaining gaps in the third, and the author in the fourth. Keep the row synchronized when the
  name, implementation status, or author changes. Link the RFC and plan
  to each other when both exist.
- Check the document against current source, scope, alternatives, failure
  behavior, and required outcomes. Apply the technical-writing clarity pass.
- Run documentation length and link checks, and formatting for changed authored
  files using the installed toolchain. Include `node scripts/check-specs.mjs`,
  also run by `pnpm docs:check`, for spec metadata and link targets.
  Do not install dependencies or run product
  tests for RFC prose. Follow any explicitly requested independent review.
- Report the document path and ID, proposed decision, material open choices, and
  checks run. Distinguish the author's recommendation from an accepted decision.
