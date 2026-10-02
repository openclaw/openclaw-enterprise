# Troubleshoot the platform

Use this page when local startup, the Kubernetes installation, the control plane,
or several Agents are affected. For a problem with one Agent, start with
[Agent troubleshooting](../topics/agent-troubleshoot.md).

## Local K3s cannot find the cpuset controller

If the k3d server logs report `failed to find cpuset cgroup (v2)`, inspect
`/sys/fs/cgroup/cgroup.controllers` inside that server. Docker running inside a
containerized development host needs the outer host to delegate `cpuset`;
a running Docker daemon does not prove delegation. For Podman, check the
[rootful setup requirements](../deploy/local-kubernetes-development.md#start-the-profile).

Use the host management service's documented delegation procedure. If delegation
changes fail, check that service before concluding that an outer-host change is
required. Restore any paused management service and verify its health before
continuing; do not disable the K3s check. Confirm `cpuset` is available inside the
k3d server and that K3s starts successfully.

## Local K3s image lookup times out

The Compose control-plane profile without OpenShell resolves a K3s channel
unless `OCC_DEVELOPMENT_K3S_IMAGE` selects an explicit image. If that lookup times out,
select an approved Kubernetes 1.35-or-newer image through the
[profile settings](../../reference/settings/development.md).

After a failed creation, wait for startup to exit, then run `./scripts/dev-down`
from the repository root with the same profile and state directory. Retry the
[Compose profile startup](../deploy/local-kubernetes-development.md#run-occ-in-compose-with-kubernetes-compute)
with the selected image and wait for the development stack to report ready.

## Local startup stalls on cert-manager

On some Linux hosts, especially Ubuntu with Docker 29, the k3d node cannot
resolve container registries. Startup then waits on the cert-manager rollout
while its pods stay in `ContainerCreating`. The launcher does not print those
Pod events, and it prints the kubeconfig path only after startup succeeds.

In a second terminal, while that wait is still running, describe the
cert-manager Pods. The context is `k3d-` plus the cluster name from the first
startup line, `Creating Kubernetes-only k3d cluster ...`. `<state-directory>`
belongs to the process that started OCC, not to this second terminal. Use
`OCC_DEVELOPMENT_STATE_DIRECTORY` when that process set it. Otherwise use that
process's temporary directory plus `openclaw-development`: its `TMPDIR` when
set, and `/tmp` on Linux when `TMPDIR` is unset. Do not substitute this
terminal's `TMPDIR`. The
[development settings](../../reference/settings/development.md#required-development-controller-environment)
define that directory.

```bash
kubectl --kubeconfig '<state-directory>/kubeconfig' \
  --context 'k3d-<cluster>' \
  -n cert-manager describe pods
```

A registry DNS failure shows up as a lookup error in the Pod events. Follow
[Resolve node DNS failures](../deploy/local-kubernetes-development.md#resolve-node-dns-failures)
and set a reachable resolver for a fresh start. That recovery changes only the
owned node's resolver. If startup rolls the cluster back, wait until that
command exits before starting again.

## Local Codex sandbox check fails

Kubernetes-only startup with `OCC_DEVELOPMENT_SANDBOX_DRIVER=none` verifies the
dedicated Codex sandbox before bootstrap. On Ubuntu 24.04,
`kernel.apparmor_restrict_unprivileged_userns=1` denies the user namespace
Codex bubblewrap needs. Startup reports `kubectl failed` while verifying that
sandbox and rolls the owned cluster back. The preparation step does not print
the bubblewrap error.

Set that host sysctl to `0`, wait until the failed startup exits, and start
again. The setting applies to the whole host. The launcher does not change it,
and the sandbox check still runs. Do not skip the check.

A production node uses the separate
[Codex sandbox profile](../deploy/codex-sandbox.md) procedure. Do not copy this
sysctl change onto a shared cluster.

## The Helm installation did not complete

Run production commands from an operator shell with Helm and `kubectl`, read
access to the `openclaw-system` namespace, and `KUBECONFIG_FILE` and `CONTEXT`
set to the affected cluster. The examples use the default release `oce`; replace
it if you installed with another name.

Start with the release and the initialization Job:

```bash
HELM_RELEASE=oce
helm status "$HELM_RELEASE" --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get jobs,pods,pvc
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  describe job "$HELM_RELEASE-initialization"
```

If the Job started, inspect the failing container:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "job/$HELM_RELEASE-initialization" -c migration
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "job/$HELM_RELEASE-initialization" -c bootstrap
```

Migration runs before bootstrap; an unstarted bootstrap container has no logs.
For image, scheduling, or volume errors, use the Pod events reported by
`kubectl describe pod <pod-name>` with the same context and namespace. Fix the
specific image, scheduling, or storage error. For a bootstrap failure, follow
[bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
before retrying; do not delete the database or credential volume to force a
rerun. The recovery check is a successful authenticated `occ installation get`,
not only a completed Job.

## The control plane is unavailable or Namespaces do not become ready

Check the API and worker separately:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get deployment openclaw-enterprise-api openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs deployment/openclaw-enterprise-api --tail=100
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs deployment/openclaw-enterprise-worker --tail=100
```

If a Deployment has no available replicas, inspect its Pods and their events.
If the API is available but a newly created Namespace stays unready, check the
worker logs and the [tenant RoleBindings](../deploy/production-agents.md#grant-tenant-rolebindings).
After fixing the cause, repeat `occ installation get` and confirm the Namespace
reports `ready` before creating an Agent there. A healthy control plane does
not prove an Agent has deployed or can run a model.

## An Agent's Gateway or Harness Pod stays unready

Run `kubectl describe pod <pod-name>` in the Agent's tenant namespace. Each
`Readiness probe failed:` event names the step that is not ready, such as
`plugin runtime phase is starting` or `Gateway /readyz unavailable: ECONNREFUSED`.
When the startup wrapper holds a failed check, the event adds it, for example
`; startup check model-probe failed with AUTHENTICATION_FAILED`. See
[Harness authentication](../../reference/harness-execution.md#harness-authentication)
for the probe codes.

## A Gateway log asks for a restart to apply the model catalog

OpenClaw downloads its hosted model catalog in the background and logs
`remote model catalog downloaded; restart the Gateway to apply it`. No action
is needed: the Gateway keeps serving with the catalog it started with, and the
download applies, if at all, at its next start. To stop this background
traffic, set `models.catalogRefresh.enabled` to `false` in the Agent's
Configuration and deploy it; the Gateway then uses only the catalog bundled in
the runtime image.

## Authentication fails after installation

Use the intended credential: `occ installation get` uses the protected service
key; the browser console uses a human administrator sign-in. Check `OCC_URL`
against the installation's approved HTTPS origin and confirm
`OCC_SERVICE_KEY_FILE` points to the intended key. For a missing or exposed key,
follow [service-key recovery](../../reference/authentication/service-api-keys.md#recover-a-lost-or-exposed-service-key).
Repeat the failed operation after recovery; do not copy tokens or key-file
contents into an incident report.

## Agent workspace files are unavailable

A `503 DEPENDENCY_UNAVAILABLE` can mean routing is not configured or the
proxy or gateway is unavailable. Start with the Gateway, certificate, security
policy, and tenant `HTTPRoute` in [workspace-routing verification](../deploy/workspace-routing.md#verify-routing-and-file-access).
After fixing the failed resource, repeat the original OCC file request. A
`404 NOT_FOUND` on an otherwise working route means that specific file is
missing; do not create or overwrite it just to clear the console message.

For missing exported logs, use [observability troubleshooting](../observability.md#troubleshooting).
When escalating, record the release, cluster context, affected Namespace IDs,
failure timestamps, exact error code, and relevant redacted events. Keep service
keys and raw Secret values out of the report.
