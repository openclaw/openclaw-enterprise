# Set up OpenClaw Enterprise locally

<span id="quickstart"></span>

Start an OpenClaw Enterprise installation that can deploy Agents on your
machine. The OpenClaw Control Plane (OCC), PostgreSQL, and Agent workloads run
in a local Kubernetes cluster created with k3d. This setup is for development
and uses loopback addresses. This guide explicitly selects the Kubernetes-only
profile; without a selection, startup uses a Compose control-plane preview that
cannot deploy Agents. A separate [Compose OCC with Kubernetes compute profile](deploy/local-kubernetes-development.md#run-occ-in-compose-with-kubernetes-compute)
has fewer configured capabilities. To install OCC itself in a cluster you already operate,
use [Kubernetes Setup](kubernetes-setup.md).

## Before you start

Run the commands below from the repository root on Linux or macOS. You need:

- Docker Engine, k3d, kubectl, and Helm. Podman users should first
  check the [local Kubernetes requirements](deploy/local-kubernetes-development.md#start-the-profile).
- The Go version in `go.mod`, Node.js 24 or later, and the pnpm version pinned
  in `package.json`.
- About 20 GB of free container-engine storage for the first build. On macOS
  that space is inside the Podman or Docker virtual machine rather than on your
  host disk; check it with `podman machine ssh df -h /var`. Without it, startup
  fails late with `no space left on device` and rolls back the cluster.
- Free local ports `3000` for the API, `8443` for the browser console, and
  `6443` for Kubernetes. If a port is in use, override `OPENCLAW_DEV_PORT`,
  `OCC_DEVELOPMENT_BROWSER_PORT`, or `OCC_DEVELOPMENT_KUBERNETES_API_PORT`;
  see [development settings](../reference/settings/development.md#required-development-controller-environment).

You do not need a model credential to install the platform. Have an OpenAI API
key available when you continue to [deploy your first Agent](first-agent.md).

## Start the local stack

By default, startup builds this checkout. To use published images, first
[select the `latest` pair](#optional-use-matching-published-images).

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./bin/occ dev up
```

The first start builds and imports both images unless you selected published
images. This can take several minutes. Wait for `OpenClaw Enterprise development stack is ready.` The
command prints the API URL, Installation ID, local service-key file, kubeconfig,
Kubernetes context, and cleanup command. Keep this output; the service-key file
is an administrator credential and must remain on your machine.

If startup stalls on cert-manager, follow [local startup troubleshooting](operate/troubleshooting.md#local-startup-stalls-on-cert-manager).

## Open the platform console

Import the printed browser CA certificate into your browser's trusted CA store
using your browser's own certificate settings, then open the printed HTTPS
browser console URL. Only import the public `browser-ca.crt`; keep its private
key and the entire state directory private. Remove the CA from your browser's
trust store when you discard this installation.

Sign in as `admin@development.openclaw.invalid` using the generated password in
the administrator password file printed by startup. That file and the service
key are private credentials; keep them on your machine. The separate HTTP API
URL remains available on loopback for CLI service-key requests.

After signing in, continue with the CLI access check below. For console-created
Agents later, the default Namespace includes Standard Codex and Standard OpenClaw
Presets; follow the [Standard Codex prerequisites](topics/standard-codex-preset.md#prerequisites)
before using that Preset.

## Read the Installation with the bootstrap service key

Use the API URL and service-key file printed at startup. On Linux, the defaults
are usually:

```bash
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/tmp/openclaw-development/initial-admin-service-key.json'
./bin/occ installation get
```

On macOS or with a custom state directory, use the printed key path instead.
Expect an Installation row with the ID printed at startup. The CLI reads the
key from the file; do not pass the credential value as an argument or share it.

## Find the initial Namespace

```bash
./bin/occ namespace list
```

Expect one Namespace named `default`. Wait for `STATUS` to become `ready` and
note its server-assigned ID. This platform Namespace is separate from Kubernetes'
built-in `default` namespace. Continue to [Deploy your first Agent](first-agent.md)
to create an Agent and verify its model response.

## Clean up and stop

When you are finished, run the cleanup command printed by startup. With the
profile exports above still set:

```bash
./bin/occ dev down
```

This deletes the local cluster, database, Agents, stored credentials, and audit
history. If cleanup fails, restore access to the container engine and run the
same command again. See [local Kubernetes cleanup](deploy/local-kubernetes-development.md#stop-and-clean-up)
if you used a custom state directory or service-key location.

## Optional: use matching published images

Follow [Use the latest published images](deploy/published-images.md) to pull both
`latest` tags and select their matching source checkout. Keep its resolved image
variables in the shell used for startup:

```bash
export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?Select the latest controller image first}"
export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?Select the latest runtime image first}"
```

Return to [Start the local stack](#start-the-local-stack) in that checkout.
To build from source instead, unset both variables before startup.

## Workspace access

Local setup configures private gateway routing. After deploying an Agent,
[verify its workspace files](deploy/workspace-routing.md#verify-routing-and-file-access).
Dedicated Agents also need [RWO workspace storage](deploy/local-kubernetes-development.md#configure-workspace-storage-on-single-node-k3d);
the stock local-path StorageClass supports the Harness-only claim.

## Open an Agent's native admin UI

For a separate console-managed Agent, follow [local native admin setup](deploy/native-admin.md#local-development).
It requires exact-Agent `administer` permission and the Agent's native access policy.
The first-Agent helper disables native UI and refuses to reuse its Agent after
outside Configuration edits.
