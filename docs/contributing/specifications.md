# Write RFCs and implementation plans

Start with the [RFC index](../../specs/README.md) and the current
[platform design](../design.md). Reuse an existing decision or plan when it owns
the work. Follow [Contributing](../../CONTRIBUTING.md) for review and merge policy.

## Choose the document

An **RFC** proposes an architectural decision: the problem, selected approach,
alternatives, ownership, trust boundaries, and required outcomes. An
**implementation plan** turns an RFC or existing architecture into concrete
changes, dependencies, and verification.

- For an architectural decision, write an RFC using the [RFC process](rfcs.md)
  and [template](rfc-template.md). A small change can keep its delivery steps in
  a short RFC section.
- For a bigger feature with an RFC, write a separate implementation plan. Link
  the RFC's requirements instead of copying its rationale and design.
- For substantial work within existing architecture, write a standalone plan.
  A plan does not require an RFC. Routine fixes need neither document.

The repository-local [spec skill](../../.agents/skills/spec/SKILL.md) supports:

```text
$spec rfc <description>
$spec plan RFC-0001 <description>
$spec plan <description>
```

The first command drafts a proposal. The second creates or updates that RFC's
implementation plan. The third looks for an owning RFC and otherwise creates a
standalone task plan. These commands author documents; they do not approve a
decision or start implementing it. Existing authorization for broader work
still applies. No personal skill installation is required.

## Files and numbering

Use single Markdown files by default:

```text
specs/
  README.md
  rfcs/
    0001-runtime-trust.md
  plans/
    0001-runtime-trust.md
    0042-credential-cleanup.md
```

**RFC numbers and task-plan numbers are independent sequences.** Use the full
identifiers `RFC-0001` and `TASK-0042` in conversation and links. An RFC plan
reuses its RFC's number and topic; it does not allocate another number. Keep one
primary plan per RFC, with milestones inside it. Link additional relevant RFCs
as dependencies. All plans share `specs/plans/`; use the document's ID to
identify its numbering sequence, not its directory or the presence of an RFC link.

Update an active plan for work within its scope. For materially different
follow-up work under the same RFC, allocate a fresh `TASK` ID and link the RFC
in frontmatter. Keep the completed primary plan intact. If an existing task
becomes the primary plan for an RFC, retain its `TASK` ID and path instead of
creating an RFC-numbered duplicate.

When a plan relates to an RFC, set `rfc` in its YAML frontmatter to a path
relative to the plan file. For example, in `specs/plans/0001-runtime-trust.md`:

```yaml
---
rfc: ../rfcs/0001-runtime-trust.md
---
```

For `specs/plans/0001-runtime-trust/index.md`, the link would be
`../../rfcs/0001-runtime-trust.md`. If the RFC uses a folder, include its
`index.md` in the path. Omit `rfc` when no RFC applies. Keep this relationship
in the plan's frontmatter and use body links for specific requirements or other
RFC dependencies; the frontmatter link does not imply acceptance.

