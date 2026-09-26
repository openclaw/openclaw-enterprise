# Configure platform observability

Send operational logs from OpenClaw Control Plane (OCC), managed gateways, and
Codex workloads to your log backend, then verify that records arrive. The
OpenTelemetry Collector also exposes metrics about its own delivery pipeline;
it does not collect application metrics, traces, or audit records. Run commands
from the repository root.

| Signal              | Available path                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operational logs    | Local container output; optional OpenTelemetry Collector export over OTLP/HTTP to your log backend.                                                                      |
| Collector metrics   | Prometheus endpoint on port `8888` for the collection pipeline itself.                                                                                                   |
| Audit records       | Stored separately in PostgreSQL; the Collector does not export them. See [Audit Log](topics/audit-log.md).                                                               |
| Application metrics | Private OCC Prometheus endpoints enabled by default in Helm; see [production scraping](observability/metrics.md) and the [development dashboard](../testing/metrics.md). |
| Distributed traces  | No application tracing pipeline is installed.                                                                                                                            |

The default Helm installation needs no telemetry backend: operational logs go to
container output at `info`, and private metrics listeners run with no scraper
ingress grant. Connect your collectors using this guide and the metrics guide.
For disposable visualization, use the [demonstration stack](observability/demo.md),
which is not recommended for production.

