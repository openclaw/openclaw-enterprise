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
node scripts/verify-workspace-boundary.mjs
```

The build renders every Markdown page under `docs/`, including the generated HTTP
API reference, and checks local page links and heading anchors. Source files,
deployment assets, and historical specs outside `docs/` link to the Enterprise
repository on GitHub. These links require repository access. External URLs are
not fetched by the build.

The full repository checks (`pnpm format:check` and `pnpm openapi:check`) require
the controller workspace dependencies from `pnpm install --frozen-lockfile`.
The API Markdown can also be checked against the checked-in schema with
`node scripts/generate-occ-api-reference.mjs --check`.

## Edit the source

Keep Markdown links relative so pages remain readable on GitHub. The
[documentation map](README.md) remains the canonical content map. `docs/docs.json`
provides the corresponding site tabs and sidebar groups using the OpenClaw
Mintlify-compatible navigation structure. Add a page to both when expanding the
map. Titles come from Markdown headings unless frontmatter supplies a title.

`docs/README.md` renders at `/`; `docs/reference/README.md` renders at `/reference/`.
Other pages use their source path without `.md`, such as `/guides/quickstart/`.
Assets under `docs/assets/` are served at `/assets/`.

For the generated [HTTP API reference](reference/api.md), edit the owning routes,
schemas, or generator and run `pnpm openapi:generate`; never edit its output by hand.

## Troubleshoot

- A missing page or anchor fails the build with its source location. Correct the
  relative link or heading in the owning Markdown page.
- If the port is occupied, stop the prior docs preview before starting another.
- If dependencies are missing, run the frozen docs install above in this worktree.

Publishing and hosting are outside this local setup. The site has no assistant
backend or community integrations.
