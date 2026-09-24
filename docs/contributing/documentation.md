# Write platform documentation

Use this guide to add or update OpenClaw Enterprise documentation. Start with the
reader's task and verify commands, permissions, defaults, and limits against the
current source before describing them as supported.

## Choose one home

The menu bar selects a sidebar. Put each page in one section and link to it from
other pages that need it:

| Menu            | What belongs here                                                    |
| --------------- | -------------------------------------------------------------------- |
| Getting Started | Orientation, concepts, local setup, and the first Agent.             |
| Topics          | Product behavior, configuration, and feature troubleshooting.        |
| Integrations    | Named Drivers, Backends, and channels; setup and support limits.     |
| Operate         | Production installation, monitoring, and ongoing administration.     |
| Reference       | CLI and HTTP API commands, inputs, outputs, and errors.              |
| Contribute      | Architecture, internals, local development, tests, and writing docs. |

The menu is independent of the file path. See [Repository layout](../layout.md#documentation-placement)
for source ownership; published links and heading anchors should survive a
navigation change. Update [`docs/docs.json`](../docs.json) and the owning
overview when adding a page. Deep implementation and testing pages can be
registered as hidden in navigation when a contributor index already links them;
they keep their URLs and remain searchable.

## Write and name the page

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

The published site omits document `Changelog` sections and empty `Manual Notes`.
Keep those records in the Markdown source; real notes still appear on the site.
If a page contains only an internal record, set `published: false` in its YAML
frontmatter and leave it out of `docs.json`. It will have no site URL or search
result, so use a GitHub source link if the archive needs to be cited.

The [documentation map](../README.md) links the six sections. A previous
[documentation inventory](../documentation-inventory.md) records gaps and
placement decisions from the navigation audit; use the live map and `docs.json`
for current navigation.

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
