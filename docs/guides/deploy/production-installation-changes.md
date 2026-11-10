# Apply other Installation changes

Use this procedure for Installation changes that an
[image upgrade](production-upgrade.md) does not apply.

An upgrade keeps your Installation YAML. A release that changes recommended
Installation values, such as the Gateway and Harness memory requests and limits
in the [installation profiles](installation-profiles.md) and production example,
does not change an existing Installation; adopted resource values apply to each
Agent at its next deployment. A candidate that changes any setting other
than the Plugin Driver selection stops the helper with `candidate Installation
changes a protected setting`. Diff `deploy/examples/production/installation.yaml`
and `scripts/render-installation-profile.mjs` between the deployed and candidate
source, decide which changes to adopt, and apply them as a separate change, not
during an image upgrade. Run these commands from a checkout of the installed
controller's source commit, not the release checkout, and keep the image
references in `values.yaml` unchanged.

For configuration-only changes and their recovery, use
`database.upgradeMigration: separate`. The initialization hook then requires the
installed image's migration history to be current instead of applying migrations.
Keep database connection and platform authentication settings fixed. A pending-history refusal requires
investigation, not switching this configuration change back to migration mode.

## Change a mutable Installation Secret

Run the setup once for each reviewed change. If
`/secure/occ/installation.yaml.before` already exists, preserve it and reconcile
the previous change before continuing. During recovery, use that original backup;
do not repeat the backup command after editing `installation.yaml`.

```bash
set -euo pipefail
cd /secure/src/openclaw-enterprise-installed # checkout of the deployed source revision
cp /secure/occ/installation.yaml /secure/occ/installation.yaml.before
# Edit /secure/occ/installation.yaml and review the diff, then:
OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)"
OCC_CHECKSUM="$(sha256sum /secure/occ/installation.yaml | cut -d ' ' -f 1)"
jq -n --arg key "$OCC_INSTALLATION_KEY" --rawfile document /secure/occ/installation.yaml \
  '{data: {($key): ($document | @base64)}}' |
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system patch secret "$OCC_INSTALLATION_SECRET" \
    --type merge --patch-file /dev/stdin
OCC_CHECKSUM="$OCC_CHECKSUM" \
  yq -i '.controlPlane.installationChecksum = strenv(OCC_CHECKSUM) |
    .database.upgradeMigration = "separate"' /secure/occ/values.yaml
helm upgrade oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
  --namespace openclaw-system -f /secure/occ/values.yaml --wait --timeout 5m
```

The new checksum restarts the API and worker so they read the new Installation.
First, the `installation-check` container of the pre-upgrade initialization Job
loads the new Installation in the release's controller image, as API startup
does. It reads the Preset files, Driver packages, repository registry and
prepared GitHub issuer CA that the Installation names.
If startup would refuse it, the upgrade fails before migration and the old API
and worker keep serving. The log names the setting and file:

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system logs job/oce-initialization --container installation-check
# installation-check: API and worker startup would refuse the Installation
# (PRESET_FILE_INVALID): presets.files: Preset file /etc/openclaw/installation/team.json is unavailable.
```

Undo a refused change right away, since a restarted API Pod reads the Secret.
The check skips Kubernetes Compute preflight, database checks and the ChatGPT
admin-key file; if the new API logs `startup-error`, undo the change too.

The patch replaces only the Installation key and keeps the Secret's
`openclaw.dev/installation-id` annotation. Do not re-create the Secret with
`kubectl apply`: if its last applied configuration carries that annotation,
apply deletes it and the next upgrade refuses the Secret. Settings that
shape Agent Pods, such as Gateway resources, apply only to Pods created
afterward; deploy an Agent to apply them to it. To undo, restore the `.before`
file, recompute its checksum, then rerun the Secret patch, values update and
`helm upgrade` commands. The
edited files are the baseline for the next upgrade.

## Change an immutable Installation Secret

Use a new Secret for the reviewed configuration and retain the original for
recovery. This is a separate, same-image Helm change; it does not expand the
[image-upgrade helper's allowed changes](immutable-installation-upgrade.md).
Ordinary Helm does not compare the Secret's Installation annotation with OCC's
stored identity. The operator must make that comparison before switching.

Use the installed source checkout and the release's exact kubeconfig, context
and namespace. Configure `occ` for that same release with an identity that can
read its Installation. Freeze concurrent deployment/configuration changes.
Preserve any existing evidence rather than overwriting it; the following paths
must be unused for this change:

```bash
set -euo pipefail
umask 077
cp /secure/occ/values.yaml /secure/occ/values.yaml.before
cp /secure/occ/installation.yaml /secure/occ/installation.yaml.before
kube=(kubectl --kubeconfig /secure/occ/kubeconfig
      --context '<reviewed-context>' --namespace openclaw-system)
