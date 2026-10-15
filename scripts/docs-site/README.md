# Local docs renderer

This is the local rendering subset of the OpenClaw docs publisher, adapted for
OpenClaw Enterprise. Run the commands in [Local preview](../../docs/local-preview.md)
from the repository root.

## Upstream sources

- Publisher: [openclaw/docs](https://github.com/openclaw/docs/tree/fb4abea55f84d3caecdc51fd72b8b67cdd8e220a/scripts/docs-site),
  revision `fb4abea55f84d3caecdc51fd72b8b67cdd8e220a`.
- Shared parser: [openclaw/openclaw](https://github.com/openclaw/openclaw/blob/34bdf6d0321dffff0cc343ee48aa4c051547f70e/scripts/lib/docs-markdown.mjs),
  revision `34bdf6d0321dffff0cc343ee48aa4c051547f70e`. The publisher mirror matched
  the current product parser at implementation time.
- `vendor/docs-markdown.mjs` retains the shared parser, heading IDs and aliases,
  frontmatter handling, and Markdown component support. Enterprise also emits GitHub-style heading aliases
  through the pinned `github-slugger`, preserving existing API deep links.
- `vendor/mdx-ish.mjs` retains the publisher's component renderer, code highlighting,
  and Mermaid source markup. Its shared-parser import points to the sibling copy.
- The MIT notice is retained in `vendor/LICENSE.openclaw`. The JetBrains Mono OFL notice accompanies
  the copied code font in `fonts/`. Body text uses system fonts; Switzer is not
  redistributed because its bundled license restricts redistribution.
- Carapace is pinned to `v0.6.2` (Git commit recorded in the package lockfile).
  The shell loads the same token, theme, typography, component, and product CSS.
  `site.css` adapts the publisher's tab/sidebar/article design to Enterprise.

The configured package registry did not provide the publisher's
`markdown-it-anchor@10.0.0` or `lucide@1.41.0` pins. This package pins the available
`9.2.1` and `1.39.0` releases; CLI and browser checks cover the rendered corpus.

## Ownership and verification

`build.mjs` discovers the authored corpus, applies `docs/docs.json` navigation,
validates links and anchors, emits Enterprise HTML and local assets, and leaves
Pagefind indexing to the root `docs:build` command. `--check` validates without
writing output. Paths resolve against Markdown source files; README pages map to
folder indexes and links outside `docs/` point to the Enterprise GitHub source.
Fragments on those links must match a GitHub heading slug or HTML anchor in the
target (`github-anchors.mjs`); `scripts/check-specs.mjs` applies the same check to
spec links.
Markdown links in full-line comments under `deploy/examples/` (`.yaml` and
`.yml`) use the same validation.

Before parsing links or rendering, the build removes document `Changelog` sections
and empty `Manual Notes` sections. It also removes the notes placeholder when real
notes follow; those notes stay visible. This keeps internal records out of the
article, table of contents, and Pagefind without changing their Markdown source.

Each navigation tab declares `groups`. A group has a `group` name and `pages`;
its entries can be Markdown slugs, `{ "page": "slug", "label": "Short label" }`,
or nested `{ "group": "Name", "pages": [...] }` groups. A short label changes
the sidebar and breadcrumb without changing the article or its search title.
The first visible page is the tab landing page; give it an overview when the tab
covers multiple subjects. A tab can also declare `hidden`, an array of slugs or
labeled pages. These pages keep their URLs and appear in search, but not in the
sidebar. Mark a repository-only archive `published: false` in Markdown frontmatter
and omit it from navigation; it has no site route or search entry, and local links
from published pages to it fail validation. A GitHub source link can cite the
record. List every other Markdown page exactly once, visible or hidden. The local
[navigation schema](./navigation.schema.json) describes the accepted format.

`word-count.mjs` checks every tracked or nonignored Markdown file returned by
Git, including root documentation, specs, generated reference, and new author
drafts. It reports pages above the 1,500-word review threshold and fails pages
above the 2,500-word hard limit. The approved single-page API reference exception
covers only `docs/reference/api.md`; its word count and exception are still
reported. Passing `--max <words>` changes the hard limit for other pages. It counts visible prose, headings, lists, tables, and fenced
examples, while excluding frontmatter, HTML comments, Markdown syntax, and link
destinations. Symlinks resolve to one real file so aliases cannot duplicate
counts or bypass the limit.

`serve.mjs` serves only `dist/docs/` on `127.0.0.1`. It accepts an optional
`--port` for parallel local previews and tests. These two small internal CLIs use
built-in Node argument handling because each has one option and no subcommands.

`site.mjs` owns mobile navigation, per-tab sidebar scroll restoration, local
Pagefind search, theme switching, code copying, heading links, Mermaid rendering,
and Driver matrix filtering. Sidebar scroll uses session storage and leaves the
navigation at the default position when storage is unavailable. Driver matrix
pages use custom replacement blocks around generated GitHub fallback tables:

- `<!-- compute-matrix:start -->` / `<!-- compute-matrix:end -->` reads
  `docs/assets/compute-driver-matrix.json` and is regenerated with
  `node scripts/generate-compute-matrix.mjs`.
- `<!-- plugin-matrix:start -->` / `<!-- plugin-matrix:end -->` reads
  `docs/assets/plugin-driver-matrix.json` and is regenerated with
  `node scripts/generate-plugin-matrix.mjs`.

Keep each fallback generated from the same JSON so GitHub Markdown remains
useful without becoming a second fact owner. No assistant, community widget,
translation pipeline, deployment command, or hosted API is included.

For documentation or site presentation changes, run `pnpm docs:build` to build
the site and its search index, `node scripts/docs-site/build.mjs --check` to
check links and anchors without writing files, and `pnpm docs:check-length` for
word limits. Inspect navigation and presentation in the browser. Run
`pnpm openapi:check` with the controller workspace installed when changing the
source for the generated [HTTP API reference](../../docs/reference/api.md) or
[API cheat sheet](../../docs/reference/cheatsheets/api.md).

The docs package is intentionally outside the active application workspace. Its
independent lockfile lets docs-only contributors install the renderer without
installing controller dependencies. Do not add it to the TypeScript solution.
