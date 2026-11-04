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
references in `values.yaml` unchanged:

```bash
set -euo pipefail
cd /secure/src/openclaw-enterprise-installed # checkout of the deployed source revision
cp /secure/occ/installation.yaml /secure/occ/installation.yaml.before
# Edit /secure/occ/installation.yaml and review the diff, then:
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
file and rerun the Secret patch, checksum and `helm upgrade` commands. The
edited files are the baseline for the next upgrade.
