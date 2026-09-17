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
Markdown links in full-line comments under `deploy/examples/` (`.yaml` and
`.yml`) use the same validation.

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

`site.mjs` owns mobile navigation, local Pagefind search, theme switching, code
copying, heading links, Mermaid rendering, and Driver matrix filtering. Driver
matrix pages use custom replacement blocks around generated GitHub fallback
tables:

- `<!-- compute-matrix:start -->` / `<!-- compute-matrix:end -->` reads
  `docs/assets/compute-driver-matrix.json` and is regenerated with
  `node scripts/generate-compute-matrix.mjs`.
- `<!-- plugin-matrix:start -->` / `<!-- plugin-matrix:end -->` reads
  `docs/assets/plugin-driver-matrix.json` and is regenerated with
  `node scripts/generate-plugin-matrix.mjs`.

Keep each fallback generated from the same JSON so GitHub Markdown remains
useful without becoming a second fact owner. No assistant, community widget,
translation pipeline, deployment command, or hosted API is included.

Run `npm run docs:check` for word-count enforcement, the real build plus
page/navigation checks, and negative link, anchor, and static-server cases. Run
`pnpm openapi:check` with the controller workspace installed to verify that the
generated API source is current.

The docs package is intentionally outside the active application workspace. Its
independent lockfile lets docs-only contributors install the renderer without
installing controller dependencies. Do not add it to the TypeScript solution.
