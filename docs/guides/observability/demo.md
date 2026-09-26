# Try the observability demonstration stack

Install disposable Prometheus, Grafana and Loki alongside OCE. This stack is
**not recommended for production**: storage is bounded, high availability and
durable backups are absent, and Pod replacement can lose telemetry. See
[metrics discovery](metrics.md) and [operational-log collection](../observability.md).

**Required:** Before directing Collector output to demo Loki, a qualified operator
must establish a cluster dedicated to the selected OCC Installation and authorized
demo workloads, and maintain it throughout collection. Confirm all streams,
including tenant runtime Pods and residual matching node log files on current and
future Collector nodes, are authorized for Loki. External Collector owners must
establish equivalent stream scope. Stop and reconcile if scope or ownership
changes or is uncertain. A namespace, kubeconfig or
disposable name cannot prove dedication. This operator/environment restriction is
not enforced by the demo NetworkPolicy, which selects Collectors, not records.

From the repository root, use Helm 3, `kubectl`, `yq` v4, Python 3, an explicit
kubeconfig/context and enforcing NetworkPolicy. You need read access to Helm
release Secrets, ConfigMaps and the `kube-system` UID, permission to create the
demo namespace and OCC Pod-discovery Role/RoleBinding, and the
[Collector permissions](../observability.md#kubernetes-and-helm).

## Install private backends

Use OCC release `oce` in `openclaw-system` and demo release `demo` in a new
`oce-observability-demo` namespace; replace names consistently. Choose
`managed` or `external` Collector mode. Run blocks in order in one Bash session;
stop on failure and keep `OBS_FILES` and Helm history through cleanup. Exclude
other writers of releases and affected resources, including hooks. The checks are
not locks: stop without exclusive control or complete live inspection. Confirm
Secret storage and no other Helm backend, and independently verify the installed
chart source; matching names, versions or renders do not prove chart and hook identity.

```bash
export KUBECONFIG=/absolute/path/to/disposable-kubeconfig
export HELM_KUBECONTEXT=k3d-your-cluster
export HELM_DRIVER=secret
export OBS_COLLECTOR_MODE=managed # or external
umask 077
OBS_FILES=$(mktemp -d)
export OBS_FILES
  release_digest() {
    kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get secret \
      "sh.helm.release.v1.oce.v${1:-$revision}" -o json | python3 -c '
import base64, gzip, hashlib, json, sys
secret = json.load(sys.stdin)
encoded = base64.b64decode(secret["data"]["release"], validate=True)
data = base64.b64decode(encoded, validate=True)
if data.startswith(b"\x1f\x8b"):
    data = gzip.decompress(data)
r = json.loads(data)
if (r.get("name") != "oce" or r.get("namespace") != "openclaw-system"
    or r.get("version") != int(sys.argv[1]) or not r.get("chart", {}).get("metadata")
    or not r.get("manifest")):
    sys.exit("Invalid stored release; stop and inspect it.")
content = r["chart"] if sys.argv[2] == "chart" else {k: r.get(k) for k in ("chart", "config", "manifest", "hooks")}
print(hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
' "${1:-$revision}" "${2:-release}"
  }
(
  set -euo pipefail
  test -n "$OBS_FILES"
  case "$OBS_COLLECTOR_MODE" in managed|external) ;; *) exit 1 ;; esac
  kubectl --context "$HELM_KUBECONTEXT" get nodes
  kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system \
    -o jsonpath='{.metadata.uid}' > "$OBS_FILES/cluster-uid"
  test -s "$OBS_FILES/cluster-uid"
  kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get configmaps \
    -l owner=helm,name=oce -o json | python3 -c '
import json, sys
if json.load(sys.stdin).get("items") != []:
    sys.exit("A ConfigMap release exists; stop and resolve its identity.")
'
  helm status oce -n openclaw-system -o json > "$OBS_FILES/occ-status.json"
  helm history oce -n openclaw-system --max 256 -o json > "$OBS_FILES/occ-history.json"
  python3 - "$OBS_FILES" <<'PY_REVISION'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
s = json.loads((p / "occ-status.json").read_text())
h = json.loads((p / "occ-history.json").read_text())
if not isinstance(h, list) or not 0 < len(h) < 256:
    sys.exit("Release history is empty or truncated; stop and inspect it.")
if any(not isinstance(x, dict) or type(x.get("revision")) is not int or x["revision"] < 1 for x in h):
    sys.exit("Invalid release history; stop and inspect it.")
revisions = [x["revision"] for x in h]
deployed = [x for x in h if x.get("status") == "deployed"]
if (len(set(revisions)) != len(revisions) or len(deployed) != 1
    or s.get("name") != "oce" or s.get("namespace") != "openclaw-system"
    or s.get("info", {}).get("status") != "deployed"
    or type(s.get("version")) is not int or s["version"] != max(revisions)
    or deployed[0]["revision"] != s["version"]
    or not deployed[0].get("chart") or deployed[0]["chart"] == "MISSING"):
    sys.exit("Release identity or deployed revision is ambiguous; stop and inspect it.")
(p / "occ-revision").write_text(str(s["version"]) + "\n")
(p / "occ-chart").write_text(deployed[0]["chart"] + "\n")
PY_REVISION
  revision=$(cat "$OBS_FILES/occ-revision")
  kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get secret \
    "sh.helm.release.v1.oce.v$revision" -o jsonpath='{.metadata.uid}' > "$OBS_FILES/occ-release-uid"
  test -s "$OBS_FILES/occ-release-uid"
  release_digest > "$OBS_FILES/occ-release-digest"
  release_digest "$revision" chart > "$OBS_FILES/occ-chart-digest"
  test -s "$OBS_FILES/occ-release-digest"
  test -s "$OBS_FILES/occ-chart-digest"
  helm get values oce -n openclaw-system --revision "$revision" --all -o yaml > "$OBS_FILES/occ-before.yaml"
  helm get manifest oce -n openclaw-system --revision "$revision" > "$OBS_FILES/occ-before-manifest.yaml"
  test -s "$OBS_FILES/occ-before.yaml"
  test -s "$OBS_FILES/occ-before-manifest.yaml"
  helm template oce deploy/helm/openclaw-enterprise -n openclaw-system \
    --is-upgrade --no-hooks --validate -f "$OBS_FILES/occ-before.yaml" > "$OBS_FILES/occ-local-manifest.yaml"
  python3 - "$OBS_FILES/occ-before-manifest.yaml" "$OBS_FILES/occ-local-manifest.yaml" <<'PY_COMPARE'
import pathlib, sys
if pathlib.Path(sys.argv[1]).read_text().rstrip() != pathlib.Path(sys.argv[2]).read_text().rstrip():
    sys.exit("Local chart render differs from the deployed manifest; stop.")
PY_COMPARE
  (cd "$OBS_FILES" && sha256sum occ-revision occ-chart occ-release-uid occ-release-digest occ-chart-digest occ-before.yaml occ-before-manifest.yaml > occ-backup.sha256)
  kubectl --context "$HELM_KUBECONTEXT" create namespace oce-observability-demo
  openssl rand -hex 24 | tr -d '\n' > "$OBS_FILES/password"
  kubectl --context "$HELM_KUBECONTEXT" -n oce-observability-demo create secret generic grafana-admin \
    --from-file=password="$OBS_FILES/password"
  kubectl --context "$HELM_KUBECONTEXT" -n default get endpoints kubernetes -o yaml
  printf '%s\n' "$OBS_COLLECTOR_MODE" > "$OBS_FILES/collector-mode"
  touch "$OBS_FILES/setup-complete"
)
```

The digest binds chart, values, manifest and hooks, excluding mutable status.
Compare the saved manifest with live OCC resources, including Collector Pods and
previous failure remnants. Stop if identity, ownership or state is uncertain.
For interrupted creation, follow [recovery](#recover-an-incomplete-setup).

Use the Kubernetes API's translated IPv4 addresses as `/32` and port in `cluster`.
Create `$OBS_FILES/demo.yaml`:

```yaml
occ:
  namespace: openclaw-system
  release: oce
cluster:
  cidrs: ["<actual-api-endpoint>/32"]
  port: 6443
grafana:
  adminSecretName: grafana-admin
```

```bash
(
  set -euo pipefail
  test -f "$OBS_FILES/setup-complete"
  test -s "$OBS_FILES/cluster-uid"
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  rm -f "$OBS_FILES/demo-installed"
  helm install demo deploy/helm/openclaw-observability-demo \
    -n oce-observability-demo -f "$OBS_FILES/demo.yaml" --wait --timeout 5m
  touch "$OBS_FILES/demo-installed"
)
```

If installation fails or is interrupted, follow [recovery](#recover-an-incomplete-setup).
A failed release may reserve the name and create resources without a marker.

Services use `ClusterIP`. Prometheus can read Pod metadata, not Secrets.
Grafana's plugins are bundled; startup downloads are disabled.

## Connect OCC telemetry

Choose one Collector per log stream. For an existing cluster Collector, retain
its filtering policy and configure its exporter to Loki. Demo Loki accepts Pods
in the OCC namespace with
`app.kubernetes.io/name=openclaw-enterprise`, the OCC release instance label, and
`app.kubernetes.io/component=collector`. If your Collector uses another identity,
configure a private Loki ingress rule selecting its exact namespace and Pod labels
as well as its exporter egress.

For the chart-managed Collector, create dedicated demo Secrets:

```bash
(
  set -euo pipefail
  test "$OBS_COLLECTOR_MODE" = managed
  test "$(cat "$OBS_FILES/collector-mode")" = "$OBS_COLLECTOR_MODE"
  test -f "$OBS_FILES/demo-installed"
  test -s "$OBS_FILES/cluster-uid"
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  rm -f "$OBS_FILES/collector-secrets-created" "$OBS_FILES/managed-values-created"
  kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system create secret generic occ-demo-collector-config \
    --from-file=collector.yaml=deploy/logging/collector.yaml \
    --from-file=kubernetes.yaml=deploy/logging/kubernetes.yaml \
    --from-file=exporter.yaml=deploy/logging/exporter.yaml
  kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system create secret generic occ-demo-collector-exporter \
    --from-literal=OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://demo-loki.oce-observability-demo.svc:3100/otlp/v1/logs
  touch "$OBS_FILES/collector-secrets-created"
)
```

If Secret creation fails, the first Secret may exist. Follow
[recovery](#recover-an-incomplete-setup).

Create `$OBS_FILES/occ-demo.yaml` from the saved values, replacing selector maps:
Helm merges overlays and can retain old labels. Keep `occ-before.yaml` unchanged
for restoration. This enables metrics, preserving their port. If the chart port
differs from 9464, match the demo's `occ.metricsPort` to `metrics.port`.

```bash
(
  set -euo pipefail
  test -f "$OBS_FILES/demo-installed"
  rm -f "$OBS_FILES/demo-values-created" "$OBS_FILES/managed-values-created"
  yq '.metrics.enabled = true |
  .metrics.scraperNamespaceLabels = {"kubernetes.io/metadata.name": "oce-observability-demo"} |
  .metrics.scraperPodLabels = {
    "app.kubernetes.io/instance": "demo",
    "app.kubernetes.io/component": "prometheus"
  }' "$OBS_FILES/occ-before.yaml" > "$OBS_FILES/occ-demo.yaml"
  touch "$OBS_FILES/demo-values-created"
)
```

For a managed Collector, replace its scraper and exporter selectors. An external
Collector skips this block and configures egress to Loki.

```bash
(
  set -euo pipefail
  test "$OBS_COLLECTOR_MODE" = managed
  test "$(cat "$OBS_FILES/collector-mode")" = "$OBS_COLLECTOR_MODE"
  test -f "$OBS_FILES/collector-secrets-created"
  test -f "$OBS_FILES/demo-values-created"
  rm -f "$OBS_FILES/managed-values-created"
  yq -i '.logging.collector.enabled = true |
  .logging.collector.configSecretName = "occ-demo-collector-config" |
  .logging.collector.envSecretName = "occ-demo-collector-exporter" |
  .logging.collector.exporter.cidr = "" |
  .logging.collector.exporter.namespaceLabels = {"kubernetes.io/metadata.name": "oce-observability-demo"} |
  .logging.collector.exporter.podLabels = {
    "app.kubernetes.io/instance": "demo",
    "app.kubernetes.io/component": "loki"
  } |
  .logging.collector.exporter.port = 3100 |
  .logging.collector.metrics.enabled = true |
  .logging.collector.metrics.scraperNamespaceLabels = {"kubernetes.io/metadata.name": "oce-observability-demo"} |
  .logging.collector.metrics.scraperPodLabels = {
    "app.kubernetes.io/instance": "demo",
    "app.kubernetes.io/component": "prometheus"
  }' "$OBS_FILES/occ-demo.yaml"
  touch "$OBS_FILES/managed-values-created"
)
```

Capture server-rendered hooks and manifest with the same chart and values. Keep
the output private; it can contain Secrets. Keep chart source, inputs, cluster
capabilities and affected live objects stable through the upgrade, or stop and
inspect again.

```bash
(
  set -euo pipefail
  rm -f "$OBS_FILES/upgrade-inspected" "$OBS_FILES/upgrade-preview-complete" \
    "$OBS_FILES/occ-upgrade-preview.txt" "$OBS_FILES/occ-demo.sha256"
  test -f "$OBS_FILES/demo-values-created"
  test "${HELM_DRIVER:-}" = secret
  test -s "$OBS_FILES/cluster-uid"
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  (cd "$OBS_FILES" && sha256sum occ-demo.yaml > occ-demo.sha256)
  helm upgrade oce deploy/helm/openclaw-enterprise -n openclaw-system \
    --history-max 0 --reset-values -f "$OBS_FILES/occ-demo.yaml" \
    --dry-run=server --debug > "$OBS_FILES/occ-upgrade-preview.txt"
  test -s "$OBS_FILES/occ-upgrade-preview.txt"
  touch "$OBS_FILES/upgrade-preview-complete"
)
```

Inspect every pre/post-upgrade hook in `HOOKS`: kind, namespace, name, deletion
policy, effects and dependencies. Helm defaults to `before-hook-creation` and
can delete an existing object by name without checking UID or ownership. The
current chart has an initialization Job, ServiceAccount and NetworkPolicy with
that policy. Check every live name and UID, including cluster-scoped objects;
independent creation records must establish ownership and incarnation. Confirm
absence, not merely unreadability. Stop on collision, replacement, unknown
ownership, failed read or unsafe effects. After inspection, acknowledge it:

```bash
touch "$OBS_FILES/upgrade-inspected"
```

Upgrade using only the inspected demo values, resetting any saved release values:

```bash
(
  set -euo pipefail
  test -f "$OBS_FILES/demo-values-created"
  test -f "$OBS_FILES/upgrade-inspected"
  test -f "$OBS_FILES/upgrade-preview-complete"
  test -s "$OBS_FILES/occ-upgrade-preview.txt"
  test "${HELM_DRIVER:-}" = secret
  test "$(cat "$OBS_FILES/collector-mode")" = "$OBS_COLLECTOR_MODE"
  test -s "$OBS_FILES/cluster-uid"
  test "$(kubectl --context "$HELM_KUBECONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/cluster-uid")"
  case "$OBS_COLLECTOR_MODE" in
    managed) test -f "$OBS_FILES/managed-values-created" ;;
    external) ;;
    *) exit 1 ;;
  esac
  (cd "$OBS_FILES" && sha256sum -c occ-backup.sha256)
  revision=$(cat "$OBS_FILES/occ-revision")
  test "$(kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get secret \
    "sh.helm.release.v1.oce.v$revision" -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/occ-release-uid")"
  test "$(release_digest)" = "$(cat "$OBS_FILES/occ-release-digest")"
  helm status oce -n openclaw-system -o json | python3 -c '
import json, sys
s = json.load(sys.stdin)
if (s.get("name") != "oce" or s.get("namespace") != "openclaw-system"
    or s.get("info", {}).get("status") != "deployed"
    or type(s.get("version")) is not int or s["version"] != int(sys.argv[1])):
    sys.exit("Release changed since setup; stop and inspect it.")
' "$revision"
  (cd "$OBS_FILES" && sha256sum -c occ-demo.sha256)
  rm -f "$OBS_FILES/upgrade-inspected" "$OBS_FILES/upgrade-preview-complete"
  touch "$OBS_FILES/occ-change-started"
  helm upgrade oce deploy/helm/openclaw-enterprise -n openclaw-system \
    --history-max 0 --reset-values -f "$OBS_FILES/occ-demo.yaml" --wait --timeout 5m
  kubectl --context "$HELM_KUBECONTEXT" -n oce-observability-demo \
    port-forward service/demo-grafana 3001:3000 --address 127.0.0.1
)
```

Keep forwarding running. At `http://127.0.0.1:3001`, sign in as `admin` with
the generated password. Open **OCC → OCC development** for metrics or
**OCC → OCC operational logs (demonstration)** for logs.

## Verify actual data

Use the OCC console or authenticated API to read the Installation and create an
Agent draft. Expect request and draft metrics and `http.completed` logs from
`occ-api`. Provisioning or deploying an Agent produces `occ-worker` events.
Model turns need their normal credentials; metrics and OCC logs do not.

In Grafana Explore, query Prometheus `up{job=~"occ-api|occ-worker"}` for one
healthy target per API/worker Pod, and Loki
`{service_name=~"occ-api|occ-worker"}` for current records from both services.

Loki receives filtered native OTLP logs on a disposable 1 GiB volume, retained
for 24 hours with asynchronous deletion. Prometheus retains 24 hours / 256 MB.
Full or unavailable backends can lose logs; Collector queue and retry limits
apply. Neither backend contains the PostgreSQL audit ledger.

If data is missing, check Pod readiness, data-source health, discovery RBAC,
NetworkPolicies and Collector metrics for refusals, export failures and queue
growth. The log endpoint requires `/otlp/v1/logs`, not `/v1/logs`.

## Recover an incomplete setup

Do not rerun a failed or interrupted command: an absent marker does not prove
no changes. Confirm the cluster UID, OCC status, complete history, saved
revision and live resources. If the upgrade was never invoked and OCC matches
the saved revision, rollback is unnecessary. Otherwise retain dependencies and
inspect for rollback below or escalate. If backup or cluster identity is
unavailable, stop and reconcile with a qualified operator.

Inspect the demo release status, every relevant history revision, manifests and
hooks, and live objects in both namespaces, including the OCC discovery Role and
RoleBinding, Grafana Secret, and both Collector Secrets. Record UIDs and establish
creation and ownership from independent records, not names or labels. Check
workloads, Pods and external Collectors for references. Retain and escalate on
failed reads or ambiguity. An install may leave objects without a release record
or outside its latest manifest; account for those separately.

Once OCC and external exporters no longer depend on the demo, if the release
exists, a qualified operator must establish ownership and revision, inspect
its latest manifest, pre/post-delete hooks, policies and effects, and
every live object Helm can delete. Confirm unchanged release and object UIDs and
exclude other writers. Run `helm uninstall demo -n oce-observability-demo --wait
--timeout 5m` once; if confirmed absent, skip uninstall.
Reconcile failures or interruptions without retrying. Verify the release and
resources are gone. For separately created or leftover resources, prove creation,
current UID and no references before deleting through the Kubernetes API with a
UID precondition. Check the namespace UID, contents, finalizers and dependencies
before deleting it. Retain anything unproved. Start again only with an owned,
clean namespace and an unreserved release name. If either cannot be reconciled,
use fresh names and retain the backup. Otherwise, after verified cleanup, confirm
`$OBS_FILES` names the setup directory, delete it, and unset it.

## Remove only the demo

Redirect any external Collector away from Loki and allow active work to finish;
rollback can restart OCC Pods. Compare current and original manifests with live
resources, UIDs and Helm ownership annotations, including objects a rollback can
delete or replace and those left by a failed upgrade. Retrieve
the original revision's hooks with `helm get hooks oce -n openclaw-system
--revision "$(cat "$OBS_FILES/occ-revision")"` and inspect every pre- and
post-rollback hook, deletion policy, live name, UID and side effect using the
same rules as the upgrade inspection. Stop if inspection fails or an object is unowned,
replaced or ambiguous. Preserve the backend, Secrets, history and backup; do
not blindly repeat an operation. After inspection, create
`$OBS_FILES/rollback-inspected` with `touch`; the command consumes it before
rollback. Reinspect after any failure or interruption.

Rollback uses the original revision's chart, values, manifest and hooks. Only
that revision or the immediately following demo revision is accepted. Stop for
manual reconciliation on pending or unexpected states, pruned or changed backup,
UID, chart or values, or an interrupted rollback. `--history-max 0` prevents
pruning the original revision.

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
  test "$(kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get secret \
    "sh.helm.release.v1.oce.v$revision" -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/occ-release-uid")"
  test "$(release_digest)" = "$(cat "$OBS_FILES/occ-release-digest")"
  (cd "$OBS_FILES" && sha256sum -c occ-demo.sha256)
  helm get values oce -n openclaw-system --revision "$revision" --all -o yaml > "$OBS_FILES/occ-restore-values.yaml"
  helm get manifest oce -n openclaw-system --revision "$revision" > "$OBS_FILES/occ-restore-manifest.yaml"
  cmp "$OBS_FILES/occ-before.yaml" "$OBS_FILES/occ-restore-values.yaml"
  cmp "$OBS_FILES/occ-before-manifest.yaml" "$OBS_FILES/occ-restore-manifest.yaml"
  helm status oce -n openclaw-system -o json > "$OBS_FILES/occ-current-status.json"
  current=$(python3 - "$OBS_FILES/occ-current-status.json" "$revision" <<'PY_STATUS'
import json, sys
s = json.load(open(sys.argv[1]))
original = int(sys.argv[2])
v = s.get("version")
if (s.get("name") != "oce" or s.get("namespace") != "openclaw-system"
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
    helm get values oce -n openclaw-system --revision "$current" -o json > "$OBS_FILES/occ-current-values.json"
    yq -o=json '.' "$OBS_FILES/occ-demo.yaml" > "$OBS_FILES/occ-demo-values.json"
    python3 - "$OBS_FILES/occ-current-values.json" "$OBS_FILES/occ-demo-values.json" <<'PY_VALUES'
import json, sys
with open(sys.argv[1]) as a, open(sys.argv[2]) as b:
    if json.load(a) != json.load(b):
        sys.exit("The current revision does not match the demo values; stop.")
PY_VALUES
    helm rollback oce "$revision" -n openclaw-system --history-max 0 --wait --timeout 5m
  fi
  touch "$OBS_FILES/occ-rollback-finished"
)
```

A completed rollback does not prove restoration or deletion. Keep dependencies
and backup while a qualified operator compares status, history, restored manifest
and live resources with the saved revision. Save DaemonSets and Pods (which may
contain sensitive configuration):

```bash
kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system get daemonsets,pods \
  -o yaml > "$OBS_FILES/occ-live-workloads.yaml"
```

If the read fails, retain resources. Check the Collector DaemonSet and every
owned or terminating Pod: owner UID, rollout, configuration, Secret references
and exporter. If originally disabled, verify the demo DaemonSet **and Pods** are
gone; otherwise verify original ownership, configuration and rollout. Check other
workloads and external Collectors for references to the demo Secrets or Loki.
An OCC read does not prove these conditions. Retain dependencies on incomplete
or ambiguous readback.

After these checks, stop the port-forward and follow the
[cleanup steps](#recover-an-incomplete-setup) for the release and remaining
resources. Keep the backup until cleanup is verified.
See [observability acceptance](../../testing/metrics.md#kubernetes-observability-acceptance) for local and CI proof.
