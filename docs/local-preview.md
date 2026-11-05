# Preview documentation locally

Render the existing Markdown as a local OpenClaw Enterprise documentation site.
The renderer uses the OpenClaw docs design system, navigation, syntax highlighting,
and Mermaid diagrams. No controller, database, or model credentials are needed. Renderer dependencies
live in the independent `scripts/docs-site/` package and lockfile; installing them
does not install the controller workspace.

## Start the preview

Use Node.js 24 or newer and the pnpm version pinned in `package.json`. From the
Enterprise repository root:

```sh
npm run docs:install
npm run docs:dev
```

Open [the local preview](http://127.0.0.1:4173). The server binds only to loopback.
Save an edit to rebuild the site and refresh connected tabs automatically. Each
tab keeps its URL and heading anchor. The preview watches `docs/`, including
shared snippets, assets, and `docs.json`, plus `scripts/docs-site/`, OpenAPI
contracts, and deployment examples under `deploy/examples/`. File creation,
deletion, and renames also trigger a rebuild.
Markdown files elsewhere in the repository are also watched to keep checks for
links to their headings current.

The preview combines rapid edits and runs one build at a time. It publishes pages
and their search index together after both succeed. A failed build shows the
error in the terminal and open tabs; the last successful site stays available.
Fix the source and save it to resume updates. If the first build fails, the
preview shows a waiting page with the error until a build succeeds.

Use `npm run docs:dev -- --port 4174` to select another port. Stop with Ctrl+C;
this stops the watcher and build process and removes temporary preview output
under `dist/.docs-preview-*/`. Generated output and installed dependencies do not
trigger rebuilds. Restart the command after editing the preview server itself.

The `npm run` commands dispatch scripts without installing the controller
workspace. `docs:install` uses the pinned pnpm version and frozen docs lockfile.

## Build and check

```sh
npm run docs:build
npm run docs:check
git diff --check
```

The build renders published Markdown pages under `docs/`, including pages hidden
from the sidebar and the generated API pages. It omits document Changelogs,
empty Manual Notes, and pages marked `published: false`. It checks local page
links and heading anchors, then builds the search index. Source files, deployment
assets, and historical specs outside `docs/` link to the Enterprise repository
on GitHub. These links require repository access. External URLs are not fetched.
`docs:check` checks word limits, navigation, and links without writing the site or
running a test suite.
The standalone build writes `dist/docs/` without a watcher or live-refresh script.
To inspect that output without rebuilding, run `node scripts/docs-site/serve.ts`.
Do not add or run tests for documentation changes, including docs-site
presentation; use the build, formatting, link checks, and visual inspection.

The full repository checks (`pnpm format:check` and `pnpm openapi:check`) require
the controller workspace dependencies from `pnpm install --frozen-lockfile`.
Both API Markdown pages can also be checked against the checked-in OpenAPI
contract with `node scripts/generate-occ-api-reference.mjs --check`.

## Edit the source

Keep Markdown links relative so pages remain readable on GitHub. The
[documentation map](README.md) links the seven menu sections; [`docs/docs.json`](docs.json)
defines each sidebar. Register each published page once, and link it from its
owning overview. Groups may nest. A page entry can set a short sidebar label using
`{"page": "guides/quickstart", "label": "Local Setup"}`; the article and browser
keep the descriptive title from Markdown or frontmatter. Use a tab's `hidden`
array for a deep page linked by an index: it remains available by URL and search
without adding another sidebar item. See [Write platform documentation](contributing/documentation.md)
for menu and naming conventions.

Keep reusable Markdown and embedded code examples in `docs/snippets/`.
Embed them with `<Snippet file="relative/path/to/source.md" />`; add `lang`
for a literal code example. Markdown snippets use `published: false` and have
no sidebar entry. Their content counts toward each including page's word limit.
Use site-root routes such as `/guides/cli/` for links in Markdown snippets
shared by pages at different directory depths: embedded links resolve from the
including page. Media stays in `docs/assets/`. The build also copies snippet
sources to `/snippets/` so links to downloadable code examples keep working.

`docs/README.md` renders at `/`; `docs/reference/README.md` renders at `/reference/`.
Other pages use their source path without `.md`, such as `/guides/quickstart/`.
Assets under `docs/assets/` are served at `/assets/`. Keep paths and existing
heading anchors when changing only the navigation or label.

When moving a published page, add a `redirects` entry to `docs/docs.json` with
site-root `from` and `to` routes. Use an `anchors` map from an old heading ID to
its new route and fragment when a section moves separately. The build validates
each destination and emits a redirect page outside navigation and search.
Query strings are preserved. Unmapped fragments are preserved when the destination
has no fragment. Source Markdown pages do not need to remain at the old paths.

The [HTTP API reference](reference/api.md) and [API cheat sheet](reference/cheatsheets/api.md)
are generated. Edit the owning routes, schemas, or generator; then run
`pnpm openapi:generate` and `pnpm openapi:check`. Do not edit either page by hand.

## Interactive Driver matrices

The [ComputeDriver feature matrix](reference/drivers/compute-matrix.md) renders
inside the existing docs page, with search, category filters, and expandable
source/test evidence. A generated Markdown table keeps the same support statuses
readable on GitHub. Both views use `docs/assets/compute-driver-matrix.json`.

After updating reviewed data and its baseline commit, regenerate the fallback:

```sh
node scripts/generate-compute-matrix.mjs
node scripts/generate-compute-matrix.mjs --check
npm run docs:build
```

The build rejects stale table content. Check the refreshed page at
`/reference/drivers/compute-matrix/`; open a cell to inspect pinned source and
unrun test evidence. A successful docs build proves presentation and links,
not Driver behavior or live deployment.

The [PluginDriver feature matrix](reference/drivers/plugin-matrix.md) uses the
same layout and evidence controls, with a status filter matching either Driver.
Its data lives in `docs/assets/plugin-driver-matrix.json`. Regenerate with
`node scripts/generate-plugin-matrix.mjs`, check with the same command plus
`--check`, then rebuild and open `/reference/drivers/plugin-matrix/`.

The custom renderer accepts raw HTML, but GitHub
[sanitizes rendered Markdown](https://github.com/github/markup#github-markup),
including scripts. Copying standalone HTML into Markdown therefore does not
provide portable interaction. The matrix uses generated markup and an external
same-origin script instead of an iframe. The current local preview sets no CSP;
any future hosting policy must allow its own required assets and scripts.

## Publish privately with GitHub Pages

Follow [Deploy private documentation](contributing/documentation-hosting.md#deploy-private-documentation)
for Pages setup, publication, access checks, and recovery. The hosting guide owns
both automatic and manual deployment procedures.

## Troubleshoot

- A missing page or anchor fails the build with its source location. Correct the
  relative link or heading in the owning Markdown page.
- If the port is occupied, stop the prior docs preview before starting another.
- If dependencies are missing, run the frozen docs install above in this worktree.

The site has no assistant backend or community integrations.
