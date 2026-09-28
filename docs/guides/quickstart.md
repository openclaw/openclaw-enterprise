# Set up OpenClaw Enterprise locally

<span id="quickstart"></span>

Start an OpenClaw Enterprise installation that can deploy Agents on your
machine. The OpenClaw Control Plane (OCC), PostgreSQL, and Agent workloads run
in a local Kubernetes cluster created with k3d. This setup is for development
and uses loopback addresses. This guide explicitly selects the Kubernetes-only
profile; without a selection, startup uses a Compose control-plane preview that
cannot deploy Agents. To install OCC itself in a cluster you already operate,
use [Kubernetes Setup](kubernetes-setup.md).

## Workspace access

Local setup configures private gateway routing. Workspace and native admin
access also require a compatible deployed Agent and its exact native policy;
follow [private workspace routing](deploy/workspace-routing.md) and
[native admin setup](deploy/native-admin.md). A successful platform startup or
model response does not establish file access.

## Before you start

Run the commands below from the repository root on Linux or macOS. You need:

- Docker Engine, k3d, kubectl, and Helm. Podman users should first
  check the [local Kubernetes requirements](deploy/local-kubernetes-development.md#start-the-profile).
- The Go version in `go.mod`, Node.js 24 or later, and the pnpm version pinned
  in `package.json`.
- Free local ports `3000` for the API, `8443` for the browser console, and
  `6443` for Kubernetes. If a port is in use, override `OPENCLAW_DEV_PORT`,
  `OCC_DEVELOPMENT_BROWSER_PORT`, or `OCC_DEVELOPMENT_KUBERNETES_API_PORT`;
  see [development settings](../reference/settings/development.md#required-development-controller-environment).

You do not need a model credential to install the platform. Have an OpenAI API
key available when you continue to [deploy your first Agent](first-agent.md).

## Optional: use matching published images

The default builds the controller and runtime from this checkout. To use
published images, verify their publication record and select the immutable
controller and runtime digests built from this same checkout revision. The
CLI checks their revision labels for consistency; those labels do not prove
publication provenance. The older images listed in the
[production installation guide](deploy/production-installation.md#use-published-images)
predate repository credentials and native admin and cannot supply this setup.

Pull your verified pair, then keep both exports in the shell used for `dev up`:

```bash
: "${CONTROLLER_IMAGE:?Set the verified controller digest reference}"
: "${RUNTIME_IMAGE:?Set the verified runtime digest reference}"
docker pull "$CONTROLLER_IMAGE"
docker pull "$RUNTIME_IMAGE"
export OCC_DEVELOPMENT_CONTROLLER_IMAGE="$CONTROLLER_IMAGE"
export OCC_KUBERNETES_RUNTIME_IMAGE="$RUNTIME_IMAGE"
```

To build both from source instead, unset both variables before startup.

## Start the local stack

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./bin/occ dev up
```

The first start builds and imports both images unless a verified pair was selected.
This can take several minutes. Wait for `OpenClaw Enterprise development stack is ready.` The
command prints the API URL, Installation ID, local service-key file, kubeconfig,
Kubernetes context, and cleanup command. Keep this output; the service-key file
is an administrator credential and must remain on your machine.

Before deploying a dedicated Agent, [check local RWO workspace storage](deploy/local-kubernetes-development.md#configure-workspace-storage-on-single-node-k3d).
The stock local-path StorageClass supports the Harness-only RWO claim; no provisioner patch is required.

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

Open **Namespaces**. Fresh bootstrap creates a platform Namespace named
`default` and no Agents. Wait for the Namespace to show `ready`. The platform
Namespace is separate from Kubernetes' built-in `default` namespace.

The default Namespace contains the Standard Codex and Standard OpenClaw
Presets. Codex plugin discovery uses the OpenAI curated catalog without a
discovery credential. Selecting a Preset or seeing a catalog entry does not
prove model execution or native sandbox enforcement; follow the
[Standard Codex prerequisites](topics/standard-codex-preset.md#prerequisites)
before deploying it.

## Open an Agent's native admin UI

Local setup prepares private routing and the browser endpoint. To opt a selected
Agent into native admin access:

1. [Create and deploy an Agent](../reference/console/create-and-deploy.md) in the
   console, for example with the Standard Codex Preset. Wait for its active
   version. The account opening the UI needs `administer` permission on that
   exact Agent.
2. In the authenticated console session, follow [Configure each Agent](deploy/native-admin.md#configure-each-agent)
   to obtain the exact `data.origin` and active revision ID from the status
   route. Include the returned port; do not construct or reuse another Agent's
   origin. An `unsupported` response can include the origin. If OCC cannot
   select an active revision, resolve that first.
3. Use **Create new version** → **Configuration** → **Edit Configuration** to
   merge the documented native policy and origin into the existing JSON. Review
   other Agents that share the Configuration: they use its new values on their
   next deployment. Preserve existing origins, gateway settings, and Secret
   references. Resolve explicit opt-outs or conflicting policy before changing
   them; do not silently replace them. Recheck the active revision before saving;
   if it changed, refresh and review the current Configuration again.
4. Save the Configuration and select **Deploy new version**. Once it is active,
   request status again and expect `available` with the same origin. Open
   **Native admin UI** on the Agent detail page. For stale drafts or uncertain
   saves, follow the [Configuration editor recovery](console/agent-details.md#configuration-tab).

The [first-Agent command](first-agent.md) creates a separate Agent with native UI
disabled and refuses to reuse it after outside Configuration edits. Create a
console-managed Agent for this native admin walkthrough.

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
profile exports above still set:

```bash
./bin/occ dev down
```

This deletes the local cluster, database, Agents, stored credentials, and audit
history. If cleanup fails, restore access to the container engine and run the
same command again. See [local Kubernetes cleanup](deploy/local-kubernetes-development.md#stop-and-clean-up)
if you used a custom state directory or service-key location.
