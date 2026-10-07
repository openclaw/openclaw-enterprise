# Try the observability demonstration stack

Install disposable Prometheus, Grafana, and Loki. **Not for production:**
there is no high availability or durable backup, and Pod replacement can lose telemetry. See
[metrics discovery](metrics.md) and [log collection](../observability.md).

**Required:** A qualified operator must dedicate the cluster to the selected OCC
Installation and authorized demo workloads throughout collection. Before export
to Loki, confirm all streams are authorized, including tenant runtime Pods and
residual matching log files on current and future Collector nodes. External
Collector owners must establish equivalent scope. Stop and reconcile uncertain or
changed scope or ownership. A namespace, kubeconfig or disposable name does not
prove dedication; demo NetworkPolicy selects Collectors, not records.

From the repository root, use Helm 3, `kubectl`, `yq` v4, Python 3, `openssl`,
`sha256sum`, `cmp`, an explicit kubeconfig/context and enforcing NetworkPolicy.
Obtain read access to Helm release Secrets, ConfigMaps and the `kube-system` UID;
permission to create the demo namespace and OCC Pod-discovery Role/RoleBinding; and
[Collector permissions](../observability.md#kubernetes-and-helm).

## Install private backends

Set `OBS_OCC_RELEASE` and `OBS_OCC_NAMESPACE` to your OCC Helm release and
namespace: production setup uses `oce` in `openclaw-system`; the local development
launcher uses `openclaw-enterprise` in `oce-system`. The demo uses release `demo`
in a new `oce-observability-demo` namespace. Choose `managed`
or `external` Collector mode. Run blocks in order in one Bash session; stop on
failure. Retain `OBS_FILES` and Helm history through cleanup. Exclude other writers
of releases, hooks and affected resources. Checks are not locks: stop without
exclusive control or complete live inspection. Confirm Secret storage and no other
Helm backend. Verify installed chart source independently; matching names, versions
or renders do not prove chart and hook identity.

```bash
export KUBECONFIG=/absolute/path/to/disposable-kubeconfig
export HELM_KUBECONTEXT=k3d-your-cluster
export HELM_DRIVER=secret
export OBS_OCC_RELEASE=oce OBS_OCC_NAMESPACE=openclaw-system
export OBS_COLLECTOR_MODE=managed # or external
umask 077
OBS_FILES=$(mktemp -d)
export OBS_FILES
  release_digest() {
    kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get secret \
      "sh.helm.release.v1.$OBS_OCC_RELEASE.v${1:-$revision}" -o json | python3 -c '
import base64, gzip, hashlib, json, os, sys
secret = json.load(sys.stdin)
encoded = base64.b64decode(secret["data"]["release"], validate=True)
data = base64.b64decode(encoded, validate=True)
if data.startswith(b"\x1f\x8b"):
    data = gzip.decompress(data)
r = json.loads(data)
if (r.get("name") != os.environ["OBS_OCC_RELEASE"]
    or r.get("namespace") != os.environ["OBS_OCC_NAMESPACE"]
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
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get configmaps \
    -l "owner=helm,name=$OBS_OCC_RELEASE" -o json | python3 -c '
import json, sys
if json.load(sys.stdin).get("items") != []:
    sys.exit("A ConfigMap release exists; stop and resolve its identity.")
'
  helm status "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" -o json > "$OBS_FILES/occ-status.json"
  helm history "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --max 256 -o json > "$OBS_FILES/occ-history.json"
  python3 - "$OBS_FILES" <<'PY_REVISION'
import json, os, pathlib, sys
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
    or s.get("name") != os.environ["OBS_OCC_RELEASE"]
    or s.get("namespace") != os.environ["OBS_OCC_NAMESPACE"]
    or s.get("info", {}).get("status") != "deployed"
    or type(s.get("version")) is not int or s["version"] != max(revisions)
    or deployed[0]["revision"] != s["version"]
    or not deployed[0].get("chart") or deployed[0]["chart"] == "MISSING"):
    sys.exit("Release identity or deployed revision is ambiguous; stop and inspect it.")
(p / "occ-revision").write_text(str(s["version"]) + "\n")
(p / "occ-chart").write_text(deployed[0]["chart"] + "\n")
PY_REVISION
  revision=$(cat "$OBS_FILES/occ-revision")
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get secret \
    "sh.helm.release.v1.$OBS_OCC_RELEASE.v$revision" -o jsonpath='{.metadata.uid}' > "$OBS_FILES/occ-release-uid"
  test -s "$OBS_FILES/occ-release-uid"
  release_digest > "$OBS_FILES/occ-release-digest"
  release_digest "$revision" chart > "$OBS_FILES/occ-chart-digest"
  test -s "$OBS_FILES/occ-release-digest"
  test -s "$OBS_FILES/occ-chart-digest"
  helm get values "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$revision" --all -o yaml > "$OBS_FILES/occ-before.yaml"
  helm get manifest "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" --revision "$revision" > "$OBS_FILES/occ-before-manifest.yaml"
  test -s "$OBS_FILES/occ-before.yaml"
  test -s "$OBS_FILES/occ-before-manifest.yaml"
  helm template "$OBS_OCC_RELEASE" deploy/helm/openclaw-enterprise -n "$OBS_OCC_NAMESPACE" \
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

The digest binds chart, values, manifest and hooks, excluding status.
Compare the saved manifest with live OCC resources, including Collector Pods and
failure remnants. Stop on uncertain identity, ownership or state; follow
[recovery](demo-cleanup.md#recover-an-incomplete-setup) after interrupted creation.

Use the Kubernetes API's translated IPv4 addresses as `/32` and port in
`$OBS_FILES/demo.yaml`:

```yaml
occ:
  namespace: <OBS_OCC_NAMESPACE>
  release: <OBS_OCC_RELEASE>
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
  helm upgrade --install demo deploy/helm/openclaw-observability-demo \
    -n oce-observability-demo -f "$OBS_FILES/demo.yaml" --wait --timeout 10m
  touch "$OBS_FILES/demo-installed"
)
```

The first install pulls three images; the 10-minute wait allows for a cold
image cache. If it fails with `context deadline exceeded`, rerun this block
unchanged: Helm upgrades the failed release in place. Any other error, or an
interrupted run (Helm reports `another operation ... is in progress`), can
leave resources without a marker; follow [recovery](demo-cleanup.md#recover-an-incomplete-setup).

After you update the checkout for an OCC upgrade, rerun this block to pick up
dashboard and NetworkPolicy changes. A changed configuration restarts Prometheus,
Grafana, and Loki: their disposable data is lost, and a `kubectl port-forward` to
Grafana stops working until you start it again.

Services use `ClusterIP`. Prometheus reads Pod metadata, not Secrets. Grafana
bundles plugins; startup downloads are disabled. Its disposable database is
memory-backed so first-start migrations finish in seconds.

## Connect OCC telemetry

Use one Collector per stream. Retain an existing cluster Collector's filtering
policy and configure its Loki exporter. Demo Loki accepts OCC namespace Pods with
`app.kubernetes.io/name=openclaw-enterprise`, the OCC release instance label,
and `app.kubernetes.io/component=collector`. For another identity, configure
private Loki ingress for its exact namespace and Pod labels, plus exporter egress.

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
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" create secret generic occ-demo-collector-config \
    --from-file=collector.yaml=deploy/logging/collector.yaml \
    --from-file=kubernetes.yaml=deploy/logging/kubernetes.yaml \
    --from-file=exporter.yaml=deploy/logging/exporter.yaml
  kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" create secret generic occ-demo-collector-exporter \
    --from-literal=OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://demo-loki.oce-observability-demo.svc:3100/otlp/v1/logs
  touch "$OBS_FILES/collector-secrets-created"
)
```