original_secret=$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)
installation_key=$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)
successor_secret='occ-installation-config-<unique-name>'
occ --output json installation get > /secure/occ/installation-live.json
OCC_INSTALLATION_ID=$(jq -er '.id | select(type == "string" and length > 0)' /secure/occ/installation-live.json)
"${kube[@]}" get secret "$original_secret" --output json > /secure/occ/original-installation-secret.json
jq -e --arg id "$OCC_INSTALLATION_ID" '
  .immutable == true and .metadata.annotations["openclaw.dev/installation-id"] == $id
' /secure/occ/original-installation-secret.json >/dev/null
```

Edit `/secure/occ/installation.yaml`, review its diff against the backup, and
copy the reviewed file to `/secure/occ/staged-installation.yaml`. Keep all image,
database connection and platform authentication settings unchanged. Apply any matching chart
settings to `values.yaml`, retaining its original backup.

Use only [Create the successor](immutable-installation-upgrade.md#create-the-successor)
to construct and create the new Secret from these variables and files. Reuse
the retained original JSON; do not repeat that section's initial Secret read.
The construction preserves the namespace, type, Installation annotation, data key
and unrelated data. Choose a unique name; never overwrite an existing Secret.
Keep the original JSON, including its UID, as evidence. Do not run that guide's
image-upgrade or candidate-values steps for this configuration change.

Read the created object back and compare it before Helm:

```bash
"${kube[@]}" get secret "$successor_secret" --output json > /secure/occ/successor-created.json
jq -en --arg id "$OCC_INSTALLATION_ID" --arg key "$installation_key" \
  --arg name "$successor_secret" --rawfile config /secure/occ/staged-installation.yaml \
  --slurpfile old /secure/occ/original-installation-secret.json \
  --slurpfile next /secure/occ/successor-created.json '
  $old[0] as $a | $next[0] as $b |
  $a.metadata.annotations["openclaw.dev/installation-id"] == $id and
  $b.metadata.annotations["openclaw.dev/installation-id"] == $id and
  $b.metadata.name == $name and $b.metadata.uid != $a.metadata.uid and
  $b.metadata.namespace == $a.metadata.namespace and
  $b.type == $a.type and $b.immutable == true and
  ($b.data | del(.[$key])) == ($a.data | del(.[$key])) and
  $b.data[$key] == ($config | @base64)' >/dev/null
test "$("${kube[@]}" get secret "$original_secret" --output jsonpath='{.metadata.uid}')" = \
  "$(jq -er '.metadata.uid' /secure/occ/original-installation-secret.json)"
OCC_CHECKSUM=$(sha256sum /secure/occ/staged-installation.yaml | cut -d ' ' -f 1)
SUCCESSOR_SECRET="$successor_secret" OCC_CHECKSUM="$OCC_CHECKSUM" \
  yq -i '.installation.secretName = strenv(SUCCESSOR_SECRET) |
    .controlPlane.installationChecksum = strenv(OCC_CHECKSUM) |
    .database.upgradeMigration = "separate"' /secure/occ/values.yaml
```

Keep `installation.key` unchanged. Review the final values diff to confirm that
all images, database connection and platform authentication settings remain fixed.
Then run:

```bash
helm upgrade oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
  --namespace openclaw-system -f /secure/occ/values.yaml --wait --timeout 5m
```

The initialization check must pass before the API and worker roll onto the new
Secret. Verify their readiness and `occ installation get` against the retained
Installation ID. Agent settings take effect on newly created Agent Pods; deploy
an Agent when needed, then verify its actual behavior.

Retain both Secrets, their UIDs and the original configuration/values throughout
recovery. To restore configuration, use the original Secret reference and
configuration checksum with the unchanged images, database connection and platform authentication settings
and `database.upgradeMigration: separate`, then repeat the same-image Helm
operation and readiness checks. Inspect an uncertain Helm outcome before
another operation. This restores configuration only; it does not roll back
schema or provider effects. Keep each Secret while any workload, retained
release or unresolved recovery still needs it.
