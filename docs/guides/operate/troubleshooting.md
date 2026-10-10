# Troubleshoot the platform

Use this page when local startup, the Kubernetes installation, the control plane,
or several Agents are affected. For a problem with one Agent, start with
[Agent troubleshooting](../topics/agent-troubleshoot.md).

## Local K3s cannot find the cpuset controller

If the k3d server logs report `failed to find cpuset cgroup (v2)`, inspect
`/sys/fs/cgroup/cgroup.controllers` inside that server. Docker running inside a
containerized development host needs the outer host to delegate `cpuset`;
a running Docker daemon does not prove delegation. On native rootless Podman,
delegating `cpuset` is not enough: k3d still fails with
`mkdir /var/run/docker.sock: permission denied`. Use the
[rootful setup requirements](../deploy/local-kubernetes-development.md#start-the-profile).

Use the host management service's documented delegation procedure. If delegation
changes fail, check that service before concluding that an outer-host change is
required. Restore any paused management service and verify its health before
continuing; do not disable the K3s check. Confirm `cpuset` is available inside the
k3d server and that K3s starts successfully.

## Local K3s image lookup fails

The Compose control-plane profile without OpenShell resolves a K3s channel
through `update.k3s.io` unless `OCC_DEVELOPMENT_K3S_IMAGE` selects an explicit
image. If that lookup fails or times out, startup stops with `k3d failed` and
k3d's `error getting K3s version for channel` line. Select an approved
Kubernetes 1.35-or-newer image through the
[profile settings](../../reference/settings/development.md).

After a failed creation, wait for startup to exit, then run `./scripts/dev-down`
from the repository root with the same profile and state directory. Retry the
[Compose profile startup](../deploy/local-kubernetes-development.md#run-occ-in-compose-with-kubernetes-compute)
with the selected image and wait for the development stack to report ready.

## Local K3s cannot load the legacy iptables nat table

Both local k3d profiles start their node with `IPTABLES_MODE=legacy`. A host whose
Docker uses nftables never loads the legacy netfilter modules, and the node cannot
load them itself. kube-proxy then exits with
`can't initialize iptables table 'nat': Table does not exist`, K3s shuts down, and
cluster creation fails when the startup timeout expires with
`k3d failed: exit status 1`: ten minutes by default for the Kubernetes-only
profile, five for the Compose profile.

When the container engine runs on the host's own Linux kernel (not Docker Desktop, a
Podman machine, or a remote engine), `occ dev up` checks that kernel first. If it can
tell the kernel has not loaded the modules, it stops before cluster creation with
`the host kernel has not loaded the legacy iptables modules (ip_tables, iptable_nat)
that the local k3d node needs`, followed by the `modprobe` command below. A kernel
that ships no `iptable_nat` module stops with `provides no legacy iptables nat table
(iptable_nat)` instead; see the end of this section. If it cannot tell, it prints
`Warning: could not confirm that the host kernel provides the legacy iptables nat
table (iptable_nat)` and continues, and the timeout above still applies. If
creation then fails, the error repeats the `modprobe` command below unless
k3d's last error names another cause.

In a second terminal, while that wait is still running, read the node log.
`<cluster>` is the cluster name from the startup output.

```bash
docker logs 'k3d-<cluster>-server-0' 2>&1 | grep -i 'iptables table'
```

On the host, `lsmod | grep '^iptable_nat'` prints nothing while the module is
unloaded. Load the legacy modules K3s uses and keep them across reboots:

```bash
sudo modprobe --all iptable_nat iptable_filter iptable_mangle br_netfilter
sudo tee /etc/modules-load.d/oce-k3d-legacy-iptables.conf >/dev/null <<'EOF'
iptable_nat
iptable_filter
iptable_mangle
br_netfilter
EOF
```

A failed creation preserves the state directory and reports it for `occ dev down`.
Wait until that startup exits, then run `./scripts/dev-down` from the repository root
with the same profile and state directory, and start the profile again.
`lsmod | grep -E '^iptable_(nat|filter)'` lists both modules, and startup reaches
`OpenClaw Enterprise development stack is ready.` A host whose kernel ships no
`iptable_nat` module cannot run these profiles.

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

Kubernetes Compute startup with `OCC_DEVELOPMENT_SANDBOX_DRIVER=none` verifies the
dedicated Codex sandbox during startup. On Ubuntu 24.04,
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

## The local console reports a certificate error

If the printed HTTPS console URL shows `NET::ERR_CERT_AUTHORITY_INVALID` or an
unknown-issuer warning, check the certificate using the public CA from the same
installation. Set `BROWSER_CA` to its path on the computer running these commands
(`./browser-ca.crt` if copied from the startup machine), and `CONSOLE_URL` to
startup's **Browser console** URL; keep the printed hostname and port:

```bash
BROWSER_CA='<local-browser-ca.crt-path>'
CONSOLE_URL='<printed-HTTPS-browser-console-URL>'
openssl x509 -in "$BROWSER_CA" -noout -subject -dates -fingerprint -sha256
curl --fail --show-error --max-time 10 --cacert "$BROWSER_CA" \
  -o /dev/null -w 'HTTP %{http_code}; TLS verify %{ssl_verify_result}\n' "$CONSOLE_URL"
```

Expect HTTP `200` and TLS verify `0`. This checks the served certificate chain
and exact hostname. It does not add browser trust. When this check succeeds but
the browser still rejects the issuer, trust that installation's public CA in
the browser's local trust store. `occ dev up` never changes that store. Importing
a certificate without enabling SSL trust may leave the warning unchanged.

### Trust the CA on macOS

Safari and Chrome use explicit local trust settings in macOS Keychain Access.
For an unmanaged Mac where local CA trust is permitted:

1. Open Keychain Access, select the **login** keychain, and import only the
   printed `browser-ca.crt` using **File → Import Items**.
2. Open the imported **OCC development browser CA**. Match its SHA-256
   fingerprint to the command above; different installations use the same name.
3. Expand **Trust**, set **Secure Sockets Layer (SSL)** to **Always Trust**, and
   close the certificate window. Complete any macOS authentication prompt locally.
4. Reload the printed HTTPS URL. If the browser cached the old trust decision,
   quit and reopen it. Expect the console sign-in page without a certificate warning.

See Apple's [certificate trust settings](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)
and Chrome's [local trust-store behavior](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md#how-does-the-chrome-certificate-verifier-integrate-with-platform-trust-stores-for-local-trust-decisions).
Other browsers may use a separate certificate store. On managed computers, use
the administrator-approved CA trust procedure; report a policy restriction
instead of bypassing the warning or disabling TLS verification.

If the `curl --cacert` check fails, inspect its error before importing anything:
an expired certificate, wrong hostname, or CA from another installation needs
that cause resolved. Do not use `curl -k` as a successful verification result.

### Remove trust when discarding the installation

Record the CA fingerprint before `occ dev down` deletes the state files. In the
same trust store, locate the certificate with that exact fingerprint, remove
its explicit trust setting, and delete it. Do not remove every certificate named
**OCC development browser CA**; another installation may still use one. A new
installation generates a new CA and requires its own trust step.

## Open the console from another machine

Kubernetes-only startup without OpenShell prints an HTTPS console URL such as
`https://console.<cluster>.oce.localhost:8443/console/`. `<cluster>` is the k3d
cluster name from startup. `8443` is the default `OCC_DEVELOPMENT_BROWSER_PORT`;
use the printed port when it differs. Kubernetes-only startup with OpenShell
prints `Console: <apiURL>/console/` and does not print this browser URL or CA.

Open that URL on the machine that ran `occ dev up`. The hostname ends in
`.localhost`, so the computer that looks it up resolves it to its own loopback
address. The launcher publishes the console port on `127.0.0.1` of the startup
machine only. A browser on another computer reports a connection error, such as
`ERR_CONNECTION_REFUSED`, because nothing is listening there.

From the computer that will run the browser, forward the printed port to the
startup machine's loopback and bind the local listener to loopback. Leave this
session open:

```bash
ssh -N -L localhost:8443:127.0.0.1:8443 <user>@<startup-host>
```

Replace `8443` in both places when startup printed a different port. The
`localhost` bind keeps the forwarded port on the browser machine's loopback
even when that machine's SSH configuration sets `GatewayPorts yes`.

Copy only the printed public CA to that same computer:

```bash
scp <user>@<startup-host>:<printed-ca-path> ./browser-ca.crt
BROWSER_CA='./browser-ca.crt'
CONSOLE_URL='<printed-HTTPS-browser-console-URL>'
```

`<printed-ca-path>` is the `browser-ca.crt` path from startup. Follow
[local browser CA trust](#the-local-console-reports-a-certificate-error) on the
browser computer using the local `BROWSER_CA` value above instead of the startup
machine's CA path. Keep the printed hostname and port in `CONSOLE_URL`. Leave the
CA private key and the state directory on the startup machine. Open the printed
URL. The console sign-in page loads. Stop the forward when you are done. Do
not publish the console port on an address other than loopback. This name and
certificate are for the private development installation.

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
INITIALIZATION_JOB=$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  get jobs --selector "app.kubernetes.io/instance=$HELM_RELEASE,app.kubernetes.io/component=initialization" \
  -o name)
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  describe "$INITIALIZATION_JOB"
```

The lookup uses release labels because long release names have a shortened Job
name. If it finds no Job, inspect the Helm error before running `describe` or
`logs`; the hook may not have been created.

If the Job started, inspect the failing container:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "$INITIALIZATION_JOB" -c migration
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  logs "$INITIALIZATION_JOB" -c bootstrap
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
`Readiness probe failed:` event reports the private HTTP endpoint's status or a
connection failure. A `503` means the runtime's native, plugin, authentication,
or identity gate has not passed. Check the container's startup-phase logs for
the failing stage. See
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
