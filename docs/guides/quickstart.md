# Set up OpenClaw Enterprise locally

<span id="quickstart"></span>

Start an OpenClaw Enterprise installation that can deploy Agents on your
machine. The OpenClaw Control Plane (OCC) runs in Compose; Agent workloads run
in a local Kubernetes cluster created with k3d. This setup is for development
and uses loopback addresses. To install OCC itself in a cluster you already
operate, use [Kubernetes Setup](kubernetes-setup.md).

## Workspace access

For Console workspace access, use [Kubernetes Setup](kubernetes-setup.md).
That setup includes private gateway routing and Agent authentication so the
Console can read and save `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.

The Compose + k3d helper below is a limited local development profile. It does
not configure workspace access: `occ dev up` can succeed while the Console
reports **Workspace access is unavailable**. A deployed Agent or a successful
model response does not establish file access. The Kubernetes routing guide
assumes OCC runs in the cluster; its `.svc` endpoint and Pod NetworkPolicies do
not directly apply to an OCC API running on the host or in Compose.

## Before you start

Run the commands below from the repository root on Linux or macOS. You need:

- Docker Engine with Docker Compose, k3d, and kubectl. Podman users should first
  check the [local Kubernetes requirements](deploy/local-kubernetes-development.md#start-the-profile).
- The Go version in `go.mod`, Node.js 24 or later, and the pnpm version pinned
  in `package.json`.
- Free local ports `3000` for OCC and `6443` for Kubernetes. If either is in
  use, override `OPENCLAW_DEV_PORT` or `OCC_DEVELOPMENT_KUBERNETES_API_PORT`;
  see [development settings](../reference/settings/development.md#required-development-controller-environment).

You do not need a model credential to install the platform. Have an OpenAI API
key available when you continue to [deploy your first Agent](first-agent.md).

## Optional: use the published runtime

On an amd64 or ARM64 Docker host, you can avoid the first runtime build by pulling the
published image. Follow [Use published images](deploy/production-installation.md#use-published-images)
for private GHCR access, authentication, and the `RUNTIME_IMAGE` digest export.
Docker selects the matching Linux variant, including on Apple Silicon.

Pull the pinned digest and tag it locally for k3d import:

```bash
: "${RUNTIME_IMAGE:?Set the published runtime digest reference}"
docker pull "$RUNTIME_IMAGE"
docker tag "$RUNTIME_IMAGE" openclaw-enterprise-runtime:published-e3b28515
export OCC_KUBERNETES_RUNTIME_IMAGE='openclaw-enterprise-runtime:published-e3b28515'
```

Keep this export in the shell used for `dev up`. The CLI requires an explicitly
selected runtime image to exist locally and imports it into k3d. OCC's controller
and worker still build from the checkout's development target. To return to the
default runtime selection, run `unset OCC_KUBERNETES_RUNTIME_IMAGE` before starting
a new local stack.

## Start the local stack

```bash
pnpm cli:build
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./bin/occ dev up
```

The first start builds the development control plane and imports the runtime
image, building the runtime too when no local image was selected or cached.
This can take several minutes. Wait for `OpenClaw Enterprise development stack is ready.` The
command prints the API URL, Installation ID, local service-key file, kubeconfig,
Kubernetes context, and cleanup command. Keep this output; the service-key file
is an administrator credential and must remain on your machine.

Before deploying a dedicated Agent, [check local RWO workspace storage](deploy/local-kubernetes-development.md#configure-workspace-storage-on-single-node-k3d).
The stock local-path StorageClass supports the Harness-only RWO claim; no provisioner patch is required.

## Open the platform console

Open `/console/` on the printed API URL, normally
`http://127.0.0.1:3000/console/`. On a fresh installation, sign in with username
`admin@openclaw.local` and password `openclaw-development-password`. If you set
`OPENCLAW_DEV_EMAIL` or `OPENCLAW_DEV_PASSWORD`, use those values. These defaults
are for the local development profile only; see [development authentication settings](../reference/settings/development.md#required-development-controller-environment).

Open **Namespaces**. Fresh bootstrap creates a platform Namespace named
`default` and no Agents. Wait for the Namespace to show `ready`. The platform
Namespace is separate from Kubernetes' built-in `default` namespace.

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
note its server-assigned ID. The control-plane readiness message alone does not
prove an Agent or model works. Continue to [Deploy your first Agent](first-agent.md)
to create your own Agent and send it a prompt.

## Clean up and stop

When you are finished, run the cleanup command printed by startup. With the
defaults:

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./bin/occ dev down
```

This deletes the local cluster, database, Agents, stored credentials, and audit
history. If cleanup fails, restore access to the container engine and run the
same command again. See [local Kubernetes cleanup](deploy/local-kubernetes-development.md#stop-and-clean-up)
if you used a custom state directory or service-key location.