If Secret creation fails, the first may exist. Follow
[recovery](demo-cleanup.md#recover-an-incomplete-setup).

Create `$OBS_FILES/occ-demo.yaml` from saved values. Replace selector maps because
Helm merges overlays and can retain old labels. Keep `occ-before.yaml` unchanged
for restoration. This enables metrics at their existing port; if it is not 9464,
match demo `occ.metricsPort` to `metrics.port`.

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

For a managed Collector, replace scraper and exporter selectors. For an external
Collector, skip this block and configure egress to Loki.

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
the output private: it can contain Secrets. Keep chart source, inputs, cluster
capabilities and affected objects stable through upgrade, or stop and reinspect.

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
  helm upgrade "$OBS_OCC_RELEASE" deploy/helm/openclaw-enterprise -n "$OBS_OCC_NAMESPACE" \
    --history-max 0 --reset-values -f "$OBS_FILES/occ-demo.yaml" \
    --dry-run=server --debug > "$OBS_FILES/occ-upgrade-preview.txt"
  test -s "$OBS_FILES/occ-upgrade-preview.txt"
  touch "$OBS_FILES/upgrade-preview-complete"
)
```

Inspect each pre/post-upgrade hook in `HOOKS`: kind, namespace, name, deletion
policy, effects and dependencies. Helm defaults to `before-hook-creation`, which
can delete by name without checking UID or ownership. The current chart uses it
for an initialization Job, ServiceAccount and NetworkPolicy. Check every live
name and UID, including cluster-scoped objects; establish ownership and incarnation
from independent creation records. Confirm absence, not unreadability. Stop on
collision, replacement, unknown ownership, failed read or unsafe effects.
Acknowledge the inspection:

```bash
touch "$OBS_FILES/upgrade-inspected"
```

Upgrade using only inspected demo values, resetting saved values:

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
  test "$(kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" get secret \
    "sh.helm.release.v1.$OBS_OCC_RELEASE.v$revision" -o jsonpath='{.metadata.uid}')" = "$(cat "$OBS_FILES/occ-release-uid")"
  test "$(release_digest)" = "$(cat "$OBS_FILES/occ-release-digest")"
  helm status "$OBS_OCC_RELEASE" -n "$OBS_OCC_NAMESPACE" -o json | python3 -c '
import json, os, sys
s = json.load(sys.stdin)
if (s.get("name") != os.environ["OBS_OCC_RELEASE"]
    or s.get("namespace") != os.environ["OBS_OCC_NAMESPACE"]
    or s.get("info", {}).get("status") != "deployed"
    or type(s.get("version")) is not int or s["version"] != int(sys.argv[1])):
    sys.exit("Release changed since setup; stop and inspect it.")
' "$revision"
  (cd "$OBS_FILES" && sha256sum -c occ-demo.sha256)
  rm -f "$OBS_FILES/upgrade-inspected" "$OBS_FILES/upgrade-preview-complete"
  touch "$OBS_FILES/occ-change-started"
  helm upgrade "$OBS_OCC_RELEASE" deploy/helm/openclaw-enterprise -n "$OBS_OCC_NAMESPACE" \
    --history-max 0 --reset-values -f "$OBS_FILES/occ-demo.yaml" --wait --timeout 5m
  if test "$OBS_COLLECTOR_MODE" = managed; then
    kubectl --context "$HELM_KUBECONTEXT" -n "$OBS_OCC_NAMESPACE" \
      rollout status daemonset/openclaw-enterprise-collector --timeout=5m
  fi
  kubectl --context "$HELM_KUBECONTEXT" -n oce-observability-demo \
    port-forward service/demo-grafana 3001:3000 --address 127.0.0.1
)
```

