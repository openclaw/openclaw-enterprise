# Customize installation profiles

Use a trusted profile file to change the bundled PluginDriver configuration.
First [prepare the site input](installation-profiles.md#prepare-inputs), images,
Secrets and infrastructure. Profile files do not provision resources or load
custom Driver modules.

From the repository root, copy the matching bundled profile:

```sh
mkdir -p .build/profiles
cp deploy/profiles/codex.json .build/profiles/codex.json
```

Edit `installation.drivers.plugin`, for example to
[select the curated catalog](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
Then render with your prepared site input:

```sh
node scripts/render-installation-profile.mjs \
  --profile codex \
  --profile-file .build/profiles/codex.json \
  --input .build/profiles/input.json \
  --out-dir .build/profile-renders/codex
```

Paths resolve from the working directory. The file replaces the bundled profile;
its `name` must match `--profile` (`openclaw` or `codex`). Unknown fields,
unreadable files, invalid JSON and mismatched names fail without fallback.
A failed rerender removes prior generated outputs; success writes `values.yaml`,
`installation.yaml` and `preflight.json`. Continue with
[Use rendered files](installation-profiles.md#use-rendered-files).

Only the selection under `installation.drivers.plugin` is copied. Its `id` must
be `occ-plugin` or `codex-plugin`. Omitted `configuration` becomes `{}`; supplied
configuration must be an object. **The Driver validates its options at controller
startup.** Rendering does not detect every option typo or prove startup or
deployment. Review the selected Driver's documented options before applying Helm.

Required strings `description`, `recommendedPreset`, `agentHarness` and
`pluginSelection` are descriptive metadata. They do not override infrastructure,
change the profile family or select a Console starter.

## Configure Preset seeding

To seed additional Presets, add `"presets": { "files": ["/app/deploy/presets/swe-preset.json"] }`
to the input JSON and rerender. This adds **SWE Agent** alongside the bundled
Presets. Set `presets.includeDefaults` to `false` to seed only the listed files;
omit `files` as well to seed no Presets. The renderer defaults `includeDefaults`
to `true`. Both controllers must read the files at startup; the renderer only validates paths. Disabling
seeding does not delete saved Presets. See
[Preset initialization](../../reference/presets.md#installation-defaults) for path
resolution and startup validation.

The Console [chooses a readable starter](../../reference/presets.md#plain-console-default)
independently of `recommendedPreset`.

For hosted catalogs, check the
[discovery egress requirements](installation-profiles.md#hosted-discovery-egress).
The `openclaw` family with hosted `codex-plugin` requires DNS at rendering time;
use curated discovery when that combination must render offline.
