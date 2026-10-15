# Recover or remove the observability demo

These steps continue [the observability demonstration stack](demo.md). Run them in the shell that ran its setup, with `HELM_KUBECONTEXT`, `OBS_OCC_RELEASE`, `OBS_OCC_NAMESPACE`, `$OBS_FILES` and the `release_digest` function from that page still defined.

## Recover an incomplete setup

Do not rerun failed or interrupted commands: an absent marker does not prove
no changes. The one exception is a demo install that timed out waiting; rerun
that block as the [setup guide](demo.md#install-private-backends) describes. Confirm cluster UID, OCC status, complete history, saved revision
and live resources. If upgrade was never invoked and OCC matches the saved
revision, no rollback is needed. Otherwise retain dependencies and inspect for
rollback below or escalate. If backup or cluster identity is unavailable, stop
and reconcile with a qualified operator.

Inspect demo status, every relevant history revision, manifests, hooks and live objects
in both namespaces, including the OCC discovery Role and RoleBinding, Grafana
Secret and both Collector Secrets. Record UIDs and establish creation and ownership
from independent records, not names or labels. Check workloads, Pods and external
Collectors for references. Retain and escalate on failed reads or ambiguity.
Account for objects without a release record or outside the latest manifest.

Once OCC and external exporters no longer depend on the demo, if the release
exists, a qualified operator must establish ownership and revision. Inspect the
latest manifest, pre/post-delete hooks, policies and effects, and every live
object Helm can delete. Confirm unchanged release and object UIDs and exclude
other writers. Run `helm uninstall demo -n oce-observability-demo --wait --timeout 5m`
once, or skip it if the release is confirmed absent. Reconcile failure or
interruption without retrying; verify the release and resources are gone.

Delete separately created or leftover resources through the Kubernetes API with
UID preconditions, only after proving creation, current UID and no references.
Check namespace UID, contents, finalizers and dependencies before deleting it;
retain anything unproved. Restart only with an owned, clean namespace and
unreserved release name. If either cannot be reconciled, use fresh names and
retain the backup. Otherwise, after verified cleanup, confirm `$OBS_FILES` names
the setup directory, delete it, and unset it.

## Refresh a renamed Loki address

A custom release with a leading digit may already run on a cluster with relaxed
Service-name validation. Upgrading its chart can rename Loki even though the old
Service was valid there. The old endpoint saved by a managed or external
Collector then stops accepting logs. Grafana updates its own datasource only.

After the owned demo upgrade completes, read the actual Loki Service name from
its manifest. Check the release, namespace, cluster UID and exporter ownership
before writing. For the dedicated managed Collector from the setup guide, set
`OBS_DEMO_RELEASE` and `OBS_DEMO_NAMESPACE` to that demo's actual identity:

```bash
(
  set -euo pipefail
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  loki_service=$(helm get manifest "$OBS_DEMO_RELEASE" -n "$OBS_DEMO_NAMESPACE" |
    yq -r 'select(.kind == "Service" and .spec.selector."app.kubernetes.io/component" == "loki") | .metadata.name')
  test -n "$loki_service"
  endpoint="http://${loki_service}.${OBS_DEMO_NAMESPACE}.svc:3100/otlp/v1/logs"
  revision=$(kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get secret occ-demo-collector-exporter -o jsonpath='{.metadata.resourceVersion}')
  patch=$(jq -cn --arg endpoint "$endpoint" --arg revision "$revision" \
    '{metadata: {resourceVersion: $revision}, data: {OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ($endpoint | @base64)}}')
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" patch secret occ-demo-collector-exporter --type=merge -p "$patch"
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" rollout restart daemonset/openclaw-enterprise-collector
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" rollout status daemonset/openclaw-enterprise-collector --timeout=2m
)
```

The patch preserves other exporter keys, including credentials, and rejects a
concurrent Secret change. Stop on a conflict and reinspect. Secret environment
variables are read when a Pod starts, so updating the Secret without refreshing
the Collector leaves the old address active. If the installation uses another
verified exporter Secret, use its configured name instead of the guide's name.

For an external Collector, update its owned Loki `logs_endpoint` or
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, retain its filtering, credentials and verified
TLS settings, and reload or restart that Collector through its owning workflow.
Use an endpoint reachable from its network; update any address-based egress rule
that pinned the old destination. The demo's Pod selectors stay unchanged.

Send a fresh authorized operational record and find it in Loki or Grafana after
the refresh. A Collector receive acknowledgement or a ready Pod alone does not
prove delivery. Inspect Collector export failures and retry/queue metrics if it
is absent. Demo rollouts can lose buffered records and disposable stored data;
this procedure restores new ingestion rather than guaranteeing old-record replay.

## Remove only the demo

Redirect external Collectors away from Loki and allow active work to finish;
rollback can restart OCC Pods. Compare current and original manifests with live
resources, UIDs and Helm ownership annotations, including objects rollback can
delete or replace and failed-upgrade remnants. Retrieve the original hooks with
`helm get hooks "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$(cat "$OBS_FILES/occ-revision")"`.
Inspect every pre/post-rollback hook, deletion policy, live name, UID and side
effect under the upgrade inspection rules. Stop on failed inspection or an unowned,
replaced or ambiguous object. Preserve backend, Secrets, history and backup; do
not blindly repeat operations. After inspection, `touch "$OBS_FILES/rollback-inspected"`;
the command consumes it before rollback. Reinspect after failure or interruption.

Rollback uses the original revision's chart, values, manifest and hooks. Only it
or the immediately following demo revision is accepted. Stop for manual
reconciliation on pending or unexpected states, pruned or changed backup, UID,
chart or values, or interrupted rollback. `--history-max 0` prevents pruning the
original revision.

```bash
(
  set -euo pipefail
  rm -f "$OBS_FILES/occ-rollback-finished" "$OBS_FILES/occ-restored"
  inspected=0
  if test -f "$OBS_FILES/rollback-inspected"; then
    rm -f "$OBS_FILES/rollback-inspected"
    inspected=1
  fi
  test -f "$OBS_FILES/setup-complete"
  test -f "$OBS_FILES/occ-change-started"
  test "${HELM_DRIVER:-}" = secret
  test -s "$OBS_FILES/cluster-uid"
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  (cd "$OBS_FILES" && sha256sum -c occ-backup.sha256)
  revision=$(cat "$OBS_FILES/occ-revision")
  test "$(kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get secret \
    "sh.helm.release.v1.$OBS_OCC_RELEASE.v$revision" -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/occ-release-uid")"
  test "$(release_digest)" = "$(cat "$OBS_FILES/occ-release-digest")"
  (cd "$OBS_FILES" && sha256sum -c occ-demo.sha256)
  helm get values "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$revision" --all -o yaml > "$OBS_FILES/occ-restore-values.yaml"
  helm get manifest "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$revision" > "$OBS_FILES/occ-restore-manifest.yaml"
  cmp "$OBS_FILES/occ-before.yaml" "$OBS_FILES/occ-restore-values.yaml"
  cmp "$OBS_FILES/occ-before-manifest.yaml" "$OBS_FILES/occ-restore-manifest.yaml"
  helm status "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" -o json > "$OBS_FILES/occ-current-status.json"
  current=$(python3 - "$OBS_FILES/occ-current-status.json" "$revision" <<'PY_STATUS'
import json, os, sys
s = json.load(open(sys.argv[1]))
original = int(sys.argv[2])
v = s.get("version")
if (s.get("name") != os.environ["OBS_OCC_RELEASE"]
    or s.get("namespace") != os.environ["OBS_OCC_NAMESPACE"]
    or type(v) is not int or v not in (original, original + 1)
    or s.get("info", {}).get("status") not in ("deployed", "failed")
    or (v == original and s.get("info", {}).get("status") != "deployed")):
    sys.exit("Unexpected release state; stop and reconcile it.")
print(v)
PY_STATUS
  )
  if test "$current" != "$revision"; then
    test "$inspected" = 1
    test "$(release_digest "$current" chart)" = "$(cat "$OBS_FILES/occ-chart-digest")"
    helm get values "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$current" -o json > "$OBS_FILES/occ-current-values.json"
    yq -o=json '.' "$OBS_FILES/occ-demo.yaml" > "$OBS_FILES/occ-demo-values.json"
    python3 - "$OBS_FILES/occ-current-values.json" "$OBS_FILES/occ-demo-values.json" <<'PY_VALUES'
import json, sys
with open(sys.argv[1]) as a, open(sys.argv[2]) as b:
    if json.load(a) != json.load(b):
        sys.exit("The current revision does not match the demo values; stop.")
PY_VALUES
    helm rollback "$OBS_OCC_RELEASE" "$revision" -n "$OBS_OCC_NAMESPACE" --history-max 0 --wait --timeout 5m
  fi
  touch "$OBS_FILES/occ-rollback-finished"
)
```

Rollback completion does not prove restoration or deletion. Keep dependencies
and backup while a qualified operator compares status, history, restored manifest
and live resources with the saved revision. Save DaemonSets and Pods; their
configuration may be sensitive:

```bash
kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get daemonsets,pods \
  -o yaml > "$OBS_FILES/occ-live-workloads.yaml"
```

If the read fails, retain resources. Check the Collector DaemonSet and every
owned or terminating Pod: owner UID, rollout, configuration, Secret references
and exporter. If originally disabled, verify the demo DaemonSet **and Pods** are
gone; otherwise verify original ownership, configuration and rollout. Check other
workloads and external Collectors for demo Secret or Loki references. An OCC read
alone does not prove these conditions; retain dependencies on incomplete or
ambiguous readback.

Stop the port-forward and follow
[cleanup](#recover-an-incomplete-setup) for the release and remaining resources.
See [observability acceptance](../../testing/metrics.md#kubernetes-observability-acceptance) for local and CI proof.
