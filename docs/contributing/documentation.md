# Write platform documentation

Use this guide to add or update OpenClaw Enterprise documentation. Start with the
reader's task and verify commands, permissions, defaults, and limits against the
current source before describing them as supported.

For private deployment, the custom domain, and the separate public-launch step,
see [Documentation hosting](documentation-hosting.md).

## Choose one home

The menu bar selects a sidebar. Put each page in one section and link to it from
other pages that need it:

| Menu             | What belongs here                                                       |
| ---------------- | ----------------------------------------------------------------------- |
| Getting Started  | Orientation, concepts, local and Kubernetes setup, and the first Agent. |
| Topics           | Product behavior, configuration, and feature troubleshooting.           |
| Integrations     | Named Drivers, Backends, and channels; setup and support limits.        |
| Deploy & Operate | Production installation, monitoring, and ongoing administration.        |
| Reference        | CLI and HTTP API commands, inputs, outputs, and errors.                 |
| Testing & CI     | Local tests, CI check scenarios, integration setup, and proof limits.   |
| Contribute       | Architecture, internals, local development, and writing docs.           |

The menu is independent of the file path. See [Repository layout](../layout.md#documentation-placement)
for source ownership; published links and heading anchors should survive a
navigation change. Update [`docs/docs.json`](../docs.json) and the owning
overview when adding a page. Deep implementation and testing pages can be
registered as hidden in navigation when a contributor index already links them;
they keep their URLs and remain searchable.

## Write and name the page

Use the [documentation taxonomy](../taxonomy.md) to select a kind and its template.

For proposals and implementation planning, follow
[RFCs and implementation plans](specifications.md), including numbering,
document ownership, and historical preservation.

Use a short sidebar label: `Overview`, `Configure`, and `Troubleshoot` work when
their group supplies the subject. Give the article a descriptive sentence-case
title, such as `Troubleshoot Agents`, so it makes sense from search or a direct
link. In `docs.json`, use a page's `label` when it differs from the article title.

Put the first useful action near the top. Use direct language, show expected
results, and put permissions or failure limits beside the affected step. Keep
one owner for a contract or procedure and link to it instead of copying it. The
[technical-writing skill](../../.agents/skills/technical-writing/SKILL.md) has
page patterns and a required plain-language pass. Use the [base Driver template](../base-driver-docs-template.md)
for a Driver contract; implementation-specific setup belongs in Integrations.
Use the [CI check template](ci-check-template.md) with `kind: reference/ci` for
test workflow coverage pages.

The published site omits document `Changelog` sections and empty `Manual Notes`.
Keep those records in the Markdown source; real notes still appear on the site.
If a page contains only an internal record, set `published: false` in its YAML
frontmatter and leave it out of `docs.json`. It will have no site URL or search
result, so use a GitHub source link if the archive needs to be cited.

The [documentation map](../README.md) links the seven sections. Use it and
`docs.json` for current navigation.

## Record human verification

After a human verifies a page, add `human_verified` to its YAML `tags` list and
set `last_verified` to the review date:

```yaml
---
tags: [human_verified]
last_verified: "2026-11-04"
---
```

Use a real date in `YYYY-MM-DD` format. Update it only after another human review,
not after an automated check or routine edit. Preserve any existing tags. The
site shows a **Human verified** badge and the date below the page title. Select
the badge with a pointer or keyboard to read its explanation.
Pages without the tag have no badge; tags on embedded snippets do not transfer
to the containing page. The badge is omitted from sidebar labels and search text.

Human-verified pages can still be out of date. Later edits may not have been
reviewed. These fields do not identify the reviewer or reviewed revision.

Existing tagged pages have dates backfilled from the Git commits that recorded
their verification tags. Each backfilled field has a comment with that commit.
These dates show when verification was recorded; the actual review may have
occurred earlier. After a new human review, replace the date and remove the
backfill comment.

## Preview and check

From the repository root, with the docs renderer dependencies installed:

```sh
npm run docs:build
npm run docs:check-length
git diff --check
```

The build checks local page links and headings, then builds the search index.
Open changed pages in the [local preview](../local-preview.md) to inspect nested
navigation, diagrams, or other presentation changes. Run `pnpm format:check`
when the existing root dependencies match the lockfile. Do not add or run tests
for documentation changes, including docs-site presentation.

The [HTTP API reference](../reference/api.md) and [API cheat sheet](../reference/cheatsheets/api.md)
are generated. Edit the owning routes, schemas, or generator; then run
`pnpm openapi:generate` and `pnpm openapi:check`. Do not edit either page by hand.

## Brand artwork

The approved OCE mascot source is [`lobster-mech-transparent.png`](../assets/lobster-mech-transparent.png)
(SHA256 `207a83faca81a49521b31e73800af235bd912470ce8f9c09bc37d8075c22330c`).
Preserve this original PNG and its transparency. The README and docs header use
`docs/assets/oce-mascot.png` at 400 × 400; the console uses its own
`apps/controller/src/console/oce-mascot.png` at 96 × 96. For the Console’s dark navigation,
`oce-mascot-inverse.png` crops the transparent margins and adds a single white contour to the
same artwork. Its 144 × 114 pixels render at 48 × 38 CSS pixels.

Both asset directories contain transparent 16- and 32-pixel PNG favicons, a
16/32/48-pixel ICO, and a 180-pixel touch icon derived from that source. Resize
the full square canvas with Pillow's `Image.Resampling.LANCZOS`; do not redraw
or replace the character. When updating these assets, check the README's relative
image path, both sites' icon links, and the console asset allowlist. Inspect
16- and 32-pixel icons on light and dark backgrounds and the Storybook
**Components / Navigation / `OCC build revision`**, **Mobile drawer**, and
**Pages / Sign in** previews. Storybook supplies simulated API state.

Visual references: [README](../assets/oce-mech-branding/readme.png),
[docs header](../assets/oce-mech-branding/docs-dark.png),
[Storybook shell](../assets/oce-mech-branding/storybook.png),
[mobile navigation](../assets/oce-mech-branding/mobile.png),
[sign-in](../assets/oce-mech-branding/sign-in.png),
[browser tab](../assets/oce-mech-branding/browser-favicon.png),
[favicon sizes](../assets/oce-mech-branding/favicon-sizes.png), and
[walkthrough](../assets/oce-mech-branding/walkthrough.mp4). These captures show
local documentation and simulated console presentation, not live backend proof.
