# Console theme bundles

Set the API's `OCC_CONSOLE_THEME_DIR` to an absolute directory containing
`theme.json` and referenced image files. Themes apply to the whole deployment,
including public sign-in and error pages. They configure presentation; they do
not change Installation identity, permissions, or Agent runtime interfaces.
See [Apply a console theme](../../guides/deploy/console-theme.md) for mounting and recovery.

With the variable absent, the console uses bundled OpenClaw Enterprise branding.
Startup reads the complete bundle before listening and retains those bytes until
the API restarts. Invalid configured bundles stop startup with
`CONSOLE_THEME_INVALID`; omitted fields inherit bundled defaults.

## Manifest

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

Only `schemaVersion` is required; its value must be `1`. Unknown fields and color
roles are rejected. `displayName` is nonblank text of at most 80 Unicode code
points, without control or formatting characters. It appears in desktop and
mobile navigation, sign-in and public errors, the browser title, and initial
loading text. Long names wrap in the sidebar and truncate in the mobile bar;
their full text remains accessible. Build diagnostics retain OCC/OCE terminology.

Image fields are simple filenames, not URLs or paths. Logo and touch icons accept
PNG and WebP; favicons accept PNG and ICO. Extensions must match file signatures.
SVG, custom CSS/JavaScript, external image URLs, custom fonts, and browser uploads
are unsupported. Unreferenced files are neither loaded nor served. Referenced
files, including ConfigMap projection symlinks, must resolve inside the directory.
The bundle is trusted deployment configuration. Only deployment administrators may
write its files or replace directories in its path; the loader's path checks do
not isolate files from an untrusted process that can change the mount during startup.

The manifest limit is 64 KiB; each image is limited to 256 KiB. The manifest and
distinct referenced images together must fit 768 KiB. These bounds support a
single operator-managed Kubernetes ConfigMap. Supply appropriately sized images:
the logo renders at 20 pixels in navigation and 40 pixels on sign-in.

## Color roles

Colors accept `#RRGGBB` or `#RRGGBBAA`. CSS expressions are rejected. The generated
stylesheet overrides semantic tokens after the bundled styles without changing
typography, spacing, or layout. A translucent `bg` blends once with the browser’s
canvas color. A modal dims that same background across the page and any empty
scrollbar gutter.

| Roles                                               | Surfaces                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `bg`, `surface`, `surface2`, `surfaceHover`         | Page, cards, secondary panels, hover backgrounds            |
| `border`, `borderStrong`                            | Separators and control borders                              |
| `text`, `textStrong`, `textMuted`                   | Body text, headings, secondary text                         |
| `accent`, `accentHover`, `accentSubtle`, `onAccent` | Primary controls, hover, accent backgrounds, text on accent |
| `link`, `focus`                                     | Links and keyboard focus rings                              |
| `success`, `successSubtle`                          | Success text and backgrounds                                |
| `warning`, `warningSubtle`                          | Warning text and backgrounds                                |
| `danger`, `dangerSubtle`                            | Destructive actions, failures, and their backgrounds        |
| `info`, `infoSubtle`                                | Informational text and backgrounds                          |
| `overlay`                                           | Modal backdrop                                              |

Provider and plugin artwork keeps its own colors. Operators must check their
palette's contrast for text, disabled and enabled controls, focus rings, and
status messages. Retain text labels that distinguish success, warning, and failure;
color alone must not communicate their meaning.

## Public assets and lifecycle

All theme content is public before authentication. Never put credentials or
private information in a bundle. The API serves generated CSS and referenced
images under `/console/theme/`; it does not publish `theme.json` or a directory
listing. Missing theme assets return a plain `404`, not the console shell.
The shell and assets use `Cache-Control: no-store`.

Replacing files does not change a running API's snapshot. Restart the API after
replacement; in Helm, change the ConfigMap name or `api.consoleTheme.checksum`.
Workers, bootstrap, migrations, and Agent Pods do not load the theme.
See the [console flow](../../flows/platform-console.md) for implementation and
[browser checks](../../testing/local.md#console-browser-checks) for verification boundaries.
