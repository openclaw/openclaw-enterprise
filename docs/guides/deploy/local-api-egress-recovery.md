# Recover local Kubernetes API egress after restart

For a retained Linux k3d installation, install the local infrastructure service
below to maintain the Helm chart's exact API destination rule. Docker can assign
control-plane containers new addresses after a host restart. Without an update,
OCC can read PostgreSQL and report Ready while Kubernetes Secret writes fail.

This is an optional deployment supplement. It preserves the
[OCE architecture](../../design.md#system-model): infrastructure owns cluster
connectivity; Compute and Sandbox Drivers retain their existing responsibilities.
It does not change Agent revision Pods, remote Harnesses or split storage. It
does not qualify EKS failover or install a different network plugin.

## Check ownership and permissions

Use an existing installation with enforcing NetworkPolicies, a local Docker
Unix-socket context and IPv4 k3d control-plane containers. The service runs on
the Linux Docker host, outside Kubernetes. It needs the installation operator's
existing Docker administration authority. Docker socket access is host-level
authority; do not grant it to OCC, an Agent or a Sandbox.

The command verifies the cluster's running server labels and addresses, the
namespace UID and Helm release ownership. It reads the API endpoint through an
owned server's existing `kubectl`; it copies no administrator credential.
Only `openclaw-enterprise-dependency-egress` can change. The command replaces its
API destination `/32` entries and preserves its selectors, port and other rules.
An unexpected endpoint, selector, port, ownership or concurrent edit refuses the
write. It reports the failure and retains the existing policy. It does not add a
subnet exception or reserve a fixed address.

This service does not remove other policies or change the existing `occ dev up`
profile. That profile can install a separate subnet-wide development API rule.
Do not claim exact-destination isolation while that additional rule is present.
This service is for retained Helm installations whose administrator has selected
exact API egress. Helm remains the configuration owner; the service maintains
the live endpoint entries after an upgrade. Update saved Helm inputs when doing
an infrastructure upgrade as well.

## Install on the Linux cluster host

Build the normal CLI from this checkout and install the service template:

```sh
go build -o /tmp/occ-k3d-infra ./cmd/occ
sudo install -d /usr/local/libexec /etc/occ/k3d-api-egress
sudo install -m 0755 /tmp/occ-k3d-infra /usr/local/libexec/occ-k3d-infra
sudo install -m 0644 deploy/local/occ-k3d-api-egress@.service /etc/systemd/system/
```

Create `/etc/occ/k3d-api-egress/local.conf` as a root-owned mode `0600` file.
Use the actual existing cluster, namespace UID, release and endpoint port:

```ini
DOCKER_CONTEXT=default
CLUSTER=occ-dev-local
NAMESPACE=openclaw-system
NAMESPACE_UID=replace-with-the-existing-namespace-uid
RELEASE=oce
API_PORT=6443
```

Get the UID through the selected cluster, then preview the change:

```sh
docker --context default exec k3d-occ-dev-local-server-0 kubectl get namespace openclaw-system -o jsonpath='{.metadata.uid}'
sudo /usr/local/libexec/occ-k3d-infra dev reconcile-k3d-api-egress \
  --docker-context default --cluster occ-dev-local --namespace openclaw-system \
  --namespace-uid ACTUAL_UID --release oce --api-port 6443
sudo systemctl daemon-reload
sudo systemctl enable --now occ-k3d-api-egress@local.service
sudo journalctl -u occ-k3d-api-egress@local.service -n 20 --no-pager
```

The preview writes no policy. The installed service reconciles every five
seconds and starts with Docker at boot. It logs the first result, endpoint
changes, errors and recovery, without Secret contents or command output. A
namespace recreated with the same name requires an explicit configuration update.
Readiness of the systemd process alone does not prove synchronization: inspect
an `api_egress_synchronized` event and the live rule.

## Verify recovery and remove the service

Record the host boot ID, API endpoints, policy specs, Agent revision and PVC
UIDs. Restart the host without manual policy edits. Verify that only the API
destination entries follow the new endpoints. Perform a normal Secret update
through OCC, then a real model turn using the retained workspace, memory and
skill. Do not retry a failed turn to declare the reboot passed.

After Kubernetes reports valid current endpoints, the service can take one
reconciliation interval plus command execution time to restore connectivity.
During boot, Kubernetes can temporarily advertise an old address alongside the
new one. The service refuses that set until every address belongs to a running
control-plane server; it does not broaden the rule to accommodate stale entries.
It is not a zero-downtime API guarantee. It manages neither
database destinations nor tenant policies, and supports at most 16 running
IPv4 k3d servers. Multiple servers are supported by address validation but need
separate operational qualification.

Before retiring the owned cluster, disable the service with
`sudo systemctl disable --now occ-k3d-api-egress@local.service` and remove its
configuration. Preserve shared CLI/service files if another installation uses
them. Removal leaves the last exact policy in place; it does not broaden access.

See the [reconciliation flow](../../flows/local-kubernetes-api-egress.md) for
source ownership and focused real-cluster tests.
