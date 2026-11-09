# Upgrade with an immutable Installation Secret

Stage a new immutable Secret before running the [production image upgrade](production-upgrade.md).
Use `--candidate-values` to select its name. The helper validates both Secrets,
switches the Helm reference during the upgrade, and retains the original for
recovery. It does not create, modify, or delete either Secret.

Use this procedure when the installed Secret is immutable and the upgrade needs
different Installation configuration, including a new runtime image. If the
configuration stays the same, the ordinary upgrade can keep the existing Secret.
Both Secrets must be in the release namespace, use the same data key, and identify
the same Installation. This procedure does not permit additional configuration
changes beyond those supported by the image-upgrade helper.

## Prepare the staged configuration

Complete the [release preparation](production-upgrade.md#prepare-the-release),
including the protected baseline, image qualification and backups. Keep the
original `--values` and `--installation` files unchanged. Freeze unrelated edits
to the release and both Secrets through the upgrade and recovery.

In the same dedicated Bash shell, select a new Secret name and read the existing
name and key from the protected values. Use your release's actual namespace and
context:

```bash
umask 077
kube=(kubectl --kubeconfig /secure/occ/kubeconfig
      --context '<reviewed-context>' --namespace openclaw-system)
original_secret=$(yq -er '.installation.secretName // "occ-installation-startup"' \
  /secure/occ/values.yaml)
installation_key=$(yq -er '.installation.key // "installation.yaml"' \
  /secure/occ/values.yaml)
successor_secret='occ-installation-next'
cp /secure/occ/values.yaml /secure/occ/candidate-values.yaml
cp /secure/occ/installation.yaml /secure/occ/staged-installation.yaml
SUCCESSOR_SECRET="$successor_secret" yq -i \
  '.installation.secretName = strenv(SUCCESSOR_SECRET)' \
  /secure/occ/candidate-values.yaml
```

For a runtime upgrade, apply the same qualified digest that you will pass as
`--runtime-image`:

```bash
export RUNTIME_IMAGE='<registry>/<runtime>@sha256:<qualified-digest>'
yq -i \
  '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
   .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' \
  /secure/occ/staged-installation.yaml
```

If you also prepared supported [Installation settings](production-upgrade.md#include-reviewed-settings),
start the staged file from that reviewed candidate before applying the runtime
digest. Keep the file passed as `--candidate-installation` separate: it contains
only the supported settings changes, with image fields still matching the
baseline. The image flag supplies the new runtime selection.

The staged YAML must describe the helper's final candidate configuration. All
Installation mapping keys must be strings; quote numeric-looking label keys. YAML
formatting may differ; the helper adopts the staged bytes and computes the
checksum from them after checking the configuration.

## Create the successor

The Kubernetes identity needs permission to read the original Secret and create
the successor. These files contain Installation configuration and any other
data already in the Secret; keep them private.

Read the original, then construct the successor with its data, type and bound
Installation ID. Only the selected data key changes. The new Secret has its own
name and UID:

```bash
"${kube[@]}" get secret "$original_secret" --output json \
  > /secure/occ/original-installation-secret.json
jq -e --arg name "$successor_secret" --arg key "$installation_key" \
  --rawfile config /secure/occ/staged-installation.yaml '
  select(.immutable == true) |
  select(.metadata.annotations["openclaw.dev/installation-id"] | type == "string") |
  select(.data[$key] | type == "string") |
  {
    apiVersion: "v1", kind: "Secret", type: .type, immutable: true,
    metadata: {
      name: $name, namespace: .metadata.namespace,
      annotations: {
        "openclaw.dev/installation-id": .metadata.annotations["openclaw.dev/installation-id"]
      }
    },
    data: (.data | .[$key] = ($config | @base64))
  }' /secure/occ/original-installation-secret.json \
  > /secure/occ/successor-installation-secret.json
```

Continue only if both commands succeeded. Review the protected result, then
create it:

```bash
"${kube[@]}" create -f /secure/occ/successor-installation-secret.json
```

A name collision stops creation. Inspect the existing object rather than
replacing or deleting it. The upgrade checks the bound Installation ID against
OCC, both Secret identities, and the candidate configuration before stopping
writers. Staging alone does not change the running release.

## Preflight, upgrade and recover

Add `--candidate-values /secure/occ/candidate-values.yaml` to the ordinary
control-plane or runtime upgrade command. Include the separate
`--candidate-installation` file only when changing supported settings. First run
with `--preflight-only` and a fresh evidence directory. Preflight rechecks both retained Secrets after its temporary Jobs finish. A passing
preflight leaves the original release serving; then run with a different fresh
evidence directory and the required writer freeze.

On success, the helper verifies the successor at the Installation mount in
Helm's initializer and controller workloads. Runtime upgrades still redeploy the recorded running Agents and
verify their selected revisions. Complete the normal
[application verification](production-upgrade.md#verify-the-release).

Retain both Secrets and all protected inputs during recovery. Resume the same
attempt using the original command, unchanged candidate files and evidence
directory. A deleted or replaced Secret, changed data, or an unexpected Helm
revision requires investigation; a new object with the same name is not the
recorded object. Follow [upgrade recovery](production-upgrade-recovery.md) for
uncertain outcomes and [same-candidate Helm recovery](production-helm-recovery.md)
when applicable. Do not switch references manually to make resume pass.

A return to the previous release can use the retained original reference only
after satisfying the existing database and workload recovery requirements.
Changing the Secret reference does not restore persisted state. Keep each Secret
while a workload, retained release or unresolved upgrade still needs it.
