# Resume the OpenShell first-Agent proof

Use this handoff to recreate and diagnose the local first-Agent flow with the
OpenClaw Enterprise (OCE) API and worker in Docker Compose, Kubernetes Compute
in k3d, and dedicated Codex in OpenShell. It records the development path proven
on October 2, 2026. It is not production qualification.

The checkpoint passed three consecutive real `openai/gpt-6-astra` turns on
branch `feat/openshell-first-agent-codex`. Start a new session with
`git status --short --branch` and preserve any current work.

## Understand the working path

The successful path depends on all of these behaviors:

- The development launcher installs the pinned OpenShell `v0.1.3-pre.2`
  gateway, sandbox runtime, supervisor, Agent Sandbox controller, cert-manager,
  and private Envoy routing into a fresh k3d cluster.
- Single-cluster Kubernetes Compute creates one tenant namespace containing the
  dedicated Gateway and the provider-owned Harness. The OpenShell Workspace uses
  that same physical name.
- Compute waits for the first fail-closed Gateway and its workspace-node setup
  material before the OpenShell Driver creates a provider or Sandbox.
- The Driver puts `runtime.json`, `config.toml`, and the complete one-shot
  workspace-node setup envelope in a revision provider. Keeping the original
  bootstrap token in this file preserves OpenClaw's signed device proof.
- Dedicated Codex receives `APP_TOKEN_SHA`, while its OpenShell service uses
  bearer passthrough. The raw app-server token remains in the dedicated Gateway
  and Codex verifies the forwarded request.
- The OpenShell supervisor originates the proxied workspace-node connection.
  Paired NetworkPolicies permit only the exact supervisor-to-Gateway route.
  The node process retries without an attempt limit while the Gateway rolls out.
- The OpenShell endpoint contract reports both the advertised WebSocket origin
  and `/sandbox/enterprise`. Kubernetes Compute passes that root to the Gateway
  as `OPENCLAW_REMOTE_WORKSPACE_ROOT`; non-OpenShell Harnesses retain
  `/home/node/workspace`.
- The direct Kubernetes `agent-*` Service stays on its inactive selector.
  Gateway-to-Codex traffic uses the OpenShell-advertised service and relay.
- Development CRD readiness polls until `Established=True`. An initially absent
  `status.conditions` is pending, not a fatal `kubectl` accessor error.

The [OpenShell provisioning flow](../flows/openshell-sandbox-provisioning.md)
owns the source-backed sequence. The
[OpenShell Sandbox reference](../reference/drivers/openshell-sandbox.md) owns the
current Driver contract and security limits.

## Start from a clean environment

Run from the repository root. Use an existing `OPENAI_API_KEY` or point
`OPENAI_API_KEY_FILE` at a private file. Do not put the key in the command or
print it while diagnosing the flow.

```bash
export OCE_OPENSHELL_RUN_ROOT="$(mktemp -d)"
export OCC_DEVELOPMENT_STATE_DIRECTORY="$OCE_OPENSHELL_RUN_ROOT/state"
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=compose
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_CONTAINER_ENGINE=docker
export OCC_DEVELOPMENT_COMPOSE_PROJECT="oce_openshell_$(date +%s)"
export OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS=900

pnpm cli:build
bin/occ dev up
```

To run the API, worker, and PostgreSQL in k3d instead, set
`OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes` and omit the Compose project. That
profile prints `Deployment: Kubernetes only` and its API URL instead of
`Control plane: Compose`; the same `first-agent.mjs` command applies. The
protected tests `local-first-agent-openshell-real` and
`local-first-agent-openshell-k3d-real` cover the two profiles.

If Docker reports an overlapping network, select an unused private `/24` before
retrying, for example:

```bash
export OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR=172.30.42.0/24
```

First run `bin/occ dev down` with the original state directory if a previous
attempt created partial resources. Do not delete an unrelated Docker network or
k3d cluster to resolve an overlap.

Successful startup prints all of these values without printing credential
contents:

- `Control plane: Compose`
- `Compute Driver: Kubernetes`
- `Sandbox Driver: openshell`
- API URL, service-key file, kubeconfig, and Kubernetes context

## Run the proof

Choose a new Agent name for an independent provisioning proof:

```bash
node scripts/first-agent.mjs resume-agent-1 --harness codex
```

Success requires the command to print `Model response verified:`. A ready
Sandbox, active revision, or HTTP response without that marker is not a complete
model proof. Run another new name to check repeatability:

```bash
node scripts/first-agent.mjs resume-agent-2 --harness codex
```

The starter intentionally disables tools and the OpenClaw Control UI. Its
printed URL opens the OCE Agent console, not an OpenClaw dashboard.

## Inspect without exposing credentials

The generated kubeconfig already selects the owned cluster:

```bash
kubectl --kubeconfig "$OCC_DEVELOPMENT_STATE_DIRECTORY/kubeconfig" get pods -A
kubectl --kubeconfig "$OCC_DEVELOPMENT_STATE_DIRECTORY/kubeconfig" \
  get sandboxes.agents.x-k8s.io -A
kubectl --kubeconfig "$OCC_DEVELOPMENT_STATE_DIRECTORY/kubeconfig" \
  get namespaces -L openclaw.dev/namespace,openclaw.dev/gateway-namespace
```

