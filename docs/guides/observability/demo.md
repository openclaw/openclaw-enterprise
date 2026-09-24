# Try the observability demonstration stack

Install disposable Prometheus, Grafana, and Loki alongside a working OCE Helm
installation. This stack is **not recommended for production**: it has one replica
per backend, bounded local storage, no high availability, and no durable backups.
Pod replacement can lose telemetry. Use your existing collection infrastructure
for production; start with [metrics discovery](metrics.md) and
[operational-log collection](../observability.md).

Run from the repository root with Helm, `kubectl`, an explicitly selected
kubeconfig/context, and an enforcing NetworkPolicy implementation. You need
permission to install the demo namespace and a Pod-discovery Role/RoleBinding in
the OCC namespace. The optional Collector additionally needs the permissions in
the [logging guide](../observability.md#kubernetes-and-helm).

## Install private backends

The example uses OCC release `oce` in `openclaw-system` and demo release `demo`
in `oce-observability-demo`. Replace these consistently for your installation.
All commands use the kubeconfig/context you explicitly select; do not switch an
unrelated default context. Save the current OCC values for cleanup:

```bash
export KUBECONFIG=/absolute/path/to/disposable-kubeconfig
export HELM_KUBECONTEXT=k3d-your-cluster
kubectl --context "$HELM_KUBECONTEXT" get nodes
umask 077
OBS_FILES=$(mktemp -d)
helm get values oce -n openclaw-system --all > "$OBS_FILES/occ-before.yaml"
kubectl --context "$HELM_KUBECONTEXT" create namespace oce-observability-demo
openssl rand -hex 24 | tr -d '\n' > "$OBS_FILES/password"
kubectl --context "$HELM_KUBECONTEXT" -n oce-observability-demo create secret generic grafana-admin \
  --from-file=password="$OBS_FILES/password"
kubectl --context "$HELM_KUBECONTEXT" -n default get endpoints kubernetes -o yaml
```

Use the Kubernetes API endpoint's actual translated IPv4 addresses and port in
`cluster`, each address as `/32`. Create `$OBS_FILES/demo.yaml`:

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
helm upgrade --install demo deploy/helm/openclaw-observability-demo \
  -n oce-observability-demo -f "$OBS_FILES/demo.yaml" --wait --timeout 5m
```

Services are `ClusterIP` only. Prometheus discovers API, worker, and Collector
Pods in the selected OCC release. Its service account can read Pod metadata in
that namespace, with no Secret access. Grafana's default plugins are bundled
in the pinned image; startup downloads are disabled.

## Connect OCC telemetry

Choose one Collector owner for each log stream. If an existing cluster Collector
already owns these streams, configure its exporter to the Loki endpoint below
and retain the shipped filtering policy; do not enable a second Collector.
The demo Loki ingress accepts only Pods in the OCC namespace with
`app.kubernetes.io/name=openclaw-enterprise`, the OCC release instance label, and
`app.kubernetes.io/component=collector`. If your Collector uses another identity,
configure a private Loki ingress rule selecting its exact namespace and Pod labels
as well as its exporter egress.

For the chart-managed Collector, create dedicated demo Secrets:

```bash
kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system create secret generic occ-demo-collector-config \
  --from-file=collector.yaml=deploy/logging/collector.yaml \
  --from-file=kubernetes.yaml=deploy/logging/kubernetes.yaml \
  --from-file=exporter.yaml=deploy/logging/exporter.yaml
kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system create secret generic occ-demo-collector-exporter \
  --from-literal=OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://demo-loki.oce-observability-demo.svc:3100/otlp/v1/logs
```

Create `$OBS_FILES/occ-demo.yaml`. The explicit flags enable metrics even if the
saved OCC values disabled them. Match the demo's `occ.metricsPort` to the OCC
chart's `metrics.port` if you changed it from 9464. For existing collection, omit
`logging` and configure that Collector's egress to the same selected Loki Pods instead.

```yaml
metrics:
  enabled: true
  scraperNamespaceLabels:
    kubernetes.io/metadata.name: oce-observability-demo
  scraperPodLabels:
    app.kubernetes.io/instance: demo
    app.kubernetes.io/component: prometheus
logging:
  collector:
    enabled: true
    configSecretName: occ-demo-collector-config
    envSecretName: occ-demo-collector-exporter
    exporter:
      cidr: ""
      namespaceLabels:
        kubernetes.io/metadata.name: oce-observability-demo
      podLabels:
        app.kubernetes.io/instance: demo
        app.kubernetes.io/component: loki
      port: 3100
    metrics:
      enabled: true
      scraperNamespaceLabels:
        kubernetes.io/metadata.name: oce-observability-demo
      scraperPodLabels:
        app.kubernetes.io/instance: demo
        app.kubernetes.io/component: prometheus
```

```bash
helm upgrade oce deploy/helm/openclaw-enterprise -n openclaw-system \
  -f "$OBS_FILES/occ-before.yaml" -f "$OBS_FILES/occ-demo.yaml" --wait --timeout 5m
kubectl --context "$HELM_KUBECONTEXT" -n oce-observability-demo \
  port-forward service/demo-grafana 3001:3000 --address 127.0.0.1
```

Keep forwarding running. Open `http://127.0.0.1:3001`, sign in as `admin` using
the generated password file, and open **OCC → OCC development** for metrics or
**OCC → OCC operational logs (demonstration)** for logs. The shared metrics
dashboard is also used by the Compose demonstration.

## Verify actual data

Use the OCC console or authenticated API to read the Installation and create an
Agent draft. Expect a request counter increase, a draft inventory sample, and
`http.completed` log records attributed to `occ-api`. Provisioning a Namespace or
deploying an Agent produces `occ-worker` events. Model turns need their normal
credentials; reading metrics and OCC logs does not.

In Grafana Explore, query Prometheus with `up{job=~"occ-api|occ-worker"}`. Expect
one healthy target per API/worker Pod. Query Loki with
`{service_name=~"occ-api|occ-worker"}`. Check current timestamps and both service
identities. A ready Grafana Pod alone does not prove either data source works.

Loki accepts the filtered logs through its native OTLP endpoint with structured
metadata enabled. It is configured for 24-hour retention on a 1 GiB
disposable volume; deletion runs asynchronously. Prometheus retains up to 24 hours / 256 MB, also
within a bounded volume. A full volume or unavailable backend can lose operational
logs; the production Collector's finite queue and retry limits still apply.
Neither backend contains the PostgreSQL audit ledger.

If data is missing, check Pod readiness, Grafana data-source health, discovery
RBAC, and both ends' NetworkPolicies. Ensure the log endpoint includes
`/otlp/v1/logs`; a plain `/v1/logs` path is wrong for this Loki configuration.
Inspect Collector metrics for refused records, export failures, and queue growth.

## Remove only the demo

First restore the saved OCC values, or redirect your existing Collector away
from Loki. Restoring values can restart OCC Pods; allow active work to finish.
Then remove the separate demo release and its dedicated Secrets:

```bash
helm upgrade oce deploy/helm/openclaw-enterprise -n openclaw-system \
  --reset-values -f "$OBS_FILES/occ-before.yaml" --wait --timeout 5m
helm uninstall demo -n oce-observability-demo --wait
kubectl --context "$HELM_KUBECONTEXT" -n openclaw-system delete secret \
  occ-demo-collector-config occ-demo-collector-exporter --ignore-not-found
kubectl --context "$HELM_KUBECONTEXT" delete namespace oce-observability-demo
rm -r "$OBS_FILES"
unset OBS_FILES
```

Stop the port-forward process and verify an authenticated OCC read still works.
These commands preserve the OCC release, PostgreSQL, tenant namespaces, and Agents.
For automated local and CI proof, see [observability acceptance](../../testing/metrics.md#kubernetes-observability-acceptance).
