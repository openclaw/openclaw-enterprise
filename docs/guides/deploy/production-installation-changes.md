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
controller's source revision, not the release checkout, and keep the image
references in `values.yaml` unchanged:

```bash
set -euo pipefail
cd /secure/src/openclaw-enterprise-installed # checkout of the deployed source revision
cp /secure/occ/installation.yaml /secure/occ/installation.yaml.before
# Edit /secure/occ/installation.yaml and review the diff, then:
yq -r '.presets.files[]?' /secure/occ/installation.yaml | while read -r preset_file; do
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system exec deploy/openclaw-enterprise-api --container api -- \
    sh -c 'cd "$(dirname "$OCC_CONFIG_PATH")" && test -f "$1" && test -r "$1"' sh "$preset_file" ||
    { echo "Could not verify Preset file $preset_file in the API container." >&2; exit 1; }
done
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
export OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)"
jq -n --arg key "$OCC_INSTALLATION_KEY" --rawfile document /secure/occ/installation.yaml \
  '{data: {($key): ($document | @base64)}}' |
  kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
    --namespace openclaw-system patch secret "$OCC_INSTALLATION_SECRET" \
    --type merge --patch-file /dev/stdin
OCC_CHECKSUM="$(sha256sum /secure/occ/installation.yaml | cut -d ' ' -f 1)" \
  yq -i '.controlPlane.installationChecksum = strenv(OCC_CHECKSUM)' /secure/occ/values.yaml
helm upgrade oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig --kube-context '<reviewed-context>' \
  --namespace openclaw-system -f /secure/occ/values.yaml --wait --timeout 5m
```

The new checksum restarts the API and worker so they read the new Installation.
This path has no startup preflight, and the API stops before its replacement
starts: an Installation the controller rejects keeps the API down, with a
`startup-error` code such as `PRESET_FILE_INVALID`, until you undo the change.
The Preset loop checks file readability, not contents. Helm reports a rejection
only after its 5-minute timeout; the API log shows `startup-error` sooner, but
let Helm return before you undo.
The patch replaces only the Installation key and keeps the Secret's
`openclaw.dev/installation-id` annotation. Do not re-create the Secret with
`kubectl apply`: if its last applied configuration carries that annotation,
apply deletes it and the next upgrade refuses the Secret. Settings that
shape Agent Pods, such as Gateway resources, apply only to Pods created
afterward; deploy an Agent to apply them to it. To undo, restore the `.before`
file and rerun the Secret patch, checksum and `helm upgrade` commands; skip the
loop, which needs a running API container. The edited files are the baseline for
the next upgrade.