The tenant appears once and carries both placement labels; the dedicated
Gateway and OpenShell Workspace do not require separate Kubernetes namespaces.

Find the tenant's dedicated Gateway Pods and read one log without dumping its
environment or Secret volumes:

```bash
kubectl --kubeconfig "$OCC_DEVELOPMENT_STATE_DIRECTORY/kubeconfig" \
  get pods -A -l openclaw.dev/workload-role=gateway
kubectl --kubeconfig "$OCC_DEVELOPMENT_STATE_DIRECTORY/kubeconfig" \
  logs -n GATEWAY_NAMESPACE GATEWAY_POD --tail=300
```

Do not print the development state JSON, Kubernetes Secret data, provider file
contents, Pod environments, or complete process arguments. The one-shot
workspace-node setup code can appear in process arguments before it expires.

## Diagnose known failures

| Symptom                                                                                          | First check                                                                              | Cause and recovery                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose cannot bind `127.0.0.1:55432`                                                            | `docker ps --format '{{.Names}} {{.Ports}}'`                                             | Another development PostgreSQL owns the port. Stop that stack through its recorded `dev down`, then retry with a fresh state directory.                                                                    |
| Docker reports that the requested subnet overlaps                                                | `docker network ls`                                                                      | A prior network uses the selected range. Clean up its owning stack or set an unused `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR`; do not remove unrelated networks.                                               |
| Helm prints `Release "openshell-gateway" does not exist` and then `context deadline exceeded`    | Inspect Pods and events in `openshell-system` and `agent-sandbox-system`.                | The install message is normal; the timeout is not. Check image import, controller readiness, node capacity, and the 900-second startup timeout. Run `dev down` before recreating the disposable cluster.   |
| `.status.conditions accessor error: <nil>` while installing Envoy                                | Rebuild `bin/occ`, then inspect `internal/occdev/gateway_k3d.go`.                        | An older launcher used `kubectl wait` before the CRD populated conditions. The current launcher polls and treats the missing field as pending.                                                             |
| Revision reports `Dependency unavailable` before Sandbox creation                                | Check the worker image and whether the workspace-node setup Secret exists.               | A stale worker may create the provider too early. Rebuild and recreate the stack so Compute waits for setup material before calling `provisionHarness`.                                                    |
| Supervisor logs early `NET:FAIL` for the Gateway Service                                         | Check whether the dedicated Gateway is still rolling out.                                | Early connection failures are expected during rollout. The node supervisor retries indefinitely. Persistent failures require checking the paired supervisor/Gateway NetworkPolicies and Service selectors. |
| The model request returns HTTP 500 and Gateway logs say `Workspace does not belong to this node` | Inspect the Gateway Deployment for `OPENCLAW_REMOTE_WORKSPACE_ROOT=/sandbox/enterprise`. | The Gateway is using the Kubernetes default `/home/node/workspace` against an OpenShell workspace. Rebuild the worker and recreate the revision or stack with the endpoint workspace-root fix.             |
| Workspace-node enrollment fails signature verification                                           | Confirm the setup envelope comes from the revision provider file.                        | Credential rewriting changes the token covered by OpenClaw's device proof. Keep the exact bootstrap token in `node-setup.json`; do not deliver it through an obfuscating credential transformation.        |
| Gateway logs `remote model catalog refresh failed` or `Codex catalog hydration failed`           | Continue to the explicit model request.                                                  | These warnings did not block the pinned-model proof. Treat them as causal only if the real request also fails.                                                                                             |
| Supervisor denies `ab.chatgpt.com`                                                               | Verify `api.openai.com` is allowed and the model turn succeeds.                          | This telemetry endpoint is outside the provider policy and its denial was nonfatal. Do not broaden policy solely to silence it.                                                                            |
| The `agent-*` Service has an inactive selector                                                   | Inspect the OpenShell-advertised endpoint and dedicated Gateway `APP_SERVER_URL`.        | This is expected for a provider-owned Harness endpoint. Activating the direct Service would bypass the selected OpenShell transport.                                                                       |
| No OpenClaw dashboard URL is printed                                                             | Inspect the first-Agent configuration.                                                   | `controlUi.enabled` is deliberately false. The OCE console URL is the supported output of this starter.                                                                                                    |

For a model authentication failure, confirm that the selected key can use the
configured model. Replace an invalid key without printing it:

```bash
node scripts/first-agent.mjs resume-agent-1 --harness codex --replace-key
```

## Current handoff checkpoint

The October 2 run used Compose project `oce_first_agent_epdei6`, state directory
`/tmp/oce-first-agent-openshell.ePdEI6GOGw/state`, and k3d cluster
`occ-dev-hwb5trxono`. Agents `test-agent`, `test-agent-2`, and `test-agent-3`
each completed a real model turn. These resources are disposable and may not
survive a reboot; treat their presence as optional evidence, not a prerequisite.

If they still exist, stop only this recorded environment with:

```bash
env \
  OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
  OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell \
  OCC_DEVELOPMENT_STATE_DIRECTORY=/tmp/oce-first-agent-openshell.ePdEI6GOGw/state \
  bin/occ dev down
```

For the normal user-facing workflow, return to
[Deploy your first Agent](../guides/first-agent.md). For broader integration
coverage and production limits, return to [OpenShell tests](openshell.md).
