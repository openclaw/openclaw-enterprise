# Frontmatter and tags

Use a YAML mapping between `---` delimiters at the start of a Markdown file.
Fields describe the page; they do not replace its article heading or navigation
entry. Preserve metadata you are not changing.

```yaml
---
title: Install the production control plane
tags: [nolimit]
---
```

## Page fields

| Field        | Values and behavior                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | String. Overrides the site page and browser title; otherwise the renderer uses the first H1. Keep the H1 consistent. Sidebar labels belong in `docs/docs.json`.                                             |
| `published`  | Boolean; omitted means published. `false` excludes the page from site pages and navigation. Use it for Markdown snippets and repository-only history. It does not exempt the file from length checks.       |
| `searchable` | Boolean; omitted means searchable. `false` retains the page route but excludes its content from the site search index and emits `noindex`. It does not control access.                                      |
| `tags`       | List of nonempty strings, such as `[nolimit]`. Exact, case-sensitive tag names. Omit the field or use `[]` for no tags; a scalar such as `tags: nolimit` is invalid.                                        |
| `kind`       | Document taxonomy value. Current templates are `reference/driver` and `reference/driver/impl`; see the [taxonomy](../../../../docs/taxonomy.md). This selects authoring guidance, not a different renderer. |

The site consumes `title`, `published`, and `searchable`; the length checker
validates `tags`. Other fields above guide authors. A sidebar's `hidden` list
retains routes and search entries and is separate from frontmatter.

## Supported tags

| Tag              | Effect                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nolimit`        | Exempts the containing file from the 1,500-word review threshold and 2,500-word hard limit. The checker still reports its count and the exemption. |
| `human_verified` | Records that a human has verified the document. Required for human-verified documents; it does not change rendering or length checks.              |

Add `human_verified` only after human verification. Store it in the `tags` list,
for example `tags: [human_verified]`, and preserve existing tags. If an approved
length exception also applies, use `tags: [human_verified, nolimit]`.

No other tag currently changes site behavior. Other nonempty string tags may be
retained as metadata; they do not create routes, filters, or search categories.

Follow the approval rule in `AGENTS.md` before adding `nolimit`. The existing
approved pages are the generated API reference, CI guide, and production
installation guide. Add the tag to the source page, or to its generator when
it is generated. Do not maintain a parallel filename allowlist in the checker.
An ordinary file linked through a symlink named `AGENTS.md` is not automatically
exempt. Files actually named `AGENTS.md` retain their existing exemption.

Frontmatter belongs to its own file. In particular, `nolimit` on a snippet does
not transfer to pages that embed it. Embedded content counts toward the host
page's length. Tags do not waive link, formatting, or correctness checks.

## Specification fields

Use the [specification process](../../../../docs/contributing/specifications.md)
for document ownership and status changes. These fields do not imply release
or runtime verification.

| Field                   | Values and purpose                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `status`                | RFC decision status: `Proposed`, `Accepted`, `Rejected`, `Superseded`, or `Unspecified`.  |
| `implementation_status` | RFC implementation status: `Not implemented`, `Partially implemented`, or `Implemented`.  |
| `author`                | RFC entry point's original PR author GitHub login, without `@`.                           |
| `status_note`           | Nonempty explanation required when RFC status is `Unspecified`.                           |
| `rfc`                   | Relative link to the owning RFC for companion documents and related implementation plans. |

## Flow and historical metadata

The [flow template](../../local-dev/references/flow-doc/template.md) uses `created`
and `updated` dates and `last_updated_session` for the authoring session. Its
optional `pr` field identifies a PR-scoped flow. Follow that workflow when
changing these values.

Existing records also contain `doc-schema-version`, `last_refreshed`,
`last_refreshed_by`, `authors`, `last_updated`, `issue`, and `rfc_pr`. Preserve
these historical or document-specific fields. They are not general site controls;
do not copy them into new pages without an owning workflow.

## Check changes

Run `pnpm docs:check` to check page lengths, links, navigation, and specifications.
The length report identifies `nolimit` exemptions and rejects malformed tag lists.
For generated API frontmatter, regenerate through the API reference generator
and run its `--check` command. Do not edit the generated Markdown by hand.
