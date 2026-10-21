# Implementation plan: Deployment-wide console theming

- **ID:** TASK-0047
- **Delivery status:** In progress
- **Owner:** Console and deployment maintainers
- **Authority:** [Platform design](../../docs/design.md#control-plane), [console reference](../../docs/reference/console.md), and [repository layout](../../docs/layout.md)
- **Source baseline:** `origin/main` at `e8185dac805b737363c7178d3068b310a53a7c24`

## Outcome and scope

An operator can customize the OpenClaw Enterprise (OCE) console's colors, logo,
and displayed product name by mounting a theme directory alongside an upstream
controller image. Applying a theme requires no source fork, image rebuild, or
database change. The same bundle works with Kubernetes, Compose, and a directly
started controller.

The requested scope is colors, logo, the upper-left product name, and deploy-time
assets. This plan proposes one theme per deployment, including the public sign-in
page. The user authorized implementation of this contract on 2026-10-20.
Tenant-specific themes, browser uploads, a theme editor, custom fonts, arbitrary
CSS or JavaScript, and a new appearance switch are outside this delivery. Keep
the current light appearance mode; this work does not depend on an unmerged
dark-mode implementation.

## Current ownership and touchpoints

The controller already owns console presentation and public asset serving. Extend
that boundary; do not introduce an OCC resource, Driver, Backend, or persistence
model for presentation configuration.

| Owner                | Current source and planned responsibility                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public assets        | `apps/controller/src/console-assets.ts` allowlists assets, supplies the HTML shell, compresses scripts/styles, and defines CSP. Add a per-app theme snapshot.                  |
| Composition          | `apps/controller/src/api-startup.mjs`, `composition/production.ts`, and `composition/development-postgres.ts` assemble the serving app. Load the bundle once before listening. |
| HTTP integration     | `apps/controller/src/index.ts` owns `ControllerAppOptions` and `serveConsole`. Pass the snapshot explicitly, preserving existing routes and headers.                           |
| Browser presentation | `console/index.html`, `console/shell.mjs`, and `console/console.mjs` hardcode the name and mascot in several locations. Share normalized branding.                             |
| Color roles          | `console/console.css` defines `--color-*` tokens and legacy aliases. `console/channels.css` and browser modules also need an inventory of literal presentation colors.         |
| Packaging            | `deploy/helm/openclaw-enterprise/` owns API deployment mounts; root `compose.yaml` owns the development stack. The upstream `Dockerfile` already includes console assets.      |

Controller paths above are relative to `apps/controller/src/` where abbreviated.
No separate architecture RFC is proposed: the design extends the console's
existing responsibility without changing platform ownership or authorization.

## Proposed theme contract

Set the API process's optional `OCC_CONSOLE_THEME_DIR` to an absolute directory
containing `theme.json` and its referenced images. With the variable absent,
serve the bundled OCE appearance. A configured empty, missing, unreadable, or
invalid bundle fails API startup with a specific configuration diagnostic; do
not silently substitute defaults for supplied invalid values.

```json
{
  "schemaVersion": 1,
  "displayName": "Example Agents",
  "logo": "logo.png",
  "favicon": "favicon.png",
  "appleTouchIcon": "touch.png",
  "colors": {
    "accent": "#2457C5",
    "accentHover": "#19439F",
    "accentSubtle": "#2457C514",
    "onAccent": "#FFFFFF"
  }
}
```

Only `schemaVersion` is required. Omitted fields inherit bundled values. Require
a nonblank `displayName` of at most 80 Unicode code points, without control
characters. Use it consistently in desktop navigation, the mobile bar, sign-in,
public error panels, browser title, and initial loading text. Preserve diagnostic
OCC/OCE terminology and source revision metadata. Long names wrap or truncate
visually while retaining the full accessible name.

`colors` accepts a curated mapping to the existing semantic color roles:
`bg`, `surface`, `surface2`, `surfaceHover`, `border`, `borderStrong`, `text`,
`textStrong`, `textMuted`, `accent`, `accentHover`, `accentSubtle`, `onAccent`,
`link`, `success`, `successSubtle`, `warning`, `warningSubtle`, `danger`,
`dangerSubtle`, `info`, `infoSubtle`, `overlay`, and `focus`. Values are six- or
eight-digit hex colors. Reject unknown keys, unsupported versions, and CSS
expressions. Keep typography, spacing, and layout outside the public override
contract. Preserve color-independent status labels and focus visibility; operators
must check their palette's contrast, including text, controls, and focus rings.

Logo and touch-icon files support PNG or WebP; favicons support PNG or ICO.
Accept simple filenames only, with matching file signatures and extensions.
Bound the manifest to 64 KiB, each image to 256 KiB, and the complete referenced
bundle to 768 KiB so it fits an operator-managed ConfigMap. Reject absolute paths,
separators, traversal, remote URLs, and resolved paths outside the bundle root.
Allow Kubernetes ConfigMap projection symlinks whose resolved targets remain
inside that root. Ignore unreferenced files and never expose a directory listing.
All theme content is public, including before authentication; credentials must
never enter the bundle.

Read and validate all referenced bytes into one immutable snapshot before
listening. An API restart applies replacements; changing files underneath a
running API has no effect. Retain the previous bundle for recovery, or remove
the setting and restart to restore bundled branding. Do not hot-reload.

## Implementation

### 1. Load and serve one validated snapshot

- [x] Add `apps/controller/src/composition/console-theme.ts` for bounded file
      loading and validation, and `apps/controller/src/console-theme.ts` for the
      normalized snapshot and safe shell/style rendering. Keep these controller
      internals; expose needed types through the existing controller entrypoint.
- [x] Wire the optional directory through server configuration and both API
      composition paths into `ControllerAppOptions.consoleTheme`. Workers, bootstrap,
      and migrations do not load or mount the theme.
- [x] Extend `console-assets.ts` to serve only normalized theme CSS and referenced
      images under `/console/theme/`. Unknown theme paths return a real asset `404`,
      without the SPA shell or disk-path disclosure. Preserve GET/HEAD, MIME,
      compression negotiation, and existing API JSON failures. Compression caches
      must distinguish app snapshots so concurrent apps cannot share theme bytes.
- [x] Render escaped display metadata, title, startup text, and selected icon
      links into the HTML shell. Load generated external theme CSS after bundled
      styles, before first paint. Use `Cache-Control: no-store` for the shell and
      theme responses so restarts do not leave old branding in browser caches.
      Preserve build metadata and CSP without adding inline-script/style permission.

### 2. Apply branding across the supported console

- [x] Read the normalized shell metadata in `console/shell.mjs` and create
      branded DOM elements with text APIs. Reuse them from `shell.mjs` and `console.mjs`
      for sidebar, mobile, sign-in, expired-session, and public failure views. Keep
      logo sizing, keyboard navigation, and accessible names consistent.
- [x] Map the documented roles to `--color-*` in generated CSS. Audit hardcoded
      presentation colors in console styles/modules and route affected surfaces
      through semantic tokens. Preserve provider and plugin artwork identities.
      Verify buttons, links, fields, hover, focus, overlays, and status messages.
- [x] Exercise `tests/integration/console-theme.test.ts` through actual Fastify routes
      and `tests/browser/console.test.mjs` through real sign-in and Agent navigation.
      Use filesystem bundles and the production loader, not mocked theme responses.

### 3. Mount the bundle with upstream images

- [x] Add `api.consoleTheme.configMapName` and `api.consoleTheme.checksum` Helm
      values. A nonempty name mounts an existing operator-managed ConfigMap read-only
      at `/etc/openclaw/console-theme` and sets the API variable. Mount the directory,
      not individual `subPath` files. A checksum change rolls the API; changing the
      name also changes its Pod template. Never mount themes in Agents or workers.
- [x] Add a focused Compose override under `deploy/examples/console-theme/` that
      bind-mounts the same directory read-only and sets the API variable. Include a
      neutral sample manifest and small raster assets. Document direct-process use.
      Verify the unmodified upstream controller image reads mounted files as its
      existing nonroot user, with the existing read-only filesystem restrictions.
- [ ] Extend `tests/integration/production-kubernetes-packaging.test.mjs` for
      default-off rendering and API-only wiring. Extend the existing QA matrix's
      `model-ui` path with a mounted theme in Compose and Helm installations: sign in,
      inspect branded Agent pages, and complete its regular Agent workflow. Update
      `tests/helpers/qa-installation.mjs`, `qa-browser.mjs`, the QA manifest and CI
      preparation as needed. Keep the scenario selector; no theme-only fake runtime.

### 4. Document, inspect, and record delivery

- [x] Update the [console reference](../../docs/reference/console.md),
      [configuration reference](../../docs/reference/configuration.md), environment
      cheat sheet, and [console flow](../../docs/flows/platform-console.md). Add a
      focused operator guide linked from deployment customization and register it
      once in `docs/docs.json`. Document restart, recovery, public assets, formats,
      limits, and contrast verification beside the configuration steps.
- [ ] Update Storybook asset preparation and `public/frame.html` to consume the
      same normalized metadata/CSS. Add default/custom branding scenarios for
      desktop and mobile navigation, sign-in, loading, denied/empty Agent views,
      credential-missing views, and public errors. Add a long-name case and workflow
      instructions. Rebuild and inspect affected previews in a browser.
- [ ] Capture screenshots and a short sign-in/navigation video outside the
      checkout; provide story names, revision, environment, and proof limits. Attach
      final media to the implementation PR before merging. Label Storybook as
      simulated UI proof and report real installed-workflow results separately.

## Verification

The source implementation and local deployment are delivered. Verification results
and remaining proof appear in the delivery record.

| Required outcome                                | Required proof                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults and partial overrides work             | Fastify and browser integration with absent, minimal, and complete filesystem bundles; inspect computed colors and image responses.                                                                                                                                                |
| Unsafe or broken configuration fails explicitly | Startup rejects malformed/versioned JSON, unknown keys, oversized files, missing images, invalid signatures, escape paths, and outside-root symlinks. Verify ConfigMap projection succeeds.                                                                                        |
| Branding stays data                             | Names containing quotes and HTML delimiters render as text; CSS expressions and remote image paths are rejected; CSP remains restrictive.                                                                                                                                          |
| Assets stay confined and coherent               | Public GET/HEAD, genuine missing-asset 404s, compression, two concurrent app themes, and unchanged live snapshot after file replacement. Restart with new files and verify fresh branding.                                                                                         |
| Supported workflows retain behavior             | Browser sign-in, Agent list/detail navigation, logout, loading, denial, mobile drawer, focus, and missing credentials with the custom theme.                                                                                                                                       |
| Upstream deployment supports drop-in assets     | Existing QA `model-ui` in Compose and Helm using the mounted bundle and unchanged controller image; replace bundle, roll API, reload browser. Use documented disposable cluster/database, pinned images, and authorized credentials. Missing prerequisites leave proof incomplete. |
| UI is reviewable and accessible                 | Rebuilt Storybook inspection, contrast and focus review, final screenshots and interaction video attached to the implementation PR.                                                                                                                                                |

During implementation use the testing and test-audit skills, run lint/typecheck,
workspace and formatting checks, selected integration/browser checks, and
documentation checks. Record required image verification if image recipes or
defaults change. The original planning-only revision used documentation checks and scoped formatting;
implementation adds the integration and browser checks below.

## Delivery record

Implemented on the planning branch against the recorded baseline, with accompanying
source changes.

Verified so far:

- Theme and existing console HTTP suites: 15 passed, no skips, using matching
  dependencies from the built controller image.
- New browser workflow: passed with real Fastify sign-in, Agent navigation,
  mobile drawer, and logout in an isolated source copy using the image's runtime
  dependencies and installed Chrome. The affected full browser suite passed all 50 tests without skips.
- Native TypeScript check: passed against that isolated dependency graph. The
  original checkout graph lacks a baseline Fastify compiler dependency; no
  checkout dependencies were installed or reconciled.
- Helm API-only mount/checksum case, lint, workspace, documentation links/length,
  flow structure, and CI test-manifest audit passed. The full Helm packaging suite passed all 92 tests without skips.
- Rebuilt prepared Storybook assets and inspected nine `Pages/Theming` previews,
  including long-name, empty, denied, loading, missing-credential, mobile, and
  public-error states. All frames became ready without fixture errors. The full
  Storybook manager build remains blocked by its absent installed dependencies.
- The live Compose/Kubernetes deployment passed sign-in, existing Agent detail,
  mobile navigation, and logout with custom branding and no page errors.
  Screenshots and a short video are outside the checkout for conversation delivery.

Remaining: full Compose/Helm QA model turns, Storybook manager build, and PR media
attachments when a PR is created. The canonical independent-review helper's
single attempt failed on network access without producing a validated report;
it is unavailable, not a clean review. Fresh source inspection reported no
verified P0–P2 findings. These gaps keep delivery status In progress. TASK numbering
was checked against current main before publication.

Length review: keep this plan together because the bundle contract, mounting,
restart behavior, and verification form one deployment workflow.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-20: Implement the theme contract, console and deployment integration,
  tests, documentation, and local mounted-theme deployment. Record passing proof
  and the remaining verification gaps.

- 2026-10-20: Created the independent deployment-wide console theming plan from
  source baseline `e8185dac805b737363c7178d3068b310a53a7c24`.
