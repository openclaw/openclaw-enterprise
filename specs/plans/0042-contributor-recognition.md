# Implementation plan: recognize Enterprise contributors

- **ID:** TASK-0042
- **Delivery status:** Completed
- **Owner:** OpenClaw Enterprise maintainers
- **Authority:** [Contribution policy](../../CONTRIBUTING.md) and [repository layout](../../docs/layout.md); independent repository-maintenance work, with no RFC required.
- **Source baseline:** Enterprise `7a6cc931d0edda65fec91935bffc8f56a44ded1c`; upstream GitHub `main` resolved to `8f98c12c581fa16e8c2af1ff5fbe92e1af350878` on 2026-10-02.

## Outcome and scope

Give people who contribute to OpenClaw Enterprise (OCE) visible credit in its
README and preserve their authorship when maintainers prepare changes. Add a
small, maintainer-run generator and a documented refresh procedure. The generated
wall lists contributors alphabetically, including people contributing only docs
and people using default GitHub avatars.

This plan covers repository recognition. It adds no OpenClaw Control Plane
resource, permission, runtime component, or deployment. Recognition does not grant
maintainer status or authorize merging. Scheduled updates, contributor ranks,
release-note automation, and a new changelog are outside this first delivery.

## What OpenClaw does

OpenClaw uses custom tooling, rather than an All Contributors configuration:

