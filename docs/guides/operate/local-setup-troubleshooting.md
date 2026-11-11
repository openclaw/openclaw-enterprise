# Troubleshoot local k3d setup

## Corepack cannot download pnpm through a proxy

Set the approved `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` values for your network. Before the first pnpm command, run `export NODE_USE_ENV_PROXY=1` so Corepack uses those settings. See [Corepack proxy configuration](https://github.com/nodejs/corepack#environment-variables).

## pnpm reports a read-only store

Select a private writable store before retrying the install. Use the run directory printed by the quickstart.

```bash
export pnpm_config_store_dir="${RUN_DIR:?Set RUN_DIR to your private run directory}/pnpm-store"
pnpm install --frozen-lockfile
```

After the install succeeds, continue with the CLI build in [local k3d setup](../deploy/local-setup.md#2-start-a-new-k3d-installation).

## Helm warns that api.trustedProxy is unset

For local password sign-in without a reverse proxy, leave this setting unset. Failed attempts are limited per email. If an HTTP proxy sits in front of the API, [configure proxy trust](../../reference/settings/production.md#external-sign-in-and-trusted-proxies) before using it.

## First-Agent deployment fails

Inspect the failed deployment in the Console and retain the error code printed by
the helper. `RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE` means managed Codex
policy refuses the configured runtime permissions. Review the configured sandbox,
permission profile, and approval reviewer with your policy administrator before
deploying again. Replacing the model key is not a demonstrated fix for this error.

For `RUNTIME_AUTHENTICATION_FAILED`, check the model credential and model access;
when replacing that credential, supply the replacement and rerun your original
first-Agent helper command for the same Agent, adding `--replace-key`. Run
`node scripts/first-agent.mjs --help` for supported options. For other codes,
inspect the deployment and controller worker logs before choosing a recovery action.

## First-Agent reports an existing lock

Wait for the command using that Agent name to finish, then retry. The helper
prints the exact lock path. It leaves existing locks untouched, including locks
left by a killed process, to prevent overlapping commands from replacing each
other's lock and resume record.

If the lock persists, stop automated retries and wait for or stop every
first-Agent helper using that state directory and Agent name, including older
versions. Coordinate with other users of the checkout before proceeding.
Inspect the exact entry without following links: it must be a regular file,
owned by the current user, with no group or other permissions. Its PID is a clue
only; check activity in the host context that ran the helper. Leave an unexpected
entry or uncertain ownership for investigation.

With all contenders stopped and abandonment confirmed, remove only the printed
lock file. Preserve the adjacent `.json` resume record. Retry once with the same
Agent name. Do not remove a lock based only on a PID check while another command
can start.

## Gateway connections return 403 after an Envoy Pod replacement

Correlate the worker's failed attempt with the Envoy access log. A `403` with
`via_upstream` means the upstream returned the refusal; it does not establish
that the model credential failed. If the native Gateway reports
`trusted_proxy_untrusted_source`, inspect the proxy trust configuration.
Retain the failed Gateway logs privately and keep the existing Agent for
redeployment. Delete the Agent only for intentional teardown; deletion also
removes its workspace and version history.

If the Installation trusts the previous Envoy Pod by its individual address,
a replacement can fall outside the configured range while the Gateway,
certificate and control plane still report ready. Startup preflight does not establish that
the configured trust admits the current proxy.

List the proxy Pods for the selected Gateway. Set these names from the installed
Compute `gatewayRouting` configuration. In the [saved quickstart
operator session](../deploy/quickstart-session.md), use its kubeconfig and context:

```bash
ENVOY_NAMESPACE='<envoyNamespace>'
GATEWAY_NAMESPACE='<gatewayNamespace>'
GATEWAY_NAME='<gatewayName>'
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" \
  -n "$ENVOY_NAMESPACE" get pods \
  -l "gateway.envoyproxy.io/owning-gateway-namespace=$GATEWAY_NAMESPACE,gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME" \
  -o custom-columns='NAME:.metadata.name,UID:.metadata.uid,IP:.status.podIP'
```

Compare the current proxy's socket-source address with
`drivers.compute.configuration.network.gatewayTrustedProxyCidrs` in the protected
Installation YAML. Pod addresses are diagnostic clues: source address translation
or a custom ingress can change the address the Gateway sees. Confirm the source
before changing trust. Also verify that only the intended proxy can reach the
listener from that source, retaining the [exact proxy NetworkPolicy
peer](../../reference/drivers/kubernetes-compute/gateway-authentication.md#listener-and-proxy-trust).
A shared translated address alone does not identify the proxy. If isolation
cannot be established, leave trust unchanged. Do not automatically trust a whole
Pod network.

For a confirmed stale entry in the k3d quickstart, edit the saved
`INSTALLATION_FILE` and follow [Update and recover the
Installation](../deploy/quickstart-session.md#update-and-recover-the-installation)
using `upgrade_installation`. For production Helm installations, follow
[Apply other Installation changes](../deploy/production-installation-changes.md).
Preserve current image references; Helm-managed API and worker Pods restart
through the configuration checksum. No image rebuild is required. These Helm
procedures do not apply to Compose-managed controllers.

If the Agent Configuration explicitly sets `gateway.trustedProxies`, omit that
override or make it match the updated Installation before redeploying; generated
defaults need no edit. Deploy the same Agent again so its Gateway receives the
corrected trust, preserving sessions and workspace storage. Verify node
enrollment and a real chat reply; a controller rollout alone does not prove either.
