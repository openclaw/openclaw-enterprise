# Apply a console theme

Mount a theme bundle into the API container and restart the API. Use the same
upstream controller image for every brand; no image rebuild is required to
replace theme files. The [theme reference](../../reference/console/theming.md)
owns the manifest, supported colors, image formats, and size limits.

## Prepare the directory

Start with `deploy/examples/console-theme/theme.json` and `logo.png`, or create
your own manifest and images. Mount the directory read-only for the API's nonroot
user. On the host, only trusted deployment administrators may change the bundle
or replace any directory in its path. A read-only bind mount still reflects host
writes. Theme assets and the display name are public before sign-in; keep credentials
and private information elsewhere.

## Podman or Docker Compose

From the repository root, select an absolute host directory:

```sh
export OCC_CONSOLE_THEME_DIRECTORY='/absolute/path/to/theme'
podman compose -f compose.yaml \
  -f deploy/examples/console-theme/compose.yaml up -d
```

The override mounts the directory read-only and sets the API's
`OCC_CONSOLE_THEME_DIR`. For an existing generated local installation, replace
the first `compose.yaml` with its state directory's Compose file, preserve its
project name, and use `up -d --no-deps --force-recreate controller` to update only
the API. Keep the override in subsequent Compose commands so recreating the API
does not discard its theme. Docker Compose accepts the same override.

To replace files in the same directory, restart `controller` with both files
selected. The worker does not need restarting for theme changes.

## Kubernetes with Helm

Create a ConfigMap from the public bundle, selecting only the manifest and
referenced images. For a manifest referencing `logo.png`:

```sh
kubectl --context '<deployment-context>' -n '<platform-namespace>' \
  create configmap console-theme-v1 \
  --from-file=theme.json=/absolute/path/to/theme/theme.json \
  --from-file=logo.png=/absolute/path/to/theme/logo.png
```

Include any referenced favicon or touch icon with another `--from-file`. Add
these values to the deployment's existing Helm values and upgrade the release:

```yaml
api:
  consoleTheme:
    configMapName: console-theme-v1
    checksum: "v1"
```

The chart mounts the ConfigMap directory read-only on the API alone. The API
captures its bytes at startup. Updating an existing ConfigMap requires changing
`checksum` to roll the API, or explicitly restarting the API Deployment. A new
ConfigMap name also triggers replacement. Keep the previous bundle for recovery.

## Direct process

Set `OCC_CONSOLE_THEME_DIR=/absolute/path/to/theme` alongside the controller's
normal development or production configuration before starting it. This setting
does not change listener, authentication, or database requirements.

## Verify and recover

Open `/console/login`, then sign in and inspect the sidebar, an Agent detail page,
and mobile navigation. Check the title, logo, primary controls, keyboard focus,
status messages, and contrast. Sign out and confirm the public page keeps the
theme. Replace the bundle, restart the API, and reload to verify the new snapshot.

`CONSOLE_THEME_INVALID` means startup refused the bundle. Check the manifest,
referenced filenames, file signatures, size limits, and nonroot read permissions.
The API does not silently fall back. Restore the previous directory or ConfigMap
and restart. To restore bundled OCE branding, remove the variable and mount, or
clear Helm's `api.consoleTheme.configMapName`, then recreate the API.