| Mechanism               | Observed behavior and source                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README wall             | The [generator](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/scripts/update-clawtributors.ts) replaces the `clawtributors:start` / `clawtributors:end` block with linked 48-pixel avatars, ten entries per source line.                                                                                                                                                  |
| Discovery               | It combines the paginated GitHub contributors API, local Git author history, up to 5,000 merged PRs for scoring, explicit inclusions, and a historical README seed. The PR list supplies counts; it is not independently a complete inclusion list.                                                                                                                                                            |
| Identity corrections    | [clawtributors-map.json](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/scripts/clawtributors-map.json) provides `ensureLogins`, display-name overrides, name/email mappings, and `seedCommit`. Historical avatar account IDs help resolve renamed accounts without crediting a new owner of an old login.                                                                 |
| Ordering and visibility | The score is `(commits × 2 + merged PRs × 10 + sqrt(changed lines)) × tenure`, with a tenure multiplier up to 1.5. Changed-line scoring excludes `docs/`. Default-avatar entries are hidden, with a hidden-login cache in the README. This is ranking behavior, not a requirement for Enterprise.                                                                                                              |
| Change-level thanks     | [changelog.sh](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/scripts/pr-lib/changelog.sh) validates PR-linked changelog attribution and eligible human thanks. This belongs to OpenClaw's PR preparation workflow.                                                                                                                                                        |
| Commit attribution      | [common.sh](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/scripts/pr-lib/common.sh) resolves eligible contributor co-author addresses; [prepare-core.sh](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/scripts/pr-lib/prepare-core.sh) uses them. Its exclusions include project-specific accounts and must not be copied wholesale. |
| PR labels               | [labeler.yml](https://github.com/openclaw/openclaw/blob/8f98c12c581fa16e8c2af1ff5fbe92e1af350878/.github/workflows/labeler.yml) applies the maintainer label from active organization-team membership. The four-PR trusted and ten-PR experienced thresholds are commented out; those labels are disabled.                                                                                                     |

No generator caller was found in the inspected local upstream package scripts or
GitHub workflows at `083b498270124a059db70714b5df93d973391ee0`; the fetched current
package manifest also has no caller. This establishes a standalone script, not
proof of a deployed schedule. External automation and current workflow execution
were not audited.

At the inspected baseline, Enterprise's [README](../../README.md) had no
recognition wall, and its [contribution policy](../../CONTRIBUTING.md) had no
dedicated attribution procedure. There was no root changelog or contributor generator.
The [CLI release script](../../scripts/ci/cli-release.mjs) supplies a fixed binary
release description, so upstream changelog enforcement has no equivalent owner
to extend today.

## Selected contract and source touchpoints

Reuse the generated README block and explicit correction mechanism, while keeping
Enterprise's implementation smaller than upstream's ranking and image-probing
pipeline.

- **Discovery:** Read all pages of `repos/openclaw/openclaw-enterprise/contributors`
  and all closed PR pages, admitting PR authors only when `merged_at` is set and
  the base is the repository's default branch. Union these accounts with reviewed
  explicit inclusions. Do not impose the upstream 5,000-PR cap. The contributors
  endpoint can lag; explicit inclusions cover missing co-authors and non-code
  contributions without guessing identities from commit names or private emails.
- **Identity:** Deduplicate by numeric GitHub account ID. Store manual additions
  and display overrides in `scripts/contributors.json`, keyed by account ID with
  a public contribution URL and reason. Resolve the current login by ID. Seed
  only Enterprise contributors; do not copy upstream's people or historical seed.
- **Eligibility:** Include human accounts and all contribution types. Exclude
  GitHub accounts whose API type is `Bot`; maintain explicit ID-based exclusions
  for service accounts and requested opt-outs. Default avatars remain visible.
  A missing or deleted account requires an explicit maintainer correction rather
  than silently removing credit or resolving a recycled username.
- **Presentation:** Sort by lowercase current login with account ID as the
  tie-breaker. Render linked 48-pixel avatars with escaped descriptive alt text,
  using canonical GitHub profile and avatar URLs. Add a link to GitHub's full
  contributor graph. Write only the unique paired marker block in `README.md`.
- **Execution:** `scripts/update-contributors.mjs`, exposed as
  `pnpm contributors:update`, uses Node's built-in APIs and an installed,
  authenticated `gh` executable. Pass subprocess arguments without a shell.
  Verify the repository identity before collecting data. No new npm dependency
  or root-workspace package is needed.
- **Failure:** Collect and validate the complete result before modifying the
  README. Authentication, rate limits, incomplete pagination, invalid override
  IDs, unresolved accounts, missing/duplicate markers, and unexpected empty
  results fail with a useful diagnostic and leave the file unchanged. Bound
  subprocess execution; do not log credentials or raw private account data.
- **Review:** Refreshes produce local diffs only. Maintainers inspect additions,
  removals, links, and overrides, then use the existing PR review process. The
  generator never commits, pushes, opens PRs, or changes repository settings.

## Implementation

1. Add the generator, reviewed correction data, and package command. Build the
   complete account set from read-only GitHub calls. Use the current default
   branch as the collection baseline and report its SHA in command output for
   review, without adding timestamps that churn the README.
2. Add the README Contributors section and markers, run the first refresh, and
   audit the list against merged Enterprise PRs and GitHub contributors. Resolve
   missing human co-authors through evidence-backed inclusions. Keep all changes
   outside the marker block intact.
3. Add a short attribution and refresh section to `CONTRIBUTING.md`: preserve
   existing author metadata; use a verified human `Co-authored-by` trailer when
   transplanting or jointly authoring work; acknowledge material non-code help
   in the PR description and correction data. Credit follows actual work, not
   whoever runs the merge. Retain Enterprise's existing merge policy.
4. Document prerequisites, invocation, expected README diff, correction requests,
   and failure recovery in that same section. The maintainer preparing a release
   refreshes the wall through a normal PR; maintainers may also refresh when
   correcting an omission. Failed collection is retried after fixing access or
   data, with the prior wall retained. This is a documented manual cadence.
5. Run the checks below and mark this plan complete only with an implementation
   commit or PR and observed results. No new docs page, navigation entry,
   architecture update, or runtime flow is necessary for this repository tool.

## Verification

Verification uses actual generation, diff inspection, and rendering. No tests
were added or run for the README or generated documentation, following repository
policy.

| Required outcome                    | Check and prerequisites                                                                                                                                                                                                   | Remaining proof                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct people receive credit       | Run the real generator with read-only repository access; compare against merged PR authors and the contributor graph. Inspect explicit non-code inclusions and bot/opt-out exclusions.                                    | Passed: 21 contributor entries and 655 merged PRs yield 19 human accounts after bot and service-account exclusions.                                      |
| Stable, scoped output               | Run twice against unchanged GitHub data; the second diff must be empty. Confirm all edits stay inside the paired markers and overrides resolve by ID.                                                                     | Passed: the final 19-account rerun is byte-identical. Outside-marker bytes and alphabetical order verified.                                              |
| Collection failure preserves credit | In a disposable copy, invoke the real command with invalid authentication, malformed correction data, and missing or duplicate markers; compare README bytes before and after. Review pagination and rate-limit handling. | Passed: six manual failure checks, including absent authentication, malformed JSON, invalid IDs, conflicting corrections, and missing/duplicate markers. |
| Readable wall                       | Render the generated README and inspect profile links, alt text, default avatars, wrapping, and narrow-width layout.                                                                                                      | Passed: local Markdown preview at 1000px and 375px; all 19 avatars loaded, descriptive alt text present, no horizontal overflow.                         |
| Repository quality                  | Run `pnpm lint`, scoped Prettier checks, `pnpm check:workspace`, `pnpm docs:check`, and `pnpm docs:check-length` using installed dependencies.                                                                            | Passed: lint, formatting, workspace boundaries, documentation length and link checks.                                                                    |

## Delivery record

Implemented locally on `dev/kevinlin/contributor-recognition`, based on
`a10baed3c4a551c697c09c2e4a96ef529509a37a`. Implementation commit:
[`ccaa2af5a`](https://github.com/openclaw/openclaw-enterprise/commit/ccaa2af5a4816b3a1ea98ae912594ec6510f8f64).

- [Generator](../../scripts/update-contributors.mjs), [corrections](../../scripts/contributors.json),
  package command, and [README wall](../../README.md#contributors) are implemented.
  [Contributor guidance](../../CONTRIBUTING.md#recognize-contributors) owns usage,
  identity corrections, permissions, and recovery.
- Live reads used Enterprise's default branch at the same SHA. The account
  `codex` reports API type `User`, but its public profile identifies an automated
  coding agent; its numeric ID is explicitly excluded. Known human co-authors in
  Git history are already represented. No missing-person additions were inferred.
- Manual failures ran the actual CLI in disposable copies and compared README
  bytes. No GitHub data or authentication was mocked. Rate limiting and account
  deletion were not induced; their error handling was inspected.
- `pnpm lint:fix`, `pnpm lint`, `pnpm format:fix`, `pnpm format:check`,
  `pnpm check:workspace`, and `pnpm docs:check` passed. The last command includes
  documentation length checks. Scoped Prettier and `git diff --check` also passed.
  Verification reused matching installed dependencies through worktree symlinks;
  `pnpm_config_verify_deps_before_run=false` prevented automatic installation.
  No dependency versions or lockfiles changed.
- The fixed command and small correction schema use Node built-ins. No parser
  dependency or platform flow document was added: this is a documentation
  maintenance command, with its complete procedure in the contribution guide.
- Screenshots were inspected locally at desktop/mobile widths. This proves local
  Markdown rendering, not publication on GitHub. Evidence stays outside the checkout.

## Manual Notes

## Changelog

- 2026-10-02: Implemented locally and recorded real GitHub, failure-path, rendering, and repository checks against `a10baed3c4a551c697c09c2e4a96ef529509a37a`.
- 2026-10-02: Drafted the upstream comparison and independent Enterprise plan against the source baselines above.