The Collector exports predefined operational events and approved fields. It
excludes arbitrary messages, prompts, responses, and Codex protocol output, even
at `debug`. See the
[security boundary](../reference/security.md#operational-log-collection-boundary).

If your Compute Driver declares
[deployment-managed runtime logging](../reference/drivers/compute.md#runtime-logging-ownership),
follow its runtime platform's collection and verification procedures. Continue
using this guide for OCC logs; the Driver does not change how OCC records audits.

## Requirements

- A working [development stack](deploy.md#development), or the protected YAML
  inputs and namespace from [production setup](deploy/production-installation.md#configure-the-installation).
- An operator-owned OTLP/HTTP Logs receiver: full `/v1/logs` endpoint,
  authentication, and trusted TLS chain. The Collector includes no storage or viewer.
- For Docker: Docker Compose and an endpoint reachable from the Collector
  container. The Docker Engine must also reach the Fluent Forward receiver.
- For Kubernetes: Helm, `kubectl`, `yq` v4, an explicit kubeconfig/context,
  enforcing NetworkPolicies, and permission to install the Collector DaemonSet,
  its Pod-read ClusterRole, and dedicated Secrets.

## Steps

### 1. Choose the log level

Set the shared level in the startup YAML:

```yaml
logging:
  level: info
```

Use `debug`, `info`, `warn`, or `error`. The default is `info`. For the
Docker logging override, edit [`deploy/logging/occ.yaml`](../../deploy/logging/occ.yaml).
For production, edit the protected Installation YAML and update its mounted
startup Secret through your deployment process. This is separate from Helm's
`logging.collector` values.

Restart the API and worker after a level change. With the Docker logging
override, migration and bootstrap read the YAML on their next execution. The
current Helm initialization Job does not mount that YAML or set `OCC_CONFIG_PATH`,
so its migration and bootstrap processes use `info`.

Existing AgentRevisions keep their original level. Deploy an Agent again to
apply the new level to its gateway or Codex runtime. See the [startup settings](../reference/configuration.md#installation-startup-configuration)
for the accepted configuration.

### 2. Configure the exporter

Use [`deploy/logging/exporter.yaml`](../../deploy/logging/exporter.yaml) as the
native Collector exporter configuration. It reads `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
and limits the queue size and retry window. Use HTTPS with verified server
identity for real backends; use plain HTTP only for a local test receiver.

For authentication or a custom CA, prepare a protected `exporter.yaml` with native
Collector header/TLS settings. Keep credentials in Collector-only Secrets or
protected mounts. Explicitly supply referenced environment variables: Docker
forwards only the endpoint; Helm loads its dedicated exporter environment Secret.
Additional mounts require deployment changes: Helm projects only three named
configuration files and offers no extra-mount value. Never reference an unmounted CA.

Keep the exporter named `otlp_http`, or update the receiver pipeline's exporter
reference too. Preserve the shared filtering policy and bounded queue/retry
settings. Do not put exporter credentials in Installation YAML, Agent
Configurations, SecretBindings, lifecycle hooks, or runtime images.

### 3. Enable collection for your deployment

#### Docker Compose

Start your receiver. For a receiver reachable through Docker's host alias:

```bash
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='http://host.docker.internal:4318/v1/logs'
./scripts/dev-up -- -f compose.yaml -f compose.logging.yaml
```

Use a same-network DNS name if the receiver is another container. If you prepared
a custom exporter file, add a private Compose override mounting it at
`/etc/otel/exporter.yaml` in the `collector` service and pass that override last.

The override routes OCC and newly created managed runtime containers through
Docker's nonblocking `fluentd` driver. It publishes Fluent Forward on loopback
port `24224` and Collector metrics on loopback port `8888`. Redeploy existing
Agents to recreate their containers with logging enabled. When Docker runs in a
VM, verify that the Engine can reach the receiver; resolving the container's
DNS name alone does not prove this.

If you change the Fluent Forward port, set both `OTEL_COLLECTOR_PORT` and
`OCC_DOCKER_LOGGING_ADDRESS` to matching values. `OTEL_COLLECTOR_METRICS_PORT`
changes only the host metrics port. See [Docker settings](../reference/settings/operations.md#local-compose-and-postgresql-configuration)
for defaults and environment precedence.

#### Kubernetes and Helm

Use production setup's `KUBECONFIG_FILE`, `CONTEXT`, `OCC_INPUT_DIRECTORY`, and
existing `openclaw-system` namespace. Retain the complete `values.yaml`; the
logging block alone cannot install OCC.

If an existing cluster Collector already reads the OCC and tenant CRI files,
use it only after applying the same [native receiver](../../deploy/logging/kubernetes.yaml)
and [shared policy](../../deploy/logging/collector.yaml): trusted metadata,
privacy, filtering, egress, and bounded state. Use one collection route per
stream. Otherwise, enable the bundled Collector below.

Create its two dedicated Secrets before installing or upgrading the chart:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-otel-collector-config \
  --from-file=collector.yaml=deploy/logging/collector.yaml \
  --from-file=kubernetes.yaml=deploy/logging/kubernetes.yaml \
  --from-file=exporter.yaml=deploy/logging/exporter.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-otel-collector-exporter \
  --from-literal=OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='https://otel.example.internal/v1/logs'
```

Replace the endpoint. For authenticated export, select your protected
`--from-file=exporter.yaml=...` and add referenced credentials from protected
files to the exporter Secret. Update existing Secrets through your normal
Secret-management workflow.

Set the exact approved exporter or proxy IPv4 address and port in the protected
values copy; `203.0.113.10/32` below is a placeholder:

```bash
yq -i '.logging.collector.enabled = true |
  .logging.collector.exporter.cidr = "203.0.113.10/32" |
  .logging.collector.exporter.port = 443' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
```

Keep a digest-pinned approved Collector image. For custom Secret names, set
`logging.collector.configSecretName` and `logging.collector.envSecretName`.
Do not reuse application Secrets. See [Helm settings](../reference/settings/production.md#production-operational-logging-collection)
for resource and storage limits.

Before first install, finish [bootstrap PVC preparation](deploy/production-installation.md#prepare-the-fresh-bootstrap-output-pvc).
For existing installations, apply reviewed values through the same Helm upgrade. The Collector reads
`/var/log/pods` read-only and needs `get/list/watch` on Pods across workload
namespaces. Namespace and node names come from Pod fields; it does not need
Namespace, Node, Secret, or `pods/log` API access. Its node filter limits queries,
but is not an RBAC security boundary.

Restart the Collector after changing either Secret to load its configuration:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  rollout restart daemonset/openclaw-enterprise-collector
```

## Tests

### Check delivery to the backend

1. With `logging.level: info` or `debug`, run the authenticated API check for
   your deployment: [Docker development](deploy.md#verify-development) or
   [Kubernetes production](deploy/production-installation.md#authenticate-to-the-production-api).
2. Find a new `service.name=occ-api`, `event.name=http.completed` record in your
   backend. Confirm its status, timestamp, and request ID match the request.
3. For runtime coverage, deploy an Agent and exercise its gateway or Codex
   app-server. Check the corresponding `openclaw-gateway` or `codex-app-server`
   records and `openclaw.agent.id` / `openclaw.revision.id` resource attributes.

A healthy Collector and local container output do not prove that the backend
received the records. Only approved runtime events appear. Receiving API logs
does not verify model turns or other integrations.

### Check Collector metrics

For Docker, inspect Collector errors and its Prometheus endpoint:

```bash
docker compose -f compose.yaml -f compose.logging.yaml logs --tail=100 collector
curl --fail "http://127.0.0.1:${OTEL_COLLECTOR_METRICS_PORT:-8888}/metrics"
```

For Kubernetes, check rollout and errors, then forward one Collector Pod's
metrics port to your machine (this checks only that node):

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  rollout status daemonset/openclaw-enterprise-collector --timeout=120s
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs -l app.kubernetes.io/component=collector --tail=100
COLLECTOR_POD=$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system get pods -l app.kubernetes.io/component=collector \
  -o jsonpath='{.items[0].metadata.name}')
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  port-forward "pod/$COLLECTOR_POD" 8888:8888
```

In another terminal, run `curl --fail http://127.0.0.1:8888/metrics`. Inspect
whether the receiver accepts or refuses records, whether exports succeed,
queue usage, and process memory. `otelcol_exporter_queue_size` should not grow indefinitely;
compare it with `otelcol_exporter_queue_capacity`. An increasing
`otelcol_processor_filter_logs_filtered` can reflect expected privacy filtering.

Privately scrape every Collector instance. The chart provides no dashboards,
metrics Service, or scrape discovery; add a narrowly scoped ingress allow rule
for your scraper.

## Production readiness

Use [production handoff](deploy/production-handoff.md#connect-alerts-to-a-response)
to assign alert recipients and response procedures alongside these collection checks.

- Keep runtime native OTLP export disabled and preserve Collector filtering.
  Local container logs and remotely exported records have different privacy
  boundaries; restrict access to both.
- Keep exporter traffic within the approved `/32` and port, with DNS and
  Kubernetes API access configured by the chart. Use an approved fixed proxy
  when your backend cannot be represented by that egress policy. NetworkPolicies
  are additive: the current shared dependency policy also permits Collector
  traffic to the configured database destination; the dedicated Collector
  policy does not remove that access.
- Alert on failed exports, refused records, queue saturation, and Collector
  restarts. Verify retention and access controls in your selected backend.
- Treat delivery as best-effort. Docker keeps exporter queues in the
  `occ_otelcol_data` volume and bounded runtime log caches; its push-based
  Fluent Forward receiver has no file offsets. Kubernetes keeps file offsets
  and exporter queues in `/var/lib/otelcol` on bounded `emptyDir` storage,
  which survives container restart but is lost on Pod or node replacement. An
  outage can lose operational logs without blocking OCC work. Audit records are
  stored separately in PostgreSQL.

## Troubleshooting

| Symptom                                                  | Check and recovery                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC will not start after changing the level              | Use only the supported `logging.level` values; unknown logging keys fail startup.                                                             |
| Runtime level did not change                             | Restart OCC with the new startup YAML, then deploy a new AgentRevision.                                                                       |
| No Docker records reach the Collector                    | Check the Engine-reachable Fluent Forward address and matching published port; recreate existing runtime containers through Agent deployment. |
| Kubernetes Collector is pending or cannot read files     | Check image pull access, Secret names, Pod security admission, and node CRI file permissions.                                                 |
| Metadata is missing or Kubernetes requests are forbidden | Check the Collector ServiceAccount binding and Pod-read ClusterRole; retain the shipped Pod association and extraction rules.                 |
| Collector receives records but the backend does not      | Check endpoint path, TLS trust, credentials, exporter errors, allowed egress address/port, and whether records pass the operational filter.   |
| Expected records disappear at `warn` or `error`          | The source level suppresses lower-severity events; use `info` for the delivery check.                                                         |

## Related

- [Deploy the platform](deploy.md).
- [Settings and supported inputs](../reference/settings.md).
- [Common operational logging flow](../flows/common-logging.md).
- [Operational logging security boundary](../reference/security.md#operational-log-collection-boundary).
