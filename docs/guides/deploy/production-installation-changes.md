# Apply other Installation changes

Use this procedure for Installation changes that an
[image upgrade](production-upgrade.md) does not apply.

An upgrade keeps your Installation YAML. A release that changes recommended
Installation values, such as the Gateway and Harness memory requests and limits
in the [installation profiles](installation-profiles.md) and production example,
does not change an existing Installation. Adopted resource values apply to each
Agent at its next deployment. A candidate that changes any setting other
than the Plugin Driver selection stops the helper with `candidate Installation
changes a protected setting`. Diff `deploy/examples/production/installation.yaml`
and `scripts/render-installation-profile.ts` between the deployed and candidate
source. If the deployed release predates the TypeScript renderer, compare its
`scripts/render-installation-profile.mjs` implementation with the candidate
TypeScript file. Decide which changes to adopt and apply them separately from
the image upgrade. Run the apply block from a checkout of the installed
controller's source commit. Keep the image references in `values.yaml` unchanged.

This procedure requires a mutable Installation Secret.

Run the backup block once for each reviewed change. Use Bash with GNU `dd`. If
`/secure/occ/installation.yaml.before` already exists, preserve it and reconcile
the previous change before continuing.

```bash
set -euo pipefail
(
  umask 077
  dd if=/secure/occ/installation.yaml of=/secure/occ/installation.yaml.before conv=excl
)
```

If backup creation fails, stop before editing or applying the change. A failed
copy can leave an incomplete backup.

Edit `/secure/occ/installation.yaml` and review the diff. Set `OCC_CONTEXT` to
the reviewed Kubernetes context and run the entire apply block in Bash.
Coordinate with the release owner to avoid concurrent changes to the release.

The apply block unsets Helm connection overrides so Helm and kubectl use the
same kubeconfig. Leave `HELM_DRIVER` unset or set it to `secret`. The block
checks that Helm finds `oce` deployed in `openclaw-system` in the Secret store
before changing the Installation Secret or checksum. If either check fails,
stop and contact the release owner. The same checks apply when you undo a change.

```bash
set -euo pipefail
cd /secure/src/openclaw-enterprise-installed # checkout of the deployed source revision
OCC_CONTEXT='<reviewed-context>'
unset HELM_KUBEAPISERVER HELM_KUBECAFILE HELM_KUBETLS_SERVER_NAME \
  HELM_KUBEINSECURE_SKIP_TLS_VERIFY HELM_KUBETOKEN HELM_KUBEASUSER HELM_KUBEASGROUPS
if [[ "${HELM_DRIVER-secret}" != secret ]]; then
  printf '%s\n' 'Stop. Unset HELM_DRIVER or set it to secret.' >&2
  exit 1
fi
if ! helm status oce --kubeconfig /secure/occ/kubeconfig --kube-context "$OCC_CONTEXT" \
  --namespace openclaw-system --output json |
  jq -es 'length == 1 and (.[0] | .name == "oce" and
    .namespace == "openclaw-system" and .info.status == "deployed")' >/dev/null; then
  printf '%s\n' 'Stop. Could not confirm that oce is deployed in openclaw-system. Contact the release owner.' >&2
  exit 1
fi
OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' /secure/occ/values.yaml)"
OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' /secure/occ/values.yaml)"
OCC_CHECKSUM="$(sha256sum /secure/occ/installation.yaml | cut -d ' ' -f 1)"
jq -n --arg key "$OCC_INSTALLATION_KEY" --rawfile document /secure/occ/installation.yaml \
  '{data: {($key): ($document | @base64)}}' |
  kubectl --kubeconfig /secure/occ/kubeconfig --context "$OCC_CONTEXT" \
    --namespace openclaw-system patch secret "$OCC_INSTALLATION_SECRET" \
    --type merge --patch-file /dev/stdin
OCC_CHECKSUM="$OCC_CHECKSUM" \
  yq -i '.controlPlane.installationChecksum = strenv(OCC_CHECKSUM)' /secure/occ/values.yaml
helm upgrade oce deploy/helm/openclaw-enterprise \
  --kubeconfig /secure/occ/kubeconfig --kube-context "$OCC_CONTEXT" \
  --namespace openclaw-system -f /secure/occ/values.yaml --wait --timeout 5m
```

The new checksum restarts the API and worker so they read the new Installation.
First, the `installation-check` container of the pre-upgrade initialization Job
loads the new Installation in the release's controller image, as API startup
does. It reads the Preset files, Driver packages, repository registry and
prepared GitHub issuer CA that the Installation names.
If startup would refuse the Installation, the upgrade fails before migration.
Check the initialization Job log for the setting and file. If you read the log
in a new shell, set `OCC_CONTEXT` to the same reviewed context first.

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context "$OCC_CONTEXT" \
  --namespace openclaw-system logs job/oce-initialization --container installation-check
# installation-check: API and worker startup would refuse the Installation
# (PRESET_FILE_INVALID): presets.files: Preset file /etc/openclaw/installation/team.json is unavailable.
```

A replacement API Pod can read the changed Secret before the upgrade completes.
The initialization check skips Kubernetes Compute preflight, database checks
and the ChatGPT admin-key file.

If the upgrade fails or is interrupted, stop. Also stop if the latest release
is failed or pending, or if you cannot confirm it is deployed. Preserve the
original backup and leave the Installation Secret and checksum as they are.
Contact the release owner promptly to check Helm history and reconcile any
writes from the upgrade before undoing the change. Check the latest release
status even when the previous API and worker Pods are still running.

If the new API logs `startup-error` after a successful upgrade, confirm that
your change is the one to undo. Before restoring the backup, run the Helm store
and status checks at the start of the apply block. If both checks pass, copy
`/secure/occ/installation.yaml.before` back to `/secure/occ/installation.yaml`.
If the copy succeeds, run the entire apply block with the same reviewed context.
The block repeats both checks before patching the Secret or writing the checksum.
Do not repeat the backup or edit.

The patch replaces only the Installation key and keeps the Secret's
`openclaw.dev/installation-id` annotation. Do not re-create the Secret with
`kubectl apply`. If the last applied configuration carries that annotation,
the command deletes it and the next upgrade refuses the Secret. Settings that
shape Agent Pods, such as Gateway resources, apply only to Pods created
afterward. Deploy an Agent to apply them to it. The edited files are the
baseline for the next upgrade.