RFC entry points use a continuous sequence from `0001`, with unique numeric
prefixes of at least four digits. Allocate one above the highest RFC number on
the current base branch. Rejected and superseded RFCs stay in place so their
numbers remain occupied. Historical RFCs have been renumbered into this sequence;
see the [old-to-new lookup](#renumbered-rfcs).

An unmerged proposal does not reserve a gap on the base branch. Before merging,
recheck its number against the current base and renumber it and its links to the
next available ID if needed. Never overwrite an existing document.

Task-plan IDs keep their independent sequence. Historical shared numbers through
**41** remain reserved for task plans. Allocate one above the highest used task
number, starting at `0042` or higher; check `specs/plans/` and Git history so deleted
or renamed task plans do not free numbers.

Keep one row per RFC in `specs/README.md`, with its linked number and name in
the first column, its implementation-status emoji in the second, concise notes
in the third, and its author in the fourth. Use the index legend to map the
textual `implementation_status` to an emoji; keep frontmatter values unchanged.
Link current evidence and identify material gaps for partial work.
Keep the row synchronized with the RFC’s name, implementation status, and author. Link an RFC and its plan to each other; plans
are not listed in the RFC index. If a standalone task later gains an RFC, retain
its task ID and path and add the relationship.

When substantial evidence, diagrams, or independently useful milestones need
companions, use a directory named `<number>-<topic>/` with the main document at
`index.md` inside it. Move an existing `<number>-<topic>.md` into that directory
when adding companions; do not keep a second top-level document. Keep the same
ID, update incoming and relative links, and link companions from `index.md` and
back to it. This applies to RFCs, RFC-linked plans, and standalone task plans:

```text
specs/rfcs/0001-runtime-trust/
  index.md
  architecture.svg
specs/plans/0001-runtime-trust/
  index.md
  qualification.md
specs/plans/0042-credential-cleanup/
  index.md
  inventory.md
```

Do not create empty directories or a separate reports area. PR screenshots
and recordings remain outside the repository, as required by
[Console Storybook](console-storybook.md).

## Status and review

The RFC’s frontmatter records decision and implementation status separately.
Every RFC entry point must begin with `status`, `implementation_status`, and
`author`:

```yaml
---
status: Proposed
implementation_status: Not implemented
author: github-login
---
```

`author` is the original RFC PR author's GitHub login, without `@`. It is required
for every non-archived RFC entry point, regardless of status. For a new draft,
use the contributor who will open its PR. When backfilling, follow file history
through renames and use the original PR author, not a later editor or merger.
Do not replace authorship with a responsible team; describe responsibilities in
the proposal.

Treat the author as the RFC owner; do not maintain a separate `owner` field.
Show the author in the index, linking their GitHub profile and matching the
`author` frontmatter. Do not repeat the author in the RFC body. Preserve
historical responsibility statements in the proposal.

Companion Markdown notes have an `rfc` frontmatter link to the owning entry
point, relative to the note (usually `rfc: index.md`). Read the decision status
there rather than copying it into each companion. An optional `status_note`
can explain partial supersession, deferred scope, or historical ambiguity.

| Document      | Status values                            |
| ------------- | ---------------------------------------- |
| RFC decision  | Proposed, Accepted, Rejected, Superseded |
| Plan delivery | Planned, In progress, Completed, Stopped |

For historical RFCs whose records do not establish a decision, use
`status: Unspecified` and explain the missing evidence in `status_note`.
This is a historical metadata fallback, not a status for new proposals.
Preserve recorded body text and distinguish implementation progress from an
RFC decision; adding frontmatter does not establish acceptance or release proof.

`implementation_status` is **Not implemented**, **Partially implemented**, or
**Implemented**. Audit the scoped delivery against current source and references;
record the audited revision and verification limits in the index. Keep explicitly
separate future phases distinct from unfinished delivery. Update this field and
the index together without rewriting historical decisions or Manual Notes.
Implementation does not establish acceptance, live verification, or release readiness.

New RFCs start **Proposed** and **Not implemented**. Record acceptance or another decision only when
supported by the responsible reviewers' decision or the contribution policy;
drafting a plan is not acceptance. If an RFC contains its own delivery steps,
track delivery separately from its decision status.

Request human feedback early. Planning and implementation can proceed while
the RFC is reviewed, subject to [review policy](../../CONTRIBUTING.md#prepare-a-pull-request)
and any specific holds. Keep an active RFC and its plan consistent as decisions
change. Follow the repository's independent-review workflow when requested.

A plan names the real caller, affected owners and files, ordered work, material
dependencies, and observable success and failure checks. Use phases only when
they deliver independently useful outcomes or enforce real sequencing. Record
blockers beside the affected work. Keep required integration proof explicit;
source inspection, fixtures, and live runtime evidence make different claims.

Before marking delivery Completed, record the implementation PR or commit,
verification results and limits, and updated current references, guides, and
flows. An unmet required outcome keeps its milestone incomplete unless an
authorized scope change is recorded. Acceptance of an RFC is not evidence of
availability. Use [documentation checks](documentation.md#preview-and-check)
for document-only changes, without running product tests.

`pnpm docs:check` also checks non-archived specs for continuous RFC numbering from
`0001`, required statuses and author logins,
relative `rfc` references to RFC entry points, and local Markdown link targets.
Run `node scripts/check-specs.mjs` for that check alone. It does not check remote
URLs or the meaning of a recorded decision. Three preserved
local artifact links in the historical architecture audit are reported as
unverified; archived documents are not scanned.

## Historical records and first-phase organization

Completed, rejected, stopped, and superseded documents stay in their existing
RFC or plan location. A later substantial change gets a new document that links
its predecessor and explains what it supersedes. Current supported behavior
belongs in [reference](../reference/README.md), and current architecture belongs
in the platform design.

Preserve historical decisions, dates, evidence, recorded statuses, and Manual
Notes. Keep mixed historical design and implementation records intact, choosing
their home by primary purpose. Historical plan names, including duplicate numeric
prefixes and date-based names, remain grandfathered. RFCs use unique numeric IDs; the old-to-new lookup
preserves their previous names. Existing linked plans keep their filenames and
point to the renumbered RFC through `rfc` frontmatter. Documents with companions
use `index.md` for the main document. Do not infer completion from placement or
rewrite historical content to match the new template.

This first phase moves non-archived specifications and supporting evidence.
`specs/.archive/` retains its content and placement.
The console spec's image links point to a preserved Git revision after removal
of `specs/assets/`. Archived links may point to removed files; forwarding pages
are not required. A future archive reorganization requires a separate change.

## Renumbered RFCs

The 18 existing RFCs were renumbered from `0001` through `0018`.
This lookup maps their original paths to the current IDs. New RFCs take the next
number; unmerged proposals must reconcile their IDs before merging.
Plan filenames and historical commit links retain their original names.

| Previous RFC path                         | Current RFC                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `0042-oidc-sign-in.md`                    | [RFC-0001](../../specs/rfcs/0001-oidc-sign-in.md)                       |
| `21-agent-workload-tags.md`               | [RFC-0002](../../specs/rfcs/0002-agent-workload-tags.md)                |
| `28-gateway-harness-storage-split.md`     | [RFC-0003](../../specs/rfcs/0003-gateway-harness-storage-split.md)      |
| `28-occ-prometheus-metrics.md`            | [RFC-0004](../../specs/rfcs/0004-occ-prometheus-metrics.md)             |
| `30-harness-auth-binding.md`              | [RFC-0005](../../specs/rfcs/0005-harness-auth-binding.md)               |
| `31-basic-rbac`                           | [RFC-0006](../../specs/rfcs/0006-basic-rbac/index.md)                   |
| `31-human-federated-sign-in`              | [RFC-0007](../../specs/rfcs/0007-human-federated-sign-in/index.md)      |
| `31-repository-credentials`               | [RFC-0008](../../specs/rfcs/0008-repository-credentials/index.md)       |
| `35-native-plugin-tool-policy.md`         | [RFC-0009](../../specs/rfcs/0009-native-plugin-tool-policy.md)          |
| `36-agent-access.md`                      | [RFC-0010](../../specs/rfcs/0010-agent-access.md)                       |
| `36-coordinated-image-upgrade.md`         | [RFC-0011](../../specs/rfcs/0011-coordinated-image-upgrade.md)          |
| `36-production-observability.md`          | [RFC-0012](../../specs/rfcs/0012-production-observability.md)           |
| `37-platform-audit`                       | [RFC-0013](../../specs/rfcs/0013-platform-audit/index.md)               |
| `37-plugin-policy-enforcement.md`         | [RFC-0014](../../specs/rfcs/0014-plugin-policy-enforcement.md)          |
| `39-repository-credential-recovery.md`    | [RFC-0015](../../specs/rfcs/0015-repository-credential-recovery.md)     |
| `39-sandbox-credential-injection.md`      | [RFC-0016](../../specs/rfcs/0016-sandbox-credential-injection/index.md) |
| `40-agent-egress-0x`                      | [RFC-0017](../../specs/rfcs/0017-agent-egress-0x/index.md)              |
| `2026-09-28-installation-profiles-design` | [RFC-0018](../../specs/rfcs/0018-installation-profiles-design/index.md) |
