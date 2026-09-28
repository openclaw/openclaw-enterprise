# Flow documentation workflow

## Destination and scope

Use `docs/flows/<behavior>.md` from the repository root. Search the docs map and
existing flows first; update the current behavior owner rather than creating a
per-task or per-PR duplicate. Preserve established filenames and split lifecycle
phases only when each is independently useful. Link new pages from the relevant
docs map, reference, or parent flow. Keep proposed behavior in specs, not a flow
that claims to describe current implementation.

## Authoring contract

For new docs, copy [the template](template.md) and fill every placeholder.
Use these sections in order:

- **Overview:** State what happens, the external trigger, purpose, environment,
  and where the lifecycle stops.
- **Entry Points:** Name the trigger, required state/context and permissions,
  and one to three actual `path/to/source.ts:functionName` or `path:line`
  pointers. Source paths are relative to the repository root.
- **Flow:** Include a Mermaid `graph TD` diagram showing the main execution path
  and branches that materially change outcomes. Use concrete actions, state
  changes, and owners; label decision edges. Omit trivial guards. The diagram
  must agree with the trace, not just connect three generic boxes.
- **Execution Trace:** Use runtime-ordered numbered `###` phases with precise
  file/function or file/line pointers in each. Follow execution, not a catalog
  of subsystems. Explain live inputs, state changes, snapshot/freeze points,
  ownership boundaries, external calls, consequential branches and failure
  outcomes where they occur. Distinguish callback registration from execution,
  and explain returns or deferred work when relevant. End with terminal state,
  observable effects, and the next owner's handoff contract. Keep excerpts
  short; add nested steps or `ts` pseudocode only when they clarify real logic.
- **Debugging and Verification:** Give actionable commands, logs, metrics,
  failure signatures, and expected outcomes. State what evidence proves and
  what remains unverified. Use `None identified` if no relevant signal exists.
- **Related docs:** Link adjacent phases and the owning architecture, reference,
  guide, testing page, or design. Use Markdown links relative to the document;
  never embed personal checkout paths.
- **Manual Notes:** Preserve the heading and complete user-owned body exactly.
- **Changelog:** Prepend local `YYYY-MM-DD HH:MM`, description, actual current
  session/run ID or recorded public authoring-run ID, and current Git SHA in the
  template's format.

Keep entry assumptions, internal freeze points, exit state, and downstream
handoff explicit for a scoped flow. Name the next owner and link its flow;
do not follow every dependency past the declared stop point. Add `Notes` before
Manual Notes only for useful detail that does not belong at a decision point.

## Source and provenance

Read the current implementation and affected tests before drafting. Verify
pointers and links against that source; distinguish verified behavior from
inference and gaps. Update affected current documentation in the same change.

Set `created`, `updated`, and `last_updated_session` in frontmatter. Preserve
`created` on revisions. Obtain the current session/run ID from the agent host's
provided task metadata; no personal lookup tool is required. If the host exposes
no ID, or its ID must remain private, create and report an authoring-run ID with
`python3 -c 'import uuid; print(uuid.uuid4())'` and label it `authoring-run/<id>`.
Record the authoring operation and any host mapping privately; do not present
the public authoring-run ID as a host session ID. Obtain provenance with `date '+%Y-%m-%d %H:%M'` and `git rev-parse HEAD`. The SHA records the inspected
revision; the changelog description identifies accompanying uncommitted changes.

Only when explicitly producing a PR-scoped document, use `# PR <number>:
<Feature> Flow` and add `pr: <number-or-url>` to frontmatter. Ordinary development
updates retain the behavior-named owner and do not need PR metadata.

## Revision and validation

1. Read the existing document and source for the changed path. Preserve useful
   detail, established structure, and user-requested diagram formats. Legacy
   `Sequence Diagram` and `Observability` headings remain valid; do not rename
   solely for template conformity.
2. Search for Manual Notes and preservation markers before editing. Do not
   modify, reflow, move, remove, or append inside that section unless the user
   explicitly asks. Compare its heading and complete body before/after; revert
   any accidental changes there.
3. Make targeted corrections, refresh provenance, and remove placeholders
   outside Manual Notes. Avoid unrelated rewrites and ceremonial expansion.
4. From the repository root, run (replace the example document path):

   ```sh
   python3 .agents/skills/local-dev/scripts/validate_flow_doc.py --kind flow-doc --doc docs/flows/<behavior>.md
   ```

   Python 3.10+ is required; the script has no third-party dependencies. Exit 0
   prints `PASS`; exit 1 reports structural errors; exit 2 reports invalid input.
   Fix reported errors before handoff, and review warnings. Validate only created
   or revised flow docs, not the unfilled template or unrelated legacy docs.

5. Run `pnpm docs:check` and `git diff --check`. Check local links and source
   pointers, inspect diagram meaning, and parse/render Mermaid with available
   repository tooling. Report rendering gaps honestly. The bundled validator
   checks structure, pointer syntax, placeholders, portable links, and changelog
   shape; it does not prove pointer existence, Mermaid syntax, preservation across
   revisions, provenance authenticity, or runtime correctness. Review these
   separately and run the changed behavior's required tests.
