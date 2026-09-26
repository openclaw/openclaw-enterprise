# Scrape OCC metrics in Kubernetes

The production Helm chart enables private API and worker metrics by default on
Pod IP port 9464. Connect your scraper by supplying both selectors below. The
[metrics reference](../../reference/metrics.md) defines families, labels,
timeouts, and failure behavior. Supply these additional Helm values:

```yaml
metrics:
  enabled: true
  port: 9464
  scraperNamespaceLabels:
    kubernetes.io/metadata.name: monitoring
  scraperPodLabels:
    app: prometheus
```

Leaving both selectors empty grants no metrics ingress. Setting only one fails
Helm rendering. When configured, both must identify your actual scraper in the
same allowed peer. It binds each process to
its Pod IP and allows only the metrics TCP port. NetworkPolicies are additive:
review other installed policies before treating this as an exclusive boundary.
Give the scraper matching egress permission when its namespace denies egress.
There is no metrics Service, ServiceMonitor, or public Ingress. Set
`metrics.enabled: false` to remove both OCC listeners.

## Discover every replica

Add a Pod discovery job to your operator-owned Prometheus. Its service account
needs permission to list/watch Pods in `openclaw-system`; the OCC chart does not
grant permissions to external scrapers. Adjust release name `oce`, namespace,
and deployment labels to your installation:

```yaml
scrape_configs:
  - job_name: occ
    scrape_interval: 15s
    scrape_timeout: 5s
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [openclaw-system]
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        regex: openclaw-enterprise
        action: keep
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_instance]
        regex: oce
        action: keep
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_component]
        regex: api|worker
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_name]
        regex: metrics
        action: keep
      - source_labels: [__meta_kubernetes_pod_phase]
        regex: Running
        action: keep
      - target_label: cluster
        replacement: my-cluster
      - target_label: installation
        replacement: my-oce-deployment
```

Prometheus uses each discovered Pod IP and port as its `instance`. Do not scrape
a load-balanced API address. The example works across replica changes; it does
not itself enable or prove general OCC horizontal scaling.

## Check and query

Verify every expected replica appears in Prometheus Targets. Each must have
`up == 1`. For a selected deployment, useful queries are:

```promql
sum by (cluster, installation) (rate(occ_http_requests_total[5m]))

histogram_quantile(0.95,
  sum by (cluster, installation, le)
    (rate(occ_http_request_duration_seconds_bucket[5m])))

max by (cluster, installation, lifecycle_state)
  (occ_agents and on (job, instance, cluster, installation) (up == 1))

max by (cluster, installation)
  (occ_work_pending and on (job, instance, cluster, installation) (up == 1))

max by (cluster, installation)
  (occ_work_oldest_pending_age_seconds and on (job, instance, cluster, installation) (up == 1))

histogram_quantile(0.95,
  sum by (cluster, installation, operation, le)
    (rate(occ_agent_operation_duration_seconds_bucket[5m])))
```

Never sum Agent inventory, queue depth, or oldest work age across workers: each reports shared
database state. Monitor `up` alongside inventory so no data is not mistaken for
zero Agents. HA Prometheus installations need their backend's own replica
deduplication before combining samples from multiple scrapers.

For missing targets, check discovery RBAC, release/namespace selection, and the
named port. For unreachable targets, check selectors and ingress/egress policies.
Worker HTTP 503 indicates collection failure: verify the application-role
database connection and look for locks/slow aggregate queries. Recovery appears
on the next scrape. API health and metrics health are separate signals.

For disposable Kubernetes visualization, use the [demonstration stack](demo.md).
For the Compose walkthrough, use [development metrics](../../testing/metrics.md).

## Monitor log collection

When the optional chart Collector is enabled, its own Prometheus endpoint serves
`/metrics` on Pod port 8888. Set both
`logging.collector.metrics.scraperNamespaceLabels` and
`logging.collector.metrics.scraperPodLabels` to admit your scraper. Empty maps
admit none. `logging.collector.metrics.enabled: false` disables the chart's
metrics port declaration and ingress grant; the operator-owned Collector config
controls whether its telemetry listener runs.

Use the Pod discovery example above with component `collector`, retaining each
node's Collector Pod as an independent target. Monitor accepted, sent, failed,
and queued log records; a healthy OCC metrics target does not prove log export.
