# Report: ComputeDriver matrix refresh

**Last Updated**: 2026-09-16

**Status**: Complete

**Authoring Agent Session**: [01a0ac26-8213-76e1-a7e5-ee8f57ecfdf2](codex://threads/01a0ac26-8213-76e1-a7e5-ee8f57ecfdf2)

## Context

Refresh the earlier comparison against public OpenClaw Enterprise main at
`23d490b93d59dc810f28430f31576209200ba9ba`. The owning current artifact is the
[ComputeDriver feature matrix](../../docs/reference/drivers/compute-matrix.md).
This report records the refresh and verification scope; it does not redefine
Driver contracts.

The requested outcome is a discoverable, source-backed comparison in the existing
documentation. Compute implementation and contract sources own support claims;
test sources describe coverage intent; executed checks establish only their
observed outcomes. Optional capabilities are not universal Driver requirements.
No runtime, deployment, hosting, or Driver behavior changes belong in this task.

Acceptance requires a current bundled-driver inventory, pinned source evidence,
explicit partial and unknown states, separate test/live-proof labels, a readable
GitHub fallback, working local interaction, and docs link validation. The data
must be maintained once, with stale generated content rejected during validation.

## Documentation integration

The existing custom Node renderer uses `docs/docs.json`, Markdown, Carapace CSS,
and Pagefind. Its Markdown parser enables raw HTML; it does not sanitize arbitrary
HTML, scripts, or iframes. The loopback preview currently sets no Content Security
Policy. Those properties are not a production-hosting security guarantee.

The refreshed matrix uses generated HTML and an external, same-origin script in
the existing page. It does not need an iframe or a new hosting service. Assets
under `docs/assets/` already publish to `/assets/` in the local build. Future
hosting must supply a suitable policy for its own deployment.

GitHub sanitizes rendered Markdown and removes executable scripts and styling.
A generated Markdown table provides the repository view; raw HTML cannot provide
the same interaction there. See [GitHub's rendering pipeline](https://github.com/github/markup#github-markup).

## Verification

The matrix contains 32 capabilities across three bundled implementations (96
cells). All 256 citation spans were checked against Git objects at the pinned
baseline, including requirement, implementation, and existing-test references.
SSH is now bundled; the historical LocalTest column is excluded. Source-inferred
Docker transport retry limits remain explicitly unreproduced.

The worktree has no installed dependency graph. An existing docs installation
with matching manifest, lockfile, and direct dependency versions was reused
read-only through a temporary Node resolver; no dependencies were installed or
changed. The build and Pagefind indexed all 108 pages. Documentation length and
static-server tests passed (12 tests). Link validation and generated-matrix
checks passed (3 tests), including stale fallback rejection. The browser
integration passed (1 test) through the actual builder, loopback server, and
Chromium, covering category/search filters and partial-support details. Chromium
needed sandbox escalation for its macOS process services; the restricted launch
failed before running page assertions.

Workspace isolation, CI test registration audit, generated fallback freshness,
and `git diff --check` passed. Browser inspection of the actual authored page
also confirmed pinned source expansion and all three columns visible at a
1280-pixel viewport. The new browser case belongs to the existing checks-baseline
CI lane, which installs docs and browser prerequisites.

The root installed dependency graph is stale, so the aggregate pinned root
format/check commands are not claimed. Scoped formatting used available
Prettier 3.9.4 (repository pin: 3.9.6). Live Docker, Kubernetes, SSH, model,
and production deployment proof were not run; test-source presence is not a
passing-run claim.

## Open Questions

No Open Questions.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-16 14:49: Completed source-backed matrix refresh and verified existing-docs integration (01a0ac26-8213-76e1-a7e5-ee8f57ecfdf2 - 23d490b93d59dc810f28430f31576209200ba9ba).
