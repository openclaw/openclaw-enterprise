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
Stop it with Ctrl+C. Generated output lives in `dist/docs/` and is ignored by Git.
After an edit, run `npm run docs:build` in another terminal and refresh the browser.
The preview serves the latest build; it does not watch source files.

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
Do not add or run tests for documentation changes, including docs-site
presentation; use the build, formatting, link checks, and visual inspection.

The full repository checks (`pnpm format:check` and `pnpm openapi:check`) require
the controller workspace dependencies from `pnpm install --frozen-lockfile`.
Both API Markdown pages can also be checked against the checked-in OpenAPI
contract with `node scripts/generate-occ-api-reference.mjs --check`.

## Edit the source

Keep Markdown links relative so pages remain readable on GitHub. The
[documentation map](README.md) links the six menu sections; [`docs/docs.json`](docs.json)
defines each sidebar. Register each published page once, and link it from its
owning overview. Groups may nest. A page entry can set a short sidebar label using
`{"page": "guides/quickstart", "label": "Local Setup"}`; the article and browser
keep the descriptive title from Markdown or frontmatter. Use a tab's `hidden`
array for a deep page linked by an index: it remains available by URL and search
without adding another sidebar item. See [Write platform documentation](contributing/documentation.md)
for menu and naming conventions.

`docs/README.md` renders at `/`; `docs/reference/README.md` renders at `/reference/`.
Other pages use their source path without `.md`, such as `/guides/quickstart/`.
Assets under `docs/assets/` are served at `/assets/`. Keep paths and existing
heading anchors when changing only the navigation or label.

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

In repository **Settings → Pages**, select **GitHub Actions** as the source and
confirm visibility is **Private** before publishing. A private repository alone
does not make a Pages site private. GitHub restricts the private site to readers
of this repository and enforces HTTPS on its assigned domain.

The [publishing workflow](../.github/workflows/docs-pages.yml) builds the docs and
Pagefind index with the frozen docs lockfile, then publishes only `dist/docs/`.
It runs on pushes to `main` or a manual dispatch from `main`. The `github-pages`
environment also restricts deployments to `main`; pull requests must pass normal
review and merge requirements before their content is published.

After a successful **Publish private documentation** run, open the deployment URL
in the Actions summary or **Settings → Pages**. Verify a deep page, search, and
the interactive matrix while signed in with repository access. For a failed
publication, inspect the failed Actions step, fix the source, and rerun from
`main`. No controller services, model credentials, or custom domain are needed.

## Troubleshoot

- A missing page or anchor fails the build with its source location. Correct the
  relative link or heading in the owning Markdown page.
- If the port is occupied, stop the prior docs preview before starting another.
- If dependencies are missing, run the frozen docs install above in this worktree.

The site has no assistant backend or community integrations.
