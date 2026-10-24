# Retain Kubernetes worker termination observations

The operator command retains observed control-plane worker exits independently
of worker logging. **Helm logging enablement does not start this command.** Use
one observer per release on a trusted Linux host with Node.js 24+, `kubectl`,
Collector Contrib 0.159.0 and existing namespace-scoped Pod list/watch permission.
No cluster resources or permissions are created.

## Start the private receiver

Use a dedicated OS account that runs only this observer and its Collector. Other
workloads must not run under that account. Administrators and that account remain
trusted. Provision `/var/lib/oce-worker-observer` owned by the account, mode 0700,
on persistent storage with a monitored disk quota. Run these commands as that
account, from the repository root:

```sh
umask 077
export OCE_WORKER_OBSERVATIONS_FILE=/var/lib/oce-worker-observer/observations.jsonl
export OCE_WORKER_STATE_DIR=/var/lib/oce-worker-observer/collector-state
mkdir -m 700 -p "$OCE_WORKER_STATE_DIR"
touch "$OCE_WORKER_OBSERVATIONS_FILE"
chmod 600 "$OCE_WORKER_OBSERVATIONS_FILE"
```

The checked-in [receiver configuration](../../../deploy/logging/worker-observer.yaml)
is mandatory. Its log pipeline has no network log receiver and reads exactly the
named file, not a directory glob. The exporter and Collector self-telemetry can
still use the network; inspect their endpoints before starting the Collector.

The observer refuses symlinks, multiply linked files,
foreign ownership, and group/world access to the file or its immediate directory.
Do not grant ACL access to other accounts or put the directory under a parent
that another account can replace. The input file must have no other producer.

Prepare `/protected/worker-exporter.yaml` from your existing protected **exporter
section**, retaining the name `otlp_http`, backend endpoint, authentication,
TLS and retention policy. The [standard exporter](../../../deploy/logging/exporter.yaml)
is the starting shape: preserve its bounded queue and retry settings, with
`sending_queue.storage: file_storage`. The receiver config supplies that extension
using `OCE_WORKER_STATE_DIR`. Do not merge another receiver or service pipeline.
Add this explicit self-telemetry configuration to the same protected file. It
keeps the Collector's Prometheus metrics listener on loopback; allow access only
to trusted local monitoring. Do not add telemetry exporters or other listeners
without reviewing their destinations and access controls.

```yaml
service:
  telemetry:
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: 127.0.0.1
                port: 8888
```

Validate the exact merged configuration before startup:

```sh
otelcol-contrib validate \
  --config=deploy/logging/worker-observer.yaml \
  --config=/protected/worker-exporter.yaml
```

Validation must exit successfully. Separately check that `otlp_http.logs_endpoint`
is the approved backend, with the existing authentication and TLS settings.
Validation checks configuration, not network reachability or backend retention.
Do not enable raw/debug export. Backend retention remains a backend setting;
local offsets and queued exports must survive process and host restarts.

After validation, start the Collector under a supervisor:

```sh
otelcol-contrib \
  --config=deploy/logging/worker-observer.yaml \
  --config=/protected/worker-exporter.yaml
```

Then start the observer under its supervisor:

```sh
KUBECONFIG=/protected/operator-kubeconfig \
  node scripts/observe-worker-terminations.ts \
  production-context oce-system oce-release "$OCE_WORKER_OBSERVATIONS_FILE"
```

Replace context, namespace and release with the actual installation. The observer
appends and syncs each record to disk. Configure restart delay and alerting for
both processes. API errors, watch closure, malformed input and capacity failures
stop the observer with a fixed diagnostic. Collector startup/configuration errors
must also alert. `kubectl` credential plugins and the kubeconfig are trusted.

## Schema and retention boundaries

The receiver accepts only the versioned worker stream, two fixed event names and
an envelope containing exactly `stream`, `event` and `fields`. It reconstructs
attributes using bounded scalar checks. Unknown fields, nested values, incoming
resource/scope metadata and bodies are not forwarded. Invalid event, stream or
envelope records are dropped. Resource and instrumentation identity are fixed by
the receiver, not the file. The only retained reasons are `Completed`, `Error`,
`OOMKilled`, `ContainerCannotRun`, `StartError` and `ContainerStatusUnknown`;
unknown reasons are omitted by both observer and receiver.

The observer stops at 64 MiB of input (plus at most one record); monitor capacity
before that point. To rotate, stop the observer, let the Collector drain, and
verify backend receipt and an empty exporter queue. Stop the Collector, archive
the input **and** state directory under the protected retention policy, then
start with an empty mode-0600 input and a **new empty state directory**. Never
reuse offsets for a truncated file or delete a nonempty export queue. Restart
both processes with the new paths. Duplicate backend delivery is possible;
deduplicate by `oce.observation.id`.

## Verify observations and gaps

Select `service.name=oce-worker-observer` and
`event.name=worker.termination.observed` in the backend. Records identify the Pod
UID, namespace, Pod name, worker placement, restart incarnation, exit code and
finish time. A termination is recorded only when the observer sees a qualifying
terminated state with a valid exit code and finish time. Raw Pod specifications,
termination messages and application output are not forwarded. Recognized
terminated CRI IDs and explicit nonzero signals are kept;
replacement IDs and images are absent. Exit 139 is not proof of SIGSEGV, and 137
is not proof of OOM. Current termination uses `restartCount`; last termination
uses `restartCount - 1`, with finish time included in the stable observation ID.

`worker.observation.coverage` distinguishes baseline, changed count, unavailable
status and counter reset. `oce.observation.missing_terminations_min` is a lower
bound on terminations the observer could not reconstruct in its observation
window. A baseline count describes history unknown to this observer at startup,
not necessarily records missing from the backend. For example, after a restart
with `restartCount: 2` and only incarnation 1 in `lastState`, the baseline reports
1 even if the backend already retained incarnations 0 and 1. Do not sum baseline
counts across observer restarts as backend loss. Consecutive missing statuses preserve the last known count rather than recounting old gaps.
A zero gap does not prove complete history: rapid restarts, deleted Pods, counter
resets, process/API outages and backend loss can still hide deaths. The initial
list is limited to 500 Pods, input to 8 MiB and tracking to 1,024 Pod UIDs.

Before relying on an installation, verify two controlled exits in an approved
release, normal and restartable init workers, backend retention, supervisor
recovery, and unchanged application logging. Local synthetic API proof does not
establish installed RBAC or end-to-end durability. See [test coverage](../../testing/local.md#worker-termination-observer)
and the existing [logging setup](../observability.md).