Helm's `--wait` can return while a new Collector Pod is still starting (a
DaemonSet may have one unavailable Pod), so the block waits for its rollout before
forwarding. Keep forwarding running. Sign in at `http://127.0.0.1:3001` as `admin` with
the generated password. Open **OCC → OCC observability** for metrics and logs.
For a console link, set `observability.url` to its `/d/occ-observability` URL in
the [Installation startup YAML](../../reference/configuration.md#installation-startup-configuration),
not `occ-demo.yaml` (profile installs set `controlPlane.observabilityUrl`). Apply it
as a separate change with
[Apply other Installation changes](../deploy/production-upgrade.md#apply-other-installation-changes);
the new checksum restarts the API and worker.

## Verify actual data

Read the Installation; create an Agent draft via console or authenticated API.
Expect request and draft metrics and `http.completed` logs from `occ-api`.
Provisioning or deployment produces `occ-worker` events. Model turns require
credentials; metrics and OCC logs do not.

In Grafana Explore, query Prometheus `up{job=~"occ-api|occ-worker"}` for one
healthy target per API/worker Pod, and Loki
`{service_name=~"occ-api|occ-worker"}` for records from both services.

## Read and narrow operational logs

**Service** and **Event** default to **All** and filter both panels. Services:
`occ-api`, `occ-worker`, `openclaw-gateway`, and `codex-app-server`. **All events**
shows matching retained records in the time range with available HTTP and worker
fields. **Needs attention** includes warnings/errors, HTTP 4xx/5xx, and `retry`,
`permanent`, or `failure` work outcomes, including INFO.

Expand a row for request, work, and workload identity. In **Explore**, query:

```logql
{service_name="occ-api"} | request_id="<request-id-from-log-details>"
```

Line bodies hold the event name (Codex turn, tool-call and short plain-text
Codex messages excepted), so a line filter such as
`|= "rev_..."` matches nothing. Filter on structured metadata instead:
`occ_revision_id`, `occ_agent_id`, `occ_namespace_id` and `work_id` on OCC
records, or `openclaw_revision_id` and `openclaw_agent_id` on Gateway and
Harness records:

```logql
{service_name="occ-worker"} | occ_revision_id="<revision-id>"
{service_name=~"openclaw-gateway|codex-app-server"} | openclaw_revision_id="<revision-id>"
```

The reviewed platform-owned Collector filters records and replaces retained bodies
with event names before export. Grafana formats metadata without adding identity
labels or enforcing export. Operators must verify destinations,
redaction, credential isolation and access controls for external or Driver-owned
pipelines; see the [collection boundary](../../reference/security.md#operational-log-collection-boundary).
Successful GETs cannot be distinguished from health probes. Filters provide
neither tenant authorization nor Agent session views.

Loki retains filtered native OTLP logs for 24 hours on a disposable 1 GiB volume
with asynchronous deletion. Prometheus retains 24 hours / 256 MB. Full or
unavailable backends can lose logs; Collector queue and retry limits apply.
Neither backend contains the PostgreSQL audit ledger.

For missing data, check Pod readiness, data-source health, discovery RBAC,
NetworkPolicies and Collector metrics for refusals, export failures and queue
growth. The log endpoint is `/otlp/v1/logs`, not `/v1/logs`.

## Recover an incomplete setup

Except for a demo install wait timeout (see above), do not rerun failed or interrupted commands. Follow [recover an incomplete setup](demo-cleanup.md#recover-an-incomplete-setup).

## Remove only the demo

Redirect external Collectors away from Loki first. [Remove only the demo](demo-cleanup.md#remove-only-the-demo) restores the saved OCC revision and verifies the Collector state.

See [observability acceptance](../../testing/metrics.md#kubernetes-observability-acceptance) for local and CI proof.
